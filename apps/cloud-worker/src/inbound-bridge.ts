import { randomUUID } from "node:crypto";
import { CLOUD_WORKER_FEATURES } from "./worker-features";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { CLOUD_V2_MAX_FRAME_BYTES, CLOUD_V2_WORKER_BRIDGE_PATH, CLOUD_V2_WORKER_BRIDGE_PROTOCOL, CLOUD_V2_WORKER_PORT,
  CloudV2ControlFrameSchema, type CloudV2ControlFrame, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { SYNC_BRIDGE_PATH, SYNC_BRIDGE_PROTOCOL, SYNC_LIMITS, SyncRenewFrameSchema } from "@zeros/protocol/workspace-sync";
import { readWorkerPublicKeys, WorkerTokenVerifier } from "./worker-auth";

interface Options {
  workspaceId: string; bootId: string; port?: number; publicKeys?: readonly string[]; publicKeysFile?: string;
  failedAuthLimit?: number; pingIntervalMs?: number; now?: () => number;
  onPushChange?: () => void;
  /** Worker journal lines for sync sockets: short ids, codes and counts only. */
  log?(line: string): void;
  /** sync-context-v1 (team sharing 3A, activated workspaces): the sync socket's control-plane client handle. */
  syncContexts?: SyncContexts;
}
type ActivityReply = Extract<CloudV2ControlFrame, { t: "activity-reply" }>;
interface Connection {
  socket: WebSocket; clients: Map<string, string>; stops: Map<string, string>; alive: boolean;
  push?: { prompts: boolean };
  activity?: { id: string; finish: (reply: ActivityReply | null) => void };
}

/** The worker's execution contexts, as a sync socket's handle needs them. */
export interface SyncContexts {
  /** An activated workspace: a grant without its handle opens nothing. */
  required(): boolean;
  /** One successful renewal (after the clean boot) before any read: a grant may have been minted before a revocation. */
  admit(contextId: string, userId: string): Promise<boolean>;
  ended(contextId: string, listener: () => void): () => void;
  release(contextId: string): void;
  /** The handle's current state, checked before every read and reply: past its (possibly shortened) deadline it has ended. */
  live(contextId: string): boolean;
}
/** Order 3: one Mac's direct sync socket, carrying plain bridge messages for one passive client. */
interface SyncConnection { socket: WebSocket; clientId: string; sub: string; dev: string; ctx?: string; alive: boolean; deadline: number; renew?: ReturnType<typeof setTimeout>; queue: Promise<void> }
/** Sync backpressure: replies wait while more than this is buffered, for at most SYNC_STALL_MS. */
const SYNC_LOW_WATER_BYTES = 1024 * 1024, SYNC_STALL_MS = 120_000;
/** A sync socket lives until the newest accepted grant's SIGNED iat + 10 minutes, less the 30 s skew allowance. */
const syncDeadline = (iat: number) => (iat + SYNC_LIMITS.renewMs / 1000 - 30) * 1000;
const MAX_SYNC_SOCKETS = 4;

/** Boat's protected route forwards to this loopback-only listener. Never log
 * request headers: Boat forwards its private _port_auth cookie too. */
export class InboundBridge {
  private readonly connections = new Set<Connection>();
  private readonly syncByContext = new Map<string, SyncConnection>();
  private readonly routes = new Map<string, { connection: Connection; clientId: string }>();
  private readonly syncs = new Map<string, SyncConnection>();
  private readonly server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/v2/worker/health") { response.writeHead(404).end(); return; }
    const status = this.authenticate(request);
    response.writeHead(status || 200, { "Cache-Control": "no-store" }).end();
  });
  private readonly websockets = new WebSocketServer({ noServer: true, maxPayload: CLOUD_V2_MAX_FRAME_BYTES, perMessageDeflate: false,
    handleProtocols: (protocols, request) => request.url === SYNC_BRIDGE_PATH
      ? protocols.has(SYNC_BRIDGE_PROTOCOL) ? SYNC_BRIDGE_PROTOCOL : false
      : protocols.has(CLOUD_V2_WORKER_BRIDGE_PROTOCOL) ? CLOUD_V2_WORKER_BRIDGE_PROTOCOL : false });
  private verifier?: WorkerTokenVerifier;
  private receive?: (frame: CloudV2ControlFrame) => Promise<void>;
  private ping?: ReturnType<typeof setInterval>;
  private failures = 0;
  private failureWindow = 0;
  private readonly pushWaiters = new Set<() => void>();

  constructor(private readonly options: Options) {
    this.websockets.on("headers", headers => { headers.push(`X-Zeros-Worker-Features: ${CLOUD_WORKER_FEATURES}`); });
  }

  async start(receive: (frame: CloudV2ControlFrame) => Promise<void>): Promise<AddressInfo> {
    this.verifier = new WorkerTokenVerifier({ ...this.options, publicKeys: this.options.publicKeys ?? await readWorkerPublicKeys(this.options.publicKeysFile) });
    this.receive = receive;
    this.server.on("upgrade", (request, socket, head) => {
      if (request.method === "GET" && request.url === SYNC_BRIDGE_PATH) return this.upgradeSync(request, socket, head);
      if (request.method !== "GET" || request.url !== CLOUD_V2_WORKER_BRIDGE_PATH) return this.reject(socket, 404);
      const status = this.authenticate(request);
      if (status) return this.reject(socket, status);
      const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
      if (!protocols.includes(CLOUD_V2_WORKER_BRIDGE_PROTOCOL)) return this.reject(socket, 400);
      if (this.connections.size >= 8) return this.reject(socket, 503);
      // No frame parser exists for this socket until authentication succeeds.
      this.websockets.handleUpgrade(request, socket, head, ws => this.attach(ws));
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port ?? CLOUD_V2_WORKER_PORT, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
    });
    this.ping = setInterval(() => {
      for (const connection of [...this.connections, ...this.syncs.values()]) {
        if (!connection.alive) { connection.socket.terminate(); continue; }
        connection.alive = false; connection.socket.ping();
      }
    }, this.options.pingIntervalMs ?? 25_000);
    this.ping.unref();
    return this.server.address() as AddressInfo;
  }

  async send(frame: CloudV2WorkerFrame): Promise<boolean> {
    if (frame.t === "frame") {
      if (frame.clientId === "*") return (await Promise.all([...this.connections].map(({ socket }) => this.write(socket, frame)))).every(Boolean);
      const sync = this.syncs.get(frame.clientId);
      // A sync socket hears only its own replies and hints, as plain bridge messages, and nothing past its deadline.
      if (sync) {
        if (this.now() >= sync.deadline || (sync.ctx && !this.options.syncContexts?.live(sync.ctx))) { sync.socket.close(4001); return false; }
        return this.writeSync(sync, frame.frame as object);
      }
      const route = this.routes.get(frame.clientId);
      return route ? this.write(route.connection.socket, { ...frame, clientId: route.clientId }) : false;
    }
    if (frame.t === "stop-ack") {
      for (const connection of this.connections) {
        const id = connection.stops.get(frame.id);
        if (id) {
          connection.stops.delete(frame.id);
          const sent = await this.write(connection.socket, { t: "stop-ack", id });
          // Move every replica onto its offline/wake path before Boat freezes
          // the VM. Another requester must receive its own pending ack first.
          if (sent) for (const peer of this.connections) if (!peer.stops.size) peer.socket.close(1001, "worker_stopping");
          return sent;
        }
      }
    }
    return false;
  }

  get promptPush(): boolean {
    return [...this.connections].some(connection => connection.push?.prompts && connection.socket.readyState === WebSocket.OPEN);
  }

  /** A prompt hint aborts the inbox's wait; losing push instead resumes HTTPS. */
  async waitForPromptFallback(signal?: AbortSignal): Promise<void> {
    if (!this.promptPush) return;
    await new Promise<void>((resolve, reject) => {
      const dispose = () => { this.pushWaiters.delete(check); signal?.removeEventListener("abort", abort); };
      const check = () => { if (!this.promptPush) { dispose(); resolve(); } };
      const abort = () => { dispose(); reject(new Error("Prompt wait cancelled.")); };
      this.pushWaiters.add(check);
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  async activity(idle: boolean): Promise<ActivityReply | null> {
    const connection = [...this.connections].find(peer => peer.push && peer.socket.readyState === WebSocket.OPEN);
    if (!connection || connection.activity) return null;
    const id = randomUUID();
    return new Promise(resolve => {
      const finish = (reply: ActivityReply | null) => {
        if (connection.activity?.id !== id) return;
        clearTimeout(timer); delete connection.activity; resolve(reply);
      };
      // Keep the slot until its ACK or close: a slow read must neither overlap
      // the next relay report nor detach the app. A late reply only frees it.
      const timer = setTimeout(() => resolve(null), 2_000);
      timer.unref();
      connection.activity = { id, finish };
      void this.write(connection.socket, { t: "activity", id, idle }).then(sent => { if (!sent) finish(null); });
    });
  }

  private pushChanged(): void {
    for (const wake of [...this.pushWaiters]) wake();
    this.options.onPushChange?.();
  }

  async dispose(): Promise<void> {
    clearInterval(this.ping);
    for (const connection of this.connections) connection.socket.terminate();
    for (const sync of this.syncs.values()) { clearTimeout(sync.renew); sync.socket.terminate(); }
    await new Promise<void>(resolve => this.websockets.close(() => resolve()));
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  /** A Mac's sync grant, and only that, opens this path; a control grant does not. */
  private upgradeSync(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const accepted = this.verifier?.acceptSync(request.headers["x-zeros-worker-auth"]);
    const identity = accepted && accepted.ctx === undefined && this.options.syncContexts?.required() ? null : accepted;
    if (!identity) {
      if (Date.now() - this.failureWindow >= 30_000) { this.failureWindow = Date.now(); this.failures = 0; }
      this.failures++;
      return this.reject(socket, this.failures > (this.options.failedAuthLimit ?? 32) ? 429 : 401);
    }
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
    if (!protocols.includes(SYNC_BRIDGE_PROTOCOL)) return this.reject(socket, 400);
    if (this.syncs.size >= MAX_SYNC_SOCKETS) return this.reject(socket, 503);
    this.websockets.handleUpgrade(request, socket, head, ws => this.attachSync(ws, identity));
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private attachSync(socket: WebSocket, identity: { sub: string; dev: string; iat: number; ctx?: string }): void {
    const sync: SyncConnection = { socket, clientId: randomUUID(), sub: identity.sub, dev: identity.dev, ...(identity.ctx ? { ctx: identity.ctx } : {}),
      alive: true, deadline: syncDeadline(identity.iat), queue: Promise.resolve() };
    const contexts = identity.ctx ? this.options.syncContexts : undefined;
    // One live socket per handle: a new one replaces its predecessor (which then releases nothing).
    if (sync.ctx) {
      const previous = this.syncByContext.get(sync.ctx);
      this.syncByContext.set(sync.ctx, sync);
      previous?.socket.close(1000);
    }
    let stopEnded = () => {};
    // Nothing is read, and the passive client is not opened, until the handle's first renewal succeeds.
    const admitted: Promise<boolean> = sync.ctx && contexts ? contexts.admit(sync.ctx, sync.sub).catch(() => false) : Promise.resolve(true);
    let opened = false;
    // Unrenewed past its deadline: closed, so a revoked Mac stops reading without any push.
    const arm = () => { clearTimeout(sync.renew); sync.renew = setTimeout(() => socket.close(4001), Math.max(0, sync.deadline - this.now())); sync.renew.unref?.(); };
    arm();
    this.syncs.set(sync.clientId, sync);
    socket.on("error", () => {});
    socket.on("pong", () => { sync.alive = true; });
    this.options.log?.(`sync socket open client=${sync.clientId.slice(0, 8)}`);
    // The Mac's device id: a sync's keep-awake allowance counts per device across sockets.
    const ready = admitted.then(ok => {
      if (!ok) { socket.close(4001); return false; }
      if (socket.readyState !== socket.OPEN) return false;
      // The handle exists once admitted: from now on its end (revoked, refused, expired) closes this socket.
      if (sync.ctx && contexts) stopEnded = contexts.ended(sync.ctx, () => socket.close(4001));
      opened = true;
      void this.receive!({ t: "open", clientId: sync.clientId, passive: true, device: sync.dev }).catch(() => socket.close(1011));
      return true;
    });
    socket.on("message", (data, binary) => { void ready.then(ok => { if (ok) handle(data, binary); }); });
    const handle = (data: WebSocket.RawData, binary: boolean) => {
      if (binary) { socket.close(4003); return; }
      // Checked on every frame, a renewal included: a late renewal cannot revive a socket.
      if (this.now() >= sync.deadline || (sync.ctx && contexts && !contexts.live(sync.ctx))) { socket.close(4001); return; }
      let value: unknown;
      try { value = JSON.parse(data.toString()); } catch { socket.close(4003); return; }
      if (value && typeof value === "object" && (value as { t?: unknown }).t === "renew") {
        const renew = SyncRenewFrameSchema.safeParse(value), next = renew.success ? this.verifier?.acceptSync(renew.data.grant) : null;
        if (!next || next.sub !== sync.sub || next.dev !== sync.dev || next.ctx !== sync.ctx) { socket.close(4001); return; }
        // A held grant (older iat) cannot extend the deadline; only a newer signature moves it.
        sync.deadline = Math.max(sync.deadline, syncDeadline(next.iat));
        arm(); return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) { socket.close(4003); return; }
      void this.receive!({ t: "frame", clientId: sync.clientId, frame: value as Record<string, unknown> } as CloudV2ControlFrame).catch(() => socket.close(1011));
    };
    socket.on("close", code => {
      clearTimeout(sync.renew);
      stopEnded();
      if (sync.ctx && this.syncByContext.get(sync.ctx) === sync) { this.syncByContext.delete(sync.ctx); contexts?.release(sync.ctx); }
      this.options.log?.(`sync socket closed client=${sync.clientId.slice(0, 8)} code=${code}`);
      if (this.syncs.get(sync.clientId) !== sync) return;
      this.syncs.delete(sync.clientId);
      if (opened) void this.receive!({ t: "close", clientId: sync.clientId }).catch(() => {});
    });
  }

  private authenticate(request: IncomingMessage): number {
    // Failed attempts must never lock out an authentic control-plane grant.
    if (this.verifier?.accept(request.headers["x-zeros-worker-auth"])) return 0;
    if (Date.now() - this.failureWindow >= 30_000) { this.failureWindow = Date.now(); this.failures = 0; }
    if (this.failures >= (this.options.failedAuthLimit ?? 32)) return 429;
    this.failures++; return 401;
  }

  private reject(socket: Duplex, status: number): void {
    socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  }

  private attach(socket: WebSocket): void {
    const connection: Connection = { socket, clients: new Map(), stops: new Map(), alive: true };
    this.connections.add(connection);
    socket.on("error", () => {});
    socket.on("pong", () => { connection.alive = true; });
    socket.on("message", (data, binary) => {
      if (binary) { socket.close(4003); return; }
      let frame: CloudV2ControlFrame;
      try { frame = CloudV2ControlFrameSchema.parse(JSON.parse(data.toString())); }
      catch { socket.close(4003); return; }
      if (frame.t === "push") {
        const changed = !connection.push || connection.push.prompts !== frame.prompts;
        connection.push = { prompts: frame.prompts };
        if (changed) this.pushChanged();
        return;
      } else if (frame.t === "activity-reply") {
        if (connection.activity?.id === frame.id) connection.activity.finish(frame);
        return;
      } else if (frame.t === "open") {
        if (connection.clients.has(frame.clientId) || connection.clients.size >= 256) { socket.close(4003); return; }
        const id = randomUUID();
        connection.clients.set(frame.clientId, id); this.routes.set(id, { connection, clientId: frame.clientId });
        // Routing uses the local id; terminal and client leases name the control plane's own (any sent value is replaced).
        frame = { ...frame, clientId: id, authorityClientId: frame.clientId };
      } else if (frame.t === "frame" || frame.t === "close") {
        const id = connection.clients.get(frame.clientId);
        if (!id) { socket.close(4003); return; }
        if (frame.t === "close") { connection.clients.delete(frame.clientId); this.routes.delete(id); }
        frame = { ...frame, clientId: id };
      } else if (frame.t === "stop") {
        if (connection.stops.size >= 8) { socket.close(4003); return; }
        const id = randomUUID(); connection.stops.set(id, frame.id); frame = { ...frame, id };
      // A per-context revocation (3A) ends one person's context; the carrier and everyone else on it stay up.
      } else if (frame.t !== "config" && frame.t !== "prompts" && frame.t !== "revoke-context") { socket.close(4003); return; }
      void this.receive!(frame).catch(() => socket.close(1011));
    });
    socket.on("close", () => {
      this.connections.delete(connection);
      connection.activity?.finish(null);
      if (connection.push) this.pushChanged();
      for (const clientId of connection.clients.values()) {
        this.routes.delete(clientId);
        void this.receive!({ t: "close", clientId }).catch(() => {});
      }
      connection.clients.clear(); connection.stops.clear();
    });
  }

  /** A sync socket carries large replies (bundle chunks, batches) over a Mac's own link: they queue in
   * order and wait for the send buffer to drain (backpressure) instead of ending the socket. A link
   * that does not drain for SYNC_STALL_MS is closed with 4008; the Mac reconnects and backs off. */
  private writeSync(sync: SyncConnection, frame: object): Promise<boolean> {
    const run = sync.queue.then(() => this.writePaced(sync, frame));
    sync.queue = run.then(() => {}, () => {});
    return run;
  }
  private async writePaced(sync: SyncConnection, frame: object): Promise<boolean> {
    const socket = sync.socket;
    if (socket.readyState !== WebSocket.OPEN) return false;
    const payload = JSON.stringify(frame), bytes = Buffer.byteLength(payload);
    if (bytes > CLOUD_V2_MAX_FRAME_BYTES) { socket.close(1009); return false; }
    const started = Date.now();
    while (socket.bufferedAmount > SYNC_LOW_WATER_BYTES) {
      if (Date.now() - started > SYNC_STALL_MS) { this.options.log?.(`sync socket stalled client=${sync.clientId.slice(0, 8)}`); socket.close(4008); return false; }
      await new Promise(resolve => setTimeout(resolve, 25));
      if (socket.readyState !== WebSocket.OPEN) return false;
    }
    return new Promise(resolve => {
      // Long enough for a slow link (at least 32 KiB/s), never the 10 s a small control frame gets.
      const timer = setTimeout(() => { socket.close(4008); resolve(false); }, Math.max(30_000, Math.ceil(bytes / 32_768) * 1000));
      socket.send(payload, error => { clearTimeout(timer); resolve(!error); });
    });
  }

  private async write(socket: WebSocket, frame: CloudV2WorkerFrame | object): Promise<boolean> {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const payload = JSON.stringify(frame);
    if (Buffer.byteLength(payload) > CLOUD_V2_MAX_FRAME_BYTES || socket.bufferedAmount > 4 * 1024 * 1024) { socket.terminate(); return false; }
    return new Promise(resolve => {
      const timer = setTimeout(() => { socket.terminate(); resolve(false); }, 10_000);
      socket.send(payload, error => { clearTimeout(timer); resolve(!error); });
    });
  }
}
