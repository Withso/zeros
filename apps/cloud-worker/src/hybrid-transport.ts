import { NotifyUserWorkerRequestSchema, type NotifyUserWorkerRequest } from "@zeros/protocol/notify-user";
import type { NotifyUserDelivery } from "./notify-user/service";
import { randomInt, randomUUID } from "node:crypto";
import type { LocalCommandInput } from "@zeros/protocol/local-commands";
import { requestLocalCommand } from "./local-commands/client";
import { CLOUD_WORKER_FEATURES } from "./worker-features";
import { CLOUD_V2_MAX_FRAME_BYTES, CLOUD_V2_RELAY_PROTOCOL, CloudV2ControlFrameSchema, CloudV2WorkerActivityReplySchema,
  CloudV2WorkerFrameSchema, CloudV2WorkerTimingSchema, type CloudV2WorkerTiming, type CloudV2ControlFrame, type CloudV2WorkerFrame, CloudV2ContextErrorCodeSchema } from "@zeros/protocol/cloud-v2-relay";
import { InboundBridge } from "./inbound-bridge";
import { readWorkerToken, WORKER_TOKEN_FILE } from "./worker-token";
import type { PromptOperation, Transport, TransportHandlers } from "./transport";
import type { McpAuthorization } from "./mcp/gateway";
import { CloudGithubCheckoutSchema, type CloudGithubCheckout } from "@zeros/protocol/cloud-github-pr";
import { mcpFailure, mcpFailureError } from "./mcp/failure";
import { CloudGithubUnavailableReasonSchema, type CloudGithubUnavailableReason } from "@zeros/protocol/cloud-github-connection";
import { GITHUB_HTTP_TIMEOUT_MS } from "./credentials/github-failure";
import { CloudEnvironmentReportSchema, CloudV2SetupStatusSchema, type CloudEnvironmentReport, type CloudV2SetupStatus } from "@zeros/protocol/cloud-v2-relay";
import { CloudRuntimeUpdateReplySchema, type CloudRuntimeUpdateRequest, type CloudRuntimeUpdateReply } from "@zeros/protocol/cloud-v2-relay";

type ConfigFrame = Extract<CloudV2ControlFrame, { t: "config" }>;
export type HybridStatus = "connected" | "disconnected" | "credential-unavailable" | "unauthorized" | "stopped" | "protocol-error";
interface Options {
  apiUrl: string; workspaceId: string; runtimeSha256: string; tokenFile?: string;
  runtimeHandoff?: { id: string; bootId: string };
  publicKeys?: readonly string[]; publicKeysFile?: string; port?: number; fetch?: typeof fetch;
  retryBaseMs?: number; retryMaxMs?: number; onStatus?: (status: HybridStatus) => void;
  /** The safety heartbeat's phase (epoch ms); random per boot by default. Tests pin it so no heartbeat lands mid-test. */
  heartbeatPhase?: number;
  /** Worker journal lines from the inbound bridge (sync sockets): short ids and codes only. */
  log?: (line: string) => void;
}
class HttpFailure extends Error {
  constructor(readonly status: number, readonly code?: "mcp_auth_required", readonly githubReason?: CloudGithubUnavailableReason,
    /** Slice B context routes: the closed refusal code (actor_changed, agent_login_required, …) and its agent. */
    readonly contextCode?: string, readonly agent?: string) { super("Worker control request failed."); }
}
const isContextPath = (path: string) => /^(turn|terminal|client|bootstrap)-lease$|^execution-leases\//.test(path);
/** Routes whose refusals carry the closed context codes: the context routes, and an activated begin (actor_busy while a previous person's cleanup holds the chat). */
const decodesContext = (path: string) => isContextPath(path) || path === "prompts/begin";

/** Live frames use authenticated loopback sockets. Durable control traffic
 * uses HTTPS independently, so it survives the final app disconnect. */
export class HybridTransport implements Transport {
  readonly bootId: string;
  private runtimeReady = false;
  private readonly listener: InboundBridge;
  private handlers?: TransportHandlers;
  private listening = false;
  private registered = false;
  private stopped = false;
  private recovering?: Promise<void>;
  private recoverRequested = false;
  private bootstrapped = false;
  private checkoutFailed = false;
  private pendingEnvironment?: CloudEnvironmentReport;
  private environmentFailed = false;
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
  private readonly pulsePhase: number;
  private readonly promptPolls = new Set<AbortController>();
  private historySequence = 0;
  private pendingHistory?: { sequence: number; frame: Extract<CloudV2WorkerFrame, { t: "history" }> };
  private historyFlight: Promise<boolean> = Promise.resolve(true);
  private requests = new Set<AbortController>();
  private readonly reportedTimings = new Set<CloudV2WorkerTiming["phase"]>();

  constructor(private readonly options: Options) {
    this.pulsePhase = options.heartbeatPhase ?? randomInt(60_000);
    this.bootId = options.runtimeHandoff?.bootId ?? randomUUID();
    let url: URL;
    try { url = new URL(options.apiUrl); } catch { throw new Error("Invalid worker API URL"); }
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid worker API URL");
    if (!/^[a-f0-9]{64}$/.test(options.runtimeSha256)) throw new Error("Invalid worker runtime pin");
    this.listener = new InboundBridge({ workspaceId: options.workspaceId, bootId: this.bootId,
      onPushChange: () => {
        for (const controller of this.promptPolls) controller.abort();
        // Reconcile once after subscribing, and on loss of the last carrier.
        void this.handlers?.frame({ t: "prompts" }).catch(() => {});
      },
      ...(options.publicKeys ? { publicKeys: options.publicKeys } : {}), ...(options.publicKeysFile ? { publicKeysFile: options.publicKeysFile } : {}),
      ...(options.port === undefined ? {} : { port: options.port }), ...(options.log ? { log: options.log } : {}) });
  }
  start(handlers: TransportHandlers): void {
    if (this.handlers || this.stopped) return;
    this.handlers = handlers; this.recover();
  }
  async send(frame: CloudV2WorkerFrame, options?: { timeoutMs: number }): Promise<boolean> {
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
      // Activated: the context names whose credential this is; without it the control plane can answer for nobody.
      void this.request("github-token", { ...(frame.purpose ? { purpose: frame.purpose } : {}),
        ...(frame.failedTokenSha256 ? { failedTokenSha256: frame.failedTokenSha256 } : {}), ...(frame.contextId ? { contextId: frame.contextId } : {}) }, undefined,
        Math.min(GITHUB_HTTP_TIMEOUT_MS, options?.timeoutMs ?? GITHUB_HTTP_TIMEOUT_MS)).then(value => {
        const reply = CloudV2ControlFrameSchema.safeParse({ t: "reply", id: frame.id, ...value });
        return this.handlers!.frame(reply.success ? reply.data : { t: "refusal", id: frame.id, code: "github_token_unavailable" });
      }).catch(async error => {
        if (error instanceof HttpFailure && error.status === 401) this.failed(error);
        await this.handlers!.frame({ t: "refusal", id: frame.id, code: error instanceof HttpFailure ? error.githubReason ?? "unavailable" : "unavailable" });
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
  private localCommandsInFlight = 0;
  get localCommandsPending(): number { return this.localCommandsInFlight; }
  async localCommand(request: { chatId: string; executionId: string; input: LocalCommandInput; contextId?: string }, signal: AbortSignal) {
    this.localCommandsInFlight++;
    try {
      return await requestLocalCommand((method, path, body, timeoutMs, callSignal) =>
        this.request(path, method === "POST" ? body ?? {} : undefined, callSignal, timeoutMs), request, signal);
    } finally { this.localCommandsInFlight--; }
  }
  async retireLocalCommandSender(request: { chatId: string; executionId: string }): Promise<void> {
    await this.request("local-commands/retire-sender", request, undefined, 5_000);
  }
  async promptRequest(operation: PromptOperation, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    if (operation === "pull") this.promptPolls.add(controller);
    try {
      if (operation === "pull" && (body as { waitMs?: unknown } | null)?.waitMs !== 0)
        await this.listener.waitForPromptFallback(lifetime);
      return await this.request(`prompts/${operation}`, body, lifetime, operation === "pull" ? 35_000 : 10_000);
    }
    catch (error) { if (error instanceof HttpFailure && error.status === 401) this.failed(error); throw error; }
    finally { this.promptPolls.delete(controller); }
  }
  async runtimeUpdate(input: CloudRuntimeUpdateRequest, signal?: AbortSignal): Promise<CloudRuntimeUpdateReply> {
    return CloudRuntimeUpdateReplySchema.parse(await this.request("runtime", input, signal, input.op === "prepare" ? 310_000 : input.op === "ready" ? 30_000 : 10_000));
  }
  async readyRuntime(): Promise<void> {
    if (!this.options.runtimeHandoff || this.runtimeReady) return;
    const reply = await this.runtimeUpdate({ op: "ready", id: this.options.runtimeHandoff.id });
    if (reply.status !== "completed" || reply.id !== this.options.runtimeHandoff.id) throw new Error("Runtime readiness is unsettled.");
    this.runtimeReady = true;
  }
  async reportGithubCheckout(value: CloudGithubCheckout): Promise<void> {
    const input = CloudGithubCheckoutSchema.parse(value);
    const reply = await this.request("github-checkout", input);
    if (reply.sequence !== input.sequence) throw new Error("Invalid GitHub checkout acknowledgement.");
  }
  async reportEnvironment(value: CloudEnvironmentReport, signal?: AbortSignal): Promise<void> {
    const report = CloudEnvironmentReportSchema.parse(value);
    if (this.pendingEnvironment && JSON.stringify(report) !== JSON.stringify(this.pendingEnvironment)) throw new Error("Environment status is unsettled.");
    this.pendingEnvironment = report;
    try {
      const reply = await this.request("environment", report, signal);
      if (reply.sequence !== report.sequence) throw new Error("Invalid environment acknowledgement.");
      this.pendingEnvironment = undefined;
      this.environmentFailed = report.state === "failed";
      if (this.environmentFailed) this.options.onStatus?.("stopped");
    } catch (error) {
      if (signal?.aborted) this.pendingEnvironment = undefined;
      throw error;
    }
  }
  /** Slice B: leases, renew and retirement (worker bearer + boot, like every control request). */
  contextRequest(path: string, body: unknown): Promise<unknown> {
    if (!isContextPath(path)) return Promise.reject(new Error("Not a context route."));
    return this.request(path, body);
  }

  async notifyUser(request: NotifyUserWorkerRequest, signal?: AbortSignal): Promise<NotifyUserDelivery> {
    const body = NotifyUserWorkerRequestSchema.parse(request);
    // The same id and body on every try: a replay is inert on the server.
    for (let attempt = 0; ; attempt++) {
      try { await this.request("notifications", body, signal, 10_000); return "sent"; }
      catch (error) {
        if (error instanceof HttpFailure) {
          if (error.status === 409) return "already_notified";
          if (error.status === 429) return "rate_limited";
          if (error.status >= 400 && error.status < 500 && error.status !== 408) throw error;
        }
        if (attempt >= 2 || signal?.aborted) throw error;
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 500 * 2 ** attempt); timer.unref?.(); });
      }
    }
  }
  async reportSetup(status: CloudV2SetupStatus): Promise<void> {
    await this.request("setup", CloudV2SetupStatusSchema.parse(status), undefined, 10_000);
  }
  async reportCheckoutFailure(): Promise<void> {
    this.checkoutFailed = true;
    try {
      const reply = await this.request("checkout-failed", {});
      if (reply.ok !== true) throw new Error("Invalid checkout failure acknowledgement.");
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 404) { this.checkoutFailed = false; return; }
      throw error;
    }
    this.options.onStatus?.("stopped");
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
  async mcpAuthorization(id: string, force = false, signal?: AbortSignal, contextId?: string): Promise<McpAuthorization> {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error("Invalid MCP server identity.");
    let reply: Record<string, unknown>;
    // Team sharing: an activated context's server is authorized as that context's person.
    try { reply = await this.request(`mcp/${id}/authorization`, contextId ? { force, contextId } : { force }, signal, 35_000); }
    catch (error) {
      // This 401 authenticates the worker, not the user's MCP account.
      if (error instanceof HttpFailure && error.status === 401) {
        this.failed(error);
        throw mcpFailureError({ source: "mcp", serverId: id, reason: "unreachable" });
      }
      throw mcpFailureError(mcpFailure(id, error));
    }
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
      if (this.pendingEnvironment) await this.reportEnvironment(this.pendingEnvironment);
      if (this.environmentFailed) return;
      if (this.checkoutFailed) {
        await this.reportCheckoutFailure();
        if (this.checkoutFailed) return;
      }
      if (!this.listening) {
        await this.listener.start(async frame => {
          // Hold early viewers until local services are published. Stop must
          // reach the owner that can cancel an in-flight configuration.
          if (!this.bootstrapped && frame.t !== "stop") {
            if (this.initialControls >= 64) throw new Error("Worker is initializing.");
            this.initialControls++;
            try { await this.initial; } finally { this.initialControls--; }
          }
          await this.control(frame);
        });
        this.listening = true;
      }
      if (!this.registered) {
        const reply = await this.request("hello", { protocol: CLOUD_V2_RELAY_PROTOCOL, runtimeSha256: this.options.runtimeSha256, bootId: this.bootId }, undefined, 30_000);
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
    if (frame.t === "stop") { await this.handlers!.frame(frame); return; }
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
        const pushed = await this.listener.activity(this.idle);
        const reply = pushed ?? CloudV2WorkerActivityReplySchema.parse(await this.request("activity", { idle: this.idle }));
        if (pushed?.prompts) await this.handlers!.frame({ t: "prompts" });
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
    // A random boot phase spreads safety reads without extending the minute
    // repair bound or turning the socket's ping cadence into database work.
    const elapsed = ((Date.now() - this.pulsePhase) % 60_000 + 60_000) % 60_000;
    this.heartbeat = setTimeout(() => { void this.activity(); }, 60_000 - elapsed);
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
    const deadline = Date.now() + timeoutMs;
    if (this.stopped) throw new Error("Worker stopped.");
    const controller = new AbortController(); this.requests.add(controller);
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs); timer.unref();
    try {
      const token = await new Promise<string>((resolve, reject) => {
        const cancelled = () => { controller.signal.removeEventListener("abort", cancelled); reject(new Error("Worker request cancelled.")); };
        if (controller.signal.aborted) { cancelled(); return; }
        controller.signal.addEventListener("abort", cancelled, { once: true });
        void readWorkerToken(this.options.tokenFile ?? WORKER_TOKEN_FILE).then(value => {
          controller.signal.removeEventListener("abort", cancelled); resolve(value);
        }, error => { controller.signal.removeEventListener("abort", cancelled); reject(error); });
      });
      controller.signal.throwIfAborted();
      if (this.stopped) throw new Error("Worker stopped.");
      if (deadline <= Date.now()) throw new Error("Worker request timed out.");
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload && Buffer.byteLength(payload) > CLOUD_V2_MAX_FRAME_BYTES) throw new Error("Worker payload too large.");
      const response = await (this.options.fetch ?? fetch)(new URL(`/v2/cloud/worker/${path}`, this.options.apiUrl), {
        method: payload === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Zeros-Worker-Boot": this.bootId,
          // An HTTP header is ignored by older control planes; adding a JSON
          // field would break their strict hello schema before configuration.
          "X-Zeros-Worker-Features": CLOUD_WORKER_FEATURES,
          ...(this.options.runtimeHandoff ? { "X-Zeros-Runtime-Handoff": this.options.runtimeHandoff.id } : {}) },
        ...(payload === undefined ? {} : { body: payload }), redirect: "error", signal: controller.signal,
      });
      if (!response.ok) {
        let code: "mcp_auth_required" | undefined, githubReason: CloudGithubUnavailableReason | undefined, contextCode: string | undefined, agent: string | undefined;
        if ((path.startsWith("mcp/") && response.status === 409) || path === "github-token" || decodesContext(path)) {
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = []; let bytes = 0;
          try {
            while (reader) {
              const chunk = await reader.read(); if (chunk.done) break;
              bytes += chunk.value.byteLength; if (bytes > 8192) break;
              chunks.push(chunk.value);
            }
            if (bytes <= 8192) {
              const error = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error;
              if (path.startsWith("mcp/") && error?.code === "mcp_auth_required") code = "mcp_auth_required";
              const parsed = CloudV2ContextErrorCodeSchema.safeParse(error?.code);
              if (decodesContext(path) && parsed.success) {
                contextCode = parsed.data;
                if (error?.agent === "codex" || error?.agent === "claude" || error?.agent === "cursor") agent = error.agent;
              }
              if (path === "github-token" && error?.code === "github_token_unavailable") {
                const reason = CloudGithubUnavailableReasonSchema.safeParse(error.reason);
                if (reason.success) githubReason = reason.data;
              }
            }
          } catch { /* Only the confirmed code can name a provider sign-in problem. */ }
          finally { await reader?.cancel(); }
        } else await response.body?.cancel();
        throw new HttpFailure(response.status, code, githubReason, contextCode, agent);
      }
      if (response.status === 204) { await response.body?.cancel(); return {}; }
      const reader = response.body?.getReader();
      // An accepted (202) answer may carry no body, as notify-user-v1's does.
      if (!reader) { if (response.status === 202) return {}; throw new Error("Empty worker control response."); }
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > CLOUD_V2_MAX_FRAME_BYTES) { await reader.cancel(); throw new Error("Worker control response too large."); }
        chunks.push(chunk.value);
      }
      if (response.status === 202 && bytes === 0) return {};
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid worker control response.");
      return value as Record<string, unknown>;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.requests.delete(controller); }
  }
}
