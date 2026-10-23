import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { SDKUserMessage } from "@cursor/sdk";
import type { ContentBlock, PromptResponse, SessionNotification, TurnUsage } from "@zeros/protocol/agent-events";
import type { SteerOutcome } from "@zeros/protocol/messages";
import type { Driver, DriverOpen } from "../driver";
import { driverTiming } from "../../agent-timings";
import { agentEnvironment } from "../shared/agent-environment";
import { normalizeProviderError } from "../shared/provider-error";
import { CursorProcess } from "./host-process";
import { CURSOR_VERSION, type CursorAgentUsage, type HostEvent } from "./native-types";
import { CursorSdkTranslator } from "./translator";
import { CursorSubagentTranscriptReader } from "./subagent-transcript-reader";
import { cursorRunUsage, cursorTokenUsage, sumCursorUsage } from "./usage-accounting";

interface Options {
  hostPath?: string; environment?: NodeJS.ProcessEnv; gitEnvironment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number; interruptTimeoutMs?: number;
}
interface Turn {
  observed?: boolean;
  id: string; runId?: string; model: string; stopped: boolean; closing: boolean;
  mapper: CursorSdkTranslator; transcripts: CursorSubagentTranscriptReader;
  callbackUsage?: TurnUsage; streamedUsage?: TurnUsage;
  controls: AbortController; poll?: ReturnType<typeof setInterval>;
  resolve(result: PromptResponse): void; reject(error: Error): void;
  done: Promise<void>; finish(): void;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The native conversation survives turns; each run gets fresh mapping state.
 * The worker stays outside the SDK process and never inherits its login. */
export class CursorDriver implements Driver {
  private readonly listeners = new Set<(event: SessionNotification) => void>();
  private input?: DriverOpen;
  private nativeSessionId?: string;
  private model = "composer-2.5";
  private process?: CursorProcess;
  private opening?: Promise<void>;
  private active?: Turn;
  private stopping?: Promise<void>;
  private disposed = false;

  constructor(private readonly options: Options = {}) {}

  async open(input: DriverOpen): Promise<{ nativeSessionId: string }> {
    if (this.input || this.disposed) throw new Error("Cursor driver has already been opened.");
    if (!input.apiKey) throw new Error("Missing Cursor API key.");
    this.input = input; this.nativeSessionId = input.nativeSessionId;
    if (input.model) this.model = validModel(input.model);
    await this.ensureProcess();
    return { nativeSessionId: this.nativeSessionId! };
  }

  async prompt(content: ContentBlock[]): Promise<PromptResponse> {
    this.ready();
    if (this.active || this.stopping) throw new Error("Cursor already has an active turn.");
    const message = nativeContent(content), id = randomUUID();
    const transcripts = new CursorSubagentTranscriptReader({ cwd: this.input!.cwd,
      home: this.options.environment?.HOME, parentAgentId: this.nativeSessionId });
    let resolve!: Turn["resolve"], reject!: Turn["reject"], finish!: () => void;
    const result = new Promise<PromptResponse>((yes, no) => { resolve = yes; reject = no; });
    const done = new Promise<void>(yes => { finish = yes; });
    const turn: Turn = { id, model: this.model, stopped: false, closing: false, resolve, reject, done, finish, transcripts,
      controls: new AbortController(), mapper: new CursorSdkTranslator({ sessionId: this.input!.sessionId,
        emit: event => { if (this.active === turn && !this.disposed) this.emit(event); },
        readSubagentTranscript: (child, final) => transcripts.read(child, final) }) };
    this.active = turn;
    void this.start(turn, message);
    return result;
  }

  async steer(content: ContentBlock[]): Promise<SteerOutcome> {
    const turn = this.active, process = this.process;
    if (!turn || !process || turn.stopped || turn.closing || this.disposed || !content.length || content.some(block => block.type !== "text")) return "queued";
    const text = content.map(block => block.type === "text" ? block.text : "").join("\n\n");
    if (!text.trim()) return "queued";
    try {
      const result = await process.request("steer", { turnId: turn.id, text }, turn.controls.signal);
      return result === "delivered" || result === "queued" ? result : "interrupted";
    } catch { return "interrupted"; }
  }

  async setModel(model: string): Promise<void> { this.ready(); this.model = validModel(model); }

  interrupt(): Promise<void> {
    if (this.stopping) return this.stopping;
    const turn = this.active;
    if (!turn) return Promise.resolve();
    turn.stopped = true; turn.controls.abort(); turn.transcripts.dispose(); clearInterval(turn.poll);
    const stopping = this.stop(turn);
    this.stopping = stopping;
    void stopping.finally(() => { if (this.stopping === stopping) this.stopping = undefined; }).catch(() => {});
    return stopping;
  }

  onEvent(emit: (event: SessionNotification) => void): () => void { this.listeners.add(emit); return () => this.listeners.delete(emit); }

  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true;
    const turn = this.active, process = this.process; this.process = undefined;
    if (turn) { turn.stopped = true; await this.settle(turn); }
    await process?.dispose(); await this.stopping;
    this.listeners.clear(); this.input = undefined;
  }

  private async ensureProcess(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.process) return;
    this.ready();
    const input = this.input!;
    const host = new CursorProcess({ path: this.options.hostPath ?? fileURLToPath(new URL("./cursor-host.mjs", import.meta.url)),
      cwd: input.cwd, env: agentEnvironment({ agent: "cursor", apiKey: input.apiKey! }, this.options.environment, this.options.gitEnvironment),
      timeoutMs: this.options.requestTimeoutMs ?? 30_000, redact: message => this.redact(message),
      onEvent: event => { if (this.process === host) this.event(event); },
      onClose: error => {
        if (this.process !== host) return; this.process = undefined;
        if (this.active) void this.settle(this.active, error);
      } });
    this.process = host;
    const opening = (async () => {
      try {
        const result = await host.request<{ nativeSessionId: string; version: string }>("open", {
          cwd: input.cwd, nativeSessionId: this.nativeSessionId, model: this.model });
        if (this.disposed || this.process !== host || result.version !== CURSOR_VERSION || typeof result.nativeSessionId !== "string" || !result.nativeSessionId ||
            (this.nativeSessionId && result.nativeSessionId !== this.nativeSessionId)) throw new Error("Cursor returned a different or closed native session.");
        this.nativeSessionId = result.nativeSessionId;
        driverTiming(this.input, "process_ready");
      } catch (error) { if (this.process === host) this.process = undefined; await host.dispose(); throw this.error(error); }
    })();
    this.opening = opening;
    try { await opening; } finally { if (this.opening === opening) this.opening = undefined; }
  }

  private async start(turn: Turn, message: SDKUserMessage): Promise<void> {
    try {
      await this.ensureProcess();
      if (this.active !== turn || this.disposed) return;
      if (turn.stopped) { await this.settle(turn); return; }
      turn.poll = setInterval(() => {
        if (this.active === turn && !turn.stopped && !turn.closing)
          void turn.mapper.pollSubagents(() => this.active === turn && !turn.stopped && !turn.closing).catch(() => {});
      }, 1200);
      turn.poll.unref();
      driverTiming(this.input, "turn_sent");
      const result = await this.process!.request<{ runId: string }>("prompt", { turnId: turn.id, content: message, model: turn.model });
      if (this.active === turn && (!result.runId || result.runId !== turn.runId)) throw new Error("Cursor returned a different native run.");
    } catch (error) {
      if (this.active === turn) {
        const host = this.process; this.process = undefined; void host?.dispose();
        await this.settle(turn, error);
      }
    }
  }

  private event(event: HostEvent): void {
    const turn = this.active;
    if (!turn || turn.id !== event.turnId || turn.closing || this.disposed) return;
    const value = record(event.value);
    if (event.kind === "started") {
      if (value.agentId !== this.nativeSessionId || typeof value.runId !== "string" || !value.runId || turn.runId)
        throw new Error("Invalid Cursor run identity.");
      turn.runId = value.runId; turn.mapper.bindRunIdentity(this.nativeSessionId!, turn.runId);
    } else if (event.kind === "error") {
      const host = this.process; this.process = undefined; void host?.dispose();
      void this.settle(turn, event.value);
    } else if (event.kind === "result") {
      const result = record(value.result);
      if (!turn.runId || result.id !== turn.runId) throw new Error("Invalid Cursor result identity.");
      void this.settle(turn, undefined, result, value.billed);
    } else if (!turn.stopped) {
      if (event.kind === "delta") {
        if (value.type === "turn-ended") turn.callbackUsage = sumCursorUsage(turn.callbackUsage, cursorTokenUsage(value.usage));
        turn.mapper.feedDelta(value);
      } else if (event.kind === "step") turn.mapper.feedStep(value);
      else if (turn.mapper.acceptsMessage(value)) {
        if (value.type === "usage") turn.streamedUsage = sumCursorUsage(turn.streamedUsage, cursorTokenUsage(value.usage));
        turn.mapper.feed(value);
      }
    }
    if (!turn.observed) { turn.observed = true; driverTiming(this.input, "first_provider_event"); }
  }

  private async settle(turn: Turn, error?: unknown, result: Record<string, unknown> = {}, billed?: unknown): Promise<void> {
    if (this.active !== turn || turn.closing) return;
    turn.closing = true; clearInterval(turn.poll); turn.controls.abort();
    try {
      await turn.mapper.flushSubagents({ readFinal: !turn.stopped, canReadFinal: () => !turn.stopped,
        ownsUpdates: () => this.active === turn && !this.disposed });
      const status = typeof result.status === "string" ? result.status.toLowerCase() : undefined;
      const tokens = cursorTokenUsage(result.usage) ?? turn.streamedUsage ?? turn.callbackUsage;
      const snapshot = record(billed);
      const billing = cursorRunUsage(Array.isArray(snapshot.runs)
        ? { runs: snapshot.runs.filter(row => !!row && typeof row === "object") } as CursorAgentUsage : undefined, turn.runId);
      const usage: TurnUsage | undefined = billing || tokens ? { ...billing, ...tokens, accountingVersion: 1, costKind: "reported" } : undefined;
      const effectiveModel = typeof record(result.model).id === "string" ? record(result.model).id as string : turn.model;
      if (turn.stopped || status === "cancelled" || turn.mapper.stopReason === "cancelled") {
        turn.resolve({ stopReason: "cancelled", effectiveModel, ...(usage ? { usage } : {}) }); return;
      }
      if (error) throw this.error(error);
      if (result.error || status === "error" || status === "expired" || turn.mapper.sawError)
        throw this.error(result.error ?? turn.mapper.terminalFailure ?? `Cursor run ${status ?? "failed"}.`);
      if (status !== "finished" && !(status === undefined && turn.mapper.sawTerminal))
        throw new Error("Cursor disconnected before confirming that the turn finished.");
      turn.mapper.recoverFinalAnswer(result.result);
      turn.resolve({ stopReason: turn.mapper.stopReason, effectiveModel, ...(usage ? { usage } : {}) });
    } catch (failure) { turn.reject(this.error(failure)); }
    finally {
      turn.transcripts.dispose(); if (this.active === turn) this.active = undefined; turn.finish();
    }
  }

  private async stop(turn: Turn): Promise<void> {
    const host = this.process;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { await host?.request("interrupt", { turnId: turn.id }); await turn.done; })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Cursor interrupt timed out.")), this.options.interruptTimeoutMs ?? 10_000); }),
      ]);
    } catch {
      if (this.process === host) this.process = undefined;
      await host?.dispose(); await this.settle(turn); await turn.done;
    } finally { clearTimeout(timer); }
  }
  private ready(): void { if (!this.input || this.disposed) throw new Error("Cursor driver is not ready."); }
  private error(error: unknown): Error {
    const native = normalizeProviderError("cursor", error);
    return Object.assign(new Error(this.redact(native.message)), { code: native.category });
  }
  private redact(message: string): string { return this.input?.apiKey ? message.split(this.input.apiKey).join("[redacted]") : message; }
  private emit(event: SessionNotification): void {
    const clean = JSON.parse(JSON.stringify(event, (_key, value) => typeof value === "string" ? this.redact(value) : value)) as SessionNotification;
    for (const listener of this.listeners) listener(clean);
  }
}

function validModel(model: string): string {
  if (!model.trim() || model.length > 200 || /\s/.test(model)) throw new Error("Invalid Cursor model.");
  return model;
}
function nativeContent(content: ContentBlock[]): SDKUserMessage {
  if (!content.length) throw new Error("A Cursor prompt must contain input.");
  const texts: string[] = [], images: NonNullable<SDKUserMessage["images"]> = [];
  for (const block of content) {
    if (block.type === "text") texts.push(block.text);
    else if (block.type === "image" && block.data && block.mimeType) images.push({ data: block.data, mimeType: block.mimeType });
    else if (block.type === "image" && block.uri) images.push({ url: block.uri });
    else throw new Error("Cursor cannot accept this resource directly.");
  }
  return { text: texts.join("\n\n"), ...(images.length ? { images } : {}) };
}
