import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { CLOUD_V2_MAX_FRAME_BYTES, CLOUD_V2_WORKER_BRIDGE_PATH, CLOUD_V2_WORKER_BRIDGE_PROTOCOL, CLOUD_V2_WORKER_PORT,
  CloudV2ControlFrameSchema, type CloudV2ControlFrame, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { readWorkerPublicKeys, WorkerTokenVerifier } from "./worker-auth";

interface Options {
  workspaceId: string; bootId: string; port?: number; publicKeys?: readonly string[]; publicKeysFile?: string;
  failedAuthLimit?: number; pingIntervalMs?: number;
}
interface Connection { socket: WebSocket; clients: Map<string, string>; stops: Map<string, string>; alive: boolean }

/** Boat's protected route forwards to this loopback-only listener. Never log
 * request headers: Boat forwards its private _port_auth cookie too. */
export class InboundBridge {
  private readonly connections = new Set<Connection>();
  private readonly routes = new Map<string, { connection: Connection; clientId: string }>();
  private readonly server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/v2/worker/health") { response.writeHead(404).end(); return; }
    const status = this.authenticate(request);
    response.writeHead(status || 200, { "Cache-Control": "no-store" }).end();
  });
  private readonly websockets = new WebSocketServer({ noServer: true, maxPayload: CLOUD_V2_MAX_FRAME_BYTES, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(CLOUD_V2_WORKER_BRIDGE_PROTOCOL) ? CLOUD_V2_WORKER_BRIDGE_PROTOCOL : false });
  private verifier?: WorkerTokenVerifier;
  private receive?: (frame: CloudV2ControlFrame) => Promise<void>;
  private ping?: ReturnType<typeof setInterval>;
  private failures = 0;
  private failureWindow = 0;

  constructor(private readonly options: Options) {
    this.websockets.on("headers", headers => { headers.push("X-Zeros-Worker-Features: mcp-v1"); });
  }

  async start(receive: (frame: CloudV2ControlFrame) => Promise<void>): Promise<AddressInfo> {
    this.verifier = new WorkerTokenVerifier({ ...this.options, publicKeys: this.options.publicKeys ?? await readWorkerPublicKeys(this.options.publicKeysFile) });
    this.receive = receive;
    this.server.on("upgrade", (request, socket, head) => {
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
      for (const connection of this.connections) {
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

  async dispose(): Promise<void> {
    clearInterval(this.ping);
    for (const connection of this.connections) connection.socket.terminate();
    await new Promise<void>(resolve => this.websockets.close(() => resolve()));
    await new Promise<void>(resolve => this.server.close(() => resolve()));
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
      if (frame.t === "open") {
        if (connection.clients.has(frame.clientId) || connection.clients.size >= 256) { socket.close(4003); return; }
        const id = randomUUID();
        connection.clients.set(frame.clientId, id); this.routes.set(id, { connection, clientId: frame.clientId });
        frame = { ...frame, clientId: id };
      } else if (frame.t === "frame" || frame.t === "close") {
        const id = connection.clients.get(frame.clientId);
        if (!id) { socket.close(4003); return; }
        if (frame.t === "close") { connection.clients.delete(frame.clientId); this.routes.delete(id); }
        frame = { ...frame, clientId: id };
      } else if (frame.t === "stop") {
        if (connection.stops.size >= 8) { socket.close(4003); return; }
        const id = randomUUID(); connection.stops.set(id, frame.id); frame = { ...frame, id };
      } else if (frame.t !== "config" && frame.t !== "prompts") { socket.close(4003); return; }
      void this.receive!(frame).catch(() => socket.close(1011));
    });
    socket.on("close", () => {
      this.connections.delete(connection);
      for (const clientId of connection.clients.values()) {
        this.routes.delete(clientId);
        void this.receive!({ t: "close", clientId }).catch(() => {});
      }
      connection.clients.clear(); connection.stops.clear();
    });
  }

  private async write(socket: WebSocket, frame: CloudV2WorkerFrame): Promise<boolean> {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const payload = JSON.stringify(frame);
    if (Buffer.byteLength(payload) > CLOUD_V2_MAX_FRAME_BYTES || socket.bufferedAmount > 4 * 1024 * 1024) { socket.terminate(); return false; }
    return new Promise(resolve => {
      const timer = setTimeout(() => { socket.terminate(); resolve(false); }, 10_000);
      socket.send(payload, error => { clearTimeout(timer); resolve(!error); });
    });
  }
}
