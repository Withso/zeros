import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, {
  WebSocketServer,
  type ClientOptions,
  type RawData,
} from "ws";
import {
  CLOUD_RUNTIME_BRIDGE_PATH,
  type CloudEngineRelayGrant,
} from "./engine-client-admission.js";
import {
  assertProviderPreviewEndpoint,
  type CloudProviderEngineEndpoint,
} from "./provider.js";

const TOKEN = /^zw[sa]_[A-Za-z0-9_-]{43}$/;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 128 * 1024 * 1024;
type Destination = CloudEngineRelayGrant & {
  endpoint: CloudProviderEngineEndpoint;
};
type Pair = {
  socket: Duplex;
  client: WebSocket | null;
  upstream: WebSocket | null;
  grant: Destination | null;
  retire: (status?: number) => void;
};

export function runtimeBridgeToken(
  headers: IncomingHttpHeaders,
): string | null {
  const header = headers["x-zeros-cloud-token"];
  const protocol = headers["sec-websocket-protocol"];
  if (header !== undefined)
    return protocol === undefined &&
      typeof header === "string" &&
      TOKEN.test(header)
      ? header
      : null;
  if (typeof protocol !== "string" || protocol.length > 1024) return null;
  const values = protocol.split(",").map((value) => value.trim());
  if (
    values.length !== 2 ||
    values.filter((value) => value === "zeros-v1").length !== 1
  )
    return null;
  const encoded = values
    .find((value) => value.startsWith("zeros-cloud-token."))
    ?.slice("zeros-cloud-token.".length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64url");
  const token = decoded.toString("utf8");
  return decoded.toString("base64url") === encoded && TOKEN.test(token)
    ? token
    : null;
}

function upstreamOptions(
  endpoint: CloudProviderEngineEndpoint,
  token: string,
): { url: string; options: ClientOptions } {
  // The adapter also validates its exact provider hostname/account. Enforce a
  // credential-free HTTPS origin and a single bounded private header here.
  assertProviderPreviewEndpoint({
    url: endpoint.url,
    headerName: endpoint.headerName ?? "x-zeros-endpoint-validation",
    headerValue: endpoint.headerValue ?? "none",
  });
  if (
    (endpoint.headerName === undefined) !==
      (endpoint.headerValue === undefined) ||
    endpoint.headerName?.startsWith("x-zeros-")
  )
    throw new Error("invalid bridge endpoint");
  const url = new URL("/ws", endpoint.url);
  url.protocol = "wss:";
  return {
    url: url.toString(),
    options: {
      headers: {
        ...(endpoint.headerName
          ? { [endpoint.headerName]: endpoint.headerValue }
          : {}),
        "x-zeros-cloud-token": token,
      },
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
      rejectUnauthorized: true,
    },
  };
}

function bytes(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, value) => total + value.byteLength, 0)
    : data.byteLength;
}
function limit(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? defaultValue;
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  )
    throw new Error("invalid relay bound");
  return selected;
}

/** Stateless, horizontally distributable transport. The engine redeems the
 * one-use client proof; the relay keeps provider credentials server-side and
 * rechecks database authority throughout the connection. It never owns agent
 * execution or replays client commands after a transport failure.
 *
 * At most eight active pairs retain two bounded 64 MiB frame assemblers each;
 * outbound buffering is separately capped at 128 MiB across the replica.
 * Deploy this conservative profile with at least 2 GiB memory. */
export class CloudRuntimeBridgeRelay {
  private readonly server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: (protocols) =>
      protocols.has("zeros-v1") ? "zeros-v1" : false,
  });
  private readonly pairs = new Set<Pair>();
  private pending = 0;
  private closed = false;
  private admissionTokens = 32;
  private lastAdmissionRefill = performance.now();
  private readonly maxPending: number;
  private readonly maxConnections: number;
  private readonly authorityCheckMs: number;
  constructor(
    private readonly options: {
      resolve: (token: string) => Promise<Destination | null>;
      revalidate: (
        token: string,
        grant: CloudEngineRelayGrant,
      ) => Promise<boolean>;
      openUpstream?: (url: string, options: ClientOptions) => WebSocket;
      maxPending?: number;
      maxConnections?: number;
      authorityCheckMs?: number;
    },
  ) {
    this.maxPending = limit(options.maxPending, 32, 1, 32);
    this.maxConnections = limit(options.maxConnections, 8, 1, 8);
    this.authorityCheckMs = limit(options.authorityCheckMs, 5_000, 25, 5_000);
  }
  get pendingCount(): number {
    return this.pending;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (req.url !== CLOUD_RUNTIME_BRIDGE_PATH) return false;
    socket.on("error", () => {});
    const reject = (status: number) => {
      if (!socket.destroyed)
        socket.end(
          `HTTP/1.1 ${status} Unavailable\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
        );
    };
    if (this.closed) {
      reject(503);
      return true;
    }
    if (this.pending >= this.maxPending) {
      reject(429);
      return true;
    }
    const token = runtimeBridgeToken(req.headers);
    if (!token || req.method !== "GET" || head.byteLength > MAX_FRAME_BYTES) {
      reject(401);
      return true;
    }
    // The upgrade listener runs before HTTP middleware. Bound valid-looking
    // random-token lookups here as well as bounding simultaneous handshakes.
    const now = performance.now();
    this.admissionTokens = Math.min(
      32,
      this.admissionTokens + Math.max(0, now - this.lastAdmissionRefill) / 500,
    );
    this.lastAdmissionRefill = now;
    if (this.admissionTokens < 1) {
      reject(429);
      return true;
    }
    this.admissionTokens -= 1;
    let retired = false;
    let upgraded = false;
    let authorityTimer: ReturnType<typeof setInterval> | undefined;
    let authorityDeadline: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const handshake = setTimeout(() => pair.retire(503), 10_000);
    handshake.unref();
    const pair: Pair = {
      socket,
      client: null,
      upstream: null,
      grant: null,
      retire: (status) => {
        if (retired) return;
        retired = true;
        clearTimeout(handshake);
        clearTimeout(authorityDeadline);
        clearInterval(authorityTimer);
        clearInterval(pingTimer);
        this.pairs.delete(pair);
        pair.client?.terminate();
        pair.upstream?.terminate();
        if (!upgraded && status) reject(status);
        else socket.destroy();
      },
    };
    this.pairs.add(pair);
    socket.once("close", () => pair.retire());
    this.pending += 1;
    const admit = async () => {
      let destination: Destination | null;
      try {
        destination = await this.options.resolve(token);
      } finally {
        this.pending -= 1;
      }
      if (retired) return;
      if (!destination) {
        pair.retire(401);
        return;
      }
      const active = [...this.pairs].filter(
        (candidate) => candidate.grant !== null,
      );
      if (
        active.length >= this.maxConnections ||
        active.filter(
          (candidate) =>
            candidate.grant!.workspaceId === destination.workspaceId,
        ).length >= 4
      ) {
        pair.retire(429);
        return;
      }
      pair.grant = destination;
      const upstream = upstreamOptions(destination.endpoint, token);
      const remote = (
        this.options.openUpstream ??
        ((url, options) => new WebSocket(url, options))
      )(upstream.url, upstream.options);
      pair.upstream = remote;
      remote.on("error", () => pair.retire(502));
      remote.once("unexpected-response", (_request, response) => {
        response.destroy();
        pair.retire(502);
      });
      remote.once("close", () => pair.retire(502));
      remote.once("open", () => {
        if (retired || this.closed) {
          pair.retire();
          return;
        }
        try {
          this.server.handleUpgrade(req, socket, head, (client) => {
            upgraded = true;
            pair.client = client;
            clearTimeout(handshake);
            client.on("error", () => pair.retire());
            client.once("close", () => pair.retire());
            const forward = (
              target: WebSocket,
              data: RawData,
              binary: boolean,
            ) => {
              const size = bytes(data);
              let buffered = 0;
              for (const current of this.pairs)
                buffered +=
                  (current.client?.bufferedAmount ?? 0) +
                  (current.upstream?.bufferedAmount ?? 0);
              if (
                target.readyState !== WebSocket.OPEN ||
                size > MAX_FRAME_BYTES ||
                target.bufferedAmount + size > MAX_FRAME_BYTES ||
                buffered + size > MAX_BUFFERED_BYTES
              ) {
                pair.retire();
                return;
              }
              target.send(data, { binary, compress: false }, (error) => {
                if (error) pair.retire();
              });
            };
            remote.on("message", (data, binary) =>
              forward(client, data, binary),
            );
            client.on("message", (data, binary) =>
              forward(remote, data, binary),
            );
            let authorityExpiresAt = 0;
            const renew = () => {
              clearTimeout(authorityDeadline);
              const leaseMs = Math.max(100, this.authorityCheckMs * 2);
              authorityExpiresAt = performance.now() + leaseMs;
              authorityDeadline = setTimeout(() => pair.retire(), leaseMs);
              authorityDeadline.unref();
            };
            renew();
            let checking = false;
            authorityTimer = setInterval(() => {
              if (checking || retired) return;
              checking = true;
              void Promise.resolve()
                .then(() => this.options.revalidate(token, destination))
                .then(
                  (valid) => {
                    if (retired) return;
                    if (valid && performance.now() < authorityExpiresAt)
                      renew();
                    else pair.retire();
                  },
                  () => pair.retire(),
                )
                .finally(() => {
                  checking = false;
                });
            }, this.authorityCheckMs);
            authorityTimer.unref();
            let clientAlive = true;
            let upstreamAlive = true;
            client.on("pong", () => {
              clientAlive = true;
            });
            remote.on("pong", () => {
              upstreamAlive = true;
            });
            pingTimer = setInterval(() => {
              if (!clientAlive || !upstreamAlive) {
                pair.retire();
                return;
              }
              clientAlive = false;
              upstreamAlive = false;
              client.ping(undefined, undefined, (error) => {
                if (error) pair.retire();
              });
              remote.ping(undefined, undefined, (error) => {
                if (error) pair.retire();
              });
            }, 25_000);
            pingTimer.unref();
          });
        } catch {
          pair.retire(502);
        }
      });
    };
    void admit().catch(() => pair.retire(503));
    return true;
  }

  close(): void {
    this.closed = true;
    for (const pair of [...this.pairs]) pair.retire();
    this.server.close();
  }
}
