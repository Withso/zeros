import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { query, type Options, type Query, type Settings, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlock, PromptResponse, SessionNotification } from "@zeros/protocol/agent-events";
import type { SteerOutcome } from "@zeros/protocol/messages";
import { providerBindingForResume } from "@zeros/protocol/identities";
import type { Driver, DriverOpen } from "../driver";
import { driverTiming } from "../../agent-timings";
import { agentEnvironment } from "../shared/agent-environment";
import { InputQueue, createDeferred, type Deferred } from "./input-queue";
import { isClaudeBackgroundAcknowledgement, isUnownedClaudeResult } from "./result-ownership";
import { ClaudeStreamTranslator } from "./translator";
import { isClaudeParentProgress } from "./event-feedback";
import { hasClaudeModelContent } from "./first-content";
import { normalizeProviderError } from "../shared/provider-error";

export const CLAUDE_VERSION = "0.3.296";
interface NativeQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>; setModel(model: string): Promise<void>; close(): void;
  applyFlagSettings: Query["applyFlagSettings"];
}
interface ClaudeOptions {
  query?: (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => NativeQuery;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  gitEnvironment?: NodeJS.ProcessEnv;
  interruptTimeoutMs?: number;
}
interface Process { query: NativeQuery; input: InputQueue<SDKUserMessage> }
interface Turn extends Deferred<PromptResponse> { uuids: Set<string>; model?: string; observed?: boolean }
interface Receipt extends Deferred<SteerOutcome> { timer?: ReturnType<typeof setTimeout> }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** One persistent SDK query owns a conversation, including native background
 * work between prompts. Only an owned root result completes the current send. */
export class ClaudeDriver implements Driver {
  private readonly listeners = new Set<(event: SessionNotification) => void>();
  private readonly steers = new Map<string, Receipt>();
  private readonly results = new Set<string>();
  private input?: DriverOpen;
  private nativeSessionId?: string;
  private resumed = false;
  private model?: string;
  private effort?: string;
  private mapper?: ClaudeStreamTranslator;
  private process?: Process;
  private active?: Turn;
  private stopping?: Promise<void>;
  private disposed = false;
  private running = false;

  constructor(private readonly options: ClaudeOptions = {}) {}

  async open(input: DriverOpen): Promise<{ nativeSessionId: string; provisional?: boolean }> {
    if (this.input || this.disposed) throw new Error("Claude driver has already been opened.");
    if (input.proxy || !!input.oauthToken === !!input.apiKey) throw new Error("Provide one Claude OAuth token or API key.");
    if (input.nativeSessionId && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(input.nativeSessionId)) throw new Error("Invalid Claude session id.");
    this.input = input; this.nativeSessionId = input.nativeSessionId ?? randomUUID(); this.resumed = !!input.nativeSessionId; this.model = input.model;
    this.effort = input.effort;
    this.mapper = new ClaudeStreamTranslator({ sessionId: input.sessionId, streamPartials: true, emit: event => this.emit(event) });
    return { nativeSessionId: this.nativeSessionId, ...(!this.resumed ? { provisional: true } : {}) };
  }

  async prompt(content: ContentBlock[]): Promise<PromptResponse> {
    this.ready();
    if (this.active || this.stopping) throw new Error("Claude already has an active turn.");
    const message = nativeContent(content);
    const process = this.ensureQuery(), uuid = randomUUID();
    const turn: Turn = { ...createDeferred<PromptResponse>(), uuids: new Set([uuid]), model: this.model };
    this.active = turn; this.mapper!.beginTurn();
    driverTiming(this.input, "turn_sent");
    process.input.push({ type: "user", uuid, session_id: this.nativeSessionId!, message: { role: "user", content: message }, parent_tool_use_id: null });
    return turn.promise;
  }

  async steer(content: ContentBlock[]): Promise<SteerOutcome> {
    const process = this.process, turn = this.active;
    if (!process || !turn || this.stopping || this.disposed || this.steers.size >= 128) return "queued";
    const message = nativeContent(content), uuid = randomUUID(), receipt = createDeferred<SteerOutcome>();
    this.steers.set(uuid, receipt); turn.uuids.add(uuid);
    process.input.push({ type: "user", uuid, session_id: this.nativeSessionId!, message: { role: "user", content: message }, parent_tool_use_id: null });
    return receipt.promise;
  }

  async setModel(model: string): Promise<void> {
    this.ready();
    if (!model.trim() || model.length > 200 || /\s/.test(model)) throw new Error("Invalid Claude model.");
    const process = this.process, changed = this.model !== model;
    try {
      await process?.query.setModel(model);
      // Omission shallow-merges in the SDK. Null resets even a creation-time
      // max effort to the new model's default; false revokes ultracode.
      if (changed) await process?.query.applyFlagSettings({ effortLevel: null, ultracode: false });
    } catch (error) { throw this.error(error); }
    if (this.disposed || (process && process !== this.process)) throw new Error("Claude session changed during model selection.");
    this.model = model;
    if (changed) this.effort = undefined;
  }

  interrupt(): Promise<void> {
    if (this.stopping) return this.stopping;
    const process = this.process;
    if (!process) return Promise.resolve();
    // The SDK's public interrupt signature cannot guarantee cancellation of
    // all queued input. Retire this query, then resume only on an explicit send.
    this.detach(process);
    this.settle(undefined, { stopReason: "cancelled" });
    const stop = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([process.query.interrupt(), new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.interruptTimeoutMs ?? 5_000); })]);
      } catch { /* Closing the retired query also stops unsupported controls. */ }
      finally { clearTimeout(timer); process.query.close(); }
    })();
    this.stopping = stop;
    void stop.finally(() => { if (this.stopping === stop) this.stopping = undefined; }).catch(() => {});
    return stop;
  }

  onEvent(emit: (event: SessionNotification) => void): () => void { this.listeners.add(emit); return () => this.listeners.delete(emit); }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const process = this.process;
    if (process) { this.detach(process); process.query.close(); }
    this.settle(undefined, { stopReason: "cancelled" });
    await this.stopping;
    this.listeners.clear(); this.input = undefined;
  }

  private ensureQuery(): Process {
    if (this.process) return this.process;
    const session = this.input!, input = new InputQueue<SDKUserMessage>();
    const options: Options = {
      cwd: session.cwd, ...(this.model ? { model: this.model } : {}),
      ...claudeEffort(this.effort),
      ...(this.resumed ? { resume: this.nativeSessionId } : { sessionId: this.nativeSessionId }),
      env: agentEnvironment(session.oauthToken ? { agent: "claude", oauthToken: session.oauthToken } : { agent: "claude", apiKey: session.apiKey! }, this.options.environment, this.options.gitEnvironment),
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      includePartialMessages: true, persistSession: true, settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      onUserDialog: async () => ({ behavior: "cancelled" }), onElicitation: async () => ({ action: "cancel" }),
      supportedDialogKinds: [],
      pathToClaudeCodeExecutable: this.options.executable ?? pinnedExecutable(),
    };
    const process = { query: (this.options.query ?? query)({ prompt: input, options }), input };
    this.mapper!.beginProcess(); this.process = process;
    void this.consume(process);
    return process;
  }

  private async consume(process: Process): Promise<void> {
    let failure: Error | undefined;
    let continuationFailure = false;
    try {
      for await (const raw of process.query) {
        if (this.process !== process || this.disposed) break;
        const frame = record(raw), root = !frame.parent_tool_use_id && !frame.agent_id;
        if (frame.type === "system" && frame.subtype === "init") {
          if (frame.session_id !== this.nativeSessionId) throw new Error("Claude resumed a different native session.");
          driverTiming(this.input, "process_ready");
          if (!this.model && typeof frame.model === "string") this.model = frame.model;
        }
        const isResult = root && frame.type === "result";
        if (isResult && typeof frame.uuid === "string") {
          if (this.results.has(frame.uuid)) continue;
          this.results.add(frame.uuid);
          if (this.results.size > 4_000) this.results.delete(this.results.values().next().value!);
        }
        this.observeSteering(frame, root);
        const ids = [frame.user_message_uuid, ...(Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids : [])].filter((id): id is string => typeof id === "string" && !!id);
        const acknowledgement = isResult && isClaudeBackgroundAcknowledgement(frame);
        const owned = !!this.active && isResult && !acknowledgement && (ids.length ? ids.some(id => this.active!.uuids.has(id)) : !isUnownedClaudeResult(frame));
        const accepted = this.mapper!.feed(raw, { preserveTurnActivity: frame.type === "result" && !!this.active && !owned });
        if (accepted && root && this.active && !this.active.observed && (!isResult || owned)) {
          this.active.observed = true; driverTiming(this.input, "first_provider_event");
        }
        if (accepted && !this.resumed && (hasClaudeModelContent(raw) ||
            (isResult && !acknowledgement && !this.mapper!.terminalError && this.mapper!.stopReason === "end_turn"))) {
          this.resumed = true;
          this.emit({ sessionId: this.input!.sessionId, update: { sessionUpdate: "provider_binding_update", providerBinding: providerBindingForResume("claude", this.nativeSessionId!) } });
        }
        if (!isResult) continue;
        if (typeof frame.queued_turn_count === "number" && frame.queued_turn_count > 0) {
          for (const receipt of this.steers.values()) { clearTimeout(receipt.timer); receipt.timer = undefined; }
        } else if (!acknowledgement && (!this.active || owned)) this.boundSteering();
        if (!owned) {
          if (!this.active && !acknowledgement) {
            const error = this.mapper!.terminalFailure;
            if (error) {
              const failure = normalizeProviderError("claude", error);
              this.continuation("claude-background-failed", failure.message, false, failure.category); continuationFailure = true;
            } else if (continuationFailure && this.mapper!.stopReason === "end_turn") {
              this.continuation("claude-background-recovered", "Claude continued successfully.", true); continuationFailure = false;
            }
          }
          continue;
        }
        const usage = this.mapper!.turnUsage, effectiveModel = this.active!.model ?? usage?.perModel?.find(entry => entry.model)?.model;
        this.settle(this.mapper!.terminalError ? this.error(this.mapper!.terminalError) : undefined, {
          stopReason: this.mapper!.stopReason, ...(usage ? { usage } : {}), ...(effectiveModel ? { effectiveModel } : {}),
        });
      }
    } catch (error) { failure = this.error(error); }
    finally {
      if (this.process === process) {
        const pending = this.mapper!.pendingUserActionFailure;
        const lostBackground = this.mapper!.hasActiveWork || this.running;
        const unfinished = !!this.active;
        this.detach(process); process.query.close();
        if (!unfinished && !continuationFailure && (lostBackground || failure || pending)) {
          this.continuation("claude-background-transport-closed", failure
            ? `Claude disconnected during background work: ${failure.message}` : "Claude disconnected before its background work finished.");
        }
        this.settle(failure ?? this.error(pending?.message ?? "Claude stream ended before the turn completed."));
      }
    }
  }

  private observeSteering(frame: Record<string, unknown>, root: boolean): void {
    if (!root) return;
    if (frame.type === "command_lifecycle" && typeof frame.command_uuid === "string") {
      if (frame.state === "started" || frame.state === "completed") this.receipt(frame.command_uuid, "delivered");
      else if (frame.state === "refused" || frame.state === "discarded") this.receipt(frame.command_uuid, "queued");
      else if (frame.state === "cancelled") this.receipt(frame.command_uuid, "interrupted");
    }
    if (["assistant", "stream_event", "result"].includes(String(frame.type)) ||
        (frame.type === "system" && frame.subtype === "thinking_tokens" && isClaudeParentProgress(frame))) {
      for (const id of [frame.user_message_uuid, ...(Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids : [])]) {
        if (typeof id === "string") this.receipt(id, "delivered");
      }
    }
  }
  private boundSteering(): void {
    for (const [id, receipt] of this.steers) if (!receipt.timer) {
      receipt.timer = setTimeout(() => this.receipt(id, "interrupted"), 5_000); receipt.timer.unref?.();
    }
  }
  private receipt(id: string, outcome: SteerOutcome): void {
    const receipt = this.steers.get(id); if (!receipt) return;
    this.steers.delete(id); clearTimeout(receipt.timer); receipt.resolve(outcome);
  }
  private detach(process: Process): void {
    if (this.process !== process) return;
    this.process = undefined;
    for (const message of process.input.discardPending()) if (message.uuid) this.receipt(message.uuid, "queued");
    process.input.end();
    for (const id of this.steers.keys()) this.receipt(id, "interrupted");
    this.mapper!.endActivity();
    // An unused or unauthenticated init never established resume authority.
    if (!this.resumed) this.nativeSessionId = randomUUID();
  }
  private settle(error?: Error, result?: PromptResponse): void {
    const turn = this.active; if (!turn) return; this.active = undefined;
    if (error) turn.reject(error); else turn.resolve(result ?? { stopReason: "cancelled" });
  }
  private ready(): void { if (!this.input || this.disposed) throw new Error("Claude driver is not ready."); }
  private emit(event: SessionNotification): void {
    if (event.update.sessionUpdate === "background_tasks_update") this.running = !!event.update.activity && event.update.activity.state !== "idle";
    const clean = JSON.parse(this.redact(JSON.stringify(event))) as SessionNotification;
    for (const listener of this.listeners) listener(clean);
  }
  private continuation(code: string, message: string, recovered = false, failureKind?: string): void {
    this.emit({ sessionId: this.input!.sessionId, update: { sessionUpdate: "error_notice", noticeId: `claude-background-${randomUUID()}`,
      severity: recovered ? "warning" : "error", recoverable: recovered, code, message, ...(failureKind ? { failureKind } : {}) } });
  }
  private redact(message: string): string {
    const token = this.input?.oauthToken ?? this.input?.apiKey;
    return token ? message.split(token).join("[redacted]").split(JSON.stringify(token).slice(1, -1)).join("[redacted]") : message;
  }
  private error(error: unknown): Error { return new Error(this.redact(error instanceof Error ? error.message : typeof error === "string" ? error : "Claude request failed.")); }
}

// Local's effort mapping, without importing the desktop runtime. The SDK's
// ultracode setting grants dynamic workflows; it is distinct from plain xhigh.
function claudeEffort(value: string | undefined): Pick<Options, "effort" | "settings"> {
  const effort = value?.trim(), ultracode = effort === "ultracode";
  const effortLevel: Settings["effortLevel"] = ultracode ? "xhigh"
    : effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" ? effort : undefined;
  return {
    settings: { ...(effortLevel ? { effortLevel } : {}), ultracode },
    ...(effort === "max" ? { effort: "max" } : {}),
  };
}

function pinnedExecutable(): string {
  const require = createRequire(import.meta.url), sdk = require.resolve("@anthropic-ai/claude-agent-sdk"), manifest = join(dirname(sdk), "package.json");
  if ((require(manifest) as { version: string }).version !== CLAUDE_VERSION) throw new Error("Claude SDK package does not match the worker pin.");
  const executable = createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${process.platform === "win32" ? "claude.exe" : "claude"}`);
  const platform = join(dirname(executable), "package.json");
  if ((require(platform) as { version: string }).version !== CLAUDE_VERSION) throw new Error("Claude CLI package does not match the worker pin.");
  return executable;
}

function nativeContent(content: ContentBlock[]): SDKUserMessage["message"]["content"] {
  if (!content.length) throw new Error("A Claude prompt must contain input.");
  const blocks = content.map(block => {
    switch (block.type) {
      case "text": return { type: "text", text: block.text };
      case "image": return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } };
      case "resource_link": return { type: "text", text: `@${block.uri.replace(/^file:\/\//, "")}` };
      case "resource": if ("text" in block.resource) return { type: "text", text: block.resource.text }; break;
    }
    throw new Error("Claude cannot accept this binary resource directly.");
  });
  return blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text! : blocks as SDKUserMessage["message"]["content"];
}
