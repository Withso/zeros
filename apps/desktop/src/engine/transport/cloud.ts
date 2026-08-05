// ──────────────────────────────────────────────────────────
// CloudTransport — HTTP + WebSocket on 0.0.0.0 (the in-sandbox bridge)
// ──────────────────────────────────────────────────────────
//
// A cloud workspace is the SAME Zeros engine running inside a remote sandbox.
// The Mac renderer reaches it over a public preview-URL WSS — which terminates
// at the sandbox provider's reverse proxy and is forwarded to whatever port the
// engine binds on 0.0.0.0 inside the box. THIS transport is that port.
//
// It is a SEPARATE transport from LocalTransport on purpose:
// LocalTransport's loopback/Origin gate is a DNS-rebinding defense for a server
// that only binds 127.0.0.1, and must NOT be relaxed to serve cloud. CloudTransport
// instead binds 0.0.0.0 (the preview proxy IS the network boundary) and gates the
// /ws upgrade with a worker-minted connection token.
//
// The transport uses a shared connection token, extended keep-alive timeouts,
// and server-side pings, surfacing each peer as a `kind: "cloud"` client so the
// engine can serve the full bridge (handshake, file tree, and PTY). Production
// multi-user hosting additionally requires account/workspace binding; when
// `accountAuth` is unset, the shared bridge token is the only remote gate.
//
// HTTP routes:  GET /health (status; ungated — the preview proxy + the worker
//                            probe it, and it carries no secrets)
// WebSocket:    /ws (the renderer's bridge; token-gated)
// ──────────────────────────────────────────────────────────

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { EngineMessage } from "../types";
import type { Transport, TransportClient } from "./types";

/** Constant-time string compare that never short-circuits on length.
 *  Duplicated from LocalTransport rather than shared — it's a 12-line security
 *  primitive and keeping the two transports import-independent is deliberate. */
function tokensMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/** The sandbox provider's preview proxy closes an idle upstream connection
 *  (its pool TTL races Node's default 5 s `keepAliveTimeout`).
 *  Raising the engine's keep-alive well past the proxy's idle window — plus the
 *  server-side ping below and the client's own pings — keeps the bridge from
 *  being torn down under it. `headersTimeout` must exceed `keepAliveTimeout`. */
const KEEPALIVE_TIMEOUT_MS = 120_000;
const HEADERS_TIMEOUT_MS = 125_000;
/** Server→client ping cadence. Under 30 s keeps the proxy's connection warm
 *  (app-level pings must beat the proxy's idle window); a client that misses two pongs in a
 *  row is assumed dead and terminated so a half-open socket can't linger. */
const PING_INTERVAL_MS = 25_000;

export interface CloudTransportOptions {
  /** TCP port the in-sandbox engine binds (on 0.0.0.0) behind the preview proxy. */
  port: number;
  /** Worker-minted connection token presented on the /ws upgrade. New clients
   *  use `x-zeros-cloud-token`; `?token=` remains a compatibility path. Empty
   *  string disables the gate for an otherwise authenticated test boundary. */
  token?: string;
}

class CloudClient implements TransportClient {
  readonly kind = "cloud" as const;
  /** Liveness flag toggled by the keepalive ping/pong loop. */
  isAlive = true;
  constructor(
    readonly id: string,
    private readonly ws: WebSocket,
  ) {}
  send(msg: EngineMessage): void {
    if (this.ws.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(msg));
  }
  close(code = 1000, reason?: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      // ignore
    }
  }
}

/**
 * Token-authenticated WS server that accepts the preview-proxy Host
 * (non-loopback) and surfaces each peer as a `kind: "cloud"` TransportClient.
 * Wired into ZerosEngine's `this.transports[]` only when `ZEROS_CLOUD_PORT` is
 * set, so it is inert in the local desktop build.
 */
export class CloudTransport implements Transport {
  private readonly httpServer: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, CloudClient>();
  private readonly startTime = Date.now();
  // Mutable: when constructed with `port: 0` (tests) this is rewritten to the
  // OS-assigned ephemeral port once the server is listening (see start()).
  private port: number;
  private readonly token: string;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private getInfo:
    | (() => { version: string; uptime: number; connections: number })
    | null = null;

  private onConnectCb: ((c: TransportClient) => void) | null = null;
  private onDisconnectCb: ((c: TransportClient) => void) | null = null;
  private onMessageCb:
    | ((c: TransportClient, msg: EngineMessage) => void)
    | null = null;

  constructor(opts: CloudTransportOptions) {
    this.port = opts.port;
    this.token = opts.token ?? "";
    this.httpServer = createServer((req, res) => this.handleHTTP(req, res));
    // Outlive the preview proxy's idle window.
    this.httpServer.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
    this.httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "", "http://sandbox");
      // No loopback/Origin gate here (that is LocalTransport's DNS-rebinding
      // defense for a 127.0.0.1 server). The preview proxy is the network
      // boundary; the connection token is the auth. A missing/!=`/ws` path or a
      // bad token drops the socket.
      if (url.pathname === "/ws" && this.isTokenValid(url, request.headers)) {
        this.wss.handleUpgrade(request, socket, head, (ws) =>
          this.wss.emit("connection", ws, request),
        );
      } else {
        socket.destroy();
      }
    });

    this.wss.on("connection", (ws: WebSocket) => {
      const client = new CloudClient(randomUUID(), ws);
      this.clients.set(ws, client);

      ws.on("pong", () => {
        client.isAlive = true;
      });
      ws.on("message", (data) => {
        let msg: EngineMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        this.onMessageCb?.(client, msg);
      });
      ws.on("close", () => {
        this.clients.delete(ws);
        this.onDisconnectCb?.(client);
      });
      ws.on("error", () => {
        this.clients.delete(ws);
      });

      this.onConnectCb?.(client);
    });
  }

  onConnect(handler: (client: TransportClient) => void): void {
    this.onConnectCb = handler;
  }
  onDisconnect(handler: (client: TransportClient) => void): void {
    this.onDisconnectCb = handler;
  }
  onMessage(
    handler: (client: TransportClient, msg: EngineMessage) => void,
  ): void {
    this.onMessageCb = handler;
  }

  broadcast(msg: EngineMessage): void {
    for (const client of this.clients.values()) client.send(msg);
  }

  setInfoProvider(
    fn: () => { version: string; uptime: number; connections: number },
  ): void {
    this.getInfo = fn;
  }
  get connectionCount(): number {
    return this.clients.size;
  }
  /** The TCP port the HTTP/WS server is bound to. Equals the configured port,
   *  except when constructed with `port: 0` (tests), where it reflects the
   *  OS-assigned ephemeral port after start() — null/0 before then. */
  get boundPort(): number {
    return this.port;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.httpServer.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.httpServer.removeListener("error", onError);
        resolve();
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      // 0.0.0.0: reachable from the preview proxy, which terminates the
      // public WSS and forwards to this port inside the sandbox.
      this.httpServer.listen(this.port, "0.0.0.0");
    });

    // When port 0 was requested, capture the ephemeral port the OS actually
    // assigned so callers (and the log line below) report the real port.
    const addr = this.httpServer.address();
    if (addr && typeof addr === "object") this.port = addr.port;

    // Keepalive sweep: ping every client; terminate any that didn't pong since
    // the last tick. Keeps the proxy connection warm AND reaps half-open sockets.
    this.pingTimer = setInterval(() => {
      for (const [ws, client] of this.clients) {
        if (!client.isAlive) {
          this.clients.delete(ws);
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          continue;
        }
        client.isAlive = false;
        try {
          ws.ping();
        } catch {
          // ignore
        }
      }
    }, PING_INTERVAL_MS);
    if (typeof this.pingTimer.unref === "function") this.pingTimer.unref();

    console.log(
      `[Zeros cloud] CloudTransport listening on 0.0.0.0:${this.port}`,
    );
  }

  async stop(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const ws of this.clients.keys()) {
      try {
        ws.close(1001, "Engine shutting down");
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** The token gate. An empty configured token disables the check. Prefer the
   *  header so credentials do not enter URLs or request-target logs; accept the
   *  query form for existing clients. */
  private isTokenValid(url: URL, headers: IncomingMessage["headers"]): boolean {
    if (!this.token) return true;
    const fromQuery = url.searchParams.get("token") ?? "";
    if (tokensMatch(this.token, fromQuery)) return true;
    const header = headers["x-zeros-cloud-token"];
    const fromHeader = Array.isArray(header)
      ? (header[0] ?? "")
      : (header ?? "");
    return tokensMatch(this.token, fromHeader);
  }

  private handleHTTP(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "", "http://sandbox");
    if (url.pathname === "/health" && req.method === "GET") {
      const info = this.getInfo?.() ?? {
        version: "unknown",
        uptime: Date.now() - this.startTime,
        connections: this.clients.size,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", transport: "cloud", ...info }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        name: "zeros-engine",
        transport: "cloud",
        health: "/health",
        ws: "/ws",
      }),
    );
  }
}
