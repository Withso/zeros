import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { CloudAgentBootScopeSchema, type CloudAgentBootScope } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudLocalCommandMirrorBatchSchema, CloudLocalCommandMirrorAckSchema, cloudLocalCommandMirrorAckMatchesBatch,
  CloudLocalCommandWriterSealSchema, CloudLocalCommandWriterSealAckSchema, cloudLocalCommandWriterSealAckMatchesSeal,
  canonicalCloudLocalCommandWriterSealDescriptor,
  type CloudLocalCommandMirrorBatch, type CloudLocalCommandMirrorAck, type CloudLocalCommandWriterSealAck } from "@zeros/protocol/cloud-local-mirror";
import { CloudCommandRuntimeError } from "./cloud-command-client";
import type { CloudRuntimeAuthority } from "./cloud-runtime-registration";

const MirrorAuthorityScopeSchema = CloudAgentBootScopeSchema.pick({ organizationId: true, workspaceId: true,
  generation: true, engineInstanceId: true });
const _failureCodes = ["cloud_mirror_invalid_batch", "cloud_mirror_invalid_ack", "cloud_mirror_scope_changed",
  "cloud_mirror_timeout", "cloud_mirror_cancelled", "cloud_mirror_closed", "cloud_mirror_unavailable"] as const;
type FailureCode = typeof _failureCodes[number];
export class CloudLocalCommandMirrorError extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = "CloudLocalCommandMirrorError"; }
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
function abortRace<T>(task: Promise<T>, signal: AbortSignal, error: () => Error): Promise<T> {
  if (signal.aborted) { void task.catch(() => undefined); return Promise.reject(error()); }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(error()); };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    task.then(value => { cleanup(); resolve(value); }, cause => { cleanup(); reject(cause); });
  });
}

export type CloudLocalCommandMirrorQueue = {
  readonly scope: Readonly<CloudAgentBootScope>;
  peekMirrorBatch(): unknown | null;
  acknowledgeMirror(ack: CloudLocalCommandMirrorAck): void;
  mirrorDrained(): boolean;
};
type Options = {
  scope: CloudAgentBootScope; queue: CloudLocalCommandMirrorQueue;
  request(batch: CloudLocalCommandMirrorBatch, signal: AbortSignal): Promise<unknown>;
  /** Already-confirmed registration/boot authority only; never a CP read. */
  assertCurrent(): void;
  retryDelayMs?: number; requestTimeoutMs?: number;
};

/** Background replication only. Send/native dispatch never waits for this
 * driver. The FULL queue owns each assigned flight before transport begins;
 * unknown replies replay that identical flight, never a claim or prompt. */
export class CloudLocalCommandMirrorDriver {
  private readonly scope: CloudAgentBootScope;
  private readonly controller = new AbortController();
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private flight: Promise<void> | null = null;
  private lastFailure: FailureCode | null = null;
  constructor(private readonly options: Options) {
    const parsed = CloudAgentBootScopeSchema.safeParse(options.scope);
    if (!parsed.success || !isDeepStrictEqual(parsed.data, options.queue.scope)) throw new CloudLocalCommandMirrorError("cloud_mirror_scope_changed");
    this.scope = immutable(structuredClone(parsed.data));
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 1 || this.retryDelayMs > 5_000 ||
        !Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 10 || this.requestTimeoutMs > 15_000)
      throw new CloudLocalCommandMirrorError("cloud_mirror_unavailable");
  }
  private current(): void {
    if (this.controller.signal.aborted) throw new CloudLocalCommandMirrorError("cloud_mirror_closed");
    try { this.options.assertCurrent(); }
    catch { throw new CloudLocalCommandMirrorError("cloud_mirror_scope_changed"); }
  }
  private batch(raw: unknown): CloudLocalCommandMirrorBatch {
    const parsed = CloudLocalCommandMirrorBatchSchema.safeParse(raw);
    if (!parsed.success || parsed.data.bootId !== this.scope.bootId || parsed.data.writerEpoch !== this.scope.writerEpoch ||
        parsed.data.changes.some(change => change.actor &&
          (change.actor.scope.workspaceId !== this.scope.workspaceId || change.actor.scope.organizationId !== this.scope.organizationId ||
            (change.entry && ["queued", "dispatching"].includes(change.entry.state) &&
              (!isDeepStrictEqual(change.actor.scope, this.scope) || change.entry.generation !== this.scope.generation)))))
      throw new CloudLocalCommandMirrorError("cloud_mirror_invalid_batch");
    return immutable(structuredClone(parsed.data));
  }
  private async send(batch: CloudLocalCommandMirrorBatch): Promise<unknown> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.requestTimeoutMs);
    const signal = AbortSignal.any([this.controller.signal, timeout.signal]);
    try {
      return await abortRace(Promise.resolve().then(() => { this.current(); return this.options.request(batch, signal); }), signal,
        () => new CloudLocalCommandMirrorError(this.controller.signal.aborted ? "cloud_mirror_closed" : "cloud_mirror_timeout"));
    } finally { clearTimeout(timer); }
  }
  private async pump(): Promise<void> {
    const deadline = performance.now() + 30_000;
    for (;;) {
      this.current();
      const raw = this.options.queue.peekMirrorBatch();
      if (raw === null) {
        if (!this.options.queue.mirrorDrained()) throw new CloudLocalCommandMirrorError("cloud_mirror_unavailable");
        this.lastFailure = null; return;
      }
      const batch = this.batch(raw);
      let reply: unknown;
      for (;;) {
        this.current();
        try { reply = await this.send(batch); break; }
        catch (error) {
          if (error instanceof CloudLocalCommandMirrorError) throw error;
          if (error instanceof CloudCommandRuntimeError && ["engine_authority_rejected", "command_context_changed", "command_conflict"].includes(error.code))
            throw new CloudLocalCommandMirrorError("cloud_mirror_scope_changed");
          if (error instanceof CloudCommandRuntimeError && ["command_response_invalid", "invalid_command"].includes(error.code))
            throw new CloudLocalCommandMirrorError("cloud_mirror_invalid_ack");
          if (performance.now() >= deadline) throw new CloudLocalCommandMirrorError("cloud_mirror_timeout");
          let timer: ReturnType<typeof setTimeout>;
          try { await abortRace(new Promise<void>(resolve => { timer = setTimeout(resolve, this.retryDelayMs); }), this.controller.signal,
            () => new CloudLocalCommandMirrorError("cloud_mirror_closed")); }
          finally { clearTimeout(timer!); }
        }
      }
      this.current();
      const ack = CloudLocalCommandMirrorAckSchema.safeParse(reply);
      if (!ack.success || !cloudLocalCommandMirrorAckMatchesBatch(ack.data, batch)) throw new CloudLocalCommandMirrorError("cloud_mirror_invalid_ack");
      try { this.options.queue.acknowledgeMirror(ack.data); }
      catch { throw new CloudLocalCommandMirrorError("cloud_mirror_unavailable"); }
    }
  }
  private start(): Promise<void> {
    if (this.flight) return this.flight;
    const flight = this.pump().catch(error => {
      const failure = error instanceof CloudLocalCommandMirrorError ? error : new CloudLocalCommandMirrorError("cloud_mirror_unavailable");
      this.lastFailure = failure.code; throw failure;
    }).finally(() => { if (this.flight === flight) this.flight = null; });
    this.flight = flight; return flight;
  }
  notify(): void { if (!this.controller.signal.aborted) void this.start().catch(() => undefined); }
  async flush(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    this.current();
    if (options.signal?.aborted) throw new CloudLocalCommandMirrorError("cloud_mirror_cancelled");
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new CloudLocalCommandMirrorError("cloud_mirror_timeout");
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = AbortSignal.any([this.controller.signal, timeout.signal, ...(options.signal ? [options.signal] : [])]);
    try { await abortRace(this.start(), signal, () => new CloudLocalCommandMirrorError(this.controller.signal.aborted ?
      "cloud_mirror_closed" : options.signal?.aborted ? "cloud_mirror_cancelled" : "cloud_mirror_timeout")); }
    finally { clearTimeout(timer); }
  }
  inspect() { return { active: this.flight !== null, closed: this.controller.signal.aborted, lastFailure: this.lastFailure }; }
  close(): void { this.controller.abort(); }
}

/** Private CP mirror ingress. Authority is supplied only by registration;
 * no endpoint/bearer or actor selector is accepted from the assigned batch. */
export async function requestCloudLocalCommandMirror(authority: CloudRuntimeAuthority, batch: unknown,
  signal: AbortSignal, requestFetch: typeof fetch = fetch): Promise<CloudLocalCommandMirrorAck> {
  const parsed = CloudLocalCommandMirrorBatchSchema.safeParse(batch);
  if (!parsed.success) throw new CloudCommandRuntimeError("invalid_command");
  return requestPrivateCommandProjection(authority, "/internal/v2/cloud-workspaces/engine/commands/mirror", { batch: parsed.data }, signal,
    value => {
      const ack = CloudLocalCommandMirrorAckSchema.safeParse(value);
      if (!ack.success || !cloudLocalCommandMirrorAckMatchesBatch(ack.data, parsed.data)) throw new CloudCommandRuntimeError("command_response_invalid");
      return ack.data;
    }, requestFetch);
}

/** Separate stop/checkpoint transport. The registration wrapper and FULL
 * producer own live boot/native-drain checks; this verifies exact wire/ACK. */
export async function requestCloudLocalCommandSeal(authority: CloudRuntimeAuthority, raw: unknown,
  signal: AbortSignal, requestFetch: typeof fetch = fetch): Promise<CloudLocalCommandWriterSealAck> {
  const parsed = CloudLocalCommandWriterSealSchema.safeParse(raw);
  if (!parsed.success) throw new CloudCommandRuntimeError("invalid_command");
  const seal = parsed.data;
  if (seal.scope.organizationId !== authority.organizationId || seal.scope.workspaceId !== authority.workspaceId ||
      seal.scope.generation !== authority.generation || seal.scope.engineInstanceId !== authority.engineInstanceId)
    throw new CloudCommandRuntimeError("command_context_changed");
  if (createHash("sha256").update(canonicalCloudLocalCommandWriterSealDescriptor(seal)).digest("hex") !== seal.sha256)
    throw new CloudCommandRuntimeError("command_conflict");
  return requestPrivateCommandProjection(authority, "/internal/v2/cloud-workspaces/engine/commands/seal", { seal }, signal,
    value => {
      const ack = CloudLocalCommandWriterSealAckSchema.safeParse(value);
      if (!ack.success || !cloudLocalCommandWriterSealAckMatchesSeal(ack.data, seal)) throw new CloudCommandRuntimeError("command_response_invalid");
      return ack.data;
    }, requestFetch);
}

async function requestPrivateCommandProjection<T>(authority: CloudRuntimeAuthority,
  path: "/internal/v2/cloud-workspaces/engine/commands/mirror" | "/internal/v2/cloud-workspaces/engine/commands/seal",
  payload: object, signal: AbortSignal, validate: (value: unknown) => T, requestFetch: typeof fetch): Promise<T> {
  let endpoint: URL;
  try {
    const parent = new URL(authority.heartbeatEndpoint);
    if (parent.protocol !== "https:" || parent.username || parent.password || parent.search || parent.hash ||
        !/^zwh_[A-Za-z0-9_-]{43}$/.test(authority.heartbeatToken) ||
        !MirrorAuthorityScopeSchema.safeParse({ organizationId: authority.organizationId, workspaceId: authority.workspaceId,
          engineInstanceId: authority.engineInstanceId, generation: authority.generation }).success) throw new Error();
    endpoint = new URL(path, parent);
  } catch { throw new CloudCommandRuntimeError("engine_authority_rejected"); }
  const { organizationId, workspaceId, generation, engineInstanceId } = authority;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  if (requestSignal.aborted) throw new CloudCommandRuntimeError("command_service_unavailable");
  let response: Response;
  try { response = await requestFetch(endpoint, { method: "POST", redirect: "error",
    signal: requestSignal, headers: { "content-type": "application/json", authorization: `Bearer ${authority.heartbeatToken}` },
    body: JSON.stringify({ organizationId, workspaceId, generation, engineInstanceId, ...payload }) }); }
  catch { throw new CloudCommandRuntimeError("command_service_unavailable"); }
  const maximum = response.ok ? 16 * 1024 : 1024;
  if (!response.body || Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel().catch(() => undefined); throw new CloudCommandRuntimeError("command_response_invalid");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await abortRace(reader.read(), requestSignal,
      () => new CloudCommandRuntimeError("command_service_unavailable")); if (done) break;
      size += value.byteLength; if (size > maximum) throw new Error(); chunks.push(value); }
    const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error();
    if (!response.ok) {
      const code = (document as { error?: unknown }).error;
      const allowed = ["engine_authority_rejected", "command_conflict", "command_context_changed", "invalid_command", "command_limit"];
      throw new CloudCommandRuntimeError(typeof code === "string" && allowed.includes(code) ? code : "command_service_unavailable");
    }
    if (Object.keys(document).length !== 1) throw new Error();
    return validate((document as { result?: unknown }).result);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CloudCommandRuntimeError) throw error;
    throw new CloudCommandRuntimeError("command_response_invalid");
  } finally { reader.releaseLock(); }
}
