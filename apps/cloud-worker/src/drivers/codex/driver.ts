import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ContentBlock, PromptResponse, SessionNotification } from "@zeros/protocol/agent-events";
import type { SteerOutcome } from "@zeros/protocol/messages";
import type { Driver, DriverOpen } from "../driver";
import { JsonRpcProcess, RpcError } from "../shared/json-rpc-process";
import { agentEnvironment } from "../shared/agent-environment";
import { CodexEventMapper } from "./event-mapper";

export const CODEX_VERSION = "0.162.1";

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
  id?: string;
  model?: string;
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
    this.mapper = new CodexEventMapper({ sessionId: input.sessionId, resumed: !!input.nativeSessionId, emit: (event) => {
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
      command, args: [...args, "app-server", ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])],
      cwd: input.cwd,
      env: agentEnvironment({ agent: "codex", token: input.proxy.token }, this.options.environment, this.options.gitEnvironment),
      requestTimeoutMs: this.options.requestTimeoutMs ?? 30_000,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method) => this.nativeRequest(method),
      onClose: (error) => { this.state = "closed"; this.mapper?.endAgentActivity(); this.settle(error); },
      redact: (message) => this.redact(message),
    });
    try {
      await this.rpc.request("initialize", { clientInfo: { name: "zeros_cloud_worker", title: "Zeros", version: "0.0.0" }, capabilities: { experimentalApi: true } });
      this.rpc.notify("initialized", {});
      const response = await this.rpc.request<{ thread: { id: string }; model?: string }>(input.nativeSessionId ? "thread/resume" : "thread/start", {
        ...(input.nativeSessionId ? { threadId: input.nativeSessionId, excludeTurns: true } : {}),
        cwd: input.cwd, ...(input.model ? { model: input.model } : {}),
        modelProvider: "zeros_proxy", approvalPolicy: "never", sandbox: "danger-full-access",
      });
      if (this.state !== "opening" || typeof response?.thread?.id !== "string" || !response.thread.id)
        throw new Error("Codex returned an invalid session.");
      if (input.nativeSessionId && input.nativeSessionId !== response.thread.id)
        throw new Error("Codex resumed a different native session.");
      this.nativeSessionId = response.thread.id;
      this.model = response.model ?? input.model;
      this.mapper.handle("thread/started", { thread: { id: this.nativeSessionId } });
      this.state = "ready";
      return { nativeSessionId: this.nativeSessionId };
    } catch (error) {
      await this.dispose();
      throw error;
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
    const turn: Turn = { model: this.model, stopping: false, promise, resolve, reject, ack, acknowledge, done, finish, buffered: [] };
    this.active = turn;
    this.mapper!.startTurn();
    void this.rpc!.request<{ turn: { id: string; status?: string } }>("turn/start", {
      threadId: this.nativeSessionId, input, ...(turn.model ? { model: turn.model } : {}),
      approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
    }).then((response) => {
      if (this.active !== turn) return;
      if (typeof response?.turn?.id !== "string" || !response.turn.id) throw new Error("Codex returned an invalid turn.");
      turn.id = response.turn.id;
      this.lastTurnId = turn.id;
      turn.acknowledge();
      this.mapper!.handle("turn/started", { turn: { id: turn.id } });
      const buffered = turn.buffered.splice(0);
      for (const frame of buffered) this.notification(frame.method, frame.params);
      if (this.active === turn && ["completed", "interrupted", "failed"].includes(response.turn.status ?? ""))
        this.notification("turn/completed", { threadId: this.nativeSessionId, turn: response.turn });
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
    if (!model.trim() || model.length > 200 || /\s/.test(model)) throw new Error("Invalid Codex model.");
    // turn/start owns model changes. A currently running turn keeps its model.
    this.model = model;
  }

  async interrupt(): Promise<void> {
    const turn = this.active;
    if (!turn) return;
    turn.stopping = true;
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
    this.state = "closed";
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
    this.mapper!.handle(method, params);
    if (this.mapper!.sawTurnTerminal) {
      const failure = this.mapper!.terminalError;
      this.settle(failure ? new Error(this.redact(failure)) : undefined);
    }
  }

  private settle(error?: Error): void {
    const turn = this.active;
    if (!turn) return;
    this.active = undefined;
    turn.buffered.length = 0;
    turn.acknowledge();
    turn.finish();
    if (error) turn.reject(error);
    else turn.resolve({ stopReason: this.mapper!.stopReason, ...(this.mapper!.turnUsage ? { usage: this.mapper!.turnUsage } : {}), ...(turn.model ? { effectiveModel: turn.model } : {}) });
  }

  private nativeRequest(method: string): unknown {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": return { decision: "decline" };
      case "item/tool/requestUserInput": return { answers: {} };
      case "mcpServer/elicitation/request": return { action: "cancel", content: null, _meta: null };
      case "item/permissions/requestApproval": return { permissions: {}, scope: "turn" };
      case "applyPatchApproval":
      case "execCommandApproval": return { decision: "denied" };
      default: throw new RpcError("Unsupported worker request.", -32601);
    }
  }

  private assertReady(): void {
    if (this.state !== "ready" || !this.rpc || !this.nativeSessionId) throw new Error("Codex driver is not ready.");
  }
  private redact(message: string): string {
    const token = this.input?.proxy?.token;
    return token ? message.split(token).join("[redacted]").split(JSON.stringify(token).slice(1, -1)).join("[redacted]") : message;
  }
  private error(error: unknown): Error { return new Error(this.redact(error instanceof Error ? error.message : "Codex request failed.")); }
  private pinnedEntry(): string {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("@openai/codex/package.json");
    const pkg = require(manifest) as { version: string };
    if (pkg.version !== CODEX_VERSION) throw new Error("Codex package version does not match the worker pin.");
    return join(dirname(manifest), "bin/codex.js");
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
