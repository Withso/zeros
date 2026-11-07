// The app keeps its ordinary bridge and one-use connect ticket. Each control-
// plane replica dials the worker's private Boat route; no worker rendezvous or
// cross-replica app affinity is needed. Only app sockets are retained here.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { CLOUD_V2_MAX_FRAME_BYTES, CloudV2WorkerFrameSchema, type CloudV2ControlFrame } from "./contract.js";
import type { PostgresSecurityEventBroker } from "../security-events.js";
import type { CloudV2Store, CloudV2Workspace, CloudV2WorkerBinding } from "./store.js";
import { isCloudV2Token } from "./tokens.js";
import { dialWorker, workerSupportsCheckout, workerSupportsMcp, workerSupportsSetup, workerSupportsRepositorySetup, workerSupportsGithub, workerSupportsGitIdentity, workerSupportsGithubUserTokens, workerSupportsAgentInteractions, workerSupportsCodeReview, workerSupportsHistoryReplacement, workerSupportsEnvironment, workerSupportsRuntimeUpdate, workerSupportsPush, type WorkerRoute } from "./worker-connection.js";
import { emitCloudV2Timing, type CloudV2TimingRecord } from "./lifecycle.js";
import { isGithubAccessRevoked, isGithubTemporary } from "../github-availability.js";
import { CLOUD_SOURCE_REFRESH_MS, type CloudSourceContinuation, type CloudSourceProof } from "./source-authority.js";

/** Bounds a lost cross-replica revocation notice for app frames between reads. */
const APP_AUTHORITY_WINDOW_MS = 5_000;
/** Retry spacing for a temporary source failure inside the original grace. */
const SOURCE_RETRY_MS = 10_000, SOURCE_RETRY_MAX_MS = 60_000;
export const CLOUD_V2_BRIDGE_PROTOCOL = "zeros.cloud.v2";
export const CLOUD_V2_EXPLICIT_WAKE_PROTOCOL = "zeros.cloud.v2.explicit-wake";
const BRIDGE_PATH = /^\/v2\/cloud\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/bridge$/;
const CONFIG_REFRESH_MS = 12 * 60 * 60_000;
const MAX_QUEUED_FRAMES = 64;
const MAX_QUEUED_OUTPUT_FRAMES = 1024;
const MAX_QUEUED_OUTPUT_BYTES = 4 * 1024 * 1024;
type ConfigFrame = Extract<CloudV2ControlFrame, { t: "config" }>;
type ActivityReply = Omit<Extract<CloudV2ControlFrame, { t: "activity-reply" }>, "t" | "id">;

export type CloudV2RelayDeps = {
  store: Pick<CloudV2Store, "consumeConnectTicket" | "get" | "accessEpoch" | "appAccessSnapshot" | "loginRevision">;
  securityEvents?: Pick<PostgresSecurityEventBroker, "start" | "subscribe">;
  /** proof, when present, comes from this room's current allowed database read. */
  config(workspace: CloudV2Workspace, mode?: "admission" | "continuation", proof?: CloudSourceProof): Promise<ConfigFrame>;
  runtimeAdmission?: {
    admitClient(workspaceId: string, clientId: string): Promise<boolean>;
    renewClient(workspaceId: string, clientId: string): Promise<boolean>;
    releaseClient(workspaceId: string, clientId: string): Promise<void>;
  };
  authorizeSource?(workspace: CloudV2Workspace): Promise<void>;
  continueSource?(workspace: CloudV2Workspace, proof?: CloudSourceProof): Promise<CloudSourceContinuation>;
  workerRoute(workspaceId: string): Promise<WorkerRoute | null>;
  workerActivity?(binding: CloudV2WorkerBinding, idle: boolean): Promise<ActivityReply | null>;
  mintWorkerToken(workspaceId: string, bootId: string): string;
  wake(workspace: CloudV2Workspace): Promise<void>;
  answerOffline(workspace: CloudV2Workspace, frame: unknown): Promise<unknown | null>;
  logger?: Pick<Console, "warn">;
  timing?: (record: CloudV2TimingRecord) => void;
  now?: () => number;
  retryBaseMs?: number; retryMaxMs?: number; idleMs?: number;
};
type ConfigFlight = { worker: WebSocket; requested: boolean; force: boolean; promise: Promise<boolean> };
type DeliveredPrompt = { worker: WebSocket; agentId?: string };
type Authority = "allowed" | "revoked" | "unavailable";
type Room = {
  workspace: CloudV2Workspace; accessEpoch: string; revoked: boolean;
  worker: WebSocket | null; ready: boolean; loginRevision: string | null; configAt: number;
  workerBinding?: CloudV2WorkerBinding;
  configFlight?: ConfigFlight; dialing?: Promise<void>; idleTimer?: NodeJS.Timeout;
  authorityFlight?: Promise<Authority>; sourceCheckAt: number;
  /** App frames and the relay's own re-checks skip the read until this time, at this security revision. */
  authorizedUntil?: number; authorizedRevision?: number; authorizedProof?: CloudSourceProof;
  /** Ends a connect retry wait early; a hint that lands outside the wait is kept. */
  retryNow?: () => void; readyHinted?: boolean;
  /** The source authority's absolute grace deadline under the proof that produced it. */
  sourceGrace?: { until: number; proof: string }; sourceRetryMs?: number;
  clients: Map<string, { ws: WebSocket; sessionId: string | null }>; queued: Map<string, unknown[]>;
  admitting: Map<string, WebSocket>;
  delivered: Map<string, Map<string, DeliveredPrompt>>;
  stops: Map<string, (ok: boolean) => void>; abort: AbortController; wakeRequested: boolean; wakeAllowed: boolean;
};
function reject(socket: Duplex): void {
  socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
}
function parse(data: RawData): unknown {
  return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8"));
}
function send(socket: WebSocket | null, value: unknown): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload) > CLOUD_V2_MAX_FRAME_BYTES || socket.bufferedAmount > 4 * 1024 * 1024) { socket.terminate(); return; }
  socket.send(payload, error => { if (error) socket.terminate(); });
}
function acceptsWork(workspace: CloudV2Workspace): boolean {
  return !workspace.archivedAt && ["creating", "starting", "running"].includes(workspace.state);
}

export class CloudV2Relay {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: CLOUD_V2_MAX_FRAME_BYTES, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(CLOUD_V2_BRIDGE_PROTOCOL)
      ? protocols.has(CLOUD_V2_EXPLICIT_WAKE_PROTOCOL) ? CLOUD_V2_EXPLICIT_WAKE_PROTOCOL : CLOUD_V2_BRIDGE_PROTOCOL : false });
  private readonly rooms = new Map<string, Room>();
  private readonly ping = setInterval(() => this.heartbeat(), 30_000);
  private securityRevision = 0;
  private readonly unsubscribeSecurity: (() => void) | undefined;
  private readonly alive = new WeakSet<WebSocket>();
  private closed = false;
  private promptNotificationsHealthy = false;

  constructor(private readonly deps: CloudV2RelayDeps) {
    this.ping.unref();
    // A pooled LISTEN socket can carry the async context of an earlier WorkOS
    // operation whose provider lock has ended. These reads belong to the relay.
    this.unsubscribeSecurity = deps.securityEvents?.subscribe(AsyncResource.bind(() => {
      this.securityRevision++; this.revalidate();
    }, "cloud-v2-security-wake"));
    void deps.securityEvents?.start().catch(() => this.revalidate());
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const bridge = BRIDGE_PATH.exec(new URL(request.url ?? "/", "http://relay").pathname);
    if (!bridge) return false;
    void this.admitApp(bridge[1]!, request, socket, head);
    return true;
  }

  close(): void {
    this.closed = true; clearInterval(this.ping); this.unsubscribeSecurity?.();
    for (const room of this.rooms.values()) this.revoke(room);
    this.rooms.clear(); this.server.close();
  }

  /** Best-effort latency hint only. Explicit enqueue owns wake; no app, room
   * or worker connection is created to deliver this notification. */
  hintPrompts(workspaceId: string): void {
    const room = this.rooms.get(workspaceId);
    if (!this.closed && room?.ready && !room.revoked) send(room.worker, { t: "prompts" });
  }

  /** A LISTEN gap restores HTTPS delivery before the socket itself is lost. */
  promptNotifications(healthy: boolean): void {
    this.promptNotificationsHealthy = healthy;
    for (const room of this.rooms.values()) {
      this.offerPush(room);
      if (healthy) this.hintPrompts(room.workspace.id);
    }
  }

  private offerPush(room: Room): void {
    if (!this.closed && room.ready && !room.revoked && room.worker && room.workerBinding &&
        this.deps.workerActivity && workerSupportsPush(room.worker))
      send(room.worker, { t: "push", prompts: this.promptNotificationsHealthy });
  }

  /** Best-effort latency hint: a room waiting for this workspace's worker
   * retries now instead of after its backoff. Polling remains the fallback. */
  hintReady(workspaceId: string): void {
    const room = this.rooms.get(workspaceId);
    if (this.closed || !room?.dialing || room.ready || room.revoked) return;
    room.readyHinted = true; room.retryNow?.();
  }

  /** Used by lifecycle replicas too: Stop must work when no app is attached. */
  async stopWorkspace(workspace: CloudV2Workspace, timeoutMs = 25_000): Promise<boolean> {
    const epoch = await this.deps.store.accessEpoch(workspace.id);
    if (epoch === null || this.closed) return false;
    const room = this.room(workspace, epoch);
    if (!room) return false;
    clearTimeout(room.idleTimer); delete room.idleTimer;
    return new Promise(resolve => {
      const id = randomUUID();
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (ok: boolean) => { clearTimeout(timer); room.stops.delete(id); this.idle(room); resolve(ok); };
      room.stops.set(id, finish);
      if (room.ready) send(room.worker, { t: "stop", id });
      else this.ensureConnected(room);
    });
  }

  private room(workspace: CloudV2Workspace, accessEpoch: string): Room | null {
    let room = this.rooms.get(workspace.id);
    if (room && room.accessEpoch !== accessEpoch) {
      // An old admission may finish after a new ticket established a successor.
      // Never let the stale read revoke that newer room.
      if (BigInt(accessEpoch) < BigInt(room.accessEpoch)) return null;
      this.revoke(room); room = undefined;
    }
    if (!room) {
      room = { workspace, accessEpoch, revoked: false, worker: null, ready: false, loginRevision: null, configAt: 0, sourceCheckAt: 0,
        clients: new Map(), admitting: new Map(), queued: new Map(), delivered: new Map(), stops: new Map(), abort: new AbortController(), wakeRequested: false, wakeAllowed: false };
      this.rooms.set(workspace.id, room);
    }
    return room;
  }

  private revoke(room: Room, code = 4001, reason = "access_revoked"): void {
    room.revoked = true; room.ready = false; room.abort.abort(); room.queued.clear(); room.delivered.clear(); clearTimeout(room.idleTimer);
    room.worker?.close(code, reason); room.worker = null;
    for (const finish of room.stops.values()) finish(false);
    for (const { ws } of room.clients.values()) ws.close(code, reason);
    for (const ws of room.admitting.values()) ws.close(code, reason);
    if (this.rooms.get(room.workspace.id) === room) this.rooms.delete(room.workspace.id);
  }

  private fresh(room: Room): boolean {
    return !room.revoked && room.authorizedRevision === this.securityRevision && (this.deps.now?.() ?? Date.now()) < (room.authorizedUntil ?? 0);
  }
  /** The relay's own re-checks share the app frame window; outside it they read. */
  private current(room: Room): Promise<Authority> {
    return this.fresh(room) ? Promise.resolve("allowed") : this.authorized(room);
  }
  private authorized(room: Room, admittingSessionId: string | null = null, admission = false): Promise<Authority> {
    if (!admission && room.authorityFlight) return room.authorityFlight;
    const flight = this.authorize(room, admittingSessionId, admission).finally(() => {
      if (room.authorityFlight === flight) delete room.authorityFlight;
    });
    if (!admission) room.authorityFlight = flight;
    return flight;
  }

  private async authorize(room: Room, admittingSessionId: string | null, admission: boolean): Promise<Authority> {
    if (room.revoked || this.closed) return "revoked";
    const revision = this.securityRevision;
    const readStartedAt = this.deps.now?.() ?? Date.now();
    const sessions = new Set([...room.clients.values()].flatMap(client => client.sessionId ? [client.sessionId] : []));
    if (admittingSessionId) sessions.add(admittingSessionId);
    let snapshot;
    try { snapshot = await this.deps.store.appAccessSnapshot(room.workspace.id, [...sessions]); }
    catch {
      if (!admission) this.revoke(room, 1013, "workspace_verification_unavailable");
      return "unavailable";
    }
    if (room.revoked) return "revoked";
    if (revision !== this.securityRevision) return this.authorize(room, admittingSessionId, admission);
    if (!snapshot || snapshot.accessEpoch !== room.accessEpoch) { this.revoke(room); return "revoked"; }
    const live = new Set(snapshot.activeSessionIds);
    for (const [id, client] of room.clients) {
      // A new admission may have joined while this read was in flight. Its
      // own proof, not an older snapshot that omitted it, controls that client.
      if (client.sessionId && sessions.has(client.sessionId) && !live.has(client.sessionId)) {
        this.detachApp(room, id);
        client.ws.close(4001, "access_revoked");
      }
    }
    if (admittingSessionId && !live.has(admittingSessionId)) return "revoked";
    const proof = snapshot.loginRevision !== undefined ? { accessEpoch: snapshot.accessEpoch, loginRevision: snapshot.loginRevision } : undefined;
    const proofKey = proof && JSON.stringify([proof.accessEpoch, proof.loginRevision]);
    try {
      const controlOnly = !room.clients.size && room.stops.size > 0 && !admission;
      if (!controlOnly) {
        if (!admission && this.deps.continueSource) {
          // During a temporary-failure backoff the next source attempt waits for
          // its retry time; app access and sessions are still read every check.
          const backingOff = room.sourceRetryMs !== undefined && proofKey && room.sourceGrace?.proof === proofKey &&
            (this.deps.now?.() ?? Date.now()) < room.sourceCheckAt;
          if (!backingOff) {
            const lease = await this.deps.continueSource(room.workspace, proof);
            // A result that began before a source or security change must not
            // write deadlines; the rerun observes the change from scratch.
            if (revision !== this.securityRevision) return this.authorize(room, admittingSessionId, admission);
            room.sourceCheckAt = lease.recheckAt;
            if (lease.graceUntil !== undefined && proofKey) room.sourceGrace = { until: lease.graceUntil, proof: proofKey };
            else delete room.sourceGrace;
            delete room.sourceRetryMs;
          }
        } else {
          await this.deps.authorizeSource?.(room.workspace);
          if (revision !== this.securityRevision) return this.authorize(room, admittingSessionId, admission);
          room.sourceCheckAt = (this.deps.now?.() ?? Date.now()) + CLOUD_SOURCE_REFRESH_MS;
        }
      }
    } catch (error) {
      if (revision !== this.securityRevision) return this.authorize(room, admittingSessionId, admission);
      if (isGithubAccessRevoked(error)) { this.revoke(room); return "revoked"; }
      const now = this.deps.now?.() ?? Date.now();
      if (!admission && isGithubTemporary(error) && proofKey && room.sourceGrace?.proof === proofKey && now < room.sourceGrace.until) {
        // A slow or unavailable verification keeps an authorized room until the
        // source authority's original deadline; it never extends that deadline.
        room.sourceRetryMs = Math.min(SOURCE_RETRY_MAX_MS, (room.sourceRetryMs ?? SOURCE_RETRY_MS / 2) * 2);
        room.sourceCheckAt = Math.min(now + room.sourceRetryMs, room.sourceGrace.until);
      } else {
        // A failed new admission must not disconnect an already authorized room.
        if (!admission) this.revoke(room, 1013, "github_unavailable");
        return "unavailable";
      }
    }
    if (room.revoked) return "revoked";
    if (revision !== this.securityRevision) return this.authorize(room, admittingSessionId, admission);
    if (snapshot.validUntil !== undefined) {
      if (snapshot.validUntil <= (this.deps.now?.() ?? Date.now())) return this.authorize(room, admittingSessionId, admission);
      room.sourceCheckAt = Math.min(room.sourceCheckAt, snapshot.validUntil);
    }
    // Repair a missed configuration notification only when the workspace is
    // actually used. The activity carrier repairs the worker independently.
    if (!admission && room.ready && room.worker && !room.configFlight &&
      ((snapshot.loginRevision !== undefined && snapshot.loginRevision !== room.loginRevision) || Date.now() - room.configAt >= CONFIG_REFRESH_MS)) {
      const ws = room.worker;
      void this.refreshConfig(room, ws, Date.now() - room.configAt >= CONFIG_REFRESH_MS).catch(() => ws.close(1011, "config_unavailable"));
    }
    if (!admission && revision === this.securityRevision && !room.revoked) {
      // A client admitted during this read is not in its expiry; the next frame re-reads.
      if ([...room.clients.values()].every(client => !client.sessionId || sessions.has(client.sessionId))) {
        room.authorizedUntil = Math.min(room.sourceCheckAt, snapshot.validUntil ?? Infinity, readStartedAt + APP_AUTHORITY_WINDOW_MS);
        room.authorizedRevision = revision;
        if (snapshot.loginRevision !== undefined) room.authorizedProof = { accessEpoch: snapshot.accessEpoch, loginRevision: snapshot.loginRevision };
        else delete room.authorizedProof;
      } else delete room.authorizedUntil;
    }
    return "allowed";
  }
  private revalidate(): void { for (const room of this.rooms.values()) { delete room.authorizedUntil; void this.authorized(room); } }
  readonly revalidateSources = AsyncResource.bind((scope: { organizationId?: string; ownerUserId?: string }): void => {
    this.securityRevision++;
    for (const room of this.rooms.values()) if ((!scope.organizationId || room.workspace.organizationId === scope.organizationId) &&
      (!scope.ownerUserId || room.workspace.creatorUserId === scope.ownerUserId)) { delete room.authorizedUntil; delete room.sourceGrace; void this.authorized(room); }
  }, "cloud-v2-source-wake");
  private watch(socket: WebSocket): void { this.alive.add(socket); socket.on("pong", () => this.alive.add(socket)); }
  private heartbeat(): void {
    // Transport liveness is not a permission poll. Security/login notifications
    // and actual workspace traffic own their bounded authority refreshes.
    void this.deps.securityEvents?.start().catch(() => {});
    for (const room of this.rooms.values()) for (const socket of [room.worker, ...[...room.clients.values()].map(client => client.ws)]) {
      if (!socket || socket.readyState !== WebSocket.OPEN) continue;
      if (!this.alive.has(socket)) { socket.terminate(); continue; }
      this.alive.delete(socket); socket.ping();
    }
    if (this.deps.runtimeAdmission) for (const room of this.rooms.values()) for (const [id, { ws }] of room.clients) {
      if (ws.readyState === WebSocket.OPEN) void this.deps.runtimeAdmission.renewClient(room.workspace.id, id).catch(() => {});
    }
  }
  private wanted(room: Room): boolean { return !room.revoked && !this.closed && (room.clients.size > 0 || room.admitting.size > 0 || room.stops.size > 0); }
  private idle(room: Room): void {
    if (this.wanted(room) || room.revoked || room.idleTimer) return;
    room.idleTimer = setTimeout(() => {
      delete room.idleTimer;
      if (this.wanted(room)) return;
      room.abort.abort(); room.revoked = true; room.worker?.close(1000); room.worker = null;
      if (this.rooms.get(room.workspace.id) === room) this.rooms.delete(room.workspace.id);
    }, this.deps.idleMs ?? 30_000);
    room.idleTimer.unref();
  }
  private wake(room: Room): void {
    if (room.wakeRequested || room.revoked || room.workspace.state !== "stopped") return;
    room.wakeRequested = true;
    void this.deps.wake(room.workspace).catch(() => { room.wakeRequested = false; });
  }
  private ensureConnected(room: Room): void {
    if (room.dialing || room.ready || !this.wanted(room)) return;
    room.dialing = this.connect(room).finally(() => { delete room.dialing; });
  }
  private async connect(room: Room): Promise<void> {
    const started = this.deps.now?.() ?? Date.now();
    const deadline = Date.now() + 60_000;
    for (let attempt = 0, attempts = 0; this.wanted(room) && Date.now() < deadline; attempt++, attempts++) {
      if (await this.current(room) !== "allowed") return;
      let ws: WebSocket | undefined;
      try {
        const route = await this.deps.workerRoute(room.workspace.id);
        if (!route || route.accessEpoch !== room.accessEpoch) { this.revoke(room); return; }
        room.workspace = route.workspace;
        if (!acceptsWork(route.workspace)) this.closeExplicitClients(room);
        if (!this.wanted(room)) return;
        if (route.workspace.state === "stopped") {
          // Losing a socket during idle Stop must not wake the VM again just
          // because an app stayed attached. Explicit opens or work may wake it.
          if (!room.wakeAllowed) return;
          this.wake(room);
        }
        else room.wakeRequested = false;
        // A stopped Boat route hangs instead of refusing; never dial it. A
        // bound boot becomes dialable only after hello configuration succeeds.
        const bootId = room.stops.size && route.stopBootIds?.length ? route.stopBootIds[attempts % route.stopBootIds.length] : route.bootId;
        if (route.url && route.token && bootId && (route.workspace.state === "running" || (route.workspace.state === "stopping" && room.stops.size))) {
          const dialStarted = this.deps.now?.() ?? Date.now();
          ws = await dialWorker(route, this.deps.mintWorkerToken(room.workspace.id, bootId));
          const dialed = this.deps.now?.() ?? Date.now();
          if (!this.wanted(room) || await this.current(room) !== "allowed") { ws.terminate(); return; }
          room.worker = ws; room.loginRevision = null;
          if (route.workerTokenHash && route.bootId === bootId) room.workerBinding = {
            workspaceId: room.workspace.id, bootId, accessEpoch: room.accessEpoch, workerTokenHash: route.workerTokenHash,
          };
          else delete room.workerBinding;
          this.attachWorker(room, ws);
          const controlOnly = !room.clients.size && room.stops.size > 0;
          if ((controlOnly || await this.refreshConfig(room, ws, true)) && room.worker === ws && ws.readyState === WebSocket.OPEN) {
            room.ready = true; room.wakeAllowed = false; delete room.readyHinted;
            if (!controlOnly) this.offerPush(room);
            const at = this.deps.now?.() ?? Date.now();
            emitCloudV2Timing(this.deps.timing, { workspaceId: room.workspace.id.slice(0, 8), phase: "relay_ready",
              durationMs: Math.max(0, Math.round(at - started)), dialMs: Math.max(0, Math.round(dialed - dialStarted)), configMs: Math.max(0, Math.round(at - dialed)),
              attempts: attempts + 1 });
            for (const [clientId, client] of room.clients) {
              if (client.ws.readyState !== WebSocket.OPEN) continue;
              send(ws, { t: "open", clientId });
              for (const frame of room.queued.get(clientId) ?? []) this.forward(room, ws, clientId, frame);
            }
            room.queued.clear();
            for (const id of room.stops.keys()) send(ws, { t: "stop", id });
            return;
          }
          ws.terminate();
        }
      } catch { ws?.terminate(); /* Errors can include route headers; never log them. */ }
      const ms = Math.min(this.deps.retryMaxMs ?? 2000, (this.deps.retryBaseMs ?? 250) * 2 ** Math.min(attempt, 4));
      // A worker that has just become ready is retried from the base delay.
      if (await this.retryWait(room, ms)) attempt = -1;
    }
    if (!room.revoked && this.wanted(room)) {
      for (const { ws: client } of room.clients.values()) client.close(1013, "workspace_starting");
      for (const finish of room.stops.values()) finish(false);
    }
  }
  /** Resolves true when a ready hint, not the delay, ended the wait. */
  private retryWait(room: Room, ms: number): Promise<boolean> {
    if (room.readyHinted || room.abort.signal.aborted) {
      const hinted = room.readyHinted === true && !room.abort.signal.aborted;
      delete room.readyHinted; return Promise.resolve(hinted);
    }
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer); room.abort.signal.removeEventListener("abort", done);
        if (room.retryNow === done) delete room.retryNow;
        const hinted = room.readyHinted === true && !room.abort.signal.aborted;
        delete room.readyHinted; resolve(hinted);
      };
      const timer = setTimeout(done, ms);
      room.abort.signal.addEventListener("abort", done, { once: true });
      room.retryNow = done;
    });
  }
  private attachWorker(room: Room, ws: WebSocket): void {
    this.watch(ws);
    const binding = room.workerBinding;
    let activityPending = false;
    type Output = Extract<ReturnType<typeof CloudV2WorkerFrameSchema.parse>, { t: "frame" }>;
    let pending: Output[] | undefined, queuedBytes = 0;
    const forward = (frame: Output) => {
      if (room.worker !== ws || room.revoked) return;
      const requestId = (frame.frame as { requestId?: unknown } | null)?.requestId;
      if (typeof requestId === "string") room.delivered.get(frame.clientId)?.delete(requestId);
      if (frame.clientId === "*") for (const { ws: client } of room.clients.values()) send(client, frame.frame);
      else send(room.clients.get(frame.clientId)?.ws ?? null, frame.frame);
    };
    ws.on("message", (data, binary) => {
      if (room.worker !== ws || room.revoked || ws.readyState !== WebSocket.OPEN) return;
      try {
        const frame = CloudV2WorkerFrameSchema.parse(binary ? null : parse(data));
        if (frame.t === "stop-ack") { room.stops.get(frame.id)?.(true); return; }
        if (frame.t === "activity" && binding && workerSupportsPush(ws) && this.deps.workerActivity) {
          if (activityPending) { ws.close(1013, "activity_backpressure"); return; }
          activityPending = true;
          // This proves the worker's current boot directly. An app session or
          // source outage must not suppress an active worker's idle-stop receipt.
          void this.deps.workerActivity(binding, frame.idle).then(reply => {
            if (room.worker !== ws || room.revoked || ws.readyState !== WebSocket.OPEN) return;
            if (!reply) { ws.close(4001, "worker_unauthorized"); return; }
            send(ws, { t: "activity-reply", id: frame.id, ...reply });
          }).catch(() => ws.close(1013, "activity_unavailable")).finally(() => { activityPending = false; });
          return;
        }
        if (frame.t !== "frame") { ws.close(4003, "invalid_carrier"); return; }
        // Keep normal streaming synchronous. Only buffer while a due authority
        // read is in flight, with both frame and byte bounds against a stalled DB.
        if (!pending && (this.deps.now?.() ?? Date.now()) < room.sourceCheckAt) { forward(frame); return; }
        const bytes = Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.byteLength, 0) : data.byteLength;
        if ((pending?.length ?? 0) >= MAX_QUEUED_OUTPUT_FRAMES || queuedBytes + bytes > MAX_QUEUED_OUTPUT_BYTES) {
          pending = []; queuedBytes = 0; ws.close(1013, "relay_backpressure"); return;
        }
        queuedBytes += bytes;
        if (pending) { pending.push(frame); return; }
        pending = [frame];
        void this.authorized(room).then(allowed => {
          if (allowed === "allowed") for (const output of pending ?? []) forward(output);
        }).catch(() => ws.close(1013, "workspace_verification_unavailable")).finally(() => { pending = undefined; queuedBytes = 0; });
      } catch { ws.close(4003, "invalid_frame"); }
    });
    ws.on("close", () => {
      this.failDelivered(room, ws);
      if (room.worker !== ws) return;
      room.worker = null; room.ready = false; room.loginRevision = null; delete room.workerBinding;
      // A close during initial configuration is handled by connect's retry.
      if (!room.dialing) this.ensureConnected(room);
    });
  }

  private forward(room: Room, worker: WebSocket, clientId: string, frame: unknown): void {
    const request = frame as { id?: unknown; type?: unknown; agentId?: unknown } | null;
    if ((request?.type === "AGENT_PROMPT" || request?.type === "AGENT_STEER") && typeof request.id === "string" && request.id.length <= 256) {
      const pending = room.delivered.get(clientId) ?? new Map<string, DeliveredPrompt>();
      if (pending.size >= MAX_QUEUED_FRAMES && !pending.has(request.id)) { room.clients.get(clientId)?.ws.close(1013, "too_many_prompts"); return; }
      pending.set(request.id, { worker, ...(typeof request.agentId === "string" ? { agentId: request.agentId } : {}) });
      room.delivered.set(clientId, pending);
    }
    send(worker, { t: "frame", clientId, frame });
  }

  /** A no-timeout legacy prompt RPC cannot survive losing its reply channel.
   * Settle only frames actually forwarded to this socket. Wake/dial queues
   * belong to the successor and must not be rejected or replayed here. New
   * desktops recover durable turn outcomes through the HTTPS receipt. */
  private failDelivered(room: Room, worker: WebSocket): void {
    if (room.revoked) return;
    for (const [clientId, pending] of room.delivered) {
      for (const [requestId, request] of pending) if (request.worker === worker) {
        pending.delete(requestId);
        send(room.clients.get(clientId)?.ws ?? null, { id: randomUUID(), timestamp: Date.now(), source: "engine", type: "AGENT_ERROR",
          requestId, ...(request.agentId ? { agentId: request.agentId } : {}), code: "transport-closed",
          message: "The worker connection ended before this turn finished. Reconnect to check the turn." });
      }
      if (!pending.size) room.delivered.delete(clientId);
    }
  }

  /** Transactional notifications push committed credential changes. Actual
   * traffic also repairs a missed notification through its access snapshot. */
  readonly refreshLogins = AsyncResource.bind(async (scope?: { ownerUserId?: string; organizationId?: string }): Promise<void> => {
    await Promise.all([...this.rooms.values()].map(async room => {
      if (!room.ready || !room.worker || (scope && ((scope.ownerUserId && scope.ownerUserId !== room.workspace.creatorUserId) ||
          (scope.organizationId && scope.organizationId !== room.workspace.organizationId)))) return;
      const ws = room.worker;
      // Changed credentials are delivered only after a fresh authority read.
      delete room.authorizedUntil;
      await this.refreshConfig(room, ws, Date.now() - room.configAt >= CONFIG_REFRESH_MS).catch(() => ws.close(1011, "config_unavailable"));
    }));
  }, "cloud-v2-login-wake");
  private refreshConfig(room: Room, ws: WebSocket, force: boolean): Promise<boolean> {
    const active = room.configFlight;
    if (active?.worker === ws) { active.requested = true; active.force ||= force; return active.promise; }
    const flight: ConfigFlight = { worker: ws, requested: true, force, promise: Promise.resolve(false) };
    room.configFlight = flight;
    flight.promise = this.loadConfig(room, flight).finally(() => { if (room.configFlight === flight) delete room.configFlight; });
    return flight.promise;
  }
  private async loadConfig(room: Room, flight: ConfigFlight): Promise<boolean> {
    const ws = flight.worker;
    do {
      flight.requested = false;
      const force = flight.force; flight.force = false;
      if (room.revoked || room.worker !== ws) return false;
      const revision = await this.deps.store.loginRevision(room.workspace.id);
      if (revision === null) { this.revoke(room); return false; }
      if (!force && revision === room.loginRevision) continue;
      if (await this.current(room) !== "allowed" || room.worker !== ws) return false;
      // Only a proof inside the fresh window lets source continuation reuse its lease.
      const config = await this.deps.config(room.workspace, "continuation", this.fresh(room) ? room.authorizedProof : undefined);
      if (await this.current(room) !== "allowed" || room.worker !== ws) return false;
      if (revision !== await this.deps.store.loginRevision(room.workspace.id)) { flight.requested = true; flight.force = true; continue; }
      if (room.worker !== ws || room.revoked) return false;
      const { mcpServers, githubPullRequests, githubUserTokens, gitIdentity, agentInteractions, codeReview, historyReplacement: _historyReplacement, environment, runtimeUpdate, ...legacy } = config;
      if (environment && !workerSupportsEnvironment(ws)) throw new Error("Cloud environment runtime support is required.");
      const { setup, setupScript, baseCommit, github, ...workspaceConfig } = config.workspace;
      if (setupScript !== undefined && !workerSupportsRepositorySetup(ws)) throw new Error("Repository setup runtime support is required.");
      send(ws, { ...legacy, workspace: { ...workspaceConfig,
        ...(setupScript !== undefined ? { setupScript } : {}),
        ...(workerSupportsGithub(ws) && github ? { github } : {}),
        ...(workerSupportsSetup(ws) && setup !== undefined ? { setup } : {}),
        ...(workerSupportsCheckout(ws) && baseCommit !== undefined ? { baseCommit } : {}) },
        ...(workerSupportsHistoryReplacement(ws) ? { historyReplacement: 1 } : {}),
        ...(workerSupportsMcp(ws) && mcpServers ? { mcpServers } : {}),
        ...(workerSupportsAgentInteractions(ws) && agentInteractions === 1 ? { agentInteractions } : {}),
        ...(environment ? { environment } : {}),
        ...(workerSupportsRuntimeUpdate(ws) && runtimeUpdate === 1 ? { runtimeUpdate } : {}),
        ...(workerSupportsGitIdentity(ws) && gitIdentity !== undefined ? { gitIdentity } : {}),
        ...(workerSupportsCodeReview(ws) && codeReview ? { codeReview } : {}),
        ...(workerSupportsGithubUserTokens(ws) && githubUserTokens === 1 ? { githubUserTokens } : {}),
        ...(workerSupportsGithub(ws) && githubPullRequests === 1 ? { githubPullRequests } : {}), loginRevision: revision }); room.loginRevision = revision; room.configAt = Date.now();
    } while (flight.requested);
    return true;
  }

  private async admitApp(workspaceId: string, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const offered = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
    const ticket = offered.find(value => value.startsWith("ticket."))?.slice("ticket.".length) ?? "";
    if (!offered.includes(CLOUD_V2_BRIDGE_PROTOCOL) || !isCloudV2Token(ticket, "connect")) return reject(socket);
    let workspace: CloudV2Workspace | null = null, epoch: string | undefined, wake = false, sessionId: string | null = null;
    try {
      const grant = await this.deps.store.consumeConnectTicket(ticket, workspaceId);
      if (grant && await this.deps.store.accessEpoch(workspaceId) === grant.accessEpoch) {
        workspace = await this.deps.store.get(workspaceId, grant.userId); epoch = grant.accessEpoch; wake = grant.wake; sessionId = grant.sessionId;
      }
    } catch { this.deps.logger?.warn("[cloud-v2] app admission failed"); }
    if (!workspace || this.closed) return reject(socket);
    const admitted = workspace;
    this.server.handleUpgrade(request, socket, head, ws => this.attachApp(admitted, epoch!, wake, sessionId, ws));
  }
  private attachApp(workspace: CloudV2Workspace, epoch: string, wake: boolean, sessionId: string | null, ws: WebSocket): void {
    const room = this.room(workspace, epoch);
    if (!room) { ws.close(4001, "access_revoked"); return; }
    const clientId = randomUUID(); this.watch(ws);
    let inboundFrames = 0, inboundBytes = 0;
    room.admitting.set(clientId, ws);
    let inbound = this.authorized(room, sessionId, true).then(async allowed => {
      if (allowed !== "allowed" || ws.readyState !== WebSocket.OPEN) {
        ws.close(allowed === "unavailable" ? 1013 : 4001, allowed === "unavailable" ? "github_unavailable" : "access_revoked"); return;
      }
      if (ws.protocol === CLOUD_V2_EXPLICIT_WAKE_PROTOCOL && !acceptsWork(workspace)) {
        ws.close(4009, "workspace_not_running"); this.idle(room); return;
      }
      if (this.deps.runtimeAdmission) {
        const deadline = Date.now() + 120_000;
        while (!await this.deps.runtimeAdmission.admitClient(workspace.id, clientId)) {
          if (room.revoked || this.closed || ws.readyState !== WebSocket.OPEN || Date.now() >= deadline) { ws.close(1013); return; }
          await delay(250, undefined, { signal: room.abort.signal }).catch(() => {});
        }
        if (room.revoked || this.closed || ws.readyState !== WebSocket.OPEN || await this.authorized(room, sessionId, true) !== "allowed") {
          await this.deps.runtimeAdmission.releaseClient(workspace.id, clientId); ws.close(4001); return;
        }
      }
      clearTimeout(room.idleTimer); delete room.idleTimer;
      if (room.worker && workspace.state !== "running") { room.worker.terminate(); room.worker = null; room.ready = false; }
      if (!room.worker) room.workspace = workspace;
      room.clients.set(clientId, { ws, sessionId });
      // The window predates this session's expiry; the next app frame re-reads.
      delete room.authorizedUntil;
      if (room.ready) send(room.worker, { t: "open", clientId });
      else {
        if (wake && ws.protocol !== CLOUD_V2_EXPLICIT_WAKE_PROTOCOL) { room.wakeAllowed = true; this.wake(room); }
        this.ensureConnected(room);
      }
    }).catch(() => ws.close(1013)).finally(() => { room.admitting.delete(clientId); this.idle(room); });
    ws.on("error", () => {});
    ws.on("message", (data, binary) => {
      if (binary) { ws.close(4003, "invalid_frame"); return; }
      if (ws.readyState !== WebSocket.OPEN) return;
      const bytes = Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.byteLength, 0) : data.byteLength;
      if (inboundFrames >= MAX_QUEUED_FRAMES || inboundBytes + bytes > MAX_QUEUED_OUTPUT_BYTES) { ws.close(1013, "relay_backpressure"); return; }
      inboundFrames++; inboundBytes += bytes;
      inbound = inbound.then(() => ws.readyState === WebSocket.OPEN ? this.fromApp(room, clientId, ws, data) : undefined)
        .catch(() => ws.close(1011, "relay_unavailable")).finally(() => { inboundFrames--; inboundBytes -= bytes; });
    });
    ws.on("close", () => { this.detachApp(room, clientId); });
  }
  private detachApp(room: Room, clientId: string): void {
    room.admitting.delete(clientId);
    void this.deps.runtimeAdmission?.releaseClient(room.workspace.id, clientId).catch(() => {});
    const attached = room.clients.delete(clientId); room.queued.delete(clientId); room.delivered.delete(clientId);
    if (attached && room.ready) send(room.worker, { t: "close", clientId });
    this.idle(room);
  }
  private closeExplicitClients(room: Room): void {
    // A live app socket must not conceal worker loss. New input acquires a
    // fresh HTTP wake; an old ticket or background frame cannot reverse Stop.
    for (const [id, { ws }] of room.clients) if (ws.protocol === CLOUD_V2_EXPLICIT_WAKE_PROTOCOL) {
      this.detachApp(room, id);
      ws.close(4009, "workspace_not_running");
    }
  }
  private async fromApp(room: Room, clientId: string, ws: WebSocket, data: RawData): Promise<void> {
    let frame: unknown;
    try { frame = parse(data); } catch { ws.close(4003, "invalid_frame"); return; }
    // The worker ignores this empty transport frame too. It cannot release
    // data, wake a VM or turn socket keepalive into a database permission poll.
    if ((frame as { type?: unknown } | null)?.type === "HEARTBEAT") return;
    // A recent allowance covers the next app frames, so interactive requests
    // do not each wait on a database read. Revocation clears it immediately on
    // this replica; the short window bounds a lost cross-replica notice.
    if (room.ready && room.worker && room.clients.has(clientId) && this.fresh(room)) {
      this.forward(room, room.worker, clientId, frame); return;
    }
    if (await this.authorized(room) !== "allowed" || !room.clients.has(clientId)) return;
    if (room.ready && room.worker) { this.forward(room, room.worker, clientId, frame); return; }
    // Connection housekeeping is not explicit workspace activity. Bridge
    // payload validation still belongs to the worker when it is online.
    const type = (frame as { type?: unknown } | null)?.type;
    if (type === "HEARTBEAT" || type === "CONNECTED") return;
    const answer = await this.deps.answerOffline(room.workspace, frame).catch(() => null);
    if (await this.authorized(room) !== "allowed" || !room.clients.has(clientId)) return;
    if (answer) { send(ws, answer); return; }
    if (room.ready && room.worker) { this.forward(room, room.worker, clientId, frame); return; }
    const queue = room.queued.get(clientId) ?? [];
    if (queue.length >= MAX_QUEUED_FRAMES) { ws.close(1013, "workspace_starting"); return; }
    queue.push(frame); room.queued.set(clientId, queue);
    if (ws.protocol !== CLOUD_V2_EXPLICIT_WAKE_PROTOCOL) {
      room.wakeAllowed = true;
      this.wake(room);
    }
    this.ensureConnected(room);
  }
}
