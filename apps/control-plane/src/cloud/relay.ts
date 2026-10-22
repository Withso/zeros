// Cloud workspace v2 relay. The worker on each Boat VM dials out to
// /v2/cloud/worker; the Mac app opens /v2/cloud/workspaces/:id/bridge with a
// one-use ticket. App frames pass to the worker verbatim, tagged with the app
// connection's clientId, and worker frames return the same way.
//
// Rooms live only in this process. Run exactly one realtime replica; scaling
// requires routing both worker and app sockets for a workspace to that same
// replica. See docs/cloud-workspaces.md.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  CLOUD_V2_MAX_FRAME_BYTES,
  CloudV2WorkerFrameSchema,
  type CloudV2ControlFrame,
  type CloudV2WorkerFrame,
} from "./contract.js";
import type { PostgresSecurityEventBroker } from "../security-events.js";
import type { CloudV2Store, CloudV2Workspace } from "./store.js";
import { isCloudV2Token } from "./tokens.js";

export const CLOUD_V2_WORKER_PATH = "/v2/cloud/worker";
export const CLOUD_V2_BRIDGE_PROTOCOL = "zeros.cloud.v2";
const BRIDGE_PATH = /^\/v2\/cloud\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/bridge$/;
const HELLO_TIMEOUT_MS = 10_000;
/** Proxy tokens live 24 h; a fresh config every 12 h keeps active turns covered. */
const CONFIG_REFRESH_MS = 12 * 60 * 60_000;
const PING_INTERVAL_MS = 30_000;
const ACTIVE_WRITE_INTERVAL_MS = 30_000;
/** Frames an app may send while its workspace wakes; more closes the socket. */
const MAX_QUEUED_FRAMES = 64;

type ConfigFrame = Extract<CloudV2ControlFrame, { t: "config" }>;

export type CloudV2RelayDeps = {
  store: Pick<CloudV2Store, "byWorkerToken" | "consumeConnectTicket" | "get" | "transition" | "markActive" | "writeHistory" | "accessEpoch" | "loginRevision">;
  securityEvents?: Pick<PostgresSecurityEventBroker, "start" | "subscribe">;
  config(workspace: CloudV2Workspace): Promise<ConfigFrame>;
  githubToken(workspace: CloudV2Workspace): Promise<{ token: string; expiresAt: number }>;
  /** Starts a stopped workspace; the worker connects once it boots. */
  wake(workspace: CloudV2Workspace): Promise<void>;
  /** History reads answered from the mirror while the worker is away. */
  answerOffline(workspace: CloudV2Workspace, frame: unknown): Promise<unknown | null>;
  logger?: Pick<Console, "warn">;
};

type ConfigFlight = { worker: WebSocket; requested: boolean; force: boolean; promise: Promise<boolean> };

type Room = {
  loginRevision: string | null;
  configFlight?: ConfigFlight;
  accessEpoch: string;
  revoked: boolean;
  workspace: CloudV2Workspace;
  worker: WebSocket | null;
  ready: boolean;
  clients: Map<string, WebSocket>;
  queued: Map<string, unknown[]>;
  history: Promise<void>;
  lastActiveWrite: number;
};

function reject(socket: Duplex, status: 401 | 404 | 409): void {
  const text = { 401: "Unauthorized", 404: "Not Found", 409: "Conflict" }[status];
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function parse(data: RawData): unknown {
  return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8"));
}

function send(socket: WebSocket | null, value: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

export class CloudV2Relay {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: CLOUD_V2_MAX_FRAME_BYTES,
    perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(CLOUD_V2_BRIDGE_PROTOCOL) ? CLOUD_V2_BRIDGE_PROTOCOL : false,
  });
  private readonly rooms = new Map<string, Room>();
  private readonly ping = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
  private securityRevision = 0;
  private readonly unsubscribeSecurity: (() => void) | undefined;
  private readonly alive = new WeakSet<WebSocket>();

  constructor(private readonly deps: CloudV2RelayDeps) {
    this.ping.unref();
    this.unsubscribeSecurity = deps.securityEvents?.subscribe(() => { this.securityRevision++; this.revalidate(); });
    void deps.securityEvents?.start().catch(() => this.revalidate());
  }

  /** Claims only the two v2 paths; every other upgrade is left untouched. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = new URL(request.url ?? "/", "http://relay").pathname;
    if (path === CLOUD_V2_WORKER_PATH) {
      void this.admitWorker(request, socket, head);
      return true;
    }
    const bridge = BRIDGE_PATH.exec(path);
    if (bridge) {
      void this.admitApp(bridge[1]!, request, socket, head);
      return true;
    }
    return false;
  }

  close(): void {
    clearInterval(this.ping);
    this.unsubscribeSecurity?.();
    for (const room of this.rooms.values()) {
      room.revoked = true;
      room.worker?.terminate();
      for (const client of room.clients.values()) client.terminate();
    }
    this.rooms.clear();
  }

  private room(workspace: CloudV2Workspace, accessEpoch: string): Room {
    let room = this.rooms.get(workspace.id);
    if (room && room.accessEpoch !== accessEpoch) { this.revoke(room); room = undefined; }
    if (!room) {
      room = { workspace, accessEpoch, loginRevision: null, revoked: false, worker: null, ready: false, clients: new Map(), queued: new Map(), history: Promise.resolve(), lastActiveWrite: 0 };
      this.rooms.set(workspace.id, room);
    }
    return room;
  }

  private revoke(room: Room): void {
    room.revoked = true; room.ready = false; room.queued.clear();
    room.worker?.close(4001, "access_revoked"); room.worker = null;
    for (const client of room.clients.values()) client.close(4001, "access_revoked");
    if (this.rooms.get(room.workspace.id) === room) this.rooms.delete(room.workspace.id);
  }

  private async authorized(room: Room): Promise<boolean> {
    if (room.revoked) return false;
    const revision = this.securityRevision;
    const epoch = await this.deps.store.accessEpoch(room.workspace.id).catch(() => null);
    if (room.revoked) return false;
    if (revision !== this.securityRevision) return this.authorized(room);
    if (epoch === room.accessEpoch) return true;
    this.revoke(room); return false;
  }

  private revalidate(): void {
    for (const room of this.rooms.values()) void this.authorized(room);
  }

  private watch(socket: WebSocket): void {
    this.alive.add(socket);
    socket.on("pong", () => this.alive.add(socket));
  }

  private heartbeat(): void {
    this.revalidate();
    void this.refreshLogins();
    void this.deps.securityEvents?.start().catch(() => {});
    for (const room of this.rooms.values()) {
      for (const socket of [room.worker, ...room.clients.values()]) {
        if (!socket) continue;
        if (!this.alive.has(socket)) { socket.terminate(); continue; }
        this.alive.delete(socket);
        socket.ping();
      }
    }
  }

  private async admitWorker(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    let workspace: (CloudV2Workspace & { accessEpoch: string }) | null = null;
    try {
      workspace = isCloudV2Token(token, "worker") ? await this.deps.store.byWorkerToken(token) : null;
    } catch (error) {
      this.deps.logger?.warn("[cloud-v2] worker admission failed", error instanceof Error ? error.message : "unknown");
    }
    if (!workspace) return reject(socket, 401);
    const admitted = workspace;
    this.server.handleUpgrade(request, socket, head, ws => this.attachWorker(admitted, ws));
  }

  private attachWorker(workspace: CloudV2Workspace & { accessEpoch: string }, ws: WebSocket): void {
    const room = this.room(workspace, workspace.accessEpoch);
    room.workspace = workspace;
    room.worker?.close(4000, "replaced");
    room.worker = ws;
    room.ready = false;
    room.loginRevision = null;
    this.watch(ws);
    const hello = setTimeout(() => ws.close(4002, "hello_timeout"), HELLO_TIMEOUT_MS);
    let inbound = Promise.resolve();
    ws.on("message", data => { inbound = inbound.then(async () => {
      if (room.worker !== ws) return;
      let frame: CloudV2WorkerFrame;
      try {
        frame = CloudV2WorkerFrameSchema.parse(parse(data));
      } catch {
        ws.close(4003, "invalid_frame");
        return;
      }
      if (!room.ready && frame.t !== "hello") { ws.close(4003, "hello_required"); return; }
      if (frame.t === "hello") { clearTimeout(hello); await this.workerReady(room, ws); return; }
      await this.fromWorker(room, ws, frame);
    }).catch(() => ws.close(1011, "relay_unavailable")); });
    ws.on("close", () => {
      clearTimeout(hello);
      if (room.worker !== ws) return;
      room.worker = null;
      room.ready = false;
    });
  }

  private async workerReady(room: Room, ws: WebSocket): Promise<void> {
    try {
      if (!await this.authorized(room) || room.worker !== ws) return;
      const running = await this.deps.store.transition(room.workspace.id, ["creating", "starting", "running"], "running");
      if (!running) { ws.close(4001, "workspace_stopped"); return; }
      room.workspace = running;
      if (!await this.refreshConfig(room, ws, true)) return;
    } catch (error) {
      this.deps.logger?.warn("[cloud-v2] worker config failed", error instanceof Error ? error.message : "unknown");
      ws.close(1011, "config_unavailable");
      return;
    }
    if (room.worker !== ws) return;
    room.ready = true;
    const refresh = setInterval(() => {
      void this.refreshConfig(room, ws, true).catch(() => ws.close(1011, "config_unavailable"));
    }, CONFIG_REFRESH_MS);
    refresh.unref();
    ws.once("close", () => clearInterval(refresh));
    for (const [clientId, client] of room.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      send(ws, { t: "open", clientId });
      for (const frame of room.queued.get(clientId) ?? []) send(ws, { t: "frame", clientId, frame });
    }
    room.queued.clear();
  }

  /** Transactional notifications reduce latency; polling the persisted revision
   * repairs lost hints without issuing fresh proxy tokens on every heartbeat. */
  async refreshLogins(scope?: { ownerUserId: string; organizationId?: string }): Promise<void> {
    await Promise.all([...this.rooms.values()].map(async room => {
      if (!room.ready || !room.worker || (scope && (scope.ownerUserId !== room.workspace.creatorUserId ||
          (scope.organizationId && scope.organizationId !== room.workspace.organizationId)))) return;
      const ws = room.worker;
      await this.refreshConfig(room, ws, false).catch(() => ws.close(1011, "config_unavailable"));
    }));
  }

  private refreshConfig(room: Room, ws: WebSocket, force: boolean): Promise<boolean> {
    const active = room.configFlight;
    if (active?.worker === ws) { active.requested = true; active.force ||= force; return active.promise; }
    const flight: ConfigFlight = { worker: ws, requested: true, force, promise: Promise.resolve(false) };
    room.configFlight = flight;
    flight.promise = this.loadConfig(room, flight).finally(() => {
      if (room.configFlight === flight) delete room.configFlight;
    });
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
      // A selection can commit while the three provider reads are in flight.
      // Discard that mixed/stale result and re-read; never send it after a newer one.
      if (revision !== await this.deps.store.loginRevision(room.workspace.id)) {
        flight.requested = true; flight.force = true; continue;
      }
      if (room.worker !== ws || room.revoked) return false;
      send(ws, config); room.loginRevision = revision;
    } while (flight.requested);
    return true;
  }

  private async fromWorker(room: Room, ws: WebSocket, frame: Exclude<CloudV2WorkerFrame, { t: "hello" }>): Promise<void> {
    if (room.revoked || room.worker !== ws) return;
    // Streaming output stays on the relay; the security broker and heartbeat
    // revalidate it. App commands and credential requests always check the DB.
    switch (frame.t) {
      case "frame":
        if (frame.clientId === "*") for (const client of room.clients.values()) send(client, frame.frame);
        else send(room.clients.get(frame.clientId) ?? null, frame.frame);
        return;
      case "history": {
        const { t: _t, ...history } = frame;
        room.history = room.history
          .then(() => room.revoked ? undefined : this.deps.store.writeHistory(room.workspace.id, history))
          .catch(error => this.deps.logger?.warn("[cloud-v2] history mirror failed", error instanceof Error ? error.message : "unknown"));
        return;
      }
      case "idle":
        if (!frame.idle && Date.now() - room.lastActiveWrite >= ACTIVE_WRITE_INTERVAL_MS) {
          room.lastActiveWrite = Date.now();
          void this.deps.store.markActive(room.workspace.id).catch(() => { room.lastActiveWrite = 0; });
        }
        return;
      case "request":
        if (!await this.authorized(room) || room.worker !== ws) return;
        void this.deps.githubToken(room.workspace).then(
          async granted => { if (await this.authorized(room) && room.worker === ws) send(ws, { t: "reply", id: frame.id, token: granted.token, expiresAt: granted.expiresAt }); },
          () => send(ws, { t: "refusal", id: frame.id, code: "github_token_unavailable" }),
        );
        return;
    }
  }

  private async admitApp(workspaceId: string, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const offered = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
    const ticket = offered.find(value => value.startsWith("ticket."))?.slice("ticket.".length) ?? "";
    if (!offered.includes(CLOUD_V2_BRIDGE_PROTOCOL) || !isCloudV2Token(ticket, "connect")) return reject(socket, 401);
    let workspace: CloudV2Workspace | null = null;
    let accessEpoch: string | undefined;
    try {
      const admitted = await this.deps.store.consumeConnectTicket(ticket, workspaceId);
      if (admitted && await this.deps.store.accessEpoch(workspaceId) === admitted.accessEpoch) {
        workspace = await this.deps.store.get(workspaceId, admitted.userId);
        accessEpoch = admitted.accessEpoch;
      }
    } catch (error) {
      this.deps.logger?.warn("[cloud-v2] app admission failed", error instanceof Error ? error.message : "unknown");
    }
    if (!workspace) return reject(socket, 401);
    const admitted = workspace;
    this.server.handleUpgrade(request, socket, head, ws => this.attachApp(admitted, accessEpoch!, ws));
  }

  private attachApp(workspace: CloudV2Workspace, accessEpoch: string, ws: WebSocket): void {
    const room = this.room(workspace, accessEpoch);
    // A stopped VM's socket can look open until the next ping; never relay into it.
    if (room.worker && (workspace.state === "stopping" || workspace.state === "stopped")) {
      room.worker.terminate();
      room.worker = null;
      room.ready = false;
    }
    if (!room.worker) room.workspace = workspace;
    const clientId = randomUUID();
    this.watch(ws);
    // A security event can commit while admission is awaiting get(). Register
    // listeners now, but expose no client or queued command until revalidated.
    let inbound = this.authorized(room).then(allowed => {
      if (!allowed || ws.readyState !== WebSocket.OPEN) { ws.close(4001, "access_revoked"); return; }
      room.clients.set(clientId, ws);
      if (room.ready) send(room.worker, { t: "open", clientId });
      else if (workspace.state === "stopped") void this.deps.wake(workspace).catch(() => {});
    });
    ws.on("message", data => { inbound = inbound.then(() => this.fromApp(room, clientId, ws, data))
      .catch(() => ws.close(1011, "relay_unavailable")); });
    ws.on("close", () => {
      room.clients.delete(clientId);
      room.queued.delete(clientId);
      if (room.ready) send(room.worker, { t: "close", clientId });
    });
  }

  private async fromApp(room: Room, clientId: string, ws: WebSocket, data: RawData): Promise<void> {
    if (!await this.authorized(room) || !room.clients.has(clientId)) return;
    let frame: unknown;
    try {
      frame = parse(data);
    } catch {
      ws.close(4003, "invalid_frame");
      return;
    }
    if (room.ready) { send(room.worker, { t: "frame", clientId, frame }); return; }
    const answer = await this.deps.answerOffline(room.workspace, frame).catch(() => null);
    if (!await this.authorized(room) || !room.clients.has(clientId)) return;
    if (answer) { send(ws, answer); return; }
    if (room.ready) { send(room.worker, { t: "frame", clientId, frame }); return; }
    const queue = room.queued.get(clientId) ?? [];
    if (queue.length >= MAX_QUEUED_FRAMES) { ws.close(1013, "workspace_starting"); return; }
    // Work for a VM that went away while this app stayed connected starts it.
    if (!queue.length) void this.deps.wake(room.workspace).catch(() => {});
    queue.push(frame);
    room.queued.set(clientId, queue);
  }
}
