import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path, { dirname, join } from "node:path";
import { codexModePolicy, codexQuestionFeatureArgs, mapCodexUserInputToQuestion, mapNativeQuestionAnswerToCodex, isCodexApprovalMethod,
  mapCodexApprovalToPermission, mapCodexPermissionResponse, defaultCodexApprovalResponse, codexFileChangePaths,
  type ContentBlock, type PromptResponse, type SessionNotification, type QuestionResponse, type RequestPermissionResponse } from "@zeros/protocol/agent-events";
import type { SteerOutcome } from "@zeros/protocol/messages";
import { codexModelUnavailableMessage } from "@zeros/protocol/model-rejection";
import { redactDriverMessage, type Driver, type DriverOpen } from "../driver";
import { normalizeProviderError } from "../shared/provider-error";
import { retainProviderFailure } from "../../provider-failure";
import { unsupportedInputNotice } from "../shared/unsupported-input";
import { CLOUD_INPUT_TIMEOUT_MS, cleanInteraction, nativeInputResponse } from "../shared/native-input";
import { driverTiming } from "../../agent-timings";
import { JsonRpcProcess, RpcError } from "../shared/json-rpc-process";
import { agentEnvironment } from "../shared/agent-environment";
import { CodexEventMapper } from "./event-mapper";

export const CODEX_VERSION = "0.166.0";

interface CodexOptions {
  /** Offline fixtures may replace the executable; production uses the pinned package. */
  command?: string;
  args?: string[];
  environment?: NodeJS.ProcessEnv;
  gitEnvironment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  interruptTimeoutMs?: number;
}

interface Turn {
  observed?: boolean;
  abort: AbortController;
  id?: string;
  model?: string;
  effort: ReturnType<typeof codexEffort>;
  fast: boolean;
  settingsPending?: Promise<void>;
  stopping: boolean;
  ack: Promise<void>;
  acknowledge: () => void;
  promise: Promise<PromptResponse>;
  resolve: (response: PromptResponse) => void;
  reject: (error: Error) => void;
  done: Promise<void>;
  finish: () => void;
  buffered: Array<{ method: string; params: unknown }>;
  interrupt?: Promise<void>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** One native app-server process per chat; no Local engine services are loaded. */
export class CodexDriver implements Driver {
  private readonly listeners = new Set<(event: SessionNotification) => void>();
  private rpc?: JsonRpcProcess;
  private mapper?: CodexEventMapper;
  private input?: DriverOpen;
  private nativeSessionId?: string;
  private model?: string;
  private modeId: "read-only" | "full-access" = "full-access";
  private readonly lifetime = new AbortController();
  private readonly fileEditPathsByItemId = new Map<string, string[]>();
  private effort?: ReturnType<typeof codexEffort>;
  private fast = false;
  private active?: Turn;
  private lastTurnId?: string;
  private state: "new" | "opening" | "ready" | "closed" = "new";

  constructor(private readonly options: CodexOptions = {}) {}

  async open(input: DriverOpen): Promise<{ nativeSessionId: string }> {
    if (this.state !== "new") throw new Error("Codex driver has already been opened.");
    if (!input.proxy) throw new Error("Missing Codex proxy configuration.");
    const proxy = new URL(input.proxy.baseUrl);
    if (!["https:", "http:"].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash)
      throw new Error("Invalid Codex proxy URL.");
    if (!input.proxy.token) throw new Error("Missing Codex proxy token.");
    this.state = "opening";
    this.input = input;
    this.model = input.model;
    if (input.modeId !== undefined && input.modeId !== "read-only" && input.modeId !== "full-access") throw new Error("Invalid Codex mode.");
    this.modeId = input.modeId ?? "full-access";
    this.effort = codexEffort(input.effort);
    this.fast = input.fast === true;
    this.mapper = new CodexEventMapper({ onAsyncQuestion: request => {
      if (this.state !== "ready" || !input.onQuestion) return;
      void input.onQuestion(cleanInteraction({ ...request, expiresAt: Date.now() + CLOUD_INPUT_TIMEOUT_MS }, input), this.lifetime.signal).catch(() => {});
    }, sessionId: input.sessionId, resumed: !!input.nativeSessionId, emit: (event) => {
      // A configured proxy token must never escape through provider error text
      // or transcript metadata. Native stderr is not observed at all.
      const clean = JSON.parse(this.redact(JSON.stringify(event))) as SessionNotification;
      for (const emit of this.listeners) emit(clean);
    } });
    const command = this.options.command ?? process.execPath;
    const args = this.options.args ?? [this.pinnedEntry()];
    const config = {
      model_provider: "zeros_proxy",
      "model_providers.zeros_proxy.name": "Zeros proxy",
      "model_providers.zeros_proxy.base_url": input.proxy.baseUrl,
      "model_providers.zeros_proxy.env_key": "ZEROS_CLOUD_PROXY_TOKEN",
      "model_providers.zeros_proxy.wire_api": "responses",
      "model_providers.zeros_proxy.requires_openai_auth": false,
    };
    this.rpc = new JsonRpcProcess({
      command, args: [...args, "app-server", ...(input.onQuestion ? codexQuestionFeatureArgs() : []),
        ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])],
      cwd: input.cwd,
      env: agentEnvironment({ agent: "codex", token: input.proxy.token }, this.options.environment, this.options.gitEnvironment),
      requestTimeoutMs: this.options.requestTimeoutMs ?? 30_000,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params, id) => this.nativeRequest(method, params, id),
      onClose: (error) => { this.state = "closed"; this.mapper?.endAgentActivity(); this.settle(error); },
      redact: (message) => this.redact(message),
    });
    try {
      await this.rpc.request("initialize", { clientInfo: { name: "zeros_cloud_worker", title: "Zeros", version: "0.0.0" }, capabilities: { experimentalApi: true } });
      this.rpc.notify("initialized", {});
      const response = await this.rpc.request<{ thread: { id: string }; model?: string }>(input.nativeSessionId ? "thread/resume" : "thread/start", {
        ...(input.nativeSessionId ? { threadId: input.nativeSessionId, excludeTurns: true } : {}),
        cwd: input.cwd, ...(input.model ? { model: input.model } : {}),
        modelProvider: "zeros_proxy", approvalPolicy: codexModePolicy(this.modeId).approvalPolicy, sandbox: codexModePolicy(this.modeId).sandboxMode,
        ...(input.mcpServers ? { config: { mcp_servers: Object.fromEntries(Object.entries(input.mcpServers).map(([name, server]) => [name, { url: server.url, http_headers: server.headers }])) } } : {}),
      });
      if (this.state !== "opening" || typeof response?.thread?.id !== "string" || !response.thread.id)
        throw new Error("Codex returned an invalid session.");
      if (input.nativeSessionId && input.nativeSessionId !== response.thread.id)
        throw new Error("Codex resumed a different native session.");
      this.nativeSessionId = response.thread.id;
      this.model = response.model ?? input.model;
      this.mapper.handle("thread/started", { thread: { id: this.nativeSessionId } });
      this.state = "ready";
      driverTiming(this.input, "process_ready");
      return { nativeSessionId: this.nativeSessionId };
    } catch (error) {
      const failure = this.error(error);
      await this.dispose();
      throw failure;
    }
  }

  async prompt(content: ContentBlock[]): Promise<PromptResponse> {
    this.assertReady();
    if (this.active) throw new Error("Codex already has an active turn.");
    const input = nativeInput(content);
    let resolve!: Turn["resolve"], reject!: Turn["reject"], acknowledge!: Turn["acknowledge"], finish!: Turn["finish"];
    const promise = new Promise<PromptResponse>((yes, no) => { resolve = yes; reject = no; });
    const ack = new Promise<void>((yes) => { acknowledge = yes; });
    const done = new Promise<void>((yes) => { finish = yes; });
    const turn: Turn = { abort: new AbortController(), model: this.model, effort: this.effort, fast: this.fast, stopping: false, promise, resolve, reject, ack, acknowledge, done, finish, buffered: [] };
    this.active = turn;
    this.fileEditPathsByItemId.clear();
    this.mapper!.startTurn();
    driverTiming(this.input, "turn_sent");
    void this.rpc!.request<{ turn: { id: string; status?: string } }>("turn/start", {
      threadId: this.nativeSessionId, input, ...(turn.model ? { model: turn.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      serviceTierForTurn: this.fast ? "fast" : "default",
      // Match Local's complete default-mode settings. Omitting turn.effort
      // alone retains the previous thread override after a model change.
      ...(turn.model ? { collaborationMode: { mode: "default", settings: {
        model: turn.model, reasoning_effort: this.effort ?? null, developer_instructions: null,
      } } } : {}),
      approvalPolicy: codexModePolicy(this.modeId).approvalPolicy, sandboxPolicy: codexModePolicy(this.modeId).sandboxPolicy,
    }).then((response) => {
      if (this.active !== turn) return;
      if (typeof response?.turn?.id !== "string" || !response.turn.id) throw new Error("Codex returned an invalid turn.");
      turn.id = response.turn.id;
      this.observe(turn);
      this.lastTurnId = turn.id;
      turn.acknowledge();
      this.mapper!.handle("turn/started", { turn: { id: turn.id } });
      const buffered = turn.buffered.splice(0);
      for (const frame of buffered) this.notification(frame.method, frame.params);
      if (this.active === turn && ["completed", "interrupted", "failed"].includes(response.turn.status ?? ""))
        this.notification("turn/completed", { threadId: this.nativeSessionId, turn: response.turn });
      void this.syncActiveTurnSettings(turn);
    }).catch((error: unknown) => { if (this.active === turn) this.settle(this.error(error)); });
    return promise;
  }

  async steer(content: ContentBlock[]): Promise<SteerOutcome> {
    const turn = this.active;
    if (!turn || turn.stopping) return "queued";
    const input = nativeInput(content);
    await turn.ack;
    if (this.active !== turn || turn.stopping || !turn.id) return "queued";
    try {
      const response = await this.rpc!.request<{ turnId: string }>("turn/steer", { threadId: this.nativeSessionId, expectedTurnId: turn.id, input });
      return response.turnId === turn.id ? "delivered" : "interrupted";
    } catch (error) {
      // Invalid params/turn preconditions prove non-delivery; losing a receipt
      // after dispatch does not. The worker must never auto-replay the latter.
      return error instanceof RpcError && error.code === -32602 ? "queued" : "interrupted";
    }
  }

  async setModel(model: string): Promise<void> {
    this.assertReady();
    validateModel(model);
    // turn/start owns model changes. A currently running turn keeps its model.
    if (this.model !== model) this.effort = undefined;
    this.model = model;
  }

  async setMode(modeId: string): Promise<void> {
    this.assertReady();
    if (modeId !== "read-only" && modeId !== "full-access") throw new Error("Invalid Codex mode.");
    this.modeId = modeId;
    for (const emit of this.listeners) emit({ sessionId: this.input!.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: modeId } });
  }

  async updateConfig(config: { model?: string; effort?: string; fast: boolean }): Promise<void> {
    this.assertReady();
    if (config.model !== undefined) { validateModel(config.model); this.model = config.model; }
    this.effort = codexEffort(config.effort);
    this.fast = config.fast;
    if (this.active) await this.syncActiveTurnSettings(this.active);
  }

  private syncActiveTurnSettings(turn: Turn): Promise<void> {
    if (turn.settingsPending) return turn.settingsPending;
    // Publish the promise before the pass, and clear it before resolving. An
    // unchanged snapshot or pending ACK must not strand a same-tick change.
    turn.settingsPending = Promise.resolve().then(async () => {
      try {
        while (this.state === "ready" && this.active === turn && turn.id && !turn.stopping) {
          // Model switches and their remembered knobs apply at turn/start.
          if (turn.model !== this.model) return;
          const effort = this.effort, fast = this.fast;
          const effortChanged = effort !== undefined && effort !== turn.effort;
          const fastChanged = fast !== turn.fast;
          if (!effortChanged && !fastChanged) return;
          turn.effort = effort; turn.fast = fast;
          try {
            await this.rpc!.request("turn/settings/update", {
              threadId: this.nativeSessionId, turnId: turn.id,
              ...(effortChanged ? { effort } : {}),
              ...(fastChanged ? { serviceTier: fast ? "fast" : null } : {}),
            }, { fatalTimeout: false });
          } catch {
            // The native runtime validates live-effort support. Its refusal or
            // a lost settings reply cannot fail a running turn. No raw errors.
            console.warn("[codex] Active-turn settings update failed; selections remain set for the next turn.");
          }
        }
      } finally { turn.settingsPending = undefined; }
    });
    return turn.settingsPending;
  }

  async interrupt(): Promise<void> {
    const turn = this.active;
    if (!turn) return;
    turn.stopping = true; turn.abort.abort();
    turn.interrupt ??= this.stop(turn);
    return turn.interrupt;
  }

  private async stop(turn: Turn): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await turn.ack;
          if (this.active !== turn || !turn.id) return;
          await this.rpc!.request("turn/interrupt", { threadId: this.nativeSessionId, turnId: turn.id });
          await turn.done;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Codex interrupt timed out.")), this.options.interruptTimeoutMs ?? 10_000);
        }),
      ]);
    } catch (error) {
      const failure = this.error(error);
      if (this.active === turn) this.settle(failure);
      await this.dispose();
      throw failure;
    } finally { clearTimeout(timer); }
  }

  onEvent(emit: (event: SessionNotification) => void): () => void {
    this.listeners.add(emit);
    return () => this.listeners.delete(emit);
  }

  async dispose(): Promise<void> {
    this.state = "closed"; this.lifetime.abort();
    this.fileEditPathsByItemId.clear();
    this.mapper?.endAgentActivity();
    this.settle(new Error("Codex driver was disposed."));
    await this.rpc?.dispose();
    this.listeners.clear();
    this.input = undefined;
  }

  private notification(method: string, params: unknown): void {
    const p = record(params);
    if (p.threadId !== undefined && p.threadId !== this.nativeSessionId) return;
    const turn = this.active;
    const nativeTurn = p.turnId ?? record(p.turn).id;
    if (!turn) {
      // Terminal delivery can precede a final authoritative item snapshot.
      // Preserve its repair while this is still the latest native turn.
      if (this.state === "ready" && this.lastTurnId && nativeTurn === this.lastTurnId)
        this.mapper!.handle(method, params);
      return;
    }
    if (!turn.id) {
      if (turn.buffered.length >= 4096) { this.settle(new Error("Codex sent too many events before acknowledgement.")); void this.dispose(); }
      else turn.buffered.push({ method, params });
      return;
    }
    if (nativeTurn !== undefined && nativeTurn !== turn.id) return;
    if (method === "item/started" || method === "item/completed") {
      const item = record(p.item), paths = codexFileChangePaths(item);
      if (item.type === "fileChange" && typeof item.id === "string" && paths.length) this.fileEditPathsByItemId.set(item.id, paths);
    }
    this.observe(turn);
    this.mapper!.handle(method, params);
    if (this.mapper!.sawTurnTerminal) {
      const failure = this.mapper!.terminalFailure ?? this.mapper!.terminalError;
      this.settle(failure ? this.error(failure) : undefined);
    }
  }

  private observe(turn: Turn): void {
    if (turn.observed) return;
    turn.observed = true; driverTiming(this.input, "first_provider_event");
  }

  private settle(error?: Error): void {
    const turn = this.active;
    if (!turn) return;
    this.active = undefined; turn.abort.abort();
    turn.buffered.length = 0;
    turn.acknowledge();
    turn.finish();
    if (error) turn.reject(error);
    else turn.resolve({ stopReason: this.mapper!.stopReason, ...(this.mapper!.turnUsage ? { usage: this.mapper!.turnUsage } : {}), ...(turn.model ? { effectiveModel: turn.model } : {}) });
  }

  private async nativeRequest(method: string, params: unknown, id: string | number): Promise<unknown> {
    const input = this.input, turn = this.active, p = record(params);
    const sameThread = p.threadId === undefined || p.threadId === this.nativeSessionId;
    if (sameThread && turn && !turn.id && p.turnId !== undefined &&
        (method === "item/tool/requestUserInput" || isCodexApprovalMethod(method))) {
      // Input can precede turn/start's bounded ACK; its ID must match before publication.
      await nativeInputResponse(() => turn.ack, turn.abort.signal, undefined);
    }
    const current = !!input && this.state === "ready" && !!turn && this.active === turn && !turn.stopping &&
      !turn.abort.signal.aborted && sameThread && (p.turnId === undefined || p.turnId === turn.id);
    if (method === "item/tool/requestUserInput") {
      if (!current) return { answers: {} };
      if (!input.onQuestion) { this.unsupportedInput("question", params); return { answers: {} }; }
      const request = mapCodexUserInputToQuestion(input.sessionId, randomUUID(), String(id), p, Date.now() + CLOUD_INPUT_TIMEOUT_MS);
      request.toolCallId = this.mapper!.emitUserInputToolCall(p) ?? request.toolCallId;
      const response = await nativeInputResponse(() => input.onQuestion!(cleanInteraction(request, input), turn.abort.signal), turn.abort.signal,
        { outcome: { outcome: "dismissed" } } as QuestionResponse);
      return mapNativeQuestionAnswerToCodex(request, response);
    }
    if (isCodexApprovalMethod(method)) {
      if (!current || !input.onPermission) return defaultCodexApprovalResponse(method, current ? "decline" : "cancel");
      const native = { method, params: p };
      const canonical = mapCodexApprovalToPermission({ zerosSessionId: input.sessionId, cwd: input.cwd, fileEditPathsByItemId: this.fileEditPathsByItemId }, native,
        { path, newId: () => String(id) });
      const nativeId = canonical.toolCall.toolCallId;
      const request = { ...canonical, nativeRequestId: String(id), allowLocalPolicies: false,
        toolCall: { ...canonical.toolCall, toolCallId: this.mapper!.toolCallIdFor(nativeId) ?? nativeId, nativeToolCallId: nativeId } };
      const response = await nativeInputResponse(() => input.onPermission!(cleanInteraction(request, input), turn.abort.signal), turn.abort.signal,
        { outcome: { outcome: "cancelled" } } as RequestPermissionResponse);
      return mapCodexPermissionResponse(native, response);
    }
    if (method === "mcpServer/elicitation/request") {
      this.unsupportedInput("elicitation", params); return { action: "cancel", content: null, _meta: null };
    }
    throw new RpcError("Unsupported worker request.", -32601);
  }

  private unsupportedInput(kind: "question" | "elicitation", params: unknown): void {
    const threadId = params && typeof params === "object" && "threadId" in params ? params.threadId : undefined;
    if (!this.input || this.state !== "ready" || (threadId !== undefined && threadId !== this.nativeSessionId)) return;
    const event = unsupportedInputNotice(this.input.sessionId, kind);
    for (const emit of this.listeners) emit(event);
  }

  private assertReady(): void {
    if (this.state !== "ready" || !this.rpc || !this.nativeSessionId) throw new Error("Codex driver is not ready.");
  }
  private redact(message: string): string {
    return redactDriverMessage(message, this.input);
  }
  private error(error: unknown): Error {
    const native = normalizeProviderError("codex", error);
    return retainProviderFailure("codex", error, native.category === "model-unavailable"
      ? codexModelUnavailableMessage(native.message) : this.redact(native.message));
  }
  private pinnedEntry(): string {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("@openai/codex/package.json");
    const pkg = require(manifest) as { version: string };
    if (pkg.version !== CODEX_VERSION) throw new Error("Codex package version does not match the worker pin.");
    return join(dirname(manifest), "bin/codex.js");
  }
}

function validateModel(model: string): void {
  if (!model.trim() || model.length > 200 || /\s/.test(model)) throw new Error("Invalid Codex model.");
}

// Local's mapCodexEffortFromEnv, copied here to keep the VM runtime standalone.
// The native schema accepts a string; never forward an unrecognized value.
function codexEffort(value: string | undefined): "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | undefined {
  switch (value?.trim().toLowerCase()) {
    case "minimal": return "minimal";
    case "low": return "low";
    case "medium": return "medium";
    case "high": return "high";
    case "xhigh": return "xhigh";
    case "max": return "max";
    case "ultracode": case "ultra": return "ultra";
    default: return undefined;
  }
}

function nativeInput(content: ContentBlock[]): unknown[] {
  if (!content.length) throw new Error("A Codex prompt must contain input.");
  return content.map((block) => {
    switch (block.type) {
      case "text": return { type: "text", text: block.text, text_elements: [] };
      case "image": return { type: "image", url: `data:${block.mimeType};base64,${block.data}` };
      case "audio": return { type: "audio", url: `data:${block.mimeType};base64,${block.data}` };
      case "resource_link": return { type: "mention", name: block.name, path: block.uri };
      case "resource":
        if ("text" in block.resource) return { type: "text", text: block.resource.text, text_elements: [] };
        throw new Error("Codex cannot accept this binary resource directly.");
    }
  });
}
