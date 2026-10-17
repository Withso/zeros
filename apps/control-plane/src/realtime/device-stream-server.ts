import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { RolloutFlagReader } from "../rollout-flags.js";
import type { DeviceSessionAuthority, DeviceSessionPrincipal, DeviceSessionState } from "./device-sessions.js";
import type { DeviceStreamCatalogRead, DeviceStreamCatalogSource, DeviceStreamWorkspace } from "./device-stream-catalog.js";
import {
  DEVICE_STREAM_CLOSE,
  DEVICE_STREAM_CONTRACT,
  DEVICE_STREAM_HEARTBEAT_INTERVAL_MS,
  DEVICE_STREAM_HELLO_TIMEOUT_MS,
  DEVICE_STREAM_MAX_FRAME_BYTES,
  DEVICE_STREAM_MAX_HELLO_BYTES,
  DEVICE_STREAM_MAX_SOCKET_PAYLOAD_BYTES,
  DEVICE_STREAM_PATH,
  DEVICE_STREAM_RESUME_RETENTION_MS,
  DeviceStreamAckSchema,
  DeviceStreamAttachSchema,
  DeviceStreamEnvelopeSchema,
  DeviceStreamHelloSchema,
  DeviceStreamPingSchema,
  DeviceStreamPresenceSetSchema,
  decodeDeviceStreamCursor,
  encodeDeviceStreamCursor,
  negotiateDeviceStreamContract,
  type CapabilityRevokedScope,
  type CatalogResetReason,
  type DeviceCapabilities,
  type PresenceState,
} from "./device-stream-protocol.js";
import { MAX_DRAIN_MS, staggeredDrain } from "./drain.js";
import type { RealtimeSecurityEvent, RealtimeSecurityEventFeed } from "./security-event-feed.js";
import { UplinkAdmission, uplinkSourceAddress, type AdmissionTicket } from "./uplink-admission.js";

/** The S3 device stream reads `device_stream` (process admission) and
 * `presence_in_memory` (per organization), plus change notifications so a
 * flag turned off closes open streams. */
export type DeviceStreamFlags = RolloutFlagReader & { onChange?(listener: () => void): () => void };

export type DeviceStreamNotification = Readonly<{
  id: string;
  kind: "turn.completed" | "turn.failed" | "turn.needs_attention" | "workspace.stopped" | "workspace.funds_low";
  workspaceId: string;
  chatId?: string;
  turnId?: string;
  title: string;
  createdAt: string;
}>;

export type DeviceStreamServerOptions = {
  authority: DeviceSessionAuthority;
  catalog: DeviceStreamCatalogSource;
  flags: DeviceStreamFlags;
  /** The process's security-event feed; access is re-evaluated on its events. */
  securityEvents?: Pick<RealtimeSecurityEventFeed, "subscribe">;
  helloTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** A socket that answers no WebSocket ping for this long is closed 4408. */
  pingTimeoutMs?: number;
  resumeRetentionMs?: number;
  /** Periodic device-session authority re-read; security events trigger it sooner. */
  authorityRecheckMs?: number;
  maxConnections?: number;
  maxPendingHandshakes?: number;
  /** Device sessions (live or parked for resume) held in memory. */
  maxDeviceSessions?: number;
  /** Resumable frames retained per device session; older ones are dropped
   * and a resume from before them yields `catalog.reset`. */
  maxResumeFrames?: number;
  maxResumeBytes?: number;
  /** Bytes the socket may buffer before the stream closes 4429. */
  maxSocketBufferBytes?: number;
  /** Coalescing delay for change-driven catalog re-reads. */
  refreshDelayMs?: number;
  refreshConcurrency?: number;
  presenceDelayMs?: number;
  /** Client frames per connection: a burst, then a steady rate; past it 4429. */
  inboundBurst?: number;
  inboundPerSecond?: number;
  maxAttachments?: number;
  admissionBurst?: number;
  sourceAdmissionBurst?: number;
  sourceAdmissionPerSecond?: number;
  sourceMaxUnadmitted?: number;
  logger?: Pick<Console, "warn">;
  now?: () => number;
  random?: () => number;
};

type ResolvedOptions = Required<Omit<DeviceStreamServerOptions, "securityEvents">> &
  Pick<DeviceStreamServerOptions, "securityEvents">;

export type DeviceStreamCounters = {
  admitted: number;
  resumed: number;
  reset: Record<string, number>;
  refused: Record<string, number>;
  closed: Record<string, number>;
};

type Known = { organizationId: string; version: number; status: string; generation: number; observedState: string };
type BufferedFrame = { seq: number; text: string; bytes: number; atMs: number; revocation: boolean };

/** One device session's stream state. It outlives its connection for the
 * resume window so a reconnect on this instance replays what it missed. */
type DeviceSessionRecord = {
  principal: DeviceSessionPrincipal;
  lineage: string;
  seq: number;
  /** Highest sequence no longer retained; a cursor below it cannot resume. */
  floor: number;
  buffer: BufferedFrame[];
  bufferBytes: number;
  known: Map<string, Known>;
  catalogVersion: number;
  connection: DeviceStreamConnection | null;
  expiry: ReturnType<typeof setTimeout> | null;
};

const ADMISSION_REFILL_MS = 2;
const MAX_PRESENCE_MEMBERS = 256;
const ACK_MIN_INTERVAL_MS = 1_000;
const REFRESH_RETRY_MS = 1_000;

const REVOCATION: Record<Exclude<DeviceSessionState, "live">, { scope: CapabilityRevokedScope; reason: string }> = {
  expired: { scope: "session", reason: "device_session_expired" },
  account: { scope: "account", reason: "account_revoked" },
  device: { scope: "device", reason: "device_revoked" },
  session: { scope: "session", reason: "session_revoked" },
};

/** Server side of the S3 device stream (s3-client-contract.md Part 2). One
 * WebSocket per signed-in device session. Catalog and lifecycle state comes
 * from durable rows: change notifications and security events only say which
 * accounts and workspaces to re-read, and every frame is the diff between
 * the re-read and what that device session was last told. */
export class DeviceStreamServer {
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: DEVICE_STREAM_MAX_SOCKET_PAYLOAD_BYTES });
  private readonly connections = new Set<DeviceStreamConnection>();
  private readonly records = new Map<string, DeviceSessionRecord>();
  private readonly byAccount = new Map<string, Set<DeviceSessionRecord>>();
  private readonly presence = new Map<string, Map<string, { state: PresenceState; since: string; connections: Set<DeviceStreamConnection> }>>();
  private readonly presenceDirty = new Set<string>();
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly dirtyAccounts = new Map<string, Set<string> | null>();
  private readonly refreshing = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly dirtyWorkspaces = new Set<string>();
  private workspaceTimer: ReturnType<typeof setTimeout> | null = null;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly admission: UplinkAdmission;
  private readonly stopFlagListener: (() => void) | null;
  private readonly stopSecurityEvents: (() => void) | null;
  private pendingHandshakes = 0;
  private closed = false;
  private draining = false;
  readonly counters: DeviceStreamCounters = { admitted: 0, resumed: 0, reset: {}, refused: {}, closed: {} };
  readonly options: ResolvedOptions;

  constructor(options: DeviceStreamServerOptions) {
    this.options = {
      helloTimeoutMs: DEVICE_STREAM_HELLO_TIMEOUT_MS,
      heartbeatIntervalMs: DEVICE_STREAM_HEARTBEAT_INTERVAL_MS,
      pingTimeoutMs: 45_000,
      resumeRetentionMs: DEVICE_STREAM_RESUME_RETENTION_MS,
      authorityRecheckMs: 60_000,
      maxConnections: 20_000,
      maxPendingHandshakes: 256,
      maxDeviceSessions: 50_000,
      maxResumeFrames: 1_000,
      maxResumeBytes: 1024 * 1024,
      maxSocketBufferBytes: 2 * 1024 * 1024,
      refreshDelayMs: 25,
      refreshConcurrency: 4,
      presenceDelayMs: 250,
      inboundBurst: 40,
      inboundPerSecond: 20,
      maxAttachments: 64,
      admissionBurst: 500,
      sourceAdmissionBurst: 100,
      sourceAdmissionPerSecond: 30,
      sourceMaxUnadmitted: 64,
      logger: console,
      now: Date.now,
      random: Math.random,
      ...options,
    };
    const heartbeat = this.options.heartbeatIntervalMs;
    if (!Number.isSafeInteger(heartbeat) || heartbeat < 5_000 || heartbeat > 60_000) throw new Error("device stream heartbeat must be 5-60 s");
    this.admission = new UplinkAdmission({
      globalBurst: this.options.admissionBurst, globalRefillMs: ADMISSION_REFILL_MS,
      sourceBurst: this.options.sourceAdmissionBurst, sourcePerSecond: this.options.sourceAdmissionPerSecond,
      sourceMaxUnadmitted: this.options.sourceMaxUnadmitted,
    });
    this.stopFlagListener = this.options.flags.onChange?.(() => this.applyRollout()) ?? null;
    this.stopSecurityEvents = this.options.securityEvents?.subscribe({
      events: batch => this.securityEvents(batch),
      gap: () => this.refreshEverything(),
    }) ?? null;
    this.recheckTimer = setInterval(() => this.recheckAuthority(), this.options.authorityRecheckMs);
    this.recheckTimer.unref?.();
  }

  get size(): number { return this.connections.size; }

  enabled(): boolean { return this.options.flags.anyEnabled("device_stream"); }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (request.url !== DEVICE_STREAM_PATH) return false;
    socket.on("error", () => {});
    const refuse = (reason: string, status: number, text: string) => {
      this.count("refused", reason);
      if (!socket.destroyed)
        socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
      return true;
    };
    if (this.closed || this.draining) return refuse("draining", 503, "Service Unavailable");
    if (!this.enabled()) return refuse("disabled", 404, "Not Found");
    if (request.method !== "GET" || head.byteLength > 0) return refuse("invalid", 400, "Bad Request");
    if (this.connections.size >= this.options.maxConnections || this.pendingHandshakes >= this.options.maxPendingHandshakes)
      return refuse("capacity", 503, "Service Unavailable");
    const ticket = this.admission.admit(uplinkSourceAddress(request));
    if (ticket === "rate_limited") return refuse("rate_limited", 429, "Too Many Requests");
    if (ticket === "capacity") return refuse("capacity", 503, "Service Unavailable");
    this.pendingHandshakes += 1;
    let settled = false;
    const settle = () => { if (!settled) { settled = true; this.pendingHandshakes -= 1; } };
    socket.once("close", () => { settle(); ticket.release(); });
    try {
      this.wss.handleUpgrade(request, socket, head, ws => {
        settle();
        if (this.closed || this.draining) { ticket.release(); ws.close(DEVICE_STREAM_CLOSE.draining, "draining"); return; }
        this.connections.add(new DeviceStreamConnection(this, ws, ticket));
      });
    } catch {
      settle();
      ticket.release();
      socket.destroy();
    }
    return true;
  }

  /** Spreads `drain` + 4503 over the window (the C0 staggered drain). */
  drain(windowMs: number): Promise<void> {
    this.draining = true;
    const window = Math.max(0, Math.min(MAX_DRAIN_MS, Math.floor(windowMs)));
    return staggeredDrain({
      items: this.connections,
      windowMs: window,
      random: this.options.random,
      pending: () => this.connections.size,
      retire: connection => connection.drain(Math.floor(Math.min(0.999_999, Math.max(0, this.options.random())) * 5_000)),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopFlagListener?.();
    this.stopSecurityEvents?.();
    for (const timer of [this.recheckTimer]) if (timer) clearInterval(timer);
    for (const timer of [this.refreshTimer, this.workspaceTimer, this.presenceTimer]) if (timer) clearTimeout(timer);
    for (const connection of [...this.connections]) connection.close(DEVICE_STREAM_CLOSE.goingAway, "going_away", { park: false });
    for (const record of [...this.records.values()]) this.dropRecord(record);
    this.wss.close();
  }

  /** The flag turned off: every stream closes 4404 without resume; the
   * client's next `POST /v1/device-sessions` answers 404 and it polls. */
  applyRollout(): void {
    if (this.enabled()) return;
    for (const connection of [...this.connections]) connection.close(DEVICE_STREAM_CLOSE.disabled, "device_stream_disabled", { park: false });
  }

  /** Workspace change hint (`zeros_cloud_workspace_catalog`). */
  workspaceChanged(workspaceId: string): void {
    if (this.closed) return;
    this.dirtyWorkspaces.add(workspaceId);
    this.workspaceTimer ??= this.timer(() => { this.workspaceTimer = null; void this.flushWorkspaces(); }, this.options.refreshDelayMs);
  }

  /** Listener (re)connected or a gap: re-read every connected account and
   * re-check every device session, since any hint may have been lost. */
  refreshEverything(): void {
    for (const account of this.connectedAccounts()) this.scheduleAccount(account, null);
    this.recheckAuthority();
  }

  /** Fans a notification out to every device session whose account
   * currently holds the workspace; parked sessions get it on resume. */
  publishNotification(notification: DeviceStreamNotification): void {
    for (const record of this.records.values())
      if (record.known.has(notification.workspaceId)) this.emit(record, "notification", { ...notification }, true);
  }

  /** Revokes runtime capabilities on matching device sessions (B's S-3
   * producer). A workspace-scoped revocation also re-reads the catalog for
   * those accounts, so a lost member gets `op: "remove"`. */
  revokeCapabilities(target: { accountUserId?: string; workspaceId?: string; organizationId?: string },
    scope: CapabilityRevokedScope, reason: string): void {
    for (const record of this.records.values()) {
      if (target.accountUserId && record.principal.accountUserId !== target.accountUserId) continue;
      if (target.workspaceId && !record.known.has(target.workspaceId)) continue;
      if (target.organizationId && ![...record.known.values()].some(known => known.organizationId === target.organizationId)) continue;
      this.emit(record, "capability.revoked", { ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}), reason, scope }, true);
      this.scheduleAccount(record.principal.accountUserId, target.workspaceId ? [target.workspaceId] : null);
    }
  }

  /** Pushes renewed capabilities for an attached runtime connection. False
   * unless that device session is connected here with the attachment. */
  pushCapabilityRenewal(deviceSessionId: string, workspaceId: string, clientSessionId: string, capabilities: DeviceCapabilities): boolean {
    const connection = this.records.get(deviceSessionId)?.connection;
    if (!connection?.isAttached(workspaceId, clientSessionId)) return false;
    return connection.sendFrame("capability.renewed", { workspaceId, clientSessionId, capabilities });
  }

  // ---- connection lifecycle (internal) ----

  /** @internal Resolves a consumed hello into a ready stream. */
  async open(connection: DeviceStreamConnection, principal: DeviceSessionPrincipal,
    resume: { cursor: string } | undefined): Promise<void> {
    const existing = this.records.get(principal.deviceSessionId);
    if (existing && existing.principal.accountUserId !== principal.accountUserId) this.dropRecord(existing);
    const previous = this.records.get(principal.deviceSessionId);
    let resumed = false;
    let reset: CatalogResetReason | null = null;
    let replay: BufferedFrame[] = [];
    if (resume) {
      const cursor = decodeDeviceStreamCursor(resume.cursor);
      if (previous && cursor && cursor.lineage === previous.lineage) {
        if (cursor.sequence <= previous.seq && cursor.sequence >= previous.floor) {
          resumed = true;
          const missed = previous.buffer.filter(frame => frame.seq > cursor.sequence);
          // S3: replayed revocations go first, then everything else in order.
          replay = [...missed.filter(frame => frame.revocation), ...missed.filter(frame => !frame.revocation)];
        } else reset = "resume_expired";
      } else reset = "instance_changed";
    }
    let record: DeviceSessionRecord;
    if (resumed && previous) {
      record = previous;
      record.principal = principal;
      record.connection?.close(DEVICE_STREAM_CLOSE.superseded, "superseded", { park: false, keepRecord: true });
    } else {
      // A fresh lineage starts from the current catalog, without frames:
      // the client reads the REST snapshot after `ready`.
      let baseline: DeviceStreamCatalogRead;
      try { baseline = await this.options.catalog.read(principal.accountUserId, null); }
      catch { connection.close(DEVICE_STREAM_CLOSE.internalError, "internal_error", { park: false }); return; }
      if (connection.isClosed()) return;
      if (previous) {
        previous.connection?.close(DEVICE_STREAM_CLOSE.superseded, "superseded", { park: false, keepRecord: true });
        this.dropRecord(previous);
      }
      record = this.newRecord(principal, baseline);
    }
    if (connection.isClosed() || this.closed) return;
    if (this.draining) { connection.close(DEVICE_STREAM_CLOSE.draining, "draining", { park: false }); return; }
    if (record.expiry) clearTimeout(record.expiry);
    record.expiry = null;
    record.connection = connection;
    connection.bind(record);
    this.counters.admitted += 1;
    if (resumed) this.counters.resumed += 1;
    if (reset) this.counters.reset[reset] = (this.counters.reset[reset] ?? 0) + 1;
    connection.sendFrame("ready", {
      deviceSessionId: principal.deviceSessionId, cursor: encodeDeviceStreamCursor(record.lineage, record.seq), resumed,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs, contract: DEVICE_STREAM_CONTRACT,
    });
    if (reset) connection.sendFrame("catalog.reset", { reason: reset });
    for (const frame of replay) connection.sendText(frame.text);
    // Changes while parked, or while the baseline read ran, arrive as diffs.
    this.scheduleAccount(principal.accountUserId, null);
  }

  /** @internal */ forget(connection: DeviceStreamConnection, park: boolean, keepRecord: boolean): void {
    this.connections.delete(connection);
    this.dropPresence(connection);
    const record = connection.record;
    if (!record || record.connection !== connection) return;
    record.connection = null;
    if (keepRecord) return;
    if (!park || this.closed) { this.dropRecord(record); return; }
    record.expiry = this.timer(() => { if (!record.connection) this.dropRecord(record); }, this.options.resumeRetentionMs);
  }

  /** @internal */ ack(record: DeviceSessionRecord, cursor: string): boolean {
    const decoded = decodeDeviceStreamCursor(cursor);
    if (!decoded || decoded.lineage !== record.lineage || decoded.sequence > record.seq) return false;
    if (decoded.sequence <= record.floor) return true;
    record.floor = decoded.sequence;
    let drop = 0;
    while (drop < record.buffer.length && record.buffer[drop]!.seq <= decoded.sequence) {
      record.bufferBytes -= record.buffer[drop]!.bytes;
      drop += 1;
    }
    if (drop) record.buffer = record.buffer.slice(drop);
    return true;
  }

  /** @internal */ setPresence(connection: DeviceStreamConnection, workspaceId: string, state: PresenceState): "ok" | "unavailable" | "ignored" {
    const record = connection.record;
    const known = record?.known.get(workspaceId);
    if (!record || !known) return "unavailable";
    if (!this.options.flags.enabled(known.organizationId, "presence_in_memory")) return "ignored";
    let members = this.presence.get(workspaceId);
    if (!members) this.presence.set(workspaceId, members = new Map());
    const userId = record.principal.accountUserId;
    const member = members.get(userId);
    if (!member) members.set(userId, { state, since: new Date(this.options.now()).toISOString(), connections: new Set([connection]) });
    else {
      member.connections.add(connection);
      if (member.state === state) return "ok";
      member.state = state;
      member.since = new Date(this.options.now()).toISOString();
    }
    this.markPresence(workspaceId);
    return "ok";
  }

  /** @internal */ count(kind: "refused" | "closed", reason: string): void {
    this.counters[kind][reason] = (this.counters[kind][reason] ?? 0) + 1;
  }

  /** @internal */ isDraining(): boolean { return this.draining || this.closed; }

  // ---- fan-out ----

  private newRecord(principal: DeviceSessionPrincipal, baseline: DeviceStreamCatalogRead): DeviceSessionRecord {
    while (this.records.size >= this.options.maxDeviceSessions) {
      const parked = [...this.records.values()].find(record => !record.connection);
      if (!parked) break;
      this.dropRecord(parked);
    }
    const record: DeviceSessionRecord = {
      principal, lineage: randomBytes(16).toString("base64url"), seq: 0, floor: 0, buffer: [], bufferBytes: 0,
      known: new Map(baseline.workspaces.map(workspace => [workspace.id, known(workspace)])),
      catalogVersion: baseline.catalogVersion, connection: null, expiry: null,
    };
    this.records.set(principal.deviceSessionId, record);
    let set = this.byAccount.get(principal.accountUserId);
    if (!set) this.byAccount.set(principal.accountUserId, set = new Set());
    set.add(record);
    return record;
  }

  private dropRecord(record: DeviceSessionRecord): void {
    if (record.expiry) clearTimeout(record.expiry);
    record.expiry = null;
    if (this.records.get(record.principal.deviceSessionId) === record) this.records.delete(record.principal.deviceSessionId);
    const set = this.byAccount.get(record.principal.accountUserId);
    set?.delete(record);
    if (set?.size === 0) this.byAccount.delete(record.principal.accountUserId);
  }

  /** Queues a resumable or plain frame for one device session. Resumable
   * frames are retained for replay even while the session is parked. */
  private emit(record: DeviceSessionRecord, t: string, d: Record<string, unknown>, resumable: boolean): void {
    if (!resumable) { record.connection?.sendFrame(t, d); return; }
    record.seq += 1;
    const text = JSON.stringify({ t, d, c: encodeDeviceStreamCursor(record.lineage, record.seq) });
    const bytes = Buffer.byteLength(text, "utf8");
    const now = this.options.now();
    record.buffer.push({ seq: record.seq, text, bytes, atMs: now, revocation: t === "capability.revoked" });
    record.bufferBytes += bytes;
    while (record.buffer.length > 0 && (record.buffer.length > this.options.maxResumeFrames ||
        record.bufferBytes > this.options.maxResumeBytes || now - record.buffer[0]!.atMs > this.options.resumeRetentionMs)) {
      const dropped = record.buffer.shift()!;
      record.bufferBytes -= dropped.bytes;
      record.floor = dropped.seq;
    }
    record.connection?.sendText(text);
  }

  private connectedAccounts(): string[] {
    const accounts = new Set<string>();
    for (const record of this.records.values()) if (record.connection?.isReady()) accounts.add(record.principal.accountUserId);
    return [...accounts];
  }

  private scheduleAccount(accountUserId: string, workspaceIds: readonly string[] | null): void {
    if (this.closed) return;
    const current = this.dirtyAccounts.get(accountUserId);
    if (workspaceIds === null || current === null) this.dirtyAccounts.set(accountUserId, null);
    else this.dirtyAccounts.set(accountUserId, new Set([...(current ?? []), ...workspaceIds]));
    this.armRefresh(this.options.refreshDelayMs);
  }

  private armRefresh(delayMs: number): void {
    this.refreshTimer ??= this.timer(() => { this.refreshTimer = null; this.pumpRefresh(); }, delayMs);
  }

  private pumpRefresh(): void {
    for (const [account, filter] of [...this.dirtyAccounts]) {
      if (this.refreshing.size >= this.options.refreshConcurrency) break;
      if (this.refreshing.has(account)) continue;
      this.dirtyAccounts.delete(account);
      this.refreshing.add(account);
      void this.refreshAccount(account, filter).catch(() => {
        // Nothing was applied; the same re-read runs again shortly.
        const timer = this.timer(() => this.scheduleAccount(account, filter ? [...filter] : null), REFRESH_RETRY_MS);
        void timer;
      }).finally(() => {
        this.refreshing.delete(account);
        if (this.dirtyAccounts.size > 0) this.armRefresh(0);
      });
    }
  }

  private async refreshAccount(accountUserId: string, filter: ReadonlySet<string> | null): Promise<void> {
    const live = () => [...(this.byAccount.get(accountUserId) ?? [])].filter(record => record.connection?.isReady());
    if (live().length === 0) return;
    const read = await this.options.catalog.read(accountUserId, filter ? [...filter] : null);
    if (this.closed) return;
    for (const record of live()) this.apply(record, read, filter);
  }

  /** Diffs a re-read against what the device session was last told. */
  private apply(record: DeviceSessionRecord, read: DeviceStreamCatalogRead, filter: ReadonlySet<string> | null): void {
    const rows = new Map(read.workspaces.map(workspace => [workspace.id, workspace]));
    const ids = filter ? [...filter] : [...new Set([...record.known.keys(), ...rows.keys()])];
    record.catalogVersion = Math.max(record.catalogVersion, read.catalogVersion);
    const catalogVersion = record.catalogVersion;
    for (const id of ids) {
      const row = rows.get(id), previous = record.known.get(id);
      if (row) {
        if (previous && row.version <= previous.version) continue;
        record.known.set(id, known(row));
        this.emit(record, "catalog.changed", { workspaceId: id, version: row.version, catalogVersion, op: "upsert", workspace: row.document }, true);
        if (previous && row.generation >= 1 && (previous.status !== row.status || previous.generation !== row.generation ||
            previous.observedState !== row.observedState))
          this.emit(record, "lifecycle.changed", { workspaceId: id, version: row.version, status: row.status,
            generation: row.generation, observedState: row.observedState }, true);
      } else if (previous && (filter || read.complete)) {
        // Lost access (or deleted): revoke runtime capabilities first, then
        // a single remove, and nothing more for this workspace.
        record.known.delete(id);
        this.emit(record, "capability.revoked", { workspaceId: id, reason: "workspace_access_lost", scope: "workspace" }, true);
        this.emit(record, "catalog.changed", { workspaceId: id, version: previous.version, catalogVersion, op: "remove" }, true);
        if (record.connection) { this.dropPresence(record.connection, id); record.connection.detachWorkspace(id); }
      }
    }
  }

  private async flushWorkspaces(): Promise<void> {
    const ids = [...this.dirtyWorkspaces];
    this.dirtyWorkspaces.clear();
    if (ids.length === 0 || this.closed) return;
    const accounts = new Set<string>();
    for (const record of this.records.values())
      if (record.connection?.isReady() && ids.some(id => record.known.has(id))) accounts.add(record.principal.accountUserId);
    const connected = this.connectedAccounts();
    try {
      for (const account of await this.options.catalog.candidates(ids, connected)) accounts.add(account);
    } catch {
      for (const account of connected) accounts.add(account);
    }
    for (const account of accounts) this.scheduleAccount(account, ids);
  }

  private async refreshOrganization(organizationId: string): Promise<void> {
    const accounts = new Set<string>();
    for (const record of this.records.values())
      if (record.connection?.isReady() && [...record.known.values()].some(known => known.organizationId === organizationId))
        accounts.add(record.principal.accountUserId);
    const connected = this.connectedAccounts();
    try {
      for (const account of await this.options.catalog.organizationAccounts(organizationId, connected)) accounts.add(account);
    } catch {
      for (const account of connected) accounts.add(account);
    }
    for (const account of accounts) this.scheduleAccount(account, null);
  }

  private securityEvents(batch: readonly RealtimeSecurityEvent[]): void {
    if (this.closed) return;
    const recheck = new Set<DeviceSessionRecord>();
    for (const event of batch) {
      switch (event.kind) {
        case "account.revoked":
        case "account.authorization_changed":
          if (!event.userId) { this.refreshEverything(); return; }
          for (const record of this.byAccount.get(event.userId) ?? []) recheck.add(record);
          this.scheduleAccount(event.userId, null);
          break;
        case "session.revoked":
          for (const record of this.records.values())
            if ((event.providerSessionId && record.principal.providerSessionId === event.providerSessionId) ||
                (event.userId && record.principal.accountUserId === event.userId)) recheck.add(record);
          break;
        case "organization.access_revoked":
          if (event.userId) this.scheduleAccount(event.userId, null);
          else if (event.organizationId) void this.refreshOrganization(event.organizationId);
          break;
        case "organization.authorization_changed":
          if (event.organizationId) void this.refreshOrganization(event.organizationId);
          break;
        case "workspace.authorization_changed":
          if (event.workspaceId) this.workspaceChanged(event.workspaceId);
          break;
        case "organization.data_changed":
          break;
      }
    }
    if (recheck.size) void this.recheckRecords([...recheck]);
  }

  private recheckAuthority(): void {
    void this.recheckRecords([...this.records.values()].filter(record => record.connection));
  }

  private async recheckRecords(records: DeviceSessionRecord[]): Promise<void> {
    if (records.length === 0 || this.closed) return;
    let states: Map<string, DeviceSessionState>;
    try { states = await this.options.authority.check(records.map(record => record.principal.deviceSessionId)); }
    catch { return; }
    for (const record of records) {
      const state = states.get(record.principal.deviceSessionId) ?? "expired";
      if (state === "live" || this.records.get(record.principal.deviceSessionId) !== record) continue;
      const revocation = REVOCATION[state];
      this.emit(record, "capability.revoked", { reason: revocation.reason, scope: revocation.scope }, true);
      const connection = record.connection;
      this.dropRecord(record);
      connection?.close(DEVICE_STREAM_CLOSE.unauthenticated, "unauthenticated", { park: false });
    }
  }

  // ---- presence ----

  private dropPresence(connection: DeviceStreamConnection, onlyWorkspaceId?: string): void {
    for (const [workspaceId, members] of this.presence) {
      if (onlyWorkspaceId && workspaceId !== onlyWorkspaceId) continue;
      for (const [userId, member] of members) {
        if (!member.connections.delete(connection) || member.connections.size > 0) continue;
        members.delete(userId);
        this.markPresence(workspaceId);
      }
      if (members.size === 0) this.presence.delete(workspaceId);
    }
  }

  private markPresence(workspaceId: string): void {
    this.presenceDirty.add(workspaceId);
    this.presenceTimer ??= this.timer(() => { this.presenceTimer = null; this.flushPresence(); }, this.options.presenceDelayMs);
  }

  private flushPresence(): void {
    const dirty = [...this.presenceDirty];
    this.presenceDirty.clear();
    for (const workspaceId of dirty) {
      const members = [...(this.presence.get(workspaceId)?.entries() ?? [])].slice(0, MAX_PRESENCE_MEMBERS)
        .map(([userId, member]) => ({ userId, state: member.state, since: member.since }));
      for (const record of this.records.values()) {
        const known = record.known.get(workspaceId);
        if (!known || !record.connection?.isReady() || !this.options.flags.enabled(known.organizationId, "presence_in_memory")) continue;
        this.emit(record, "presence.changed", { workspaceId, members }, false);
      }
    }
  }

  private timer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  }
}

function known(workspace: DeviceStreamWorkspace): Known {
  return { organizationId: workspace.organizationId, version: workspace.version, status: workspace.status,
    generation: workspace.generation, observedState: workspace.observedState };
}

type ConnectionState = "hello" | "opening" | "ready" | "closed";

class DeviceStreamConnection {
  record: DeviceSessionRecord | null = null;
  private state: ConnectionState = "hello";
  private readonly helloTimer: ReturnType<typeof setTimeout>;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastPongMs: number;
  private tokens: number;
  private refilledAtMs: number;
  private lastAckMs = -Infinity;
  private readonly attachments = new Map<string, Set<string>>();
  private attachmentCount = 0;

  constructor(private readonly server: DeviceStreamServer, private readonly ws: WebSocket, private readonly admission: AdmissionTicket) {
    const now = server.options.now();
    this.lastPongMs = now;
    this.tokens = server.options.inboundBurst;
    this.refilledAtMs = now;
    this.helloTimer = setTimeout(() => this.close(DEVICE_STREAM_CLOSE.pingTimeout, "hello_timeout", { park: false }),
      server.options.helloTimeoutMs);
    this.helloTimer.unref?.();
    ws.on("message", (data, isBinary) => this.receive(data, isBinary));
    ws.on("pong", () => { this.lastPongMs = this.server.options.now(); });
    ws.on("close", () => this.closed());
    ws.on("error", () => {});
  }

  isClosed(): boolean { return this.state === "closed"; }
  isReady(): boolean { return this.state === "ready"; }

  isAttached(workspaceId: string, clientSessionId: string): boolean {
    return this.attachments.get(workspaceId)?.has(clientSessionId) ?? false;
  }

  detachWorkspace(workspaceId: string): void {
    const set = this.attachments.get(workspaceId);
    if (!set) return;
    this.attachmentCount -= set.size;
    this.attachments.delete(workspaceId);
  }

  bind(record: DeviceSessionRecord): void {
    this.record = record;
    this.state = "ready";
    this.admission.release();
    this.heartbeat = setInterval(() => this.beat(), this.server.options.heartbeatIntervalMs);
    this.heartbeat.unref?.();
  }

  sendFrame(t: string, d: Record<string, unknown>): boolean {
    return this.sendText(JSON.stringify({ t, d }));
  }

  sendText(text: string): boolean {
    if (this.state === "closed" || this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > this.server.options.maxSocketBufferBytes) {
      // The client resumes from its last cursor; the record keeps the frames.
      this.close(DEVICE_STREAM_CLOSE.backpressure, "backpressure", { park: true });
      return false;
    }
    this.ws.send(text);
    return true;
  }

  drain(reconnectAfterMs: number): void {
    if (this.state === "closed") return;
    if (this.state === "ready") this.sendFrame("drain", { reconnectAfterMs });
    this.close(DEVICE_STREAM_CLOSE.draining, "draining", { park: true });
  }

  close(code: number, reason: string, options: { park: boolean; keepRecord?: boolean }): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.stopTimers();
    this.admission.release();
    this.server.count("closed", reason);
    this.server.forget(this, options.park, options.keepRecord ?? false);
    try { this.ws.close(code, reason); } catch { this.ws.terminate(); }
    const kill = setTimeout(() => this.ws.terminate(), 2_000);
    kill.unref?.();
  }

  private closed(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.stopTimers();
    this.admission.release();
    this.server.count("closed", "peer_closed");
    this.server.forget(this, true, false);
  }

  private stopTimers(): void {
    clearTimeout(this.helloTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private beat(): void {
    const now = this.server.options.now();
    if (now - this.lastPongMs > this.server.options.pingTimeoutMs) {
      this.close(DEVICE_STREAM_CLOSE.pingTimeout, "ping_timeout", { park: true });
      return;
    }
    this.sendFrame("heartbeat", { ts: now });
    try { this.ws.ping(); } catch { /* the close event follows */ }
  }

  private take(): boolean {
    const now = this.server.options.now();
    const options = this.server.options;
    this.tokens = Math.min(options.inboundBurst, this.tokens + ((now - this.refilledAtMs) / 1_000) * options.inboundPerSecond);
    this.refilledAtMs = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private receive(data: RawData, isBinary: boolean): void {
    if (this.state === "closed") return;
    if (!this.take()) { this.close(DEVICE_STREAM_CLOSE.backpressure, "rate_limited", { park: true }); return; }
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    const limit = this.state === "hello" ? DEVICE_STREAM_MAX_HELLO_BYTES : DEVICE_STREAM_MAX_FRAME_BYTES;
    if (isBinary || buffer.byteLength > limit) { this.invalid(isBinary ? "frame_invalid" : "frame_too_large"); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(buffer.toString("utf8")); } catch { this.invalid("frame_invalid"); return; }
    const envelope = DeviceStreamEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) { this.invalid("frame_invalid"); return; }
    const { t, d } = envelope.data;
    if (this.state === "hello") {
      if (t !== "hello") { this.invalid("hello_required"); return; }
      clearTimeout(this.helloTimer);
      this.state = "opening";
      void this.hello(d);
      return;
    }
    if (this.state === "opening") { this.invalid("hello_pending"); return; }
    this.frame(t, d);
  }

  private async hello(d: Record<string, unknown>): Promise<void> {
    const hello = DeviceStreamHelloSchema.safeParse(d);
    if (!hello.success) { this.invalid("frame_invalid"); return; }
    if (negotiateDeviceStreamContract(hello.data.contract) === null) {
      this.close(DEVICE_STREAM_CLOSE.contractUnsupported, "contract_unsupported", { park: false });
      return;
    }
    let principal: DeviceSessionPrincipal | null;
    try { principal = await this.server.options.authority.consume(hello.data.ticket); }
    catch { this.close(DEVICE_STREAM_CLOSE.internalError, "internal_error", { park: false }); return; }
    if (this.state === "closed") return;
    if (!principal) { this.close(DEVICE_STREAM_CLOSE.unauthenticated, "unauthenticated", { park: false }); return; }
    if (this.server.isDraining()) { this.close(DEVICE_STREAM_CLOSE.draining, "draining", { park: false }); return; }
    await this.server.open(this, principal, hello.data.resume ? { cursor: hello.data.resume.cursor } : undefined);
  }

  private frame(t: string, d: Record<string, unknown>): void {
    const record = this.record!;
    switch (t) {
      case "ping": {
        const ping = DeviceStreamPingSchema.safeParse(d);
        if (!ping.success) { this.invalid("frame_invalid"); return; }
        this.sendFrame("pong", { ts: ping.data.ts });
        return;
      }
      case "ack": {
        const ack = DeviceStreamAckSchema.safeParse(d);
        if (!ack.success) { this.invalid("frame_invalid"); return; }
        const now = this.server.options.now();
        if (now - this.lastAckMs < ACK_MIN_INTERVAL_MS) return;
        this.lastAckMs = now;
        if (!this.server.ack(record, ack.data.cursor)) this.invalid("cursor_invalid");
        return;
      }
      case "presence.set": {
        const presence = DeviceStreamPresenceSetSchema.safeParse(d);
        if (!presence.success) { this.invalid("frame_invalid"); return; }
        if (this.server.setPresence(this, presence.data.workspaceId, presence.data.state) === "unavailable")
          this.error("workspace_unavailable", "Workspace is not available");
        return;
      }
      case "attach":
      case "detach": {
        const attach = DeviceStreamAttachSchema.safeParse(d);
        if (!attach.success) { this.invalid("frame_invalid"); return; }
        const { workspaceId, clientSessionId } = attach.data;
        if (t === "detach") {
          const set = this.attachments.get(workspaceId);
          if (set?.delete(clientSessionId)) this.attachmentCount -= 1;
          if (set?.size === 0) this.attachments.delete(workspaceId);
          return;
        }
        if (!record.known.has(workspaceId)) { this.error("workspace_unavailable", "Workspace is not available"); return; }
        let set = this.attachments.get(workspaceId);
        if (set?.has(clientSessionId)) return;
        if (this.attachmentCount >= this.server.options.maxAttachments) { this.error("attachments_exceeded", "Too many attached runtime sessions"); return; }
        if (!set) this.attachments.set(workspaceId, set = new Set());
        set.add(clientSessionId);
        this.attachmentCount += 1;
        return;
      }
      default:
        // Unknown client frame types are reported, not fatal, so a newer
        // client degrades instead of reconnecting in a loop.
        this.error("frame_unknown", "Unknown frame type");
    }
  }

  private error(code: string, message: string): void {
    this.sendFrame("error", { code, message, fatal: false });
  }

  private invalid(reason: string): void {
    if (this.state === "ready") this.sendFrame("error", { code: reason, message: "Invalid frame", fatal: true });
    this.close(DEVICE_STREAM_CLOSE.frameInvalid, reason, { park: this.state === "ready" });
  }
}
