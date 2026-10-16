import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { hostname } from "node:os";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { MAX_DRAIN_MS } from "./drain.js";
import { InboundSequence, ReliableOutbox, ResumeStore } from "./resume.js";
import type { UplinkSecurityAlerts } from "./uplink-alerts.js";
import type { EngineCapabilityIssuer, UplinkAuthSource } from "./uplink-auth-source.js";
import type { UplinkAuthority, UplinkIdentity } from "./uplink-authority.js";
import type { UplinkPhase, UplinkPresenceSnapshot, UplinkPresenceWriter } from "./uplink-presence.js";
import {
  UPLINK_ACK_DELAY_MS,
  UPLINK_CLOSE,
  UPLINK_DEFAULT_PING_INTERVAL_MS,
  UPLINK_HELLO_TIMEOUT_MS,
  UPLINK_MAX_SOCKET_PAYLOAD_BYTES,
  UPLINK_MAX_CONTROL_FRAME_BYTES,
  UPLINK_PATH,
  UPLINK_SUBPROTOCOL,
  UPLINK_WATERMARK_INTERVAL_MS,
  UplinkActivityReportSchema,
  UplinkAuthAppliedSchema,
  UplinkEnvelopeSchema,
  UplinkHelloSchema,
  UplinkPingSchema,
  UplinkStatusReadySchema,
  UplinkStatusReportSchema,
  negotiateUplinkProtocol,
  parseUplinkRelayChunk,
  uplinkBearerToken,
  type UplinkActivityReport,
  type UplinkAuthDelta,
  type UplinkRelayChunk,
  type UplinkHello,
  type UplinkStatusReport,
} from "./uplink-protocol.js";
import type { RolloutFlagReader } from "../rollout-flags.js";

/** The rollout feed the uplink reads: `realtime_uplink` per organization,
 * plus change notifications so a flag turned off closes open uplinks. */
export type UplinkRolloutFlags = RolloutFlagReader & { onChange?(listener: () => void): () => void };

/** What a feature module sees of one admitted uplink. */
export interface UplinkSession {
  readonly connectionId: string;
  readonly identity: UplinkIdentity;
  readonly features: ReadonlySet<string>;
  /** Queues a reliable frame. Frames queued before the `auth` exchange
   * completes are held and sent after it. False once the session closed. */
  sendReliable(t: string, d: Record<string, unknown>): boolean;
}

/** Feature modules (credential push, relay) plug in here instead of growing
 * the connection state machine. `onOpen` runs once the `auth` exchange and
 * the resume retransmit finished; with `resumed: false` the module resyncs. */
export interface UplinkExtension {
  readonly feature: string;
  onOpen?(session: UplinkSession, resumed: boolean): void;
  /** True when the frame type belongs to this extension; a thrown error or
   * `"invalid"` closes the uplink with 4400. Sequenced (reliable) and
   * unsequenced engine→CP frames both arrive here, in receive order;
   * unsequenced types are never replayed on a resume. */
  onFrame?(session: UplinkSession, t: string, d: Record<string, unknown>): boolean | "invalid";
  /** True when the relay chunk's channel belongs to this extension; a
   * thrown error closes the uplink with 4400. Unclaimed channels get a
   * non-fatal `sys.error relay_channel_unknown` (contract error codes). */
  onRelayChunk?(session: UplinkSession, chunk: UplinkRelayChunk): boolean;
  onClose?(session: UplinkSession): void;
}

export type UplinkPresenceView = Readonly<{
  connectionId: string;
  protocol: number;
  features: readonly string[];
  connectedAtMs: number;
  lastSeenAtMs: number;
  authApplied: boolean;
  ready: boolean;
  phase: UplinkPhase | null;
  report: UplinkStatusReport | null;
  activity: UplinkActivityReport | null;
}>;

/** Reliable-channel state that survives a resume on this instance. `auth`
 * and `relay` state is per connection and never part of it. */
type Lineage = {
  outbox: ReliableOutbox;
  inbound: InboundSequence;
  ready: boolean;
  phase: UplinkPhase | null;
  report: UplinkStatusReport | null;
  activity: UplinkActivityReport | null;
};

export type UplinkMetric = "capability_revocation_push_ms" | "uplink_auth_sync_ms";

export type UplinkServerOptions = {
  authority: UplinkAuthority;
  authSource: UplinkAuthSource;
  capabilities: EngineCapabilityIssuer;
  flags: UplinkRolloutFlags;
  realtimeInstance: string;
  presence?: UplinkPresenceWriter;
  alerts?: UplinkSecurityAlerts;
  extensions?: readonly UplinkExtension[];
  metric?: (name: UplinkMetric, valueMs: number) => void;
  pingIntervalMs?: number;
  helloTimeoutMs?: number;
  authAppliedTimeoutMs?: number;
  ackDelayMs?: number;
  watermarkIntervalMs?: number;
  /** Periodic authority re-read; notifications trigger it sooner. */
  authorityRecheckMs?: number;
  capabilityRetryMs?: number;
  resumeRetentionMs?: number;
  maxConnections?: number;
  maxPendingHandshakes?: number;
  /** Bytes the socket may buffer before the uplink closes with 4429. */
  maxSocketBufferBytes?: number;
  now?: () => number;
  random?: () => number;
};

type ResolvedOptions = Required<Omit<UplinkServerOptions, "presence" | "alerts" | "metric" | "resumeRetentionMs">> &
  Pick<UplinkServerOptions, "presence" | "alerts" | "metric">;

export type UplinkCounters = {
  admitted: number;
  resumed: number;
  refused: Record<string, number>;
  closed: Record<string, number>;
};

const ADMISSION_BURST = 500;
const ADMISSION_REFILL_MS = 2;
const CHURN_WINDOW_MS = 10 * 60_000;
const CHURN_LIMIT = 3;

/** Server side of the S2 engine uplink (docs/cloud-workspace/contracts/s2-uplink.md,
 * frozen 1.0.0). Liveness, readiness and activity live in memory; presence
 * reaches the database only on transitions plus a coarse watermark. */
export class CloudEngineUplinkServer {
  private readonly wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: UPLINK_MAX_SOCKET_PAYLOAD_BYTES,
    handleProtocols: protocols => protocols.has(UPLINK_SUBPROTOCOL) ? UPLINK_SUBPROTOCOL : false,
  });
  private readonly all = new Set<UplinkConnection>();
  private readonly current = new Map<string, UplinkConnection>();
  private readonly supersedes = new Map<string, number[]>();
  readonly resume: ResumeStore<Lineage>;
  private pendingHandshakes = 0;
  private admissionTokens = ADMISSION_BURST;
  private lastRefill = performance.now();
  private closed = false;
  private draining = false;
  readonly counters: UplinkCounters = { admitted: 0, resumed: 0, refused: {}, closed: {} };
  readonly options: ResolvedOptions;

  constructor(options: UplinkServerOptions) {
    this.options = {
      pingIntervalMs: UPLINK_DEFAULT_PING_INTERVAL_MS,
      helloTimeoutMs: UPLINK_HELLO_TIMEOUT_MS,
      authAppliedTimeoutMs: 10_000,
      ackDelayMs: UPLINK_ACK_DELAY_MS,
      watermarkIntervalMs: UPLINK_WATERMARK_INTERVAL_MS,
      authorityRecheckMs: 60_000,
      capabilityRetryMs: 30_000,
      maxConnections: 20_000,
      maxPendingHandshakes: 256,
      maxSocketBufferBytes: 4 * 1024 * 1024,
      now: Date.now,
      random: Math.random,
      extensions: [],
      ...options,
    };
    if (!/^[A-Za-z0-9:._-]{1,128}$/.test(this.options.realtimeInstance)) throw new Error("invalid realtime instance id");
    const ping = this.options.pingIntervalMs;
    if (!Number.isSafeInteger(ping) || ping < 10_000 || ping > 30_000) throw new Error("uplink ping interval must be 10-30 s");
    this.resume = new ResumeStore<Lineage>({ now: this.options.now,
      ...(options.resumeRetentionMs !== undefined ? { retentionMs: options.resumeRetentionMs } : {}) });
    this.stopFlagListener = this.options.flags.onChange?.(() => this.applyRollout()) ?? null;
  }

  private readonly stopFlagListener: (() => void) | null;

  /** Organization ids reach the flag reader only in canonical lowercase
   * form (the hello schema enforces it), so any other spelling reads off. */
  uplinkEnabled(organizationId: string): boolean {
    return this.options.flags.enabled(organizationId, "realtime_uplink");
  }

  /** A flag turned off closes that organization's uplinks with 4404; the
   * engines stop dialing and keep the HTTP heartbeat and credential poll. */
  applyRollout(): void {
    for (const connection of [...this.all]) {
      const organizationId = connection.identity?.organizationId;
      if (organizationId && !this.uplinkEnabled(organizationId))
        connection.close(UPLINK_CLOSE.disabled, "uplink_disabled", { park: false });
    }
  }

  get size(): number { return this.all.size; }

  /** In-process view for the API and workers sharing this process. */
  presence(engineInstanceId: string): UplinkPresenceView | null {
    return this.current.get(engineInstanceId)?.view() ?? null;
  }

  /** The admitted session for an engine if this instance owns its uplink. */
  session(engineInstanceId: string): UplinkSession | null {
    return this.current.get(engineInstanceId)?.session ?? null;
  }

  /** Engine instances whose uplink this instance currently owns. */
  ownedEngineInstances(): string[] { return [...this.current.keys()]; }

  /** Pushes an epochs delta to every owned uplink of the workspace, routed
   * by the authenticated identity only. `createdAtMs` is the committing
   * event's time, used for `capability_revocation_push_ms`. */
  pushAuthEpochs(workspaceId: string, delta: UplinkAuthDelta, createdAtMs: number): void {
    for (const connection of this.current.values())
      if (connection.identity?.workspaceId === workspaceId) connection.pushEpochs(delta, createdAtMs);
  }

  /** Re-reads authority now for the given engines (or every owned uplink),
   * closing with 4403 those that are no longer current. */
  revalidate(engineInstanceIds?: Iterable<string>): void {
    const targets = engineInstanceIds ? [...engineInstanceIds].map(id => this.current.get(id)) : [...this.current.values()];
    for (const connection of targets) void connection?.recheck();
  }

  revalidateWorkspace(workspaceId: string): void {
    for (const connection of this.current.values())
      if (connection.identity?.workspaceId === workspaceId) void connection.recheck();
  }

  /** Another realtime instance recorded a newer uplink for this engine.
   * Replica clocks are NTP-disciplined but not identical, so "newer" is a
   * deterministic order: the later connect wins, ties (or skew within the
   * connect gap) break by connection id. */
  ownerChanged(engineInstanceId: string, connectionId: string, connectedAtMs: number): void {
    const local = this.current.get(engineInstanceId);
    if (!local || local.connectionId === connectionId) return;
    if (connectedAtMs < local.connectedAtMs ||
        (connectedAtMs === local.connectedAtMs && connectionId < local.connectionId)) return;
    if (!local.drained) this.recordSupersede(local.identity!);
    local.supersede();
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (request.url !== UPLINK_PATH) return false;
    socket.on("error", () => {});
    const refuse = (reason: string, status: number, text: string) => {
      this.count("refused", reason);
      if (!socket.destroyed)
        socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
      return true;
    };
    if (this.closed || this.draining) return refuse("draining", 503, "Service Unavailable");
    if (request.method !== "GET" || head.byteLength > 0) return refuse("invalid", 400, "Bad Request");
    const token = uplinkBearerToken(request.headers.authorization);
    if (!token) return refuse("unauthenticated", 401, "Unauthorized");
    const offered = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
    if (!offered.includes(UPLINK_SUBPROTOCOL)) return refuse("protocol", 400, "Bad Request");
    if (this.all.size >= this.options.maxConnections || this.pendingHandshakes >= this.options.maxPendingHandshakes)
      return refuse("capacity", 503, "Service Unavailable");
    const now = performance.now();
    this.admissionTokens = Math.min(ADMISSION_BURST, this.admissionTokens + (now - this.lastRefill) / ADMISSION_REFILL_MS);
    this.lastRefill = now;
    if (this.admissionTokens < 1) return refuse("rate_limited", 429, "Too Many Requests");
    this.admissionTokens -= 1;
    this.pendingHandshakes += 1;
    let settled = false;
    const settle = () => { if (!settled) { settled = true; this.pendingHandshakes -= 1; } };
    socket.once("close", settle);
    const address = sourceAddress(request);
    try {
      this.wss.handleUpgrade(request, socket, head, ws => {
        settle();
        if (this.closed || this.draining) { ws.close(UPLINK_CLOSE.draining, "draining"); return; }
        this.all.add(new UplinkConnection(this, ws, token, address));
      });
    } catch {
      settle();
      socket.destroy();
    }
    return true;
  }

  /** Sends `sys.drain` to every uplink with a randomized reconnect delay,
   * then closes the remainder with 4503 at the deadline. */
  drain(windowMs: number): Promise<void> {
    this.draining = true;
    const deadlineMs = Math.max(1_000, Math.min(MAX_DRAIN_MS, Math.floor(windowMs)));
    const spreadMs = Math.min(10_000, deadlineMs);
    for (const connection of this.all)
      connection.drain(Math.floor(Math.min(0.999_999, Math.max(0, this.options.random())) * spreadMs), deadlineMs);
    return new Promise(resolve => {
      const started = Date.now();
      const check = () => {
        if (this.all.size === 0 || Date.now() - started >= deadlineMs + 1_500) { resolve(); return; }
        setTimeout(check, 50).unref?.();
      };
      check();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopFlagListener?.();
    for (const connection of [...this.all]) connection.close(UPLINK_CLOSE.goingAway, "going_away", { park: false });
    this.resume.close();
    this.wss.close();
  }

  /** @internal */ forget(connection: UplinkConnection): void {
    this.all.delete(connection);
    const engineInstanceId = connection.identity?.engineInstanceId;
    if (engineInstanceId && this.current.get(engineInstanceId) === connection) this.current.delete(engineInstanceId);
  }

  /** @internal */ owner(engineInstanceId: string): UplinkConnection | undefined { return this.current.get(engineInstanceId); }

  /** @internal `previous` is the owner observed before a resume superseded it. */
  take(connection: UplinkConnection, observed?: UplinkConnection): void {
    const identity = connection.identity!;
    const previous = this.current.get(identity.engineInstanceId) ?? observed;
    this.current.set(identity.engineInstanceId, connection);
    if (!previous || previous === connection) return;
    // One logical supersede is recorded exactly once, here. When the new
    // connection resumed the lineage, the resume entry's callback already
    // closed `previous`, but that callback never records; skipping a
    // already-closed `previous` here would record zero instead.
    if (!previous.drained) {
      this.recordSupersede(identity);
      if (previous.address !== connection.address)
        this.options.alerts?.raise("uplink_supersede_address", identity);
    }
    previous.supersede();
  }

  /** @internal */ isDraining(): boolean { return this.draining || this.closed; }

  /** @internal */ count(kind: "refused" | "closed", reason: string): void {
    this.counters[kind][reason] = (this.counters[kind][reason] ?? 0) + 1;
  }

  private recordSupersede(identity: UplinkIdentity): void {
    const now = this.options.now();
    const recent = (this.supersedes.get(identity.engineInstanceId) ?? []).filter(at => now - at < CHURN_WINDOW_MS);
    recent.push(now);
    if (this.supersedes.size >= 20_000 && !this.supersedes.has(identity.engineInstanceId)) this.supersedes.clear();
    this.supersedes.set(identity.engineInstanceId, recent);
    if (recent.length > CHURN_LIMIT) this.options.alerts?.raise("uplink_supersede_churn", identity, { supersedes: recent.length });
  }
}

class UplinkConnection {
  readonly connectionId = randomUUID();
  identity: UplinkIdentity | null = null;
  session: UplinkSession | null = null;
  connectedAtMs = 0;
  drained = false;
  private lineage: Lineage | null = null;
  private resumeToken: string | null = null;
  private resumed = false;
  private peerLastReceived = 0;
  private protocol = 0;
  private features = new Set<string>();
  private lastSeenAtMs = 0;
  private leaseExpiresAtMs = 0;
  private state: "hello" | "admitting" | "welcomed" | "closed" = "hello";
  private syncId: string | null = null;
  private syncSentAtMs = 0;
  private authApplied = false;
  /** Reliable frames flow only after `auth.applied`, the capability and the
   * resume retransmit, in that order. */
  private flowing = false;
  private pendingDeltas: UplinkAuthDelta[] = [];
  private deltaCreatedAt: number[] = [];
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private capabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private watermarkTimer: ReturnType<typeof setInterval> | null = null;
  private authorityTimer: ReturnType<typeof setInterval> | null = null;
  private drainTimers: ReturnType<typeof setTimeout>[] = [];
  private rechecking = false;

  constructor(
    private readonly server: CloudEngineUplinkServer,
    private readonly ws: WebSocket,
    private readonly token: string,
    readonly address: string,
  ) {
    this.helloTimer = setTimeout(() => this.close(UPLINK_CLOSE.frameInvalid, "hello_timeout", { park: false }),
      server.options.helloTimeoutMs);
    this.helloTimer.unref?.();
    ws.on("message", (data, isBinary) => this.receive(data, isBinary));
    ws.on("error", () => {});
    ws.on("close", () => this.close(UPLINK_CLOSE.normal, "peer_closed", { park: true }));
  }

  view(): UplinkPresenceView | null {
    if (this.state !== "welcomed" || !this.lineage) return null;
    return Object.freeze({
      connectionId: this.connectionId, protocol: this.protocol, features: [...this.features],
      connectedAtMs: this.connectedAtMs, lastSeenAtMs: this.lastSeenAtMs, authApplied: this.authApplied,
      ready: this.lineage.ready, phase: this.lineage.phase, report: this.lineage.report, activity: this.lineage.activity,
    });
  }

  private now(): number { return this.server.options.now(); }
  private invalid(reason: string): void { this.close(UPLINK_CLOSE.frameInvalid, reason, { park: false }); }

  private receive(data: RawData, isBinary: boolean): void {
    if (this.state === "closed") return;
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (isBinary) return this.relayChunk(buffer);
    if (buffer.byteLength > UPLINK_MAX_CONTROL_FRAME_BYTES) return this.invalid("frame_too_large");
    let parsed: unknown;
    try { parsed = JSON.parse(buffer.toString("utf8")); } catch { return this.invalid("frame_invalid"); }
    const envelope = UplinkEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) return this.invalid("frame_invalid");
    const frame = envelope.data;
    if (this.state === "hello") {
      if (frame.t !== "sys.hello" || frame.s !== undefined) return this.invalid("hello_expected");
      const hello = UplinkHelloSchema.safeParse(frame.d ?? {});
      if (!hello.success) return this.invalid("hello_invalid");
      this.state = "admitting";
      if (this.helloTimer) clearTimeout(this.helloTimer);
      void this.admit(hello.data).catch(() => this.close(UPLINK_CLOSE.internalError, "internal_error", { park: false }));
      return;
    }
    // The engine sends nothing between hello and welcome.
    if (this.state !== "welcomed" || !this.lineage) return this.invalid("frame_before_welcome");
    if (frame.t === "sys.hello") return this.invalid("hello_repeated");
    this.lastSeenAtMs = this.now();
    if (frame.a !== undefined && !this.lineage.outbox.ack(frame.a)) return this.invalid("ack_invalid");
    const d = frame.d ?? {};
    if (frame.s !== undefined) {
      const order = this.lineage.inbound.accept(frame.s);
      if (order === "gap") return this.invalid("sequence_gap");
      this.scheduleAck();
      if (order === "duplicate") return;
      if (this.reliable(frame.t, d) === "invalid") this.invalid("frame_invalid");
      return;
    }
    if (frame.t === "sys.ping") {
      const ping = UplinkPingSchema.safeParse(d);
      if (!ping.success) return this.invalid("frame_invalid");
      this.send({ t: "sys.pong", d: { ts: ping.data.ts, leaseExpiresAtMs: this.leaseExpiresAtMs } });
      return;
    }
    if (frame.t === "auth.applied") {
      const applied = UplinkAuthAppliedSchema.safeParse(d);
      if (!applied.success) return this.invalid("frame_invalid");
      if (applied.data.syncId !== undefined) {
        if (this.authApplied || applied.data.syncId !== this.syncId) return this.invalid("auth_sync_unknown");
        this.server.options.metric?.("uplink_auth_sync_ms", this.now() - this.syncSentAtMs);
        void this.openGate().catch(() => this.close(UPLINK_CLOSE.internalError, "internal_error", { park: true }));
        return;
      }
      const createdAt = this.deltaCreatedAt.shift();
      if (!this.authApplied || createdAt === undefined) return this.invalid("auth_applied_unexpected");
      this.server.options.metric?.("capability_revocation_push_ms", Math.max(0, this.now() - createdAt));
      return;
    }
    // sys.ack carries only `a`, applied above. Other unsequenced engine→CP
    // frames (relay.accept/reject/credit/close, …) belong to the negotiated
    // extensions; unknown unsequenced types stay ignored (the contract's
    // unknown-type rule).
    if (frame.t === "sys.ack") return;
    for (const extension of this.server.options.extensions) {
      if (!this.features.has(extension.feature) || !extension.onFrame) continue;
      try {
        const handled = extension.onFrame(this.session!, frame.t, d);
        if (handled === "invalid") return this.invalid("frame_invalid");
        if (handled) return;
      } catch { return this.invalid("frame_invalid"); }
    }
  }

  /** Binary frames are relay chunks (contract "Binary relay frame"). Relay
   * channels exist only after `relay.open`, which requires the welcome, so
   * an earlier binary frame is a protocol violation. A chunk no extension
   * claims is non-fatal: `sys.error relay_channel_unknown`, per the
   * contract's error-code table. */
  private relayChunk(frame: Buffer): void {
    if (this.state !== "welcomed" || !this.session) return this.invalid("frame_before_welcome");
    this.lastSeenAtMs = this.now();
    const chunk = parseUplinkRelayChunk(frame);
    if (!chunk) return this.invalid("frame_invalid");
    for (const extension of this.server.options.extensions) {
      if (!this.features.has(extension.feature) || !extension.onRelayChunk) continue;
      try {
        if (extension.onRelayChunk(this.session, chunk)) return;
      } catch { return this.invalid("frame_invalid"); }
    }
    this.send({ t: "sys.error", d: {
      code: "relay_channel_unknown", message: "no negotiated extension claims this relay channel",
      fatal: false, channel: chunk.channel,
    } });
  }

  private reliable(t: string, d: Record<string, unknown>): "ok" | "invalid" {
    const lineage = this.lineage!;
    if (t === "status.ready") {
      const ready = UplinkStatusReadySchema.safeParse(d);
      if (!ready.success) return "invalid";
      const changed = lineage.ready !== ready.data.ready || lineage.phase !== ready.data.phase;
      lineage.ready = ready.data.ready;
      lineage.phase = ready.data.phase;
      if (changed) this.writePresence(true);
      return "ok";
    }
    if (t === "status.report") {
      const report = UplinkStatusReportSchema.safeParse(d);
      if (!report.success) return "invalid";
      lineage.report = report.data;
      return "ok";
    }
    if (t === "activity.report") {
      const activity = UplinkActivityReportSchema.safeParse(d);
      if (!activity.success) return "invalid";
      lineage.activity = activity.data;
      return "ok";
    }
    for (const extension of this.server.options.extensions) {
      if (!this.features.has(extension.feature) || !extension.onFrame) continue;
      try {
        const handled = extension.onFrame(this.session!, t, d);
        if (handled === "invalid") return "invalid";
        if (handled) return "ok";
      } catch { return "invalid"; }
    }
    // Unknown sequenced types are acked and ignored.
    return "ok";
  }

  private async admit(hello: UplinkHello): Promise<void> {
    const options = this.server.options;
    const protocol = negotiateUplinkProtocol(hello.protocol);
    if (protocol === null) return this.refuse(UPLINK_CLOSE.protocolUnsupported, "protocol_unsupported");
    if (!this.server.uplinkEnabled(hello.organizationId)) return this.refuse(UPLINK_CLOSE.disabled, "uplink_disabled");
    const identity: UplinkIdentity = Object.freeze({
      workspaceId: hello.workspaceId, organizationId: hello.organizationId, generation: hello.generation,
      engineInstanceId: hello.engineInstanceId, bootId: hello.bootId,
    });
    // Validation happens before any supersede: a failing hello never touches a live uplink.
    const verified = await options.authority.verify(identity, this.token);
    if (this.state !== "admitting") return;
    if (!verified.ok) {
      if (verified.reason === "unavailable") return this.refuse(UPLINK_CLOSE.internalError, "internal_error");
      if (verified.reason === "unauthenticated") return this.refuse(UPLINK_CLOSE.unauthenticated, "uplink_unauthenticated");
      return this.refuse(UPLINK_CLOSE.forbidden, "uplink_forbidden");
    }
    if (this.server.isDraining()) return this.refuse(UPLINK_CLOSE.draining, "draining");
    if (!this.server.uplinkEnabled(identity.organizationId)) return this.refuse(UPLINK_CLOSE.disabled, "uplink_disabled");
    this.identity = identity;
    this.protocol = protocol;
    this.leaseExpiresAtMs = verified.leaseExpiresAtMs;
    const offered = new Set(hello.features);
    this.features = new Set(options.extensions.map(extension => extension.feature).filter(feature => offered.has(feature)));
    // A token resumes only with the credential, engine instance and bootId it was issued to.
    const key = lineageKey(identity, this.token);
    const observed = this.server.owner(identity.engineInstanceId);
    if (hello.resume) {
      const taken = this.server.resume.take(hello.resume.token, key);
      if (taken.resumed && taken.state.outbox.replayAfter(hello.resume.lastReceivedSeq)) {
        this.lineage = taken.state;
        this.resumed = true;
        this.peerLastReceived = hello.resume.lastReceivedSeq;
      }
    }
    this.lineage ??= { outbox: new ReliableOutbox(), inbound: new InboundSequence(), ready: false, phase: null, report: null, activity: null };
    this.connectedAtMs = this.lastSeenAtMs = this.now();
    this.state = "welcomed";
    this.server.take(this, observed);
    this.server.counters.admitted += 1;
    if (this.resumed) this.server.counters.resumed += 1;
    this.resumeToken = this.server.resume.issue(key, this.lineage, () => this.supersede());
    this.session = {
      connectionId: this.connectionId, identity, features: this.features,
      sendReliable: (t, d) => this.sendReliable(t, d),
    };
    this.send({ t: "sys.welcome", d: {
      protocol, features: [...this.features], resumeToken: this.resumeToken, resumed: this.resumed,
      pingIntervalMs: options.pingIntervalMs, leaseExpiresAtMs: this.leaseExpiresAtMs,
    } });
    this.writePresence(true);
    this.startTimers();
    let keys, snapshot;
    try {
      [keys, snapshot] = await Promise.all([options.authSource.keys(), options.authSource.snapshot(identity, hello.authCursor)]);
    } catch {
      return this.close(UPLINK_CLOSE.internalError, "internal_error", { park: true });
    }
    if (this.state !== "welcomed") return;
    this.syncId = randomUUID();
    this.syncSentAtMs = this.now();
    this.send({ t: "auth.keys", d: { keys } });
    this.send({ t: "auth.sync", d: { syncId: this.syncId, ...snapshot } });
    this.authTimer = setTimeout(() => this.invalid("auth_applied_timeout"), options.authAppliedTimeoutMs);
    this.authTimer.unref?.();
  }

  private async openGate(): Promise<void> {
    this.authApplied = true;
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
    for (const delta of this.pendingDeltas.splice(0)) this.send({ t: "auth.epochs", d: delta });
    await this.issueCapability();
  }

  /** Each engine token is issued by `api` from current authority. The gate
   * opens only on the first successful issue — a transient issuer failure
   * retries with full-jitter backoff (floored at 100 ms so a zero draw
   * never spins) while buffered reliable frames keep waiting; an authority
   * refusal closes 4403. Frozen handshake step 4 order: the capability,
   * then the resume retransmit, then extension `onOpen`. */
  private async issueCapability(): Promise<void> {
    if (this.capabilityTimer) clearTimeout(this.capabilityTimer);
    this.capabilityTimer = null;
    const options = this.server.options;
    const issued = await options.capabilities.issue(this.identity!).catch(() => ({ ok: false as const, reason: "unavailable" as const }));
    if (this.state !== "welcomed" || !this.lineage) return;
    if (!issued.ok && issued.reason === "authority")
      return this.close(UPLINK_CLOSE.forbidden, "uplink_forbidden", { park: false });
    let nextMs: number;
    if (issued.ok) {
      this.send({ t: "auth.capability", d: { audience: "zeros:api", token: issued.token, expiresAtMs: issued.expiresAtMs } });
      // 60% of the lifetime (300 s cadence per the contract), floored so a
      // near-past expiry can never drive a reissue loop.
      nextMs = Math.max(5_000, Math.floor((issued.expiresAtMs - this.now()) * 0.6));
      if (!this.flowing) {
        const frames = this.lineage.outbox.replayAfter(this.peerLastReceived) ?? [];
        this.flowing = true;
        for (const frame of frames) this.sendText(frame.text);
        for (const extension of this.server.options.extensions)
          if (this.features.has(extension.feature)) extension.onOpen?.(this.session!, this.resumed);
      }
    } else {
      nextMs = Math.max(100, Math.floor(options.random() * options.capabilityRetryMs));
    }
    this.capabilityTimer = setTimeout(() => void this.issueCapability(), nextMs);
    this.capabilityTimer.unref?.();
  }

  pushEpochs(delta: UplinkAuthDelta, createdAtMs: number): void {
    if (this.state !== "welcomed") return;
    this.deltaCreatedAt.push(createdAtMs);
    if (this.deltaCreatedAt.length > 1_000) this.deltaCreatedAt.shift();
    if (!this.authApplied) { this.pendingDeltas.push(delta); return; }
    this.send({ t: "auth.epochs", d: delta });
  }

  private startTimers(): void {
    const options = this.server.options;
    const offlineAfterMs = 2 * options.pingIntervalMs + 5_000;
    this.livenessTimer = setInterval(() => {
      if (this.now() - this.lastSeenAtMs > offlineAfterMs) this.close(UPLINK_CLOSE.pingTimeout, "ping_timeout", { park: true });
    }, Math.min(5_000, options.pingIntervalMs));
    this.watermarkTimer = setInterval(() => this.writePresence(false), options.watermarkIntervalMs);
    this.authorityTimer = setInterval(() => void this.recheck(), options.authorityRecheckMs);
    for (const timer of [this.livenessTimer, this.watermarkTimer, this.authorityTimer]) timer.unref?.();
  }

  /** Authority loss closes with 4403 at once; an unavailable database
   * never closes an established uplink. */
  async recheck(): Promise<void> {
    if (this.state !== "welcomed" || !this.identity || this.rechecking) return;
    this.rechecking = true;
    try {
      const verified = await this.server.options.authority.verify(this.identity, this.token).catch(() => null);
      if (this.state !== "welcomed") return;
      if (verified?.ok) { this.leaseExpiresAtMs = verified.leaseExpiresAtMs; return; }
      if (!verified || verified.reason === "unavailable") return;
      this.close(UPLINK_CLOSE.forbidden, "uplink_forbidden", { park: false });
    } finally { this.rechecking = false; }
  }

  private writePresence(transition: boolean): void {
    const presence = this.server.options.presence, identity = this.identity, lineage = this.lineage;
    if (!presence || !identity || !lineage) return;
    if (!transition && this.state !== "welcomed") return;
    const closed = this.state === "closed";
    const snapshot: UplinkPresenceSnapshot = {
      connectionId: this.connectionId, engineInstanceId: identity.engineInstanceId, workspaceId: identity.workspaceId,
      organizationId: identity.organizationId, generation: identity.generation,
      realtimeInstance: this.server.options.realtimeInstance, protocol: this.protocol,
      connected: !closed, ready: !closed && lineage.ready, phase: lineage.phase,
      connectedAtMs: this.connectedAtMs, lastSeenAtMs: Math.max(this.connectedAtMs, this.lastSeenAtMs),
      disconnectedAtMs: closed ? Math.max(this.connectedAtMs, this.now()) : null,
    };
    presence.enqueue(snapshot);
  }

  private scheduleAck(): void {
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.state === "welcomed" && this.lineage) this.send({ t: "sys.ack", a: this.lineage.inbound.lastContiguous });
    }, this.server.options.ackDelayMs);
    this.ackTimer.unref?.();
  }

  private sendReliable(t: string, d: Record<string, unknown>): boolean {
    if (this.state !== "welcomed" || !this.lineage) return false;
    const lineage = this.lineage;
    const frame = lineage.outbox.push(s => ({ t, text: JSON.stringify({ t, s, a: lineage.inbound.lastContiguous, d }) }));
    if (!frame) { this.close(UPLINK_CLOSE.backpressure, "backpressure", { park: true }); return false; }
    if (this.flowing) this.sendText(frame.text);
    return true;
  }

  private send(frame: { t: string; a?: number; d?: Record<string, unknown> }): void {
    this.sendText(JSON.stringify(frame));
  }

  private sendText(text: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > this.server.options.maxSocketBufferBytes) {
      this.close(UPLINK_CLOSE.backpressure, "backpressure", { park: true });
      return;
    }
    this.ws.send(text);
  }

  drain(reconnectAfterMs: number, deadlineMs: number): void {
    if (this.state !== "welcomed") { this.close(UPLINK_CLOSE.draining, "draining", { park: false }); return; }
    this.drained = true;
    this.send({ t: "sys.drain", d: { reconnectAfterMs, deadlineMs } });
    const timer = setTimeout(() => this.close(UPLINK_CLOSE.draining, "draining", { park: true }), deadlineMs);
    timer.unref?.();
    this.drainTimers.push(timer);
  }

  supersede(): void {
    // A resumed lineage already moved to the newer uplink; a fresh one
    // replaces it. Either way this connection's token must never resume.
    const token = this.resumeToken;
    this.resumeToken = null;
    if (token) this.server.resume.revoke(token);
    this.close(UPLINK_CLOSE.superseded, "uplink_superseded", { park: false });
  }

  private refuse(code: number, reason: string): void {
    this.server.count("refused", reason);
    this.close(code, reason, { park: false });
  }

  close(code: number, reason: string, options: { park: boolean }): void {
    if (this.state === "closed") return;
    const welcomed = this.state === "welcomed";
    this.state = "closed";
    this.server.count("closed", reason);
    if (this.resumeToken && this.lineage) {
      if (options.park) this.server.resume.park(this.resumeToken, this.lineage);
      else this.server.resume.revoke(this.resumeToken);
    }
    this.resumeToken = null;
    this.stopTimers();
    this.server.forget(this);
    if (welcomed) {
      this.writePresence(true);
      for (const extension of this.server.options.extensions)
        if (this.features.has(extension.feature)) extension.onClose?.(this.session!);
    }
    if (this.ws.readyState === WebSocket.CLOSED) return;
    try { this.ws.close(code, reason); } catch { this.ws.terminate(); }
    const force = setTimeout(() => this.ws.terminate(), 5_000);
    force.unref?.();
    this.ws.once("close", () => clearTimeout(force));
  }

  private stopTimers(): void {
    for (const timer of [this.helloTimer, this.authTimer, this.ackTimer, this.capabilityTimer, ...this.drainTimers])
      if (timer) clearTimeout(timer);
    for (const timer of [this.livenessTimer, this.watermarkTimer, this.authorityTimer]) if (timer) clearInterval(timer);
    this.helloTimer = this.authTimer = this.ackTimer = this.capabilityTimer = null;
    this.livenessTimer = this.watermarkTimer = this.authorityTimer = null;
    this.drainTimers = [];
  }
}

/** Identifies this process in presence rows and owner notifications. */
export function realtimeInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const replica = (env.RAILWAY_REPLICA_ID ?? hostname()).replace(/[^A-Za-z0-9:._-]+/g, "-").slice(0, 100) || "realtime";
  return `${replica}:${process.pid}`;
}

function lineageKey(identity: UplinkIdentity, token: string): string {
  const credential = createHash("sha256").update(token, "utf8").digest("base64url");
  return [credential, identity.organizationId, identity.workspaceId, identity.generation, identity.engineInstanceId, identity.bootId].join(":");
}

/** The address the nearest proxy saw: the last `X-Forwarded-For` hop when
 * present (appended by the platform proxy, not chosen by the client),
 * otherwise the socket peer. Used only to notice supersede tug-of-war. */
function sourceAddress(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
  const last = value?.split(",").at(-1)?.trim();
  return (last || request.socket.remoteAddress || "unknown").slice(0, 64);
}
