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
import {
  MAX_BRIDGE_FRAME_BYTES,
  safeParseClientBridgeMessage,
} from "@zeros/protocol/schemas";
import type { EngineMessage } from "../types";
import type { Transport, TransportClient } from "./types";

/** Constant-time string compare for equal-length candidates. Length mismatches
 *  are rejected before the constant-time byte comparison.
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

function tokenFromWebSocketProtocols(headers: IncomingMessage["headers"]): {
  present: boolean;
  token: string;
} {
  const raw = headers["sec-websocket-protocol"];
  const header = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  if (!header) return { present: false, token: "" };
  const protocols = header
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const candidates = protocols.filter((value) =>
    value.startsWith("zeros-cloud-token."),
  );
  const present = candidates.length > 0;
  if (header.length > 8 * 1024) return { present, token: "" };
  if (protocols.filter((value) => value === "zeros-v1").length !== 1) {
    return { present, token: "" };
  }
  if (candidates.length !== 1) return { present, token: "" };
  const encoded = candidates[0].slice("zeros-cloud-token.".length);
  if (!/^[A-Za-z0-9_-]{20,6000}$/.test(encoded)) {
    return { present, token: "" };
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded || decoded.length > 4_096) {
    decoded.fill(0);
    return { present, token: "" };
  }
  const token = decoded.toString("utf8");
  const canonicalUtf8 = Buffer.from(token, "utf8");
  const isCanonicalUtf8 =
    canonicalUtf8.length === decoded.length && canonicalUtf8.equals(decoded);
  canonicalUtf8.fill(0);
  decoded.fill(0);
  if (!isCanonicalUtf8 || !token || /[\0\r\n]/.test(token)) {
    return { present, token: "" };
  }
  return { present, token };
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
/** Remote peers are untrusted even after the outer preview/bridge capabilities
 * are presented. Bound pre-auth dwell time, concurrent sockets, and queued
 * outbound bytes so a leaked capability cannot turn the engine into a memory
 * or file-descriptor sink. These limits do not apply to LocalTransport. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 32;
const MAX_CONNECTIONS = 128;
const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BUFFERED_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BUFFERED_BYTES = 256 * 1024 * 1024;
const HTTP_CONNECTION_HEADROOM = 16;
const MAX_PREAUTH_QUEUED_FRAMES = 64;
const MAX_PREAUTH_QUEUED_BYTES = 1024 * 1024;
/** Aggregate, transport-wide handler limits. A limit per WebSocket still lets
 *  N authenticated peers multiply retained frames and long-running engine
 *  operations by N. Keep a separate small control lane so cancel/settlement
 *  messages remain actionable while ordinary prompts or workspace calls are
 *  legitimately long lived. */
const MAX_HANDLER_IN_FLIGHT = 32;
const MAX_CONTROL_HANDLER_IN_FLIGHT = 8;
const MAX_HANDLER_QUEUED_FRAMES = 64;
const MAX_HANDLER_QUEUED_BYTES = 32 * 1024 * 1024;
const MAX_CONTROL_HANDLER_QUEUED_FRAMES = 16;
const MAX_CONTROL_HANDLER_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_HANDLER_PEER_QUEUED_FRAMES = 32;
const MAX_HANDLER_PEER_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_CONTROL_HANDLER_PEER_QUEUED_FRAMES = 8;
const MAX_CONTROL_HANDLER_PEER_QUEUED_BYTES = 4 * 1024 * 1024;
const MAX_HANDLER_RETAINED_BYTES = 64 * 1024 * 1024;
const FORCE_CLOSE_TIMEOUT_MS = 1_000;

const CONTROL_HANDLER_MESSAGE_TYPES = new Set<string>([
  "OWNER_SIGNED_OUT",
  "AGENT_CANCEL",
  "AGENT_STOP_BACKGROUND_TASK",
  "AGENT_STEER",
  "AGENT_CLOSE_SESSION",
  "AGENT_PERMISSION_RESPONSE",
  "AGENT_QUESTION_RESPONSE",
]);

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return resolved;
}

/** Parse the optional engine environment value without letting a typo silently
 * disable the remote listener. Port zero remains available to direct
 * CloudTransport callers for ephemeral test sockets, but is never a valid
 * deployed listener. */
export function parseCloudTransportPort(
  raw: string | undefined,
): number | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^[1-9][0-9]{0,4}$/.test(value)) {
    throw new Error("ZEROS_CLOUD_PORT is an invalid cloud port");
  }
  const port = Number(value);
  if (port > 65_535) {
    throw new Error("ZEROS_CLOUD_PORT is an invalid cloud port");
  }
  return port;
}

export interface CloudTransportOptions {
  /** TCP port the in-sandbox engine binds (on 0.0.0.0) behind the preview proxy. */
  port: number;
  /** Worker-minted connection token presented on the /ws upgrade. New clients
   *  use the safe WebSocket subprotocol carrier; trusted non-browser probes
   *  may use `x-zeros-cloud-token`, and `?token=` remains a compatibility path.
   *  This outer bearer is mandatory even when account binding adds a second gate. */
  token: string;
  /** Bounded test/operator tuning. Production uses the conservative defaults;
   * callers cannot raise any value above its package-owned security ceiling. */
  maxConnections?: number;
  handshakeTimeoutMs?: number;
  maxBufferedBytes?: number;
  maxTotalBufferedBytes?: number;
}

interface QueuedHandlerMessage {
  readonly ws: WebSocket;
  readonly client: CloudClient;
  readonly msg: EngineMessage;
  readonly bytes: number;
  readonly control: boolean;
  readonly routeKey: string | null;
}

class CloudClient implements TransportClient {
  readonly kind = "cloud" as const;
  /** Liveness flag toggled by the keepalive ping/pong loop. */
  isAlive = true;
  private forceCloseTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    readonly id: string,
    private readonly ws: WebSocket,
    private readonly maxBufferedBytes: number,
    private readonly maxTotalBufferedBytes: number,
    private readonly totalBufferedBytes: () => number,
  ) {
    this.ws.once("close", () => {
      if (this.forceCloseTimer) clearTimeout(this.forceCloseTimer);
      this.forceCloseTimer = null;
    });
  }
  send(msg: EngineMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const payload = JSON.stringify(msg);
      const pendingBytes =
        this.ws.bufferedAmount + Buffer.byteLength(payload, "utf8");
      const pendingTotalBytes =
        this.totalBufferedBytes() + Buffer.byteLength(payload, "utf8");
      if (
        pendingBytes > this.maxBufferedBytes ||
        pendingTotalBytes > this.maxTotalBufferedBytes
      ) {
        this.close(1009, "outbound buffer limit");
        return;
      }
      this.ws.send(payload, (error) => {
        if (!error) return;
        try {
          this.ws.terminate();
        } catch {
          // ignore
        }
      });
    } catch {
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
    }
  }
  close(code = 1000, reason?: string): void {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    try {
      this.ws.close(code, reason);
    } catch {
      // ignore
    }
    if (this.forceCloseTimer) return;
    this.forceCloseTimer = setTimeout(() => {
      this.forceCloseTimer = null;
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
    }, FORCE_CLOSE_TIMEOUT_MS);
    this.forceCloseTimer.unref?.();
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
  private readonly maxConnections: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxBufferedBytes: number;
  private readonly maxTotalBufferedBytes: number;
  private handlerInFlight = 0;
  private controlHandlerInFlight = 0;
  private handlerInFlightBytes = 0;
  private handlerQueuedBytes = 0;
  private controlHandlerQueuedFrames = 0;
  private controlHandlerQueuedBytes = 0;
  private readonly handlerQueue: QueuedHandlerMessage[] = [];
  private readonly handlerPeerQueued = new Map<
    WebSocket,
    {
      frames: number;
      bytes: number;
      controlFrames: number;
      controlBytes: number;
    }
  >();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private getInfo:
    | (() => { version: string; uptime: number; connections: number })
    | null = null;

  private onConnectCb: ((c: TransportClient) => void) | null = null;
  private onDisconnectCb: ((c: TransportClient) => void) | null = null;
  private onMessageCb:
    | ((c: TransportClient, msg: EngineMessage) => void | Promise<void>)
    | null = null;

  constructor(opts: CloudTransportOptions) {
    if (
      typeof opts.token !== "string" ||
      opts.token.length < 16 ||
      Buffer.byteLength(opts.token, "utf8") > 4_096 ||
      /[\0\r\n]/.test(opts.token)
    ) {
      throw new Error("cloud transport token is invalid");
    }
    if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65_535) {
      throw new Error(
        "cloud transport port must be an integer from 0 through 65535",
      );
    }
    this.port = opts.port;
    this.token = opts.token;
    this.maxConnections = boundedInteger(
      opts.maxConnections,
      DEFAULT_MAX_CONNECTIONS,
      1,
      MAX_CONNECTIONS,
      "cloud maxConnections",
    );
    this.handshakeTimeoutMs = boundedInteger(
      opts.handshakeTimeoutMs,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
      25,
      MAX_HANDSHAKE_TIMEOUT_MS,
      "cloud handshakeTimeoutMs",
    );
    this.maxBufferedBytes = boundedInteger(
      opts.maxBufferedBytes,
      DEFAULT_MAX_BUFFERED_BYTES,
      256,
      MAX_BUFFERED_BYTES,
      "cloud maxBufferedBytes",
    );
    this.maxTotalBufferedBytes = boundedInteger(
      opts.maxTotalBufferedBytes,
      DEFAULT_MAX_TOTAL_BUFFERED_BYTES,
      256,
      MAX_TOTAL_BUFFERED_BYTES,
      "cloud maxTotalBufferedBytes",
    );
    this.httpServer = createServer((req, res) => this.handleHTTP(req, res));
    // Authenticated WebSocket peers consume `maxConnections`; reserve a small
    // bounded lane for health probes and in-progress HTTP upgrades without
    // allowing partial-header peers to exhaust the worker's file descriptors.
    this.httpServer.maxConnections =
      this.maxConnections + HTTP_CONNECTION_HEADROOM;
    // Outlive the preview proxy's idle window.
    this.httpServer.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
    this.httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_BRIDGE_FRAME_BYTES,
      // The token subprotocol is a browser-compatible credential carrier, not
      // an application protocol. Never echo that bearer into the response.
      handleProtocols: (protocols) =>
        protocols.has("zeros-v1") ? "zeros-v1" : false,
    });

    this.httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "", "http://sandbox");
      // No loopback/Origin gate here (that is LocalTransport's DNS-rebinding
      // defense for a 127.0.0.1 server). The preview proxy is the network
      // boundary; the connection token is the auth. A missing/!=`/ws` path or a
      // bad token drops the socket.
      if (
        url.pathname === "/ws" &&
        this.clients.size < this.maxConnections &&
        this.isTokenValid(url, request.headers)
      ) {
        this.wss.handleUpgrade(request, socket, head, (ws) =>
          this.wss.emit("connection", ws, request),
        );
      } else {
        socket.destroy();
      }
    });

    this.wss.on("connection", (ws: WebSocket) => {
      const client = new CloudClient(
        randomUUID(),
        ws,
        this.maxBufferedBytes,
        this.maxTotalBufferedBytes,
        () => this.totalOutboundBufferedBytes(),
      );
      this.clients.set(ws, client);
      let protocolReady = false;
      let protocolStarted = false;
      let finalized = false;
      let preauthQueuedBytes = 0;
      const preauthMessages: Array<{ msg: EngineMessage; bytes: number }> = [];
      const handshakeTimer = setTimeout(() => {
        if (!protocolReady) client.close(1008, "CONNECTED required");
      }, this.handshakeTimeoutMs);
      handshakeTimer.unref?.();
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        clearTimeout(handshakeTimer);
        preauthMessages.length = 0;
        preauthQueuedBytes = 0;
        this.dropQueuedHandlerMessages(ws);
        this.clients.delete(ws);
        this.drainHandlerQueue();
        this.onDisconnectCb?.(client);
      };
      const invokeMessageHandler = (msg: EngineMessage): Promise<void> => {
        return this.invokeMessageHandler(client, msg);
      };

      ws.on("pong", () => {
        client.isAlive = true;
      });
      ws.on("message", (data) => {
        const text = data.toString();
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          return;
        }
        const msg = safeParseClientBridgeMessage(raw) as EngineMessage | null;
        if (!msg) return;
        if (!protocolStarted) {
          if (msg.type !== "CONNECTED") {
            client.close(1008, "CONNECTED required");
            return;
          }
          protocolStarted = true;
          // ZerosEngine may await a remote JWKS lookup here. Keep later frames
          // behind the authentication boundary until that promise settles;
          // otherwise an immediate WORKSPACE_REQUEST races the verified-account
          // map and is spuriously rejected (or a future handler could fail open).
          void invokeMessageHandler(msg).then(
            () => {
              if (finalized || ws.readyState !== WebSocket.OPEN) return;
              protocolReady = true;
              clearTimeout(handshakeTimer);
              const pending = preauthMessages.splice(0);
              preauthQueuedBytes = 0;
              for (const queued of pending) {
                this.enqueueMessageHandler(
                  ws,
                  client,
                  queued.msg,
                  queued.bytes,
                );
              }
            },
            () => client.close(1011, "CONNECTED handler failed"),
          );
          return;
        }
        if (!protocolReady) {
          const bytes = Buffer.byteLength(text, "utf8");
          if (
            preauthMessages.length >= MAX_PREAUTH_QUEUED_FRAMES ||
            preauthQueuedBytes + bytes > MAX_PREAUTH_QUEUED_BYTES
          ) {
            client.close(1008, "pre-auth queue limit");
            return;
          }
          preauthMessages.push({ msg, bytes });
          preauthQueuedBytes += bytes;
          return;
        }
        this.enqueueMessageHandler(
          ws,
          client,
          msg,
          Buffer.byteLength(text, "utf8"),
        );
      });
      ws.on("close", finalize);
      ws.on("error", () => {
        finalize();
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      });

      this.onConnectCb?.(client);
    });
  }

  private invokeMessageHandler(
    client: CloudClient,
    msg: EngineMessage,
  ): Promise<void> {
    try {
      return Promise.resolve(this.onMessageCb?.(client, msg));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private handlerRouteKey(msg: EngineMessage): string | null {
    const record = msg as unknown as Record<string, unknown>;
    const execution = record.executionId ?? record.sessionId;
    if (typeof execution === "string" && execution) {
      return `execution:${execution}`;
    }
    const chat = record.chatId;
    if (typeof chat === "string" && chat) return `chat:${chat}`;
    const permission = record.permissionId;
    if (typeof permission === "string" && permission) {
      return `permission:${permission}`;
    }
    const question = record.questionId;
    if (typeof question === "string" && question) {
      return `question:${question}`;
    }
    return null;
  }

  private enqueueMessageHandler(
    ws: WebSocket,
    client: CloudClient,
    msg: EngineMessage,
    bytes: number,
  ): void {
    if (this.clients.get(ws) !== client || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const control = CONTROL_HANDLER_MESSAGE_TYPES.has(msg.type);
    const routeKey = this.handlerRouteKey(msg);
    const entry: QueuedHandlerMessage = {
      ws,
      client,
      msg,
      bytes,
      control,
      routeKey,
    };
    const retainedBytes =
      this.handlerInFlightBytes + this.handlerQueuedBytes + bytes;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      retainedBytes > MAX_HANDLER_RETAINED_BYTES
    ) {
      this.dropQueuedHandlerMessages(ws);
      this.drainHandlerQueue();
      client.close(1008, "message queue limit");
      return;
    }

    const laneAvailable = control
      ? this.controlHandlerInFlight < MAX_CONTROL_HANDLER_IN_FLIGHT
      : this.handlerInFlight < MAX_HANDLER_IN_FLIGHT;
    const earlierSameRoute = Boolean(
      routeKey &&
      this.handlerQueue.some((queued) => queued.routeKey === routeKey),
    );
    if (laneAvailable && !earlierSameRoute) {
      this.dispatchHandler(entry);
      return;
    }

    const peer = this.handlerPeerQueued.get(ws) ?? {
      frames: 0,
      bytes: 0,
      controlFrames: 0,
      controlBytes: 0,
    };
    const regularQueuedFrames =
      this.handlerQueue.length - this.controlHandlerQueuedFrames;
    const regularQueuedBytes =
      this.handlerQueuedBytes - this.controlHandlerQueuedBytes;
    const peerRegularFrames = peer.frames - peer.controlFrames;
    const peerRegularBytes = peer.bytes - peer.controlBytes;
    const laneQueueExceeded = control
      ? this.controlHandlerQueuedFrames >= MAX_CONTROL_HANDLER_QUEUED_FRAMES ||
        this.controlHandlerQueuedBytes + bytes >
          MAX_CONTROL_HANDLER_QUEUED_BYTES ||
        peer.controlFrames >= MAX_CONTROL_HANDLER_PEER_QUEUED_FRAMES ||
        peer.controlBytes + bytes > MAX_CONTROL_HANDLER_PEER_QUEUED_BYTES
      : regularQueuedFrames >= MAX_HANDLER_QUEUED_FRAMES ||
        regularQueuedBytes + bytes > MAX_HANDLER_QUEUED_BYTES ||
        peerRegularFrames >= MAX_HANDLER_PEER_QUEUED_FRAMES ||
        peerRegularBytes + bytes > MAX_HANDLER_PEER_QUEUED_BYTES;
    if (laneQueueExceeded) {
      // Remove this offender's already-retained queue before beginning the
      // bounded close handshake. Other authenticated peers keep their slots.
      this.dropQueuedHandlerMessages(ws);
      this.drainHandlerQueue();
      client.close(1008, "message queue limit");
      return;
    }

    this.handlerQueue.push(entry);
    this.handlerQueuedBytes += bytes;
    if (control) {
      this.controlHandlerQueuedFrames += 1;
      this.controlHandlerQueuedBytes += bytes;
    }
    this.handlerPeerQueued.set(ws, {
      frames: peer.frames + 1,
      bytes: peer.bytes + bytes,
      controlFrames: peer.controlFrames + Number(control),
      controlBytes: peer.controlBytes + (control ? bytes : 0),
    });
    this.drainHandlerQueue();
  }

  private takeQueuedHandler(control: boolean): QueuedHandlerMessage | null {
    for (let index = 0; index < this.handlerQueue.length; index++) {
      const candidate = this.handlerQueue[index];
      if (candidate.control !== control) continue;
      // A control message may overtake unrelated long-running work, but never
      // an earlier queued message for its own session/interaction. In
      // particular, Cancel cannot race ahead of the Prompt it is cancelling.
      if (
        candidate.routeKey &&
        this.handlerQueue
          .slice(0, index)
          .some((entry) => entry.routeKey === candidate.routeKey)
      ) {
        continue;
      }
      const [entry] = this.handlerQueue.splice(index, 1);
      this.handlerQueuedBytes -= entry.bytes;
      if (entry.control) {
        this.controlHandlerQueuedFrames -= 1;
        this.controlHandlerQueuedBytes -= entry.bytes;
      }
      const peer = this.handlerPeerQueued.get(entry.ws);
      if (peer) {
        const next = {
          frames: peer.frames - 1,
          bytes: peer.bytes - entry.bytes,
          controlFrames: peer.controlFrames - Number(entry.control),
          controlBytes: peer.controlBytes - (entry.control ? entry.bytes : 0),
        };
        if (next.frames <= 0) this.handlerPeerQueued.delete(entry.ws);
        else this.handlerPeerQueued.set(entry.ws, next);
      }
      return entry;
    }
    return null;
  }

  private dropQueuedHandlerMessages(ws: WebSocket): void {
    let writeIndex = 0;
    let droppedBytes = 0;
    let droppedControlFrames = 0;
    let droppedControlBytes = 0;
    for (const entry of this.handlerQueue) {
      if (entry.ws === ws) {
        droppedBytes += entry.bytes;
        if (entry.control) {
          droppedControlFrames += 1;
          droppedControlBytes += entry.bytes;
        }
      } else {
        this.handlerQueue[writeIndex++] = entry;
      }
    }
    this.handlerQueue.length = writeIndex;
    this.handlerQueuedBytes = Math.max(
      0,
      this.handlerQueuedBytes - droppedBytes,
    );
    this.controlHandlerQueuedFrames = Math.max(
      0,
      this.controlHandlerQueuedFrames - droppedControlFrames,
    );
    this.controlHandlerQueuedBytes = Math.max(
      0,
      this.controlHandlerQueuedBytes - droppedControlBytes,
    );
    this.handlerPeerQueued.delete(ws);
  }

  private dispatchHandler(entry: QueuedHandlerMessage): void {
    if (
      this.clients.get(entry.ws) !== entry.client ||
      entry.ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    if (entry.control) this.controlHandlerInFlight += 1;
    else this.handlerInFlight += 1;
    this.handlerInFlightBytes += entry.bytes;
    const complete = () => {
      if (entry.control) this.controlHandlerInFlight -= 1;
      else this.handlerInFlight -= 1;
      this.handlerInFlightBytes = Math.max(
        0,
        this.handlerInFlightBytes - entry.bytes,
      );
      this.drainHandlerQueue();
    };
    void this.invokeMessageHandler(entry.client, entry.msg).then(
      complete,
      () => {
        this.dropQueuedHandlerMessages(entry.ws);
        entry.client.close(1011, "message handler failed");
        complete();
      },
    );
  }

  private drainHandlerQueue(): void {
    while (this.controlHandlerInFlight < MAX_CONTROL_HANDLER_IN_FLIGHT) {
      const entry = this.takeQueuedHandler(true);
      if (!entry) break;
      this.dispatchHandler(entry);
    }
    while (this.handlerInFlight < MAX_HANDLER_IN_FLIGHT) {
      const entry = this.takeQueuedHandler(false);
      if (!entry) break;
      this.dispatchHandler(entry);
    }
  }

  onConnect(handler: (client: TransportClient) => void): void {
    this.onConnectCb = handler;
  }
  onDisconnect(handler: (client: TransportClient) => void): void {
    this.onDisconnectCb = handler;
  }
  onMessage(
    handler: (
      client: TransportClient,
      msg: EngineMessage,
    ) => void | Promise<void>,
  ): void {
    this.onMessageCb = handler;
  }

  broadcast(msg: EngineMessage): void {
    for (const client of this.clients.values()) client.send(msg);
  }

  private totalOutboundBufferedBytes(): number {
    let total = 0;
    for (const ws of this.clients.keys()) {
      const buffered = ws.bufferedAmount;
      if (!Number.isSafeInteger(buffered) || buffered < 0) return Infinity;
      total += buffered;
      if (!Number.isSafeInteger(total)) return Infinity;
    }
    return total;
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
    for (const client of this.clients.values()) {
      client.close(1001, "Engine shutting down");
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
      // `close()` deliberately waits for existing HTTP connections. Remote
      // peers are untrusted and can otherwise hold shutdown for the full
      // headers timeout with a partial request, so terminate them after the
      // listener has stopped accepting new sockets.
      this.httpServer.closeAllConnections();
    });
  }

  /** The token gate. Prefer the header or browser WebSocket subprotocol so
   *  credentials do not enter URLs or request-target logs; accept the query
   *  form for existing clients. */
  private isTokenValid(url: URL, headers: IncomingMessage["headers"]): boolean {
    const queryTokens = url.searchParams.getAll("token");
    if (queryTokens.length > 1) return false;
    const header = headers["x-zeros-cloud-token"];
    if (Array.isArray(header) && header.length !== 1) return false;
    const fromHeader = Array.isArray(header)
      ? (header[0] ?? "")
      : (header ?? "");
    const fromProtocol = tokenFromWebSocketProtocols(headers);
    const carrierCount =
      Number(queryTokens.length === 1) +
      Number(header !== undefined) +
      Number(fromProtocol.present);
    if (carrierCount !== 1) return false;
    if (queryTokens.length === 1) {
      return tokensMatch(this.token, queryTokens[0]);
    }
    if (header !== undefined) return tokensMatch(this.token, fromHeader);
    return tokensMatch(this.token, fromProtocol.token);
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
