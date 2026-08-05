// ──────────────────────────────────────────────────────────
// LocalTransport — HTTP + WebSocket on loopback (the existing server)
// ──────────────────────────────────────────────────────────
//
// Extracted from the former EngineServer behind the Transport interface.
// Behavior is unchanged EXCEPT the wildcard `Access-Control-Allow-Origin`
// header is removed — a loopback-only server doesn't need CORS, and the
// wildcard would be a hole the moment anything became remote-reachable.
//
// HTTP routes:  GET /health (status)
// WebSocket:    /ws (the renderer's bridge)
// ──────────────────────────────────────────────────────────

import {
  createServer,
  request as httpRequest,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { ENGINE_PORT_SPAN } from "../runtime";
import type { EngineMessage } from "../types";
import type { Transport, TransportClient } from "./types";

/** Constant-time string compare that never short-circuits on length. */
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

/** The host[:port] in a Host header must resolve to loopback. A DNS-rebinding
 *  page reaches 127.0.0.1 but its Host header carries the attacker domain, so
 *  rejecting a non-loopback Host blunts that vector. An absent Host (some Node
 *  clients) is allowed — the server only binds 127.0.0.1, so it isn't remotely
 *  reachable, and rebinding always carries a Host. */
function isHostLoopback(host: string | undefined): boolean {
  if (!host) return true;
  // Strip an optional :port (and handle bracketed IPv6 `[::1]:port`).
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0];
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export interface EngineServerInfo {
  version: string;
  uptime: number;
  connections: number;
  stats?: { selectors: number; files: number; tokens: number };
}

export interface LocalHttpRequest {
  method: string;
  url: URL;
}

export interface LocalHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Early socket-ownership check.
 *
 * `listen()` resolving is insufficient when a killed engine's descendants
 * retain inherited copies of its listening socket: Bun can report a successful
 * bind while loopback traffic is still routed to the stale listener. Requiring
 * this boot's nonce three times catches that condition and lets LocalTransport
 * walk before the rest of startup.
 *
 * This is deliberately not the authoritative readiness signal. It runs before
 * later engine subsystems start, so the independent Electron host must still
 * prove the same nonce after startup completes. */
export async function confirmLoopbackOwnership(
  port: number,
  nonce: string,
  opts: { probes?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  const probes = opts.probes ?? 3;
  const timeoutMs = opts.timeoutMs ?? 1_000;
  for (let i = 0; i < probes; i++) {
    if (!(await healthNonceMatches(port, nonce, timeoutMs))) return false;
  }
  return true;
}

function healthNonceMatches(
  port: number,
  nonce: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 8192) body += chunk;
        });
        res.once("end", () => {
          if (res.statusCode !== 200) {
            finish(false);
            return;
          }
          try {
            const parsed = JSON.parse(body) as { instance?: unknown };
            finish(parsed.instance === nonce);
          } catch {
            finish(false);
          }
        });
        res.once("error", () => finish(false));
      },
    );
    req.once("timeout", () => {
      req.destroy();
      finish(false);
    });
    req.once("error", () => finish(false));
    req.end();
  });
}

class LocalClient implements TransportClient {
  readonly kind = "local" as const;
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

export class LocalTransport implements Transport {
  private readonly httpServer: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, LocalClient>();
  private readonly startTime = Date.now();
  private getInfo: (() => EngineServerInfo) | null = null;
  private readonly basePort: number;
  /** Per-launch secret the renderer must present (?token=…) on the /ws
   *  upgrade. Empty string disables the token gate (standalone/test only). */
  private readonly token: string;
  /** Web origins explicitly permitted to reach loopback (the dev renderer).
   *  file://, null and absent Origin are always allowed; any OTHER http(s)
   *  origin (a website, an embedded-browser tab) is rejected. */
  private readonly allowedOrigins: ReadonlySet<string>;
  /** Trusted host-only HTTP routes. The custom design protocol is the first
   * caller; renderer documents never receive the launch token that gates it. */
  private readonly handleHttp:
    | ((request: LocalHttpRequest) => Promise<LocalHttpResponse | null>)
    | null;

  /** Per-boot identity nonce, served as `instance` in /health. Not a secret —
   *  it lets the early ownership probe and Electron host tell THIS server's
   *  responses apart from a stale listener or sibling engine. */
  readonly instanceNonce = randomUUID();

  /** The port actually bound after start() (the port walk may shift it). */
  actualPort = 0;
  /** Maximum number of consecutive ports this process may try. Electron passes
   *  the remainder of its channel-owned range while doing cross-process
   *  readiness recovery; standalone engines use the historical eight. */
  private readonly portSpan: number;

  private onConnectCb: ((c: TransportClient) => void) | null = null;
  private onDisconnectCb: ((c: TransportClient) => void) | null = null;
  private onMessageCb:
    | ((c: TransportClient, msg: EngineMessage) => void)
    | null = null;

  constructor(opts: {
    port: number;
    portSpan?: number;
    token?: string;
    allowedOrigins?: string[];
    handleHttp?: (
      request: LocalHttpRequest,
    ) => Promise<LocalHttpResponse | null>;
  }) {
    this.basePort = opts.port;
    const requestedSpan = opts.portSpan ?? ENGINE_PORT_SPAN;
    this.portSpan =
      Number.isInteger(requestedSpan) && requestedSpan > 0
        ? Math.min(ENGINE_PORT_SPAN, requestedSpan)
        : ENGINE_PORT_SPAN;
    this.token = opts.token ?? "";
    this.allowedOrigins = new Set(opts.allowedOrigins ?? []);
    this.handleHttp = opts.handleHttp ?? null;
    this.httpServer = createServer((req, res) => {
      void this.handleHTTP(req, res).catch(() => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      });
    });
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "", "http://localhost");
      // Loopback is not a trust boundary: any website can open a
      // cross-origin ws:// to 127.0.0.1. Reject unless the request proves it
      // comes from our own renderer: a same-origin/loopback Host, an allowed
      // (or absent/file://) Origin, AND the per-launch token. Without all
      // three a drive-by page could drive the engine as a "local" client.
      if (
        url.pathname === "/ws" &&
        this.isOriginAllowed(request.headers.origin) &&
        isHostLoopback(request.headers.host) &&
        this.isTokenValid(url)
      ) {
        this.wss.handleUpgrade(request, socket, head, (ws) =>
          this.wss.emit("connection", ws, request),
        );
      } else {
        socket.destroy();
      }
    });

    this.wss.on("connection", (ws: WebSocket) => {
      const client = new LocalClient(randomUUID(), ws);
      this.clients.set(ws, client);

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

  setInfoProvider(fn: () => EngineServerInfo): void {
    this.getInfo = fn;
  }
  get connectionCount(): number {
    return this.clients.size;
  }

  /** Bind the loopback server, walking the allowed consecutive ports when a
   *  candidate is busy or its traffic is routed to a stale inherited socket.
   *
   *  The in-process nonce check proves early socket ownership only. It cannot
   *  claim final readiness: in beta.84 it passed, then a later native FSEvents
   *  watcher deadlocked Bun's compiled event loop. The independent Electron
   *  host therefore verifies the same nonce after the manifest is published. */
  async start(): Promise<void> {
    const maxAttempts = this.portSpan;
    for (let i = 0; i < maxAttempts; i++) {
      const port = this.basePort + i;
      try {
        await this.listen(port);
      } catch (err: unknown) {
        if (
          (err as NodeJS.ErrnoException).code === "EADDRINUSE" &&
          i < maxAttempts - 1
        )
          continue;
        throw err;
      }
      if (await confirmLoopbackOwnership(port, this.instanceNonce)) {
        this.actualPort = port;
        return;
      }
      console.warn(
        `[Zeros] bound port ${port} but its loopback traffic routes to another process ` +
          `(stale listener holding an inherited socket?) — walking to the next port`,
      );
      await new Promise<void>((resolve) =>
        this.httpServer.close(() => resolve()),
      );
    }
    throw new Error(
      `Could not find a working port (tried ${this.basePort}-${this.basePort + maxAttempts - 1})`,
    );
  }

  async stop(): Promise<void> {
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

  private listen(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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
      this.httpServer.listen(port, "127.0.0.1");
    });
  }

  /** An Origin is allowed when absent, `null`, a `file://` origin (the packaged
   *  renderer), or one of the explicitly-allowlisted dev origins. Any other
   *  http(s) origin — a website, or a page inside the embedded browser tab —
   *  is rejected, so a cross-site request can't masquerade as the renderer. */
  private isOriginAllowed(origin: string | undefined): boolean {
    if (origin === undefined || origin === "" || origin === "null") return true;
    if (origin.startsWith("file://")) return true;
    return this.allowedOrigins.has(origin);
  }

  /** The token gate. An empty configured token disables the check (standalone
   *  engine / tests that never set ZEROS_LOCAL_WS_TOKEN). */
  private isTokenValid(url: URL): boolean {
    if (!this.token) return true;
    return tokensMatch(this.token, url.searchParams.get("token") ?? "");
  }

  private isHeaderTokenValid(value: string | string[] | undefined): boolean {
    if (!this.token) return true;
    return tokensMatch(
      this.token,
      Array.isArray(value) ? (value[0] ?? "") : (value ?? ""),
    );
  }

  private async handleHTTP(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "", "http://localhost");

    // Same cross-origin and rebinding gate as the WebSocket upgrade. The CLI health
    // probe sends no Origin (allowed); a browser on another site sends its own
    // Origin (rejected) so it can't even probe /health for version/stats.
    if (
      !this.isOriginAllowed(req.headers.origin) ||
      !isHostLoopback(req.headers.host)
    ) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    if (url.pathname.startsWith("/design/")) {
      if (
        req.method !== "GET" ||
        !this.handleHttp ||
        !this.isHeaderTokenValid(req.headers["x-zeros-engine-token"])
      ) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      const result = await this.handleHttp({ method: req.method, url });
      if (!result) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found.");
        return;
      }
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }

    if (url.pathname === "/health" && req.method === "GET") {
      const info = this.getInfo?.() ?? {
        version: "unknown",
        uptime: Date.now() - this.startTime,
        connections: this.clients.size,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      // Ownership fields come last so an info provider cannot accidentally
      // override the nonce/status that the engine and host use as proof.
      res.end(
        JSON.stringify({
          ...info,
          status: "ok",
          instance: this.instanceNonce,
        }),
      );
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ name: "zeros-engine", health: "/health", ws: "/ws" }),
    );
  }
}
