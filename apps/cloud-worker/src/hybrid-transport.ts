import { randomUUID } from "node:crypto";
import { CLOUD_V2_MAX_FRAME_BYTES, CLOUD_V2_RELAY_PROTOCOL, CloudV2ControlFrameSchema, CloudV2WorkerActivityReplySchema,
  CloudV2WorkerFrameSchema, CloudV2WorkerTimingSchema, type CloudV2WorkerTiming, type CloudV2ControlFrame, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { InboundBridge } from "./inbound-bridge";
import { readWorkerToken, WORKER_TOKEN_FILE } from "./worker-token";
import type { PromptOperation, Transport, TransportHandlers } from "./transport";
import type { McpAuthorization } from "./mcp/gateway";

type ConfigFrame = Extract<CloudV2ControlFrame, { t: "config" }>;
export type HybridStatus = "connected" | "disconnected" | "credential-unavailable" | "unauthorized" | "stopped" | "protocol-error";
interface Options {
  apiUrl: string; workspaceId: string; runtimeSha256: string; tokenFile?: string;
  publicKeys?: readonly string[]; publicKeysFile?: string; port?: number; fetch?: typeof fetch;
  retryBaseMs?: number; retryMaxMs?: number; onStatus?: (status: HybridStatus) => void;
}
class HttpFailure extends Error { constructor(readonly status: number) { super("Worker control request failed."); } }

/** Live frames use authenticated loopback sockets. Durable control traffic
 * uses HTTPS independently, so it survives the final app disconnect. */
export class HybridTransport implements Transport {
  readonly bootId = randomUUID();
  private readonly listener: InboundBridge;
  private handlers?: TransportHandlers;
  private listening = false;
  private registered = false;
  private stopped = false;
  private recovering?: Promise<void>;
  private recoverRequested = false;
  private bootstrapped = false;
  private initialControls = 0;
  private releaseInitial!: () => void;
  private readonly initial = new Promise<void>(resolve => { this.releaseInitial = resolve; });
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private busyTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private idle = true;
  private lastBusy = -Infinity;
  private applied?: ConfigFrame;
  private configAt = 0;
  private applying: Promise<void> = Promise.resolve();
  private activityFlight?: Promise<void>;
  private activityRequested = false;
  private historySequence = 0;
  private pendingHistory?: { sequence: number; frame: Extract<CloudV2WorkerFrame, { t: "history" }> };
  private historyFlight: Promise<boolean> = Promise.resolve(true);
  private requests = new Set<AbortController>();
  private readonly reportedTimings = new Set<CloudV2WorkerTiming["phase"]>();

  constructor(private readonly options: Options) {
    let url: URL;
    try { url = new URL(options.apiUrl); } catch { throw new Error("Invalid worker API URL"); }
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid worker API URL");
    if (!/^[a-f0-9]{64}$/.test(options.runtimeSha256)) throw new Error("Invalid worker runtime pin");
    this.listener = new InboundBridge({ workspaceId: options.workspaceId, bootId: this.bootId,
      ...(options.publicKeys ? { publicKeys: options.publicKeys } : {}), ...(options.publicKeysFile ? { publicKeysFile: options.publicKeysFile } : {}),
      ...(options.port === undefined ? {} : { port: options.port }) });
  }
  start(handlers: TransportHandlers): void {
    if (this.handlers || this.stopped) return;
    this.handlers = handlers; this.recover();
  }
  async send(frame: CloudV2WorkerFrame): Promise<boolean> {
    if (this.stopped || !this.registered || !CloudV2WorkerFrameSchema.safeParse(frame).success) return false;
    if (frame.t === "frame" || frame.t === "stop-ack") return this.listener.send(frame);
    // CloudWorker's internal hello hook carries capabilities for its fake
    // transports; this carrier already registered the process by HTTP.
    if (frame.t === "hello") return true;
    if (frame.t === "history") {
      this.historyFlight = this.historyFlight.catch(() => false).then(async () => {
        if (this.pendingHistory) return false;
        this.pendingHistory = { sequence: this.historySequence + 1, frame: structuredClone(frame) };
        try { await this.commitHistory(); return true; }
        catch (error) { this.failed(error); return false; }
      });
      return this.historyFlight;
    }
    if (frame.t === "idle") {
      this.idle = frame.idle;
      if (!frame.idle && Date.now() - this.lastBusy < 30_000) {
        this.busyTimer ??= setTimeout(() => { this.busyTimer = undefined; if (!this.idle) void this.activity(); }, 30_000 - (Date.now() - this.lastBusy));
        this.busyTimer.unref?.(); return true;
      }
      // Configuration can emit idle while its own HTTP response is being
      // applied. Do not make that application wait on a second config read.
      void this.activity(); return true;
    }
    if (frame.t === "request") {
      // Do not await delivery into a configuring worker: checkout preparation
      // may already be waiting on this very credential request.
      void this.request("github-token", {}).then(value => {
        const reply = CloudV2ControlFrameSchema.safeParse({ t: "reply", id: frame.id, ...value });
        return this.handlers!.frame(reply.success ? reply.data : { t: "refusal", id: frame.id, code: "github_token_unavailable" });
      }).catch(async error => {
        if (error instanceof HttpFailure && error.status === 401) this.failed(error);
        await this.handlers!.frame({ t: "refusal", id: frame.id, code: "github_token_unavailable" });
      });
      return true;
    }
    return false;
  }
  async dispose(): Promise<void> {
    if (this.stopped && !this.listening) return;
    this.stopped = true; clearTimeout(this.retry); clearTimeout(this.heartbeat); clearTimeout(this.busyTimer);
    this.releaseInitial();
    for (const controller of this.requests) controller.abort();
    await this.recovering;
    if (this.listening) { await this.listener.dispose(); this.listening = false; }
    this.handlers?.close();
  }
  async promptRequest(operation: PromptOperation, body: unknown, signal?: AbortSignal): Promise<unknown> {
    try { return await this.request(`prompts/${operation}`, body, signal, operation === "pull" ? 35_000 : 10_000); }
    catch (error) { if (error instanceof HttpFailure && error.status === 401) this.failed(error); throw error; }
  }
  reportTiming(record: CloudV2WorkerTiming): void {
    if (this.stopped || !this.registered || this.reportedTimings.has(record.phase)) return;
    const parsed = CloudV2WorkerTimingSchema.safeParse(record);
    if (!parsed.success) return;
    this.reportedTimings.add(record.phase);
    // At most one small request per startup phase, no retries or recovery side
    // effects. Older control planes return 404 without affecting the worker.
    void this.request("timing", parsed.data, undefined, 2000).catch(() => {});
  }
  async mcpAuthorization(id: string, force = false, signal?: AbortSignal): Promise<McpAuthorization> {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error("Invalid MCP server identity.");
    const reply = await this.request(`mcp/${id}/authorization`, { force }, signal, 35_000);
    if (!reply.headers || typeof reply.headers !== "object" || Array.isArray(reply.headers) ||
      Object.keys(reply.headers).length > 128 || Object.entries(reply.headers).some(([key, value]) =>
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof value !== "string" || value.length > 16384 || /[\r\n\0]/.test(value)) ||
      (reply.expiresAt !== undefined && (typeof reply.expiresAt !== "number" || !Number.isSafeInteger(reply.expiresAt) || reply.expiresAt <= 0)))
      throw new Error("Invalid MCP authorization response.");
    return { headers: reply.headers as Record<string, string>, ...(reply.expiresAt === undefined ? {} : { expiresAt: reply.expiresAt as number }) };
  }
  private recover(): void {
    if (this.stopped) return;
    if (this.recovering) { this.recoverRequested = true; return; }
    this.recovering = (async () => {
      if (!this.listening) {
        await this.listener.start(async frame => {
          // Hello marks the VM running before its HTTP response reaches us.
          // Hold an early dial until credentials and checkout are initialized;
          // GitHub replies still go directly to the configuring worker.
          if (!this.bootstrapped) {
            if (this.initialControls >= 64) throw new Error("Worker is initializing.");
            this.initialControls++;
            try { await this.initial; } finally { this.initialControls--; }
          }
          await this.control(frame);
        });
        this.listening = true;
      }
      if (!this.registered) {
        const reply = await this.request("hello", { protocol: CLOUD_V2_RELAY_PROTOCOL, runtimeSha256: this.options.runtimeSha256, bootId: this.bootId });
        this.registered = true;
        await this.handlers!.open();
        await this.configuration(reply);
      } else {
        // A committed POST may have lost its response. Complete that exact
        // request before taking a new snapshot or advancing its sequence.
        await this.historyFlight;
        await this.commitHistory();
        await this.configuration(await this.request("config"));
      }
      this.bootstrapped = true; this.releaseInitial();
      this.attempt = 0; this.options.onStatus?.("connected"); this.scheduleHeartbeat();
    })().catch(error => this.failed(error)).finally(() => {
      this.recovering = undefined;
      if (this.recoverRequested) { this.recoverRequested = false; this.recover(); }
    });
  }
  private async commitHistory(): Promise<void> {
    const pending = this.pendingHistory;
    if (!pending) return;
    const reply = await this.request("history", { ...pending.frame, bootId: this.bootId, sequence: pending.sequence });
    if (reply.sequence !== pending.sequence) throw new Error("Invalid history acknowledgement.");
    this.historySequence = pending.sequence; this.pendingHistory = undefined;
  }
  private async configuration(value: Record<string, unknown>): Promise<void> {
    const frame = CloudV2ControlFrameSchema.parse(value.config);
    if (frame.t !== "config") throw new Error("Invalid worker configuration.");
    await this.control(frame);
  }
  private async control(frame: CloudV2ControlFrame): Promise<void> {
    if (this.stopped) return;
    if (frame.t !== "config") { await this.applying; if (!this.stopped) await this.handlers!.frame(frame); return; }
    this.applying = this.applying.catch(() => {}).then(async () => {
      if (frame.workspace.id !== this.options.workspaceId) throw new Error("Invalid worker scope.");
      if (this.applied && BigInt(frame.loginRevision) < BigInt(this.applied.loginRevision)) return;
      if (this.applied?.loginRevision === frame.loginRevision && frame.agents.codex && this.applied.agents.codex &&
          frame.agents.codex.expiresAt < this.applied.agents.codex.expiresAt) return;
      await this.handlers!.frame(frame);
      this.applied = frame; this.configAt = Date.now();
    });
    await this.applying;
  }
  private async activity(): Promise<void> {
    if (this.stopped || !this.registered) return;
    this.activityRequested = true;
    if (this.activityFlight) return this.activityFlight;
    this.activityFlight = (async () => {
      do {
        this.activityRequested = false;
        if (!this.idle) this.lastBusy = Date.now();
        const reply = CloudV2WorkerActivityReplySchema.parse(await this.request("activity", { idle: this.idle }));
        if (["stopped", "failed", "deleting", "deleted"].includes(reply.state)) { this.options.onStatus?.("stopped"); return; }
        if (reply.loginRevision !== this.applied?.loginRevision || Date.now() - this.configAt >= 12 * 60 * 60_000)
          await this.configuration(await this.request("config"));
      } while (this.activityRequested && !this.stopped);
    })().catch(error => this.failed(error)).finally(() => { this.activityFlight = undefined; this.scheduleHeartbeat(); });
    return this.activityFlight;
  }
  private scheduleHeartbeat(): void {
    clearTimeout(this.heartbeat);
    if (this.stopped) return;
    this.heartbeat = setTimeout(() => { void this.activity(); }, 60_000);
    this.heartbeat.unref();
  }
  private failed(error: unknown): void {
    if (this.stopped) return;
    if (this.registered && error instanceof HttpFailure && error.status === 401) { this.options.onStatus?.("unauthorized"); return; }
    this.options.onStatus?.(this.registered ? "disconnected" : "credential-unavailable");
    if (this.retry) return;
    const delay = Math.min(this.options.retryMaxMs ?? 30_000, (this.options.retryBaseMs ?? 1000) * 2 ** Math.min(this.attempt++, 5));
    this.retry = setTimeout(() => { this.retry = undefined; this.recover(); }, delay);
    this.retry.unref();
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const token = await readWorkerToken(this.options.tokenFile ?? WORKER_TOKEN_FILE);
    if (this.stopped) throw new Error("Worker stopped.");
    const controller = new AbortController(); this.requests.add(controller);
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs); timer.unref();
    try {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload && Buffer.byteLength(payload) > CLOUD_V2_MAX_FRAME_BYTES) throw new Error("Worker payload too large.");
      const response = await (this.options.fetch ?? fetch)(new URL(`/v2/cloud/worker/${path}`, this.options.apiUrl), {
        method: payload === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Zeros-Worker-Boot": this.bootId,
          // An HTTP header is ignored by older control planes; adding a JSON
          // field would break their strict hello schema before configuration.
          "X-Zeros-Worker-Features": "prompt-outbox-v1,mcp-v1,workspace-setup-v1,checkout-v2" },
        ...(payload === undefined ? {} : { body: payload }), redirect: "error", signal: controller.signal,
      });
      if (!response.ok) { await response.body?.cancel(); throw new HttpFailure(response.status); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty worker control response.");
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > CLOUD_V2_MAX_FRAME_BYTES) { await reader.cancel(); throw new Error("Worker control response too large."); }
        chunks.push(chunk.value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid worker control response.");
      return value as Record<string, unknown>;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.requests.delete(controller); }
  }
}
