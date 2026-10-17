import { WebSocket } from "ws";

/**
 * S2 engine uplink client (`contracts/s2-uplink.md`, frozen 1.0.0): the
 * cloud engine's WebSocket to `realtime`. Cloud workspaces only; a Local
 * engine never constructs this class. The HTTP heartbeat remains the lease
 * owner in this release — the uplink carries push traffic and presence and
 * is parked (never redialed) when the control plane says the credential or
 * identity is definitively rejected (4401/4403), the rollout flag is off
 * (4404) or no common protocol exists (4426); every other loss redials with
 * full-jitter backoff (250 ms base, 30 s cap, reset after 60 s connected).
 *
 * The engine mirrors the wire constants here and never imports the
 * control-plane package at runtime; the contract tests in
 * `__tests__/cloud-engine-uplink.test.ts` run this client against the real
 * `CloudEngineUplinkServer` so the mirrors cannot drift apart.
 */

const UPLINK_SUBPROTOCOL = "zeros-uplink.v1";
const UPLINK_PROTOCOL = { min: 1, max: 1 } as const;
const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
const MAX_BINARY_FRAME_BYTES = 256 * 1024 + 8;
const HELLO_TIMEOUT_MS = 10_000;
const ACK_DELAY_MS = 250;
const DEFAULT_PING_INTERVAL_MS = 20_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 30_000;
/** Full jitter can draw near zero; a tight redial is never correct. */
const BACKOFF_FLOOR_MS = 100;
const BACKOFF_RESET_AFTER_MS = 60_000;
const OUTBOX_MAX_BYTES = 2 * 1024 * 1024;
const OUTBOX_MAX_FRAMES = 2_000;

const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  internalError: 1011,
  frameInvalid: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  disabled: 4404,
  pingTimeout: 4408,
  superseded: 4409,
  protocolUnsupported: 4426,
  backpressure: 4429,
  draining: 4503,
} as const;

export type EngineUplinkIdentity = Readonly<{
  workspaceId: string;
  organizationId: string;
  generation: number;
  engineInstanceId: string;
  bootId: string;
}>;

/** Mirrors the CP `auth.*` payloads (S1 shapes). */
export type EngineUplinkJwk = Readonly<{
  kty: "OKP"; crv: "Ed25519"; x: string; kid: string; use: "sig"; alg: "EdDSA";
  zeros_state?: "next" | "current" | "retiring";
}>;
export type EngineUplinkEpochSet = Readonly<{
  wa?: number; wr?: number;
  members?: Readonly<Record<string, number>>;
  accounts?: Readonly<Record<string, number>>;
  devices?: Readonly<Record<string, number>>;
}>;
export type EngineUplinkRevocation = Readonly<{ kind: "session" | "device"; id: string; until: number }>;
export type EngineUplinkAuthSync = Readonly<{
  syncId: string;
  epochs: EngineUplinkEpochSet & { wa: number; wr: number };
  revocations: readonly EngineUplinkRevocation[];
  authCursor: string;
  complete: boolean;
}>;
export type EngineUplinkAuthDelta = Readonly<{
  epochs: EngineUplinkEpochSet;
  revocations: readonly EngineUplinkRevocation[];
  authCursor: string;
}>;
export type EngineUplinkCapability = Readonly<{ token: string; expiresAtMs: number }>;

/** The frozen S1 application points the uplink drives. Track B's shared
 * capability verifier binds these to signature and epoch checks; the uplink
 * itself never verifies tokens. */
export interface EngineUplinkAuthSink {
  /** The last applied cursor, offered in `sys.hello` (`authCursor`). */
  authCursor(): string | undefined;
  /** `auth.keys` replaces the key set. */
  applyKeys(keys: readonly EngineUplinkJwk[]): Promise<void>;
  /** `auth.sync` snapshot, maximum-merged (S1); resolves once durable. */
  applySync(sync: EngineUplinkAuthSync): Promise<void>;
  /** `auth.epochs` delta, maximum-merged (S1); resolves once durable. */
  applyDelta(delta: EngineUplinkAuthDelta): Promise<void>;
  /** `auth.capability`: a fresh `zeros:api` engine token, reissued at 60%. */
  holdCapability(capability: EngineUplinkCapability): void;
}

/** In-memory S1 verifier state: the maximum-merge epoch table, the key set,
 * revocations and the latest engine capability. Nothing here verifies a
 * signature; the shared verifier module (track B) reads this state. */
export class EngineUplinkAuthState implements EngineUplinkAuthSink {
  private keySet: readonly EngineUplinkJwk[] = [];
  private wa = 0;
  private wr = 0;
  private readonly members = new Map<string, number>();
  private readonly accounts = new Map<string, number>();
  private readonly devices = new Map<string, number>();
  private readonly revocations = new Map<string, number>();
  private cursor: string | undefined;
  private capability: EngineUplinkCapability | null = null;

  authCursor(): string | undefined { return this.cursor; }
  keys(): readonly EngineUplinkJwk[] { return this.keySet; }
  engineCapability(): EngineUplinkCapability | null { return this.capability; }
  epochOf(kind: "me" | "ac" | "dk", subject: string): number | undefined {
    return (kind === "me" ? this.members : kind === "ac" ? this.accounts : this.devices).get(subject);
  }
  workspaceEpochs(): { wa: number; wr: number } { return { wa: this.wa, wr: this.wr } }
  revokedUntil(kind: "session" | "device", id: string): number | undefined {
    return this.revocations.get(`${kind}:${id}`);
  }

  applyKeys(keys: readonly EngineUplinkJwk[]): Promise<void> {
    this.keySet = [...keys];
    return Promise.resolve();
  }

  applySync(sync: EngineUplinkAuthSync): Promise<void> {
    this.merge(sync.epochs, sync.revocations);
    this.cursor = sync.authCursor;
    return Promise.resolve();
  }

  applyDelta(delta: EngineUplinkAuthDelta): Promise<void> {
    this.merge(delta.epochs, delta.revocations);
    this.cursor = delta.authCursor;
    return Promise.resolve();
  }

  holdCapability(capability: EngineUplinkCapability): void {
    this.capability = capability;
  }

  /** S1: merge is a maximum and never lowers, including a `complete`
   * snapshot; revocations are a union dropped only at their own `until`. */
  private merge(epochs: EngineUplinkEpochSet, revocations: readonly EngineUplinkRevocation[]): void {
    if (epochs.wa !== undefined) this.wa = Math.max(this.wa, epochs.wa);
    if (epochs.wr !== undefined) this.wr = Math.max(this.wr, epochs.wr);
    const mergeInto = (table: Map<string, number>, entries: Readonly<Record<string, number>> | undefined) => {
      for (const [subject, epoch] of Object.entries(entries ?? {}))
        table.set(subject, Math.max(table.get(subject) ?? 0, epoch));
    };
    mergeInto(this.members, epochs.members);
    mergeInto(this.accounts, epochs.accounts);
    mergeInto(this.devices, epochs.devices);
    const nowMs = Date.now();
    for (const revocation of revocations) {
      const key = `${revocation.kind}:${revocation.id}`;
      this.revocations.set(key, Math.max(this.revocations.get(key) ?? 0, revocation.until));
    }
    for (const [key, until] of this.revocations) if (until <= nowMs) this.revocations.delete(key);
  }
}

export type EngineUplinkReadiness = Readonly<{
  ready: boolean;
  phase: "starting" | "preparing" | "ready" | "degraded" | "stopping";
  reason?: string;
}>;

export type EngineUplinkParkReason = "disabled" | "unauthenticated" | "forbidden" | "protocol_unsupported";

/** The `ws` surface the client uses; injectable for tests. */
export interface EngineUplinkSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

/** A pushed credential-control revision (S2 cred channel). */
export type EngineUplinkCredentialRevision = Readonly<{ kind: "agent-controls" | "repository"; revision: number }>;
/** The outcome the engine reports back in `cred.ack` after its exchange. */
export type EngineUplinkCredentialAck = Readonly<{ result: "applied" | "failed"; code?: string }>;

export type CloudEngineUplinkOptions = {
  endpoint: string;
  /** The heartbeat credential; the uplink authenticates with it once per connection. */
  token: string;
  identity: EngineUplinkIdentity;
  runtimeVersion: string;
  /** Additive feature flags offered in the hello; `cred.v1` negotiates the
   * credential-control push. */
  features?: readonly string[];
  auth: EngineUplinkAuthSink;
  /** Current engine readiness, sent as `status.ready` once the gate opens. */
  readiness?: () => EngineUplinkReadiness;
  /** Applies a pushed credential-control revision (runs the engine's
   * credential exchange). Pushes coalesce to the latest revision per kind
   * while one is in flight; the result is reported as `cred.ack`. */
  onCredentialRevision?: (revision: EngineUplinkCredentialRevision) => Promise<EngineUplinkCredentialAck>;
  /** The credential kinds the engine consumes. A push of any other kind is
   * acked `failed`/`cred_kind_unsupported` without calling the handler and
   * without recording it applied, so a future `repository` push is an
   * explicit signal, never silently swallowed. Defaults to
   * `["agent-controls"]`. */
  credentialKinds?: readonly EngineUplinkCredentialRevision["kind"][];
  /** Reports flips of `established`. The engine drops the credential poll
   * back to its fast fallback cadence the moment the gate closes instead of
   * waiting out an armed slow timer. */
  onEstablishedChange?: (established: boolean) => void;
  /** 4409: re-verify registration authority before the redial (S2 rule 4). */
  onReverifyAuthority?: () => void;
  /** Terminal close: the client parks and never redials (HTTP stays up). */
  onParked?: (reason: EngineUplinkParkReason) => void;
  metric?: (name: string, valueMs: number) => void;
  now?: () => number;
  random?: () => number;
  openSocket?: (url: string, protocols: string[], headers: Record<string, string>) => EngineUplinkSocket;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  backoffResetAfterMs?: number;
  helloTimeoutMs?: number;
};

type ReliableFrame = Readonly<{ s: number; text: string; bytes: number }>;

type Frame = { t: string; s?: number; a?: number; d?: Record<string, unknown> };

export class CloudEngineUplinkClient {
  private readonly options: CloudEngineUplinkOptions;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly openSocket: NonNullable<CloudEngineUplinkOptions["openSocket"]>;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly backoffResetAfterMs: number;
  private readonly helloTimeout: number;
  private started = false;
  private stopped = false;
  private parked: EngineUplinkParkReason | null = null;
  private failures = 0;
  private dialTimer: ReturnType<typeof setTimeout> | null = null;
  private handoffTimer: ReturnType<typeof setTimeout> | null = null;
  private connection: Connection | null = null;
  /** Set while a drain handoff dial is in flight beside `connection`. */
  private handoff: Connection | null = null;
  /** The lineage offered on the next dial; dropped on any terminal close. */
  private resume: { token: string; lastReceivedSeq: number } | null = null;
  /** Engine-side reliable sequence state; survives a resume, resets when the
   * server answers `resumed: false`. */
  private outbox: ReliableFrame[] = [];
  private outboxBytes = 0;
  private outboxSent = 0;
  private outboxAcked = 0;
  private inboundContiguous = 0;
  /** Credential push: latest queued and latest acked-applied revision per
   * kind. Survives reconnects — revisions are monotonic per binding, so the
   * high-water stays valid across a lineage reset. */
  private readonly credQueue = new Map<string, number>();
  private readonly credApplied = new Map<string, number>();
  private credFlight: Promise<void> | null = null;

  constructor(options: CloudEngineUplinkOptions) {
    this.options = options;
    this.clock = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.openSocket = options.openSocket ??
      ((url, protocols, headers) => new WebSocket(url, protocols, {
        headers, perMessageDeflate: false, maxPayload: MAX_BINARY_FRAME_BYTES,
      }) as unknown as EngineUplinkSocket);
    this.backoffBaseMs = options.backoffBaseMs ?? BACKOFF_BASE_MS;
    this.backoffCapMs = options.backoffCapMs ?? BACKOFF_CAP_MS;
    this.backoffResetAfterMs = options.backoffResetAfterMs ?? BACKOFF_RESET_AFTER_MS;
    this.helloTimeout = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  }

  /** Null while dialing; "parked" means a terminal close, not a backoff. */
  get state(): "off" | "dialing" | "connected" | "backoff" | "parked" {
    if (!this.started) return "off";
    if (this.parked) return "parked";
    if (this.connection?.welcomed) return "connected";
    if (this.connection || this.handoff) return "dialing";
    return "backoff";
  }

  get parkReason(): EngineUplinkParkReason | null { return this.parked; }

  /** True while a connection's gate is open (its first auth.capability
   * arrived): pushed cred.revision frames flow, so the credential-control
   * poll can back off to its slow fallback cadence. */
  get established(): boolean { return this.computeEstablished(); }
  private lastEstablished = false;

  /** A pushed cred.revision failed to apply. While outstanding, established
   * stays false so the fallback poll (500 ms) retries what the CP does not
   * re-push; cleared by the next successful exchange, push or poll. */
  private credFailedOutstanding = false;

  private computeEstablished(): boolean {
    const connection = this.connection;
    return connection?.gateOpen === true
      && connection.features.has("cred.v1") // no negotiated push channel: poll fast
      && !this.credFailedOutstanding;
  }

  /** A credential-control exchange succeeded outside a push (the fallback
   * poll): clears a failed-push-outstanding mark so `established` recovers
   * without waiting for the CP to push again. */
  noteCredentialExchangeSucceeded(): void {
    if (!this.credFailedOutstanding) return;
    this.credFailedOutstanding = false;
    this.noteEstablished();
  }

  /** @internal Recompute `established` at every input change (gate open,
   * connection loss, stop) and report a flip exactly once. */
  noteEstablished(): void {
    const value = this.computeEstablished();
    if (value === this.lastEstablished) return;
    this.lastEstablished = value;
    this.options.onEstablishedChange?.(value);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.dial(0, false);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of [this.dialTimer, this.handoffTimer]) if (timer) clearTimeout(timer);
    this.dialTimer = this.handoffTimer = null;
    this.connection?.initiateClose(CLOSE.normal, "engine_stopping");
    this.handoff?.initiateClose(CLOSE.normal, "engine_stopping");
    this.connection = this.handoff = null;
    this.resume = null;
    this.noteEstablished();
  }

  /** Reliable engine→CP frame (`status.ready`, later `cred.ack`, …). Frames
   * are buffered until acked and retransmitted on a resume; overflow drops
   * the connection so both sides resync on the next hello. A frame leaves
   * the socket only once the connection's gate is open (its first
   * auth.capability): anything earlier would hit the server's
   * frame_before_welcome or cross frozen handshake step 4, so pre-gate
   * frames buffer and flush with the gate retransmit. */
  sendReliable(t: string, d: Record<string, unknown>): void {
    if (!this.started || this.stopped || this.parked) return;
    const s = this.outboxSent + 1;
    const text = JSON.stringify({ t, s, a: this.inboundContiguous, d });
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_CONTROL_FRAME_BYTES ||
        this.outbox.length + 1 > OUTBOX_MAX_FRAMES || this.outboxBytes + bytes > OUTBOX_MAX_BYTES) {
      console.error(`[engine-uplink] reliable frame ${t} exceeds the buffer; resyncing`);
      this.connection?.initiateClose(CLOSE.normal, "resync");
      return;
    }
    this.outbox.push(Object.freeze({ s, text, bytes }));
    this.outboxBytes += bytes;
    this.outboxSent = s;
    if (this.connection?.gateOpen) this.connection.sendRaw(text);
  }

  /** Pushes the current readiness as `status.ready` (track E: the engine
   * marks ready when its inputs change, not only at the gate). Safe at any
   * time: pre-gate the frame buffers and flushes with the gate retransmit;
   * before start or after park it is a no-op. */
  reportReadiness(): void {
    if (!this.options.readiness) return;
    this.sendReliable("status.ready", { ...this.options.readiness() });
  }

  /** @internal A validated `cred.revision` arrived on the wire. Applies
   * coalesce to the latest revision per kind while one is in flight, and
   * each applied revision is acked exactly once (a re-push of an applied
   * revision — the resync case — acks without re-running the exchange). */
  pushCredentialRevision(revision: EngineUplinkCredentialRevision): void {
    const handler = this.options.onCredentialRevision;
    if (!handler) return; // nothing consumes pushes yet; the poll keeps working
    if (!(this.options.credentialKinds ?? ["agent-controls"]).includes(revision.kind)) {
      this.sendReliable("cred.ack",
        { kind: revision.kind, revision: revision.revision, result: "failed", code: "cred_kind_unsupported" });
      return;
    }
    if (revision.revision <= (this.credApplied.get(revision.kind) ?? 0)) {
      this.sendReliable("cred.ack", { kind: revision.kind, revision: revision.revision, result: "applied" });
      return;
    }
    this.credQueue.set(revision.kind, Math.max(revision.revision, this.credQueue.get(revision.kind) ?? 0));
    this.credFlight ??= this.drainCredentialRevisions(handler)
      .finally(() => { this.credFlight = null; });
  }

  private async drainCredentialRevisions(
    handler: NonNullable<CloudEngineUplinkOptions["onCredentialRevision"]>,
  ): Promise<void> {
    for (;;) {
      const next = this.credQueue.entries().next().value;
      if (!next) return;
      const [kind, revision] = next;
      this.credQueue.delete(kind);
      let outcome: EngineUplinkCredentialAck;
      try {
        outcome = await handler({ kind: kind as EngineUplinkCredentialRevision["kind"], revision });
      } catch {
        outcome = { result: "failed", code: "cred_fetch_failed" };
      }
      // A failed revision is not recorded: a later re-push retries the
      // exchange (and the fallback poll converges regardless).
      if (outcome.result === "applied") {
        this.credApplied.set(kind, Math.max(revision, this.credApplied.get(kind) ?? 0));
        if (this.credFailedOutstanding) { this.credFailedOutstanding = false; this.noteEstablished(); }
      } else {
        this.credFailedOutstanding = true; // drops the poll to its fast cadence until recovery
        this.noteEstablished();
      }
      this.sendReliable("cred.ack", {
        kind, revision, result: outcome.result, ...(outcome.code ? { code: outcome.code } : {}),
      });
    }
  }

  /* ---- connection-facing internals (the only dial/park/count site) ---- */

  /** @internal */ now(): number { return this.clock(); }
  /** @internal */ get socketFactory(): NonNullable<CloudEngineUplinkOptions["openSocket"]> { return this.openSocket; }
  /** @internal */ get helloTimeoutMs(): number { return this.helloTimeout; }
  /** @internal */ get config(): CloudEngineUplinkOptions { return this.options; }
  /** @internal */ get resumeOffer(): { token: string; lastReceivedSeq: number } | null {
    if (this.resume) return this.resume;
    // A drain handoff dials while the drained connection is still open; it
    // must offer that connection's token so the server moves the lineage
    // (resumed: true) instead of superseding it into a fresh resync.
    const current = this.connection;
    if (current?.welcomed && current.resumeToken)
      return { token: current.resumeToken, lastReceivedSeq: this.inboundContiguous };
    return null;
  }
  /** @internal */ get inboundAck(): number { return this.inboundContiguous; }

  /** @internal A reliable CP frame landed. Duplicates after a replay (the
   * drain-handoff case: a frame in flight on the drained socket also lands
   * on the replacement's retransmit) are acked again but never re-applied;
   * only a true gap redials for the retransmit. */
  acceptInbound(s: number): "new" | "duplicate" | "gap" {
    if (!Number.isSafeInteger(s) || s < 1) return "gap";
    if (s <= this.inboundContiguous) return "duplicate";
    if (s !== this.inboundContiguous + 1) return "gap";
    this.inboundContiguous = s;
    return "new";
  }

  /** @internal */ outboxPending(): boolean { return this.outbox.length > 0; }

  /** @internal Piggybacked cumulative ack from the server. */
  ackOutbound(a: number): void {
    if (!Number.isSafeInteger(a) || a < 0 || a > this.outboxSent) return;
    if (a <= this.outboxAcked) return;
    this.outboxAcked = a;
    let drop = 0;
    while (drop < this.outbox.length && this.outbox[drop]!.s <= a) {
      this.outboxBytes -= this.outbox[drop]!.bytes;
      drop += 1;
    }
    if (drop) this.outbox = this.outbox.slice(drop);
  }

  /** @internal Retransmit unacked reliable frames after a resume (contract
   * step 4: both sides retransmit once the capability lands). */
  retransmit(connection: Connection): void {
    for (const frame of this.outbox) connection.sendRaw(frame.text);
  }

  /** @internal A `resumed: false` welcome starts a new lineage: unacked
   * frames are dropped (feature modules resync current state instead). */
  resetLineage(): void {
    this.outbox = [];
    this.outboxBytes = 0;
    this.outboxSent = 0;
    this.outboxAcked = 0;
    this.inboundContiguous = 0;
  }

  /** @internal */
  welcomed(connection: Connection, resumed: boolean): void {
    this.options.metric?.("engine_uplink_hello_ms", this.clock() - connection.openedAtMs);
    this.resume = null;
    // A refused resume starts a new lineage: drop the old lineage's unacked
    // frames (feature modules resync current state instead). Pre-gate
    // buffered frames on a connection that offered nothing are part of the
    // fresh lineage — never transmitted, correctly numbered from s=1 — so
    // they survive to flush at the gate.
    if (!resumed && connection.offeredResume) this.resetLineage();
    if (connection.handoff) {
      this.handoff = null;
      const old = this.connection;
      this.connection = connection;
      this.noteEstablished(); // the replacement's gate is closed until its capability lands
      // Drain handoff: the replacement is up; retire the drained uplink.
      if (old && old !== connection) old.initiateClose(CLOSE.normal, "drain_handoff");
    }
  }

  /** @internal Simulates an unannounced network loss (failover tests). */
  dropConnection(): void {
    this.connection?.drop();
  }

  /** @internal */
  drain(reconnectAfterMs: number): void {
    // Open the replacement (offering the resume token) before the drained
    // uplink's deadline; once welcomed it supersedes this one (S2 drain).
    this.dial(Math.max(0, reconnectAfterMs), true);
  }

  /** @internal */
  closed(connection: Connection, code: number, initiated: boolean): void {
    if (connection.welcomed && this.clock() - connection.welcomedAtMs >= this.backoffResetAfterMs) this.failures = 0;
    if (connection === this.handoff) {
      this.handoff = null;
      if (initiated) return;
      this.failures += 1;
      // A refused or lost handoff retries as a handoff while the drained
      // uplink is still open (the deadline may be 30 s away); once it is
      // gone the main slot redials instead.
      this.dial(this.backoffDelay(), this.connection !== null);
      return;
    }
    if (connection !== this.connection) return;
    this.connection = null;
    this.noteEstablished(); // the gate is closed from here to the next capability
    if (!this.started || this.stopped || this.parked) return;
    if (connection.draining && code === CLOSE.superseded) {
      // The expected end of a drain handoff: the replacement's resume took
      // the lineage, so nothing here redials, re-verifies or saves a token.
      return;
    }
    if (connection.welcomed && connection.resumeToken) {
      // Keep the lineage for a resume; the server retains it for 120 s.
      this.resume = { token: connection.resumeToken, lastReceivedSeq: this.inboundContiguous };
    }
    switch (code) {
      case CLOSE.unauthenticated:
        return this.park("unauthenticated");
      case CLOSE.forbidden:
        return this.park("forbidden");
      case CLOSE.disabled:
        return this.park("disabled");
      case CLOSE.protocolUnsupported:
        return this.park("protocol_unsupported");
      case CLOSE.superseded:
        // S2 rule 4: re-verify registration authority, then redial. The old
        // lineage was revoked with the supersede, so the redial is fresh.
        this.resume = null;
        this.resetLineage();
        this.options.onReverifyAuthority?.();
        break;
      default:
        // 1000/1001/1006/1011/4400/4408/4429/4503: backoff and resume.
        break;
    }
    this.failures += 1;
    // The dial guard yields to an in-flight drain handoff, so scheduling is
    // always safe here.
    this.scheduleBackoff();
  }

  private scheduleBackoff(): void {
    this.dial(this.backoffDelay(), false);
  }

  private backoffDelay(): number {
    const cap = Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** Math.min(this.failures, 16));
    return Math.max(BACKOFF_FLOOR_MS, Math.floor(this.random() * cap));
  }

  private park(reason: EngineUplinkParkReason): void {
    this.parked = reason;
    this.resume = null;
    this.resetLineage();
    this.handoff?.initiateClose(CLOSE.normal, "parked");
    this.handoff = null;
    this.options.onParked?.(reason);
  }

  private dial(delayMs: number, handoff: boolean): void {
    if (!this.started || this.stopped || this.parked) return;
    // One dial per slot; the main slot also yields to an in-flight handoff.
    if (handoff ? (this.handoff !== null || this.handoffTimer !== null)
      : (this.connection !== null || this.dialTimer !== null || this.handoff !== null || this.handoffTimer !== null)) return;
    const open = () => {
      if (!this.started || this.stopped || this.parked) return;
      if (handoff ? this.handoff !== null
        : (this.connection !== null || this.handoff !== null)) return;
      const connection = new Connection(this, handoff);
      if (handoff) this.handoff = connection;
      else this.connection = connection;
      connection.open();
    };
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        if (handoff) this.handoffTimer = null;
        else this.dialTimer = null;
        open();
      }, delayMs);
      timer.unref?.();
      if (handoff) this.handoffTimer = timer;
      else this.dialTimer = timer;
      return;
    }
    open();
  }
}

class Connection {
  readonly openedAtMs: number;
  welcomed = false;
  welcomedAtMs = 0;
  resumeToken: string | null = null;
  /** Opens on this connection's first auth.capability (frozen step 4);
   * reliable engine frames send live only while it is open. */
  gateOpen = false;
  /** The welcome's negotiated extension set (`sys.welcome.features`). */
  features: ReadonlySet<string> = new Set();
  /** The hello offered a resume token: a `resumed: false` welcome then
   * means the server lost that lineage, and its unacked frames reset. */
  offeredResume = false;
  /** Received `sys.drain`: a handoff dial owns this connection's lineage. */
  draining = false;
  private socket: EngineUplinkSocket | null = null;
  private pingIntervalMs = DEFAULT_PING_INTERVAL_MS;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReceivedAtMs: number;
  private initiated = false;
  private finished = false;

  constructor(private readonly uplink: CloudEngineUplinkClient, readonly handoff: boolean) {
    this.openedAtMs = uplink.now();
    this.lastReceivedAtMs = this.openedAtMs;
  }

  open(): void {
    const options = this.uplink.config;
    let socket: EngineUplinkSocket;
    try {
      socket = this.uplink.socketFactory(options.endpoint, [UPLINK_SUBPROTOCOL], {
        authorization: `Bearer ${options.token}`,
      });
    } catch {
      this.finish(CLOSE.goingAway, false);
      return;
    }
    this.socket = socket;
    socket.on("error", () => {});
    // The hello timeout covers the whole pre-welcome phase — TCP/TLS, the
    // upgrade and the server's welcome — so a black-holed dial (ws applies
    // no handshake timeout once constructed here) cannot wait forever.
    this.helloTimer = setTimeout(() => {
      console.warn("[engine-uplink] no sys.welcome inside the hello timeout; redialing");
      this.terminate(CLOSE.goingAway);
    }, this.uplink.helloTimeoutMs);
    this.helloTimer.unref?.();
    socket.on("open", () => {
      this.lastReceivedAtMs = this.uplink.now();
      const offer = this.uplink.resumeOffer;
      this.offeredResume = offer !== null;
      this.send({
        t: "sys.hello",
        d: {
          protocol: UPLINK_PROTOCOL,
          runtimeVersion: options.runtimeVersion,
          ...options.identity,
          features: [...(options.features ?? [])],
          lastJournalSeq: 0,
          ...(offer ? { resume: offer } : {}),
          ...(options.auth.authCursor() ? { authCursor: options.auth.authCursor() } : {}),
        },
      });
    });
    socket.on("message", (data, isBinary) => this.receive(data, isBinary));
    socket.on("close", (code) => this.finish(code, this.initiated));
  }

  sendRaw(text: string): void {
    if (this.finished || this.socket?.readyState !== 1) return;
    this.socket.send(text);
  }

  initiateClose(code: number, reason: string): void {
    if (this.finished) return;
    this.initiated = true;
    this.stopTimers();
    try {
      if (this.socket && this.socket.readyState <= 1) this.socket.close(code, reason);
    } catch {
      // The close event still finishes the connection.
    }
    const force = setTimeout(() => this.terminate(code), 5_000);
    force.unref?.();
  }

  /** @internal Abnormal loss: the close event (1006) finishes the connection. */
  drop(): void {
    try {
      this.socket?.terminate();
    } catch {
      // The close event still finishes the connection.
    }
  }

  /** The socket is unusable without a close handshake (timeout, liveness). */
  private terminate(code: number): void {
    try {
      this.socket?.terminate();
    } catch {
      // Termination is best-effort; finish below is the authority.
    }
    this.finish(code, false);
  }

  private finish(code: number, initiated: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.stopTimers();
    this.uplink.closed(this, code, initiated);
  }

  private receive(data: Buffer, isBinary: boolean): void {
    if (this.finished) return;
    this.lastReceivedAtMs = this.uplink.now();
    if (isBinary) {
      // Relay channels arrive with C4; no channel can exist yet. The
      // contract's non-fatal answer is sys.error relay_channel_unknown.
      if (data.byteLength >= 8 && data[0] === 0x01)
        this.send({ t: "sys.error", d: {
          code: "relay_channel_unknown", message: "no relay channel exists for this chunk",
          fatal: false, channel: data.readUInt32BE(4),
        } });
      return;
    }
    if (data.byteLength > MAX_CONTROL_FRAME_BYTES) return this.initiateClose(CLOSE.frameInvalid, "frame_too_large");
    let frame: Frame;
    try {
      frame = JSON.parse(data.toString("utf8"));
    } catch {
      return this.initiateClose(CLOSE.frameInvalid, "frame_invalid");
    }
    if (!frame || typeof frame.t !== "string") return this.initiateClose(CLOSE.frameInvalid, "frame_invalid");
    if (frame.a !== undefined) this.uplink.ackOutbound(frame.a);
    if (frame.s !== undefined) {
      // Reliable CP→engine frames are exactly-once across a resume. A gap
      // is repaired by the server's retransmit, so redial with the token;
      // a duplicate is acked again but never re-applied.
      const inbound = this.uplink.acceptInbound(frame.s);
      if (inbound === "gap") return this.initiateClose(CLOSE.normal, "sequence_gap");
      this.scheduleAck();
      if (inbound === "duplicate") return;
    }
    switch (frame.t) {
      case "sys.welcome":
        return this.onWelcome(frame.d ?? {});
      case "sys.pong":
        return;
      case "sys.drain":
        return this.onDrain(frame.d ?? {});
      case "sys.error":
        console.warn(`[engine-uplink] sys.error ${String(frame.d?.code ?? "unknown")}${frame.d?.fatal === true ? " (fatal)" : ""}`);
        return;
      case "auth.keys":
        return this.enqueueAuth(() => this.applyKeys(frame.d ?? {}));
      case "auth.sync":
        return this.enqueueAuth(() => this.applySync(frame.d ?? {}));
      case "auth.epochs":
        return this.enqueueAuth(() => this.applyEpochs(frame.d ?? {}));
      case "auth.capability":
        return this.onCapability(frame.d ?? {});
      case "cred.revision": {
        const d = frame.d ?? {};
        if ((d.kind !== "agent-controls" && d.kind !== "repository") ||
            typeof d.revision !== "number" || !Number.isSafeInteger(d.revision) || d.revision < 1)
          return this.initiateClose(CLOSE.frameInvalid, "frame_invalid");
        this.uplink.pushCredentialRevision({ kind: d.kind, revision: d.revision });
        return;
      }
      default:
        // Unknown types on unsequenced channels are ignored; unknown
        // sequenced types are acked and ignored (the ack was scheduled).
        return;
    }
  }

  private onWelcome(d: Record<string, unknown>): void {
    if (this.welcomed) return this.initiateClose(CLOSE.frameInvalid, "welcome_repeated");
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    if (typeof d.resumeToken !== "string" || typeof d.protocol !== "number" || d.protocol < 1)
      return this.initiateClose(CLOSE.frameInvalid, "welcome_invalid");
    if (d.features !== undefined &&
        (!Array.isArray(d.features) || d.features.some(feature => typeof feature !== "string")))
      return this.initiateClose(CLOSE.frameInvalid, "welcome_invalid");
    this.welcomed = true;
    this.welcomedAtMs = this.uplink.now();
    this.resumeToken = d.resumeToken;
    this.features = new Set((d.features as string[] | undefined) ?? []);
    this.pingIntervalMs = clampPingInterval(d.pingIntervalMs);
    this.uplink.welcomed(this, d.resumed === true);
    this.pingTimer = setInterval(() => this.send({ t: "sys.ping", d: { ts: this.uplink.now() } }), this.pingIntervalMs);
    this.livenessTimer = setInterval(() => {
      if (this.uplink.now() - this.lastReceivedAtMs > 2 * this.pingIntervalMs + 5_000) {
        console.warn("[engine-uplink] no frame within two ping intervals; redialing");
        this.terminate(CLOSE.pingTimeout);
      }
    }, Math.min(5_000, this.pingIntervalMs));
    this.pingTimer.unref?.();
    this.livenessTimer.unref?.();
  }

  /** Auth applications serialize per connection in frame order: the sink
   * resolves once durable, so without a chain an `auth.applied` could reach
   * the CP (opening its gate) while keys are still landing, or a delta
   * could apply under a slower snapshot. A rejected link must not wedge the
   * chain — the apply methods handle failures themselves (close + redial,
   * which re-sends keys and the snapshot from the cursor). */
  private authChain: Promise<void> = Promise.resolve();

  private enqueueAuth(work: () => Promise<void>): void {
    this.authChain = this.authChain.then(work).catch(() => {});
  }

  private async applyKeys(d: Record<string, unknown>): Promise<void> {
    if (!Array.isArray(d.keys)) return this.initiateClose(CLOSE.frameInvalid, "frame_invalid");
    try {
      await this.uplink.config.auth.applyKeys(d.keys as readonly EngineUplinkJwk[]);
    } catch {
      // The next connection re-sends keys and the snapshot from the cursor.
      this.initiateClose(CLOSE.normal, "auth_apply_failed");
    }
  }

  private async applySync(d: Record<string, unknown>): Promise<void> {
    if (typeof d.syncId !== "string" || typeof d.authCursor !== "string" || !isRecord(d.epochs) || !Array.isArray(d.revocations))
      return this.initiateClose(CLOSE.frameInvalid, "frame_invalid");
    const started = this.uplink.now();
    try {
      await this.uplink.config.auth.applySync(d as unknown as EngineUplinkAuthSync);
    } catch {
      return this.initiateClose(CLOSE.normal, "auth_apply_failed");
    }
    this.uplink.config.metric?.("engine_uplink_auth_apply_ms", this.uplink.now() - started);
    this.send({ t: "auth.applied", d: { syncId: d.syncId, authCursor: this.uplink.config.auth.authCursor() ?? d.authCursor } });
  }

  private async applyEpochs(d: Record<string, unknown>): Promise<void> {
    if (typeof d.authCursor !== "string" || !isRecord(d.epochs) || !Array.isArray(d.revocations))
      return this.initiateClose(CLOSE.frameInvalid, "frame_invalid");
    try {
      await this.uplink.config.auth.applyDelta(d as unknown as EngineUplinkAuthDelta);
    } catch {
      return this.initiateClose(CLOSE.normal, "auth_apply_failed");
    }
    this.send({ t: "auth.applied", d: { authCursor: this.uplink.config.auth.authCursor() ?? d.authCursor } });
  }

  private onCapability(d: Record<string, unknown>): void {
    if (typeof d.token !== "string" || typeof d.expiresAtMs !== "number" || d.audience !== "zeros:api")
      return this.initiateClose(CLOSE.frameInvalid, "frame_invalid");
    this.uplink.config.auth.holdCapability({ token: d.token, expiresAtMs: d.expiresAtMs });
    // Step 4 (retransmit the unacked outbox, else report readiness) runs on
    // the connection's FIRST capability; renewals only hold the new token.
    if (this.gateOpen) return;
    this.gateOpen = true;
    this.uplink.noteEstablished();
    if (this.uplink.outboxPending()) {
      this.uplink.retransmit(this);
    } else if (this.uplink.config.readiness) {
      this.uplink.sendReliable("status.ready", { ...this.uplink.config.readiness() });
    }
  }

  private onDrain(d: Record<string, unknown>): void {
    const reconnectAfterMs = typeof d.reconnectAfterMs === "number" ? d.reconnectAfterMs : 0;
    this.draining = true;
    this.uplink.drain(reconnectAfterMs);
  }

  private scheduleAck(): void {
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.send({ t: "sys.ack", a: this.uplink.inboundAck });
    }, ACK_DELAY_MS);
    this.ackTimer.unref?.();
  }

  private send(frame: { t: string; a?: number; d?: Record<string, unknown> }): void {
    this.sendRaw(JSON.stringify(frame));
  }

  private stopTimers(): void {
    for (const timer of [this.helloTimer, this.ackTimer]) if (timer) clearTimeout(timer);
    for (const timer of [this.pingTimer, this.livenessTimer]) if (timer) clearInterval(timer);
    this.helloTimer = this.ackTimer = this.pingTimer = this.livenessTimer = null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The CP may set 10–30 s; clamp anything else into that envelope. */
function clampPingInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PING_INTERVAL_MS;
  return Math.min(30_000, Math.max(10_000, Math.floor(value)));
}
