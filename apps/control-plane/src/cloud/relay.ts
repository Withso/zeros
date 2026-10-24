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
import type { CloudV2Store, CloudV2Workspace } from "./store.js";
import { isCloudV2Token } from "./tokens.js";
import { dialWorker, workerSupportsMcp, type WorkerRoute } from "./worker-connection.js";
import { emitCloudV2Timing, type CloudV2TimingRecord } from "./lifecycle.js";

export const CLOUD_V2_BRIDGE_PROTOCOL = "zeros.cloud.v2";
const BRIDGE_PATH = /^\/v2\/cloud\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/bridge$/;
const CONFIG_REFRESH_MS = 12 * 60 * 60_000;
const MAX_QUEUED_FRAMES = 64;
type ConfigFrame = Extract<CloudV2ControlFrame, { t: "config" }>;

export type CloudV2RelayDeps = {
  store: Pick<CloudV2Store, "consumeConnectTicket" | "get" | "accessEpoch" | "appAccessSnapshot" | "loginRevision">;
  securityEvents?: Pick<PostgresSecurityEventBroker, "start" | "subscribe">;
  config(workspace: CloudV2Workspace): Promise<ConfigFrame>;
  workerRoute(workspaceId: string): Promise<WorkerRoute | null>;
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
type Room = {
  workspace: CloudV2Workspace; accessEpoch: string; revoked: boolean;
  worker: WebSocket | null; ready: boolean; loginRevision: string | null; configAt: number;
  configFlight?: ConfigFlight; dialing?: Promise<void>; idleTimer?: NodeJS.Timeout;
  clients: Map<string, { ws: WebSocket; sessionId: string | null }>; queued: Map<string, unknown[]>;
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

export class CloudV2Relay {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: CLOUD_V2_MAX_FRAME_BYTES, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(CLOUD_V2_BRIDGE_PROTOCOL) ? CLOUD_V2_BRIDGE_PROTOCOL : false });
  private readonly rooms = new Map<string, Room>();
  private readonly ping = setInterval(() => this.heartbeat(), 30_000);
  private securityRevision = 0;
  private readonly unsubscribeSecurity: (() => void) | undefined;
  private readonly alive = new WeakSet<WebSocket>();
  private closed = false;

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
      room = { workspace, accessEpoch, revoked: false, worker: null, ready: false, loginRevision: null, configAt: 0,
        clients: new Map(), queued: new Map(), delivered: new Map(), stops: new Map(), abort: new AbortController(), wakeRequested: false, wakeAllowed: false };
      this.rooms.set(workspace.id, room);
    }
    return room;
  }

  private revoke(room: Room): void {
    room.revoked = true; room.ready = false; room.abort.abort(); room.queued.clear(); room.delivered.clear(); clearTimeout(room.idleTimer);
    room.worker?.close(4001, "access_revoked"); room.worker = null;
    for (const finish of room.stops.values()) finish(false);
    for (const { ws } of room.clients.values()) ws.close(4001, "access_revoked");
    if (this.rooms.get(room.workspace.id) === room) this.rooms.delete(room.workspace.id);
  }

  private async authorized(room: Room, admittingSessionId: string | null = null): Promise<boolean> {
    if (room.revoked || this.closed) return false;
    const revision = this.securityRevision;
    const sessions = new Set([...room.clients.values()].flatMap(client => client.sessionId ? [client.sessionId] : []));
    if (admittingSessionId) sessions.add(admittingSessionId);
    const snapshot = await this.deps.store.appAccessSnapshot(room.workspace.id, [...sessions]).catch(() => null);
    if (room.revoked) return false;
    if (revision !== this.securityRevision) return this.authorized(room, admittingSessionId);
    if (!snapshot || snapshot.accessEpoch !== room.accessEpoch) { this.revoke(room); return false; }
    const live = new Set(snapshot.activeSessionIds);
    for (const [id, client] of room.clients) {
      // A new admission may have joined while this read was in flight. Its
      // own proof, not an older snapshot that omitted it, controls that client.
      if (client.sessionId && sessions.has(client.sessionId) && !live.has(client.sessionId)) {
        this.detachApp(room, id);
        client.ws.close(4001, "access_revoked");
      }
    }
    return !admittingSessionId || live.has(admittingSessionId);
  }
  private revalidate(): void { for (const room of this.rooms.values()) void this.authorized(room); }
  private watch(socket: WebSocket): void { this.alive.add(socket); socket.on("pong", () => this.alive.add(socket)); }
  private heartbeat(): void {
    this.revalidate(); void this.refreshLogins(); void this.deps.securityEvents?.start().catch(() => {});
    for (const room of this.rooms.values()) for (const socket of [room.worker, ...[...room.clients.values()].map(client => client.ws)]) {
      if (!socket || socket.readyState !== WebSocket.OPEN) continue;
      if (!this.alive.has(socket)) { socket.terminate(); continue; }
      this.alive.delete(socket); socket.ping();
    }
  }
  private wanted(room: Room): boolean { return !room.revoked && !this.closed && (room.clients.size > 0 || room.stops.size > 0); }
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
    for (let attempt = 0; this.wanted(room) && Date.now() < deadline; attempt++) {
      if (!await this.authorized(room)) return;
      let ws: WebSocket | undefined;
      try {
        const route = await this.deps.workerRoute(room.workspace.id);
        if (!route || route.accessEpoch !== room.accessEpoch) { this.revoke(room); return; }
        room.workspace = route.workspace;
        if (route.workspace.state === "stopped") {
          // Losing a socket during idle Stop must not wake the VM again just
          // because an app stayed attached. Explicit opens or work may wake it.
          if (!room.wakeAllowed) return;
          this.wake(room);
        }
        else room.wakeRequested = false;
        // A stopped Boat route hangs instead of refusing; never dial it. Hello
        // stores the new boot id and marks running before an app can dial.
        if (route.url && route.token && route.bootId && (route.workspace.state === "running" || (route.workspace.state === "stopping" && room.stops.size))) {
          ws = await dialWorker(route, this.deps.mintWorkerToken(room.workspace.id, route.bootId));
          if (!this.wanted(room) || !await this.authorized(room)) { ws.terminate(); return; }
          room.worker = ws; room.loginRevision = null; this.attachWorker(room, ws);
          if (await this.refreshConfig(room, ws, true) && room.worker === ws && ws.readyState === WebSocket.OPEN) {
            room.ready = true; room.wakeAllowed = false;
            emitCloudV2Timing(this.deps.timing, { workspaceId: room.workspace.id.slice(0, 8), phase: "relay_ready",
              durationMs: Math.max(0, Math.round((this.deps.now?.() ?? Date.now()) - started)) });
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
      await delay(ms, undefined, { signal: room.abort.signal }).catch(() => {});
    }
    if (!room.revoked && this.wanted(room)) {
      for (const { ws: client } of room.clients.values()) client.close(1013, "workspace_starting");
      for (const finish of room.stops.values()) finish(false);
    }
  }
  private attachWorker(room: Room, ws: WebSocket): void {
    this.watch(ws);
    ws.on("message", (data, binary) => {
      if (room.worker !== ws || room.revoked) return;
      try {
        const frame = CloudV2WorkerFrameSchema.parse(binary ? null : parse(data));
        if (frame.t === "stop-ack") { room.stops.get(frame.id)?.(true); return; }
        if (frame.t !== "frame") { ws.close(4003, "invalid_carrier"); return; }
        const requestId = (frame.frame as { requestId?: unknown } | null)?.requestId;
        if (typeof requestId === "string") room.delivered.get(frame.clientId)?.delete(requestId);
        if (frame.clientId === "*") for (const { ws: client } of room.clients.values()) send(client, frame.frame);
        else send(room.clients.get(frame.clientId)?.ws ?? null, frame.frame);
      } catch { ws.close(4003, "invalid_frame"); }
    });
    ws.on("close", () => {
      this.failDelivered(room, ws);
      if (room.worker !== ws) return;
      room.worker = null; room.ready = false; room.loginRevision = null;
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

  /** Committed revision polling repairs missed transactional notifications. */
  async refreshLogins(scope?: { ownerUserId?: string; organizationId?: string }): Promise<void> {
    await Promise.all([...this.rooms.values()].map(async room => {
      if (!room.ready || !room.worker || (scope && ((scope.ownerUserId && scope.ownerUserId !== room.workspace.creatorUserId) ||
          (scope.organizationId && scope.organizationId !== room.workspace.organizationId)))) return;
      const ws = room.worker;
      await this.refreshConfig(room, ws, Date.now() - room.configAt >= CONFIG_REFRESH_MS).catch(() => ws.close(1011, "config_unavailable"));
    }));
  }
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
      if (!await this.authorized(room) || room.worker !== ws) return false;
      const config = await this.deps.config(room.workspace);
      if (!await this.authorized(room) || room.worker !== ws) return false;
      if (revision !== await this.deps.store.loginRevision(room.workspace.id)) { flight.requested = true; flight.force = true; continue; }
      if (room.worker !== ws || room.revoked) return false;
      const { mcpServers, ...legacy } = config;
      send(ws, { ...legacy, ...(workerSupportsMcp(ws) && mcpServers ? { mcpServers } : {}), loginRevision: revision }); room.loginRevision = revision; room.configAt = Date.now();
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
    let inbound = this.authorized(room, sessionId).then(allowed => {
      if (!allowed || ws.readyState !== WebSocket.OPEN) { ws.close(4001, "access_revoked"); return; }
      clearTimeout(room.idleTimer); delete room.idleTimer;
      if (room.worker && workspace.state !== "running") { room.worker.terminate(); room.worker = null; room.ready = false; }
      if (!room.worker) room.workspace = workspace;
      room.clients.set(clientId, { ws, sessionId });
      if (room.ready) send(room.worker, { t: "open", clientId });
      else {
        if (wake) { room.wakeAllowed = true; this.wake(room); }
        this.ensureConnected(room);
      }
    });
    ws.on("error", () => {});
    ws.on("message", (data, binary) => {
      if (binary) { ws.close(4003, "invalid_frame"); return; }
      inbound = inbound.then(() => this.fromApp(room, clientId, ws, data)).catch(() => ws.close(1011, "relay_unavailable"));
    });
    ws.on("close", () => { this.detachApp(room, clientId); });
  }
  private detachApp(room: Room, clientId: string): void {
    const attached = room.clients.delete(clientId); room.queued.delete(clientId); room.delivered.delete(clientId);
    if (attached && room.ready) send(room.worker, { t: "close", clientId });
    this.idle(room);
  }
  private async fromApp(room: Room, clientId: string, ws: WebSocket, data: RawData): Promise<void> {
    if (!await this.authorized(room) || !room.clients.has(clientId)) return;
    let frame: unknown;
    try { frame = parse(data); } catch { ws.close(4003, "invalid_frame"); return; }
    if (room.ready && room.worker) { this.forward(room, room.worker, clientId, frame); return; }
    // Connection housekeeping is not explicit workspace activity. Bridge
    // payload validation still belongs to the worker when it is online.
    const type = (frame as { type?: unknown } | null)?.type;
    if (type === "HEARTBEAT" || type === "CONNECTED") return;
    const answer = await this.deps.answerOffline(room.workspace, frame).catch(() => null);
    if (!await this.authorized(room) || !room.clients.has(clientId)) return;
    if (answer) { send(ws, answer); return; }
    if (room.ready && room.worker) { this.forward(room, room.worker, clientId, frame); return; }
    const queue = room.queued.get(clientId) ?? [];
    if (queue.length >= MAX_QUEUED_FRAMES) { ws.close(1013, "workspace_starting"); return; }
    queue.push(frame); room.queued.set(clientId, queue);
    room.wakeAllowed = true;
    this.wake(room); this.ensureConnected(room);
  }
}
