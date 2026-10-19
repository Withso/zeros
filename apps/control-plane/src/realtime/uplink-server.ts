import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { hostname } from "node:os";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { MAX_DRAIN_MS } from "./drain.js";
import { UplinkAdmission, uplinkSourceAddress, type AdmissionTicket } from "./uplink-admission.js";
import { InboundSequence, ReliableOutbox, ResumeStore } from "./resume.js";
import type { UplinkSecurityAlerts } from "./uplink-alerts.js";
import type { EngineCapabilityIssuer, UplinkAuthSource } from "./uplink-auth-source.js";
import type { UplinkAuthority, UplinkIdentity } from "./uplink-authority.js";
import { UPLINK_IDLE_STOP_MS, UplinkIdleDecision, type UplinkIdleStopResult, type UplinkIdleStopStore } from "./uplink-idle.js";
import { UPLINK_ENGINE_LEASE_MS, type UplinkLeaseStore } from "./uplink-lease.js";
import type { UplinkPhase, UplinkPresenceSnapshot, UplinkPresenceWriter } from "./uplink-presence.js";
import {
  UPLINK_ACK_DELAY_MS,
  UPLINK_AUTH_APPLIED_TIMEOUT_MS,
  UPLINK_CLOSE,
  UPLINK_DEFAULT_PING_INTERVAL_MS,
  UPLINK_FEATURES,
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
  type UplinkJwk,
  type UplinkRelayChunk,
  type UplinkHello,
  type UplinkStatusReport,
} from "./uplink-protocol.js";
import type { RolloutFlagName, RolloutFlagReader } from "../rollout-flags.js";

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
  /** Sends a non-fatal, unsequenced `sys.error` (contract error codes). */
  sendError?(code: string, message: string, extra?: Record<string, unknown>): void;
  /** Connection-local auth control, excluded from reliable resume replay. */
  sendControl?(t: string, d: Record<string, unknown>): boolean;
  /** Null until the snapshot and every targeted delta have been ACKed. */
  authState?(): { syncId: string; authCursor: string; revision: number } | null;
}

/** Feature modules (credential push, relay) plug in here instead of growing
 * the connection state machine. `onOpen` runs once the `auth` exchange and
 * the resume retransmit finished; with `resumed: false` the module resyncs. */
export interface UplinkExtension {
  readonly feature: string;
  /** Rollout flag that gates negotiating `feature`, per organization. A
   * flip closes the affected uplinks (1001 `features_changed`) so the
   * engine re-dials and renegotiates. */
  readonly flag?: RolloutFlagName;
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
  coordinator?: UplinkPresenceSnapshot["coordinator"];
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
  /** Renews the engine lease of `lease.v1` uplinks; negotiated only while
   * `engine_lease_over_uplink` is on for the organization. */
  lease?: UplinkLeaseStore;
  /** Requests the idle stop of `idle.v1` uplinks; negotiated only while
   * `cp_idle_stop` is on for the organization. */
  idle?: UplinkIdleStopStore;
  /** Reported quiet time before an `idle.v1` uplink's stop is requested. */
  idleStopMs?: number;
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
  /** Pre-authentication admission: the process-wide burst (refilled one
   * token per 2 ms) and, per source address, a burst, a steady rate and the
   * sockets it may hold before their welcome. */
  admissionBurst?: number;
  sourceAdmissionBurst?: number;
  sourceAdmissionPerSecond?: number;
  sourceMaxUnadmitted?: number;
  /** Durable readiness writes per uplink: a burst of three, then one per
   * interval; the latest state is written when the interval allows. */
  presenceMinIntervalMs?: number;
  /** Epoch deltas held for the gate or awaiting `auth.applied`; past it the
   * uplink closes 4429 and resyncs on the redial. */
  maxOutstandingAuthDeltas?: number;
  logger?: Pick<Console, "warn">;
  /** Bytes the socket may buffer before the uplink closes with 4429. */
  maxSocketBufferBytes?: number;
  now?: () => number;
  random?: () => number;
};

type ResolvedOptions = Required<Omit<UplinkServerOptions, "presence" | "alerts" | "lease" | "idle" | "metric" | "resumeRetentionMs">> &
  Pick<UplinkServerOptions, "presence" | "alerts" | "lease" | "idle" | "metric">;

export type UplinkCounters = {
  admitted: number;
  resumed: number;
  refused: Record<string, number>;
  closed: Record<string, number>;
};

const ADMISSION_REFILL_MS = 2;
const PRESENCE_BURST = 3;
const CHURN_WINDOW_MS = 10 * 60_000;
const CHURN_LIMIT = 3;

/** Server side of the S2 engine uplink (docs/cloud-workspace/contracts/s2-uplink.md,
 * 1.2.0). Liveness, readiness and activity live in memory; presence
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
  private readonly admission: UplinkAdmission;
  /** Authority notifications, so an admission whose read overlapped one
   * re-reads after it owns the engine. */
  private authoritySeq = 0;
  private allNotifiedAt = 0;
  private readonly notifiedAt = new Map<string, number>();
  private closed = false;
  private draining = false;
  readonly counters: UplinkCounters = { admitted: 0, resumed: 0, refused: {}, closed: {} };
  readonly options: ResolvedOptions;
  /** True while the uplink LISTEN session is current. Only then do `lease.v1`
   * uplinks skip the periodic authority recheck: every notified authority
   * change still re-reads them at once, and each lease renewal re-checks
   * authority within one watermark interval. */
  notificationsCurrent = false;

  constructor(options: UplinkServerOptions) {
    this.options = {
      pingIntervalMs: UPLINK_DEFAULT_PING_INTERVAL_MS,
      helloTimeoutMs: UPLINK_HELLO_TIMEOUT_MS,
      authAppliedTimeoutMs: UPLINK_AUTH_APPLIED_TIMEOUT_MS,
      ackDelayMs: UPLINK_ACK_DELAY_MS,
      watermarkIntervalMs: UPLINK_WATERMARK_INTERVAL_MS,
      authorityRecheckMs: 60_000,
      capabilityRetryMs: 30_000,
      maxConnections: 20_000,
      maxPendingHandshakes: 256,
      admissionBurst: 500,
      // 300 engines behind one egress re-dialing across a drain's 10 s spread
      // fit (100 + 30/s x 10 s); one source holds at most a fifth of the burst.
      sourceAdmissionBurst: 100,
      sourceAdmissionPerSecond: 30,
      sourceMaxUnadmitted: 64,
      presenceMinIntervalMs: 2_000,
      maxOutstandingAuthDeltas: 1_000,
      logger: console,
      maxSocketBufferBytes: 4 * 1024 * 1024,
      now: Date.now,
      random: Math.random,
      extensions: [],
      idleStopMs: UPLINK_IDLE_STOP_MS,
      ...options,
    };
    if (!/^[A-Za-z0-9:._-]{1,128}$/.test(this.options.realtimeInstance)) throw new Error("invalid realtime instance id");
    const ping = this.options.pingIntervalMs;
    if (!Number.isSafeInteger(ping) || ping < 10_000 || ping > 30_000) throw new Error("uplink ping interval must be 10-30 s");
    this.admission = new UplinkAdmission({
      globalBurst: this.options.admissionBurst, globalRefillMs: ADMISSION_REFILL_MS,
      sourceBurst: this.options.sourceAdmissionBurst, sourcePerSecond: this.options.sourceAdmissionPerSecond,
      sourceMaxUnadmitted: this.options.sourceMaxUnadmitted,
    });
    this.resume = new ResumeStore<Lineage>({ now: this.options.now,
      ...(options.resumeRetentionMs !== undefined ? { retentionMs: options.resumeRetentionMs } : {}) });
    this.stopFlagListener = this.options.flags.onChange?.(() => this.applyRollout()) ?? null;
    this.stopKeyListener = this.options.authSource.onKeysChanged?.(keys => {
      for (const connection of this.all) connection.pushKeys(keys);
    }) ?? null;
  }

  private readonly stopFlagListener: (() => void) | null;
  private readonly stopKeyListener: (() => void) | null;

  /** Organization ids reach the flag reader only in canonical lowercase
   * form (the hello schema enforces it), so any other spelling reads off. */
  uplinkEnabled(organizationId: string): boolean {
    return this.options.flags.enabled(organizationId, "realtime_uplink");
  }

  /** The extensions both sides offer whose rollout flag (if any) is on,
   * plus `lease.v1` and `idle.v1` when this server has their store and the flag is on. */
  negotiate(organizationId: string, offered: ReadonlySet<string>): Set<string> {
    const features = new Set(this.options.extensions
      .filter(extension => offered.has(extension.feature) &&
        (extension.feature !== UPLINK_FEATURES.detached ||
          (["capabilities", "realtime_uplink", "credential_push", "turn_journal", "detached_turns"] as const)
            .every(flag => this.options.flags.enabled(organizationId, flag))) &&
        (extension.feature !== UPLINK_FEATURES.checkpoint || offered.has(UPLINK_FEATURES.checkpointFallback)) &&
        (!extension.flag || this.options.flags.enabled(organizationId, extension.flag)))
      .map(extension => extension.feature));
    if (this.options.lease && offered.has(UPLINK_FEATURES.lease) &&
        offered.has(UPLINK_FEATURES.exitReport) &&
        this.options.flags.enabled(organizationId, "engine_lease_over_uplink")) features.add(UPLINK_FEATURES.lease);
    if (this.options.idle && offered.has(UPLINK_FEATURES.idle) &&
        this.options.flags.enabled(organizationId, "cp_idle_stop")) features.add(UPLINK_FEATURES.idle);
    if (offered.has(UPLINK_FEATURES.coordinator) && this.options.flags.enabled(organizationId, "agent_runners"))
      features.add(UPLINK_FEATURES.coordinator);
    return features;
  }

  /** A flag turned off closes that organization's uplinks with 4404; the
   * engines stop dialing and keep the HTTP heartbeat and credential poll. A
   * feature flag that changes what an uplink would negotiate closes it with
   * 1001 so the engine re-dials (resuming its lineage) and renegotiates;
   * until then it keeps its 500 ms credential poll. */
  applyRollout(): void {
    for (const connection of [...this.all]) {
      const organizationId = connection.identity?.organizationId;
      if (!organizationId) continue;
      if (!this.uplinkEnabled(organizationId))
        connection.close(UPLINK_CLOSE.disabled, "uplink_disabled", { park: false });
      else if (connection.featuresStale())
        connection.close(UPLINK_CLOSE.goingAway, "features_changed", { park: true });
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
    const ids = engineInstanceIds ? [...engineInstanceIds] : null;
    this.noteAuthority(ids?.map(id => `e:${id}`) ?? null);
    const targets = ids ? ids.map(id => this.current.get(id)) : [...this.current.values()];
    for (const connection of targets) void connection?.recheck();
  }

  revalidateWorkspace(workspaceId: string): void {
    this.noteAuthority([`w:${workspaceId}`]);
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

  private noteAuthority(keys: string[] | null): void {
    this.authoritySeq += 1;
    if (!keys || this.notifiedAt.size + keys.length > 20_000) {
      this.notifiedAt.clear();
      this.allNotifiedAt = this.authoritySeq;
      return;
    }
    for (const key of keys) this.notifiedAt.set(key, this.authoritySeq);
  }

  /** @internal */ authoritySequence(): number { return this.authoritySeq; }

  /** @internal Whether an authority notification for the engine or its
   * workspace arrived after `since`. */
  authorityNotifiedSince(identity: UplinkIdentity, since: number): boolean {
    return this.allNotifiedAt > since ||
      (this.notifiedAt.get(`e:${identity.engineInstanceId}`) ?? 0) > since ||
      (this.notifiedAt.get(`w:${identity.workspaceId}`) ?? 0) > since;
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
    // Before any credential check, so admission is per source: a flood of
    // shaped tokens from one address spends only that address's budget.
    const address = uplinkSourceAddress(request);
    const ticket = this.admission.admit(address);
    if (ticket === "rate_limited") return refuse("rate_limited", 429, "Too Many Requests");
    if (ticket === "capacity") return refuse("capacity", 503, "Service Unavailable");
    this.pendingHandshakes += 1;
    let settled = false;
    const settle = () => { if (!settled) { settled = true; this.pendingHandshakes -= 1; } };
    socket.once("close", () => { settle(); ticket.release(); });
    try {
      this.wss.handleUpgrade(request, socket, head, ws => {
        settle();
        if (this.closed || this.draining) { ticket.release(); ws.close(UPLINK_CLOSE.draining, "draining"); return; }
        this.all.add(new UplinkConnection(this, ws, token, address, ticket));
      });
    } catch {
      settle();
      ticket.release();
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
    this.stopKeyListener?.();
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
  private offered: ReadonlySet<string> = new Set();
  private lastSeenAtMs = 0;
  private leaseExpiresAtMs = 0;
  private state: "hello" | "admitting" | "welcomed" | "closed" = "hello";
  private syncId: string | null = null;
  private authCursor: string | null = null;
  private authRevision = 0;
  private syncSentAtMs = 0;
  private authApplied = false;
  /** Reliable frames flow only after `auth.applied`, the capability and the
   * resume retransmit, in that order. */
  private flowing = false;
  private initialKeysSent = false;
  private pendingKeys: readonly UplinkJwk[] | null = null;
  private pendingDeltas: UplinkAuthDelta[] = [];
  /** One entry per delta sent or held and not yet applied, oldest first. */
  private deltaCreatedAt: Array<{ at: number; cursor: string }> = [];
  private presenceTokens = PRESENCE_BURST;
  private presenceAtMs = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private capabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private watermarkTimer: ReturnType<typeof setInterval> | null = null;
  private authorityTimer: ReturnType<typeof setInterval> | null = null;
  private drainTimers: ReturnType<typeof setTimeout>[] = [];
  private rechecking = false;
  private recheckAgain = false;
  private leaseRenewing = false;
  private idle: UplinkIdleDecision | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleRequesting = false;

  constructor(
    private readonly server: CloudEngineUplinkServer,
    private readonly ws: WebSocket,
    private readonly token: string,
    readonly address: string,
    private readonly admission: AdmissionTicket,
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
        if (this.features.has(UPLINK_FEATURES.detached) && applied.data.authCursor !== this.authCursor)
          return this.invalid("auth_cursor_mismatch");
        this.server.options.metric?.("uplink_auth_sync_ms", this.now() - this.syncSentAtMs);
        void this.openGate().catch(() => this.close(UPLINK_CLOSE.internalError, "internal_error", { park: true }));
        return;
      }
      const createdAt = this.deltaCreatedAt.shift();
      if (!this.authApplied || createdAt === undefined) return this.invalid("auth_applied_unexpected");
      if (this.features.has(UPLINK_FEATURES.detached) && applied.data.authCursor !== createdAt.cursor)
        return this.invalid("auth_cursor_mismatch");
      this.authCursor = createdAt.cursor;
      this.server.options.metric?.("capability_revocation_push_ms", Math.max(0, this.now() - createdAt.at));
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
      const coordinator = ready.data.coordinator;
      if (!coordinator && (this.features.has(UPLINK_FEATURES.coordinator) || lineage.coordinator)) return "invalid";
      if (coordinator) {
        if (coordinator.bootId !== this.identity?.bootId) return "invalid";
        // A reliable replay or a late original frontend cannot change either
        // the projection or its receive-time bound. API reports use the same
        // revision CAS, independently of this uplink connection's lifetime.
        if (lineage.coordinator && coordinator.revision <= lineage.coordinator.report.revision) return "ok";
        lineage.coordinator = { report: coordinator, receivedAtMs: this.now() };
      }
      const changed = lineage.ready !== ready.data.ready || lineage.phase !== ready.data.phase;
      lineage.ready = ready.data.ready;
      lineage.phase = ready.data.phase;
      if (changed || coordinator) this.writeReadiness();
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
      if (this.idle) this.scheduleIdle(this.idle.report(activity.data, this.now()));
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
    const notifiedFrom = this.server.authoritySequence();
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
    this.offered = new Set(hello.features);
    this.features = this.server.negotiate(identity.organizationId, this.offered);
    if (this.features.has(UPLINK_FEATURES.idle)) this.idle = new UplinkIdleDecision(options.idleStopMs);
    // A token resumes only with the credential, engine instance and bootId
    // it was issued to — and only when its cursor can be repaired. Peek
    // first: a cursor the outbox cannot replay (a foreign or confused peer)
    // falls back to a fresh session without consuming the lineage, so the
    // real owner can still resume with a valid cursor.
    const key = lineageKey(identity, this.token);
    const observed = this.server.owner(identity.engineInstanceId);
    if (hello.resume) {
      const peeked = this.server.resume.peek(hello.resume.token, key);
      if (peeked.resumable && peeked.state.outbox.replayableAfter(hello.resume.lastReceivedSeq)) {
        const taken = this.server.resume.take(hello.resume.token, key);
        if (taken.resumed) {
          this.lineage = taken.state;
          this.resumed = true;
          this.peerLastReceived = hello.resume.lastReceivedSeq;
        }
      }
    }
    this.lineage ??= { outbox: new ReliableOutbox(), inbound: new InboundSequence(), ready: false, phase: null, report: null, activity: null };
    this.connectedAtMs = this.lastSeenAtMs = this.now();
    this.state = "welcomed";
    this.admission.release();
    this.server.take(this, observed);
    this.server.counters.admitted += 1;
    if (this.resumed) this.server.counters.resumed += 1;
    this.resumeToken = this.server.resume.issue(key, this.lineage, () => this.supersede());
    this.session = {
      connectionId: this.connectionId, identity, features: this.features,
      sendReliable: (t, d) => this.sendReliable(t, d),
      sendControl: (t, d) => this.flowing && this.send({ t, d }),
      authState: () => this.state === "welcomed" && this.flowing && this.authApplied && !this.deltaCreatedAt.length && this.syncId && this.authCursor
        ? { syncId: this.syncId, authCursor: this.authCursor, revision: this.authRevision } : null,
      sendError: (code, message, extra) => { this.send({ t: "sys.error", d: { ...extra, code, message, fatal: false } }); },
    };
    this.send({ t: "sys.welcome", d: {
      protocol, features: [...this.features], resumeToken: this.resumeToken, resumed: this.resumed,
      ...(this.features.has(UPLINK_FEATURES.detached) ? { connectionId: this.connectionId } : {}),
      pingIntervalMs: options.pingIntervalMs, leaseExpiresAtMs: this.leaseExpiresAtMs,
    } });
    this.presenceAtMs = this.now();
    this.writePresence(true);
    this.startTimers();
    // A revocation that committed after the hello's read notified while this
    // engine was not owned yet, so it reached nobody: read again now.
    if (this.server.authorityNotifiedSince(identity, notifiedFrom)) void this.recheck();
    let keys, snapshot;
    try {
      [keys, snapshot] = await Promise.all([options.authSource.keys(), options.authSource.snapshot(identity, hello.authCursor)]);
    } catch {
      return this.close(UPLINK_CLOSE.internalError, "internal_error", { park: true });
    }
    if (this.state !== "welcomed") return;
    this.syncId = randomUUID();
    this.authCursor = snapshot.authCursor;
    this.authRevision += 1;
    this.syncSentAtMs = this.now();
    // A change during admission or these reads wins over the older snapshot.
    // Keep the frozen welcome -> keys -> sync order with only one pending set.
    this.initialKeysSent = true;
    if (!this.send({ t: "auth.keys", d: { keys: this.pendingKeys ?? keys } })) return;
    this.pendingKeys = null;
    if (!this.send({ t: "auth.sync", d: { syncId: this.syncId, ...snapshot } })) return;
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
        // A redial within one watermark of the last renewal (a drain or a
        // deploy) keeps that lease until the next tick.
        if (this.leaseExpiresAtMs - this.now() <= UPLINK_ENGINE_LEASE_MS - options.watermarkIntervalMs) void this.renewLease();
        if (this.idle) this.scheduleIdle(this.idle.dueAtMs());
      }
    } else {
      nextMs = Math.max(100, Math.floor(options.random() * options.capabilityRetryMs));
    }
    this.capabilityTimer = setTimeout(() => void this.issueCapability(), nextMs);
    this.capabilityTimer.unref?.();
  }

  pushKeys(keys: readonly UplinkJwk[]): void {
    if (this.state === "closed") return;
    this.authRevision += 1;
    if (!this.initialKeysSent) { this.pendingKeys = keys; return; }
    this.send({ t: "auth.keys", d: { keys } });
  }

  pushEpochs(delta: UplinkAuthDelta, createdAtMs: number): void {
    if (this.state !== "welcomed") return;
    // Every held or sent delta keeps its entry until its auth.applied, so the
    // engine's honest applied is never "unexpected"; an engine this far
    // behind resyncs from the snapshot on its redial instead.
    if (this.deltaCreatedAt.length >= this.server.options.maxOutstandingAuthDeltas)
      return this.close(UPLINK_CLOSE.backpressure, "auth_deltas_backlog", { park: true });
    this.authRevision += 1;
    this.deltaCreatedAt.push({ at: createdAtMs, cursor: delta.authCursor });
    if (!this.authApplied) { this.pendingDeltas.push(delta); return; }
    this.send({ t: "auth.epochs", d: delta });
  }

  private startTimers(): void {
    const options = this.server.options;
    const offlineAfterMs = 2 * options.pingIntervalMs + 5_000;
    this.livenessTimer = setInterval(() => {
      if (this.now() - this.lastSeenAtMs > offlineAfterMs) this.close(UPLINK_CLOSE.pingTimeout, "ping_timeout", { park: true });
    }, Math.min(5_000, options.pingIntervalMs));
    this.watermarkTimer = setInterval(() => {
      this.writePresence(false);
      if (this.flowing) void this.renewLease();
    }, options.watermarkIntervalMs);
    this.authorityTimer = setInterval(() => {
      if (this.features.has(UPLINK_FEATURES.lease) && this.server.notificationsCurrent) return;
      void this.recheck();
    }, options.authorityRecheckMs);
    for (const timer of [this.livenessTimer, this.watermarkTimer, this.authorityTimer]) timer.unref?.();
  }

  /** True when the flags now negotiate a different feature set. */
  featuresStale(): boolean {
    if (this.state !== "welcomed" || !this.identity) return false;
    const now = this.server.negotiate(this.identity.organizationId, this.offered);
    return now.size !== this.features.size || [...now].some(feature => !this.features.has(feature));
  }

  /** Authority loss closes with 4403 at once; an unavailable database
   * never closes an established uplink. A recheck requested while a read is
   * in flight runs once more after it: that read's snapshot may predate the
   * notifying commit. */
  async recheck(): Promise<void> {
    if (this.state !== "welcomed" || !this.identity) return;
    if (this.rechecking) { this.recheckAgain = true; return; }
    this.rechecking = true;
    try {
      do {
        this.recheckAgain = false;
        const verified = await this.server.options.authority.verify(this.identity, this.token).catch(() => null);
        if (this.state !== "welcomed") return;
        // A read that raced a newer renewal never moves the lease back.
        if (verified?.ok) { this.leaseExpiresAtMs = Math.max(this.leaseExpiresAtMs, verified.leaseExpiresAtMs); continue; }
        if (!verified || verified.reason === "unavailable") continue;
        return this.close(UPLINK_CLOSE.forbidden, "uplink_forbidden", { park: false });
      } while (this.recheckAgain);
    } finally { this.rechecking = false; }
  }

  /** `lease.v1`: an unavailable renewal keeps the uplink open (the next
   * tick retries, and the engine's HTTP heartbeat resumes before the lease
   * runs low); a refusal is an authority loss and closes 4403. */
  private async renewLease(): Promise<void> {
    const store = this.server.options.lease, identity = this.identity;
    if (!store || !identity || !this.features.has(UPLINK_FEATURES.lease) || this.state !== "welcomed" || this.leaseRenewing) return;
    this.leaseRenewing = true;
    try {
      const renewed = await store.renew(identity, this.token).catch(() => ({ ok: false, reason: "unavailable" }) as const);
      if (this.state !== "welcomed") return;
      if (renewed.ok) this.leaseExpiresAtMs = Math.max(this.leaseExpiresAtMs, renewed.leaseExpiresAtMs);
      else if (renewed.reason === "authority") this.close(UPLINK_CLOSE.forbidden, "uplink_forbidden", { park: false });
    } finally { this.leaseRenewing = false; }
  }

  /** `idle.v1`: the quiet time the engine reported elapsed on this open
   * uplink. One request in flight. The store's transaction re-checks
   * authority, engine age and durable work, and the engine still proves
   * idleness before its checkpoint, cancelling the request if it is not. */
  private async requestIdleStop(): Promise<void> {
    const store = this.server.options.idle, identity = this.identity, idle = this.idle;
    if (!store || !identity || !idle || this.state !== "welcomed" || !this.flowing || this.idleRequesting) return;
    const due = idle.dueAtMs();
    if (due === null || due > this.now()) return this.scheduleIdle(due);
    this.idleRequesting = true;
    let result: UplinkIdleStopResult;
    try {
      result = await store.request(identity, this.token, randomUUID()).catch(() => "unavailable" as const);
    } finally { this.idleRequesting = false; }
    if (this.state !== "welcomed") return;
    idle.attempted(this.now(), result);
    if (result === "authority") void this.recheck();
    this.scheduleIdle(idle.dueAtMs());
  }

  private scheduleIdle(dueAtMs: number | null): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (dueAtMs === null || !Number.isFinite(dueAtMs) || this.state !== "welcomed") return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; void this.requestIdleStop(); }, Math.max(0, dueAtMs - this.now()));
    this.idleTimer.unref?.();
  }

  /** Readiness writes are bounded per uplink (a burst, then one per
   * interval). A flip inside the interval schedules one trailing write that
   * reads the state when it fires, so the latest readiness always lands. */
  private writeReadiness(): void {
    if (this.presenceTimer || this.state !== "welcomed") return;
    const intervalMs = this.server.options.presenceMinIntervalMs, now = this.now();
    this.presenceTokens = Math.min(PRESENCE_BURST, this.presenceTokens + Math.max(0, now - this.presenceAtMs) / intervalMs);
    this.presenceAtMs = now;
    if (this.presenceTokens >= 1) {
      this.presenceTokens -= 1;
      this.writePresence(true);
      return;
    }
    this.presenceTimer = setTimeout(() => { this.presenceTimer = null; this.writeReadiness(); },
      Math.ceil((1 - this.presenceTokens) * intervalMs));
    this.presenceTimer.unref?.();
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
      ...(lineage.coordinator ? { coordinator: lineage.coordinator } : {}),
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
    // Room for the envelope's t, s and a around d.
    const bytes = Buffer.byteLength(JSON.stringify(d), "utf8") + Buffer.byteLength(t, "utf8") + 64;
    if (bytes > UPLINK_MAX_CONTROL_FRAME_BYTES) { this.outboundTooLarge(t, bytes); return false; }
    const frame = lineage.outbox.push(s => ({ t, text: JSON.stringify({ t, s, a: lineage.inbound.lastContiguous, d }) }));
    if (!frame) { this.close(UPLINK_CLOSE.backpressure, "backpressure", { park: true }); return false; }
    if (this.flowing) this.sendText(frame.text);
    return true;
  }

  /** False when the frame was refused as oversize (the uplink is closing). */
  private send(frame: { t: string; a?: number; d?: Record<string, unknown> }): boolean {
    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > UPLINK_MAX_CONTROL_FRAME_BYTES) { this.outboundTooLarge(frame.t, bytes); return false; }
    this.sendText(text);
    return true;
  }

  /** The engine must close 4400 on a text frame above the cap, so sending
   * one would only start a redial loop. Until the contract can split
   * `auth.sync`, refuse it here: 1011, which the engine answers with its
   * full-jitter backoff. The log names the frame type and size only. */
  private outboundTooLarge(t: string, bytes: number): void {
    this.server.options.logger.warn(
      `[realtime] uplink ${t} frame of ${bytes} bytes exceeds the ${UPLINK_MAX_CONTROL_FRAME_BYTES}-byte cap; closing 1011`);
    this.close(UPLINK_CLOSE.internalError, t === "auth.sync" ? "auth_sync_too_large" : "outbound_frame_too_large", { park: false });
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
    this.admission.release();
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
    for (const timer of [this.helloTimer, this.authTimer, this.ackTimer, this.capabilityTimer, this.presenceTimer, this.idleTimer, ...this.drainTimers])
      if (timer) clearTimeout(timer);
    for (const timer of [this.livenessTimer, this.watermarkTimer, this.authorityTimer]) if (timer) clearInterval(timer);
    this.helloTimer = this.authTimer = this.ackTimer = this.capabilityTimer = this.presenceTimer = this.idleTimer = null;
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
