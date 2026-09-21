import {
  request,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
  type OutgoingHttpHeaders,
} from "node:http";
import { Transform, type Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { CloudRuntimeServiceAccess } from "../cloud-runtime-registration";

const MAX_REQUESTS = 32;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_MS = 60_000;
const HEADER = "x-zeros-runtime-access";
const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function limitedStream(maximum: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > maximum ? new Error("preview size limit") : null, chunk);
    },
  });
}

function proxyHeaders(source: IncomingMessage["headers"]): OutgoingHttpHeaders {
  const blocked = new Set(HOP_HEADERS);
  for (const name of (source.connection ?? "").split(","))
    blocked.add(name.trim().toLowerCase());
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      blocked.has(name) ||
      name.startsWith("x-zeros-") ||
      name.startsWith("x-daytona-")
    )
      continue;
    result[name] = value;
  }
  return result;
}

/** One provider-independent application gateway. Provider routes expose only
 * this authenticated runtime port, never an application's raw listener.
 * Authorization precedes loopback I/O and is renewed during long responses.
 * Streams use backpressure; slots, bytes, lifetime and authority are bounded. */
export class CloudRuntimePreviewGateway {
  private readonly requests = new Set<() => void>();
  private closed = false;
  private pendingVerifications = 0;
  constructor(
    private readonly options: {
      verify: (token: string) => Promise<CloudRuntimeServiceAccess | null>;
      forbiddenPorts: () => readonly number[];
    },
  ) {}

  /** Transparent, bounded WebSocket transport for HMR and application streams.
   * Authentication completes before opening the application socket. The
   * application never receives a Zeros or provider service credential. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (req.headers[HEADER] === undefined) return false;
    const deny = (status: number) => socket.end(`HTTP/1.1 ${status} Preview unavailable\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    if (this.closed) { deny(503); return true; }
    if (this.requests.size >= MAX_REQUESTS || this.pendingVerifications >= MAX_REQUESTS) { deny(429); return true; }
    const token = req.headers[HEADER], key = req.headers["sec-websocket-key"];
    if (typeof token !== "string" || !/^zwp_[A-Za-z0-9_-]{43}$/.test(token) ||
      req.method !== "GET" || !req.url?.startsWith("/") || req.url.startsWith("//") ||
      req.headers.upgrade?.toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13" ||
      !(req.headers.connection ?? "").toLowerCase().split(",").map(x => x.trim()).includes("upgrade") ||
      typeof key !== "string" || !/^[+/0-9A-Za-z]{22}==$/.test(key) || head.length > MAX_REQUEST_BYTES) { deny(401); return true; }
    socket.pause();
    let finished = false, upstream: ClientRequest | null = null, peer: Duplex | null = null;
    let renewal: ReturnType<typeof setTimeout> | undefined, accessDeadline: ReturnType<typeof setTimeout> | undefined;
    let accessExpiresAt = 0;
    const finish = (destroy = true) => {
      if (finished) return; finished = true;
      clearTimeout(lifetime); clearTimeout(handshake); clearTimeout(renewal); clearTimeout(accessDeadline);
      this.requests.delete(abort); upstream?.destroy(); peer?.destroy();
      if (destroy) socket.destroy();
    };
    const abort = () => finish();
    const reject = (status: number) => { if (finished) return; deny(status); finish(false); };
    const lifetime = setTimeout(abort, 30 * 60_000); lifetime.unref();
    const handshake = setTimeout(abort, 10_000); handshake.unref();
    this.requests.add(abort); socket.once("error", abort); socket.once("close", abort);
    const run = async () => {
      const grant = await this.verify(token);
      if (finished) return;
      if (!this.allowed(grant)) { reject(401); return; }
      const renew = (current: CloudRuntimeServiceAccess) => {
        clearTimeout(accessDeadline);
        const remaining = current.expiresAtMs - Date.now(); accessExpiresAt = current.expiresAtMs;
        accessDeadline = setTimeout(abort, Math.max(0, remaining)); accessDeadline.unref();
        renewal = setTimeout(() => {
          void this.verify(token).then(next => {
            if (finished) return;
            if (Date.now() >= accessExpiresAt || !this.allowed(next) || next.grantId !== grant.grantId ||
              next.accountUserId !== grant.accountUserId || next.authorityEpoch !== grant.authorityEpoch || next.remotePort !== grant.remotePort) { abort(); return; }
            renew(next);
          }, abort);
        }, Math.max(1, Math.floor(remaining / 2))); renewal.unref();
      };
      renew(grant);
      const headers = proxyHeaders(req.headers);
      headers.host = `127.0.0.1:${grant.remotePort}`; headers.connection = "Upgrade"; headers.upgrade = "websocket";
      upstream = request({ host: "127.0.0.1", port: grant.remotePort!, method: "GET", path: req.url,
        headers, agent: false, maxHeaderSize: 32 * 1024 });
      upstream.once("response", response => { response.destroy(); reject(502); });
      upstream.once("error", () => reject(502));
      upstream.once("upgrade", (response, connected, upstreamHead) => {
        if (finished) { connected.destroy(); return; }
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        const offered = (req.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
        const selected = response.headers["sec-websocket-protocol"];
        if (response.statusCode !== 101 || response.headers["sec-websocket-accept"] !== accept ||
          response.headers.upgrade?.toLowerCase() !== "websocket" ||
          (selected !== undefined && (typeof selected !== "string" || !offered.includes(selected)))) {
          connected.destroy(); reject(502); return;
        }
        peer = connected; clearTimeout(handshake);
        const responseHeaders = proxyHeaders(response.headers);
        responseHeaders.connection = "Upgrade"; responseHeaders.upgrade = "websocket";
        const lines = Object.entries(responseHeaders).flatMap(([name, value]) => value === undefined ? [] :
          (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}\r\n`));
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("")}\r\n`);
        if (head.length) socket.unshift(head);
        if (upstreamHead.length) connected.unshift(upstreamHead);
        void pipeline(socket, limitedStream(MAX_REQUEST_BYTES), connected).then(abort, abort);
        void pipeline(connected, limitedStream(MAX_RESPONSE_BYTES), socket).then(abort, abort);
        socket.resume();
      });
      upstream.end();
    };
    void run().catch(() => reject(502));
    return true;
  }

  private allowed(value: CloudRuntimeServiceAccess | null): value is CloudRuntimeServiceAccess {
    return Boolean(value?.kind === "preview" && Number.isSafeInteger(value.remotePort) &&
      value.remotePort! >= 1024 && value.remotePort! <= 65535 && value.remotePort !== 22222 &&
      !this.options.forbiddenPorts().includes(value.remotePort!) && value.expiresAtMs > Date.now() && value.expiresAtMs <= Date.now() + 10_000);
  }

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.headers[HEADER] === undefined) return false;
    const deny = (status: number) => {
      res.writeHead(status, {
        "cache-control": "no-store",
        "content-type": "text/plain",
        "x-content-type-options": "nosniff",
      });
      res.end(status === 401 ? "Preview access denied" : "Preview unavailable");
    };
    if (this.closed) {
      deny(503);
      return true;
    }
    if (
      this.requests.size >= MAX_REQUESTS ||
      this.pendingVerifications >= MAX_REQUESTS
    ) {
      deny(429);
      return true;
    }
    const token = req.headers[HEADER];
    if (
      typeof token !== "string" ||
      !/^zwp_[A-Za-z0-9_-]{43}$/.test(token) ||
      !req.url?.startsWith("/") ||
      req.url.startsWith("//") ||
      req.method === "CONNECT" ||
      req.headers.upgrade ||
      Number(req.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES
    ) {
      deny(401);
      return true;
    }
    let finished = false;
    let upstream: ClientRequest | null = null;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let accessDeadline: ReturnType<typeof setTimeout> | undefined;
    let accessExpiresAt = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(renewal);
      clearTimeout(accessDeadline);
      this.requests.delete(abort);
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
      upstream?.destroy();
    };
    const abort = () => {
      finish();
      res.destroy();
    };
    const deadline = setTimeout(abort, MAX_REQUEST_MS);
    deadline.unref();
    this.requests.add(abort);
    req.once("aborted", abort);
    res.once("close", abort);
    const run = async () => {
      const grant = await this.verify(token);
      if (finished) return;
      if (!this.allowed(grant)) {
        deny(401);
        finish();
        return;
      }
      // Expiry closes the connection even if renewal hangs. A successful
      // renewal may extend only the same grant, authority and destination.
      const renew = (current: CloudRuntimeServiceAccess) => {
        clearTimeout(accessDeadline);
        const remaining = current.expiresAtMs - Date.now();
        accessExpiresAt = current.expiresAtMs;
        accessDeadline = setTimeout(abort, Math.max(0, remaining));
        accessDeadline.unref();
        renewal = setTimeout(
          () => {
            void this.verify(token).then((next) => {
              if (finished) return;
              if (
                Date.now() >= accessExpiresAt ||
                !this.allowed(next) ||
                next.grantId !== grant.grantId ||
                next.accountUserId !== grant.accountUserId ||
                next.authorityEpoch !== grant.authorityEpoch ||
                next.remotePort !== grant.remotePort
              ) {
                abort();
                return;
              }
              renew(next);
            }, abort);
          },
          Math.max(1, Math.floor(remaining / 2)),
        );
        renewal.unref();
      };
      res.once("close", () => clearTimeout(accessDeadline));
      renew(grant);
      const headers = proxyHeaders(req.headers);
      headers.host = `127.0.0.1:${grant.remotePort}`;
      upstream = request(
        {
          host: "127.0.0.1",
          port: grant.remotePort!,
          method: req.method,
          path: req.url,
          headers,
          agent: false,
          maxHeaderSize: 32 * 1024,
        },
        (response) => {
          if (finished) {
            response.destroy();
            return;
          }
          const size = Number(response.headers["content-length"] ?? 0);
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy();
            deny(502);
            finish();
            return;
          }
          res.writeHead(
            response.statusCode ?? 502,
            proxyHeaders(response.headers),
          );
          void pipeline(response, limitedStream(MAX_RESPONSE_BYTES), res).then(
            finish,
            abort,
          );
        },
      );
      upstream.setTimeout(15_000, abort);
      upstream.once("error", () => {
        if (finished) return;
        if (!res.headersSent) {
          deny(502);
          finish();
        } else abort();
      });
      void pipeline(req, limitedStream(MAX_REQUEST_BYTES), upstream).catch(
        abort,
      );
    };
    void run().catch(() => {
      if (!finished) {
        if (!res.headersSent) {
          deny(502);
          finish();
        } else abort();
      }
    });
    return true;
  }

  private async verify(
    token: string,
  ): Promise<CloudRuntimeServiceAccess | null> {
    if (this.closed || this.pendingVerifications >= MAX_REQUESTS) return null;
    this.pendingVerifications += 1;
    try {
      return await this.options.verify(token);
    } catch {
      return null;
    } finally {
      this.pendingVerifications -= 1;
    }
  }

  close(): void {
    this.closed = true;
    for (const abort of [...this.requests]) abort();
  }
}
