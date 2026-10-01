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
import { WebSocketFrameMeter } from "./runtime-bridge-frame-meter.js";
import {
  CLOUD_RUNTIME_RELAY_MAX_MESSAGE_BYTES,
  cloudRuntimeRelayLimits,
  cloudRuntimeRelayOutboundBytes,
  type CloudRuntimeRelayLimits,
} from "./runtime-bridge-limits.js";

const TOKEN = /^zw[sa]_[A-Za-z0-9_-]{43}$/;
const MAX_FRAME_BYTES = CLOUD_RUNTIME_RELAY_MAX_MESSAGE_BYTES;
/** Messages up to this size are never charged to the inbound budget, so
 * tokens, terminal output and events cannot be refused by it. Each socket
 * holds at most this much outside the budget. */
const UNCHARGED_MESSAGE_BYTES = 64 * 1024;
const ADMISSION_BURST = 32;
const ADMISSION_REFILL_MS = 500;
/** At most one warning per reason per interval; repeats are counted. */
const REPORT_INTERVAL_MS = 60_000;
const SUMMARY_INTERVAL_MS = 5 * 60_000;
const MiB = 1024 * 1024;

/** Why a connection ended before it was admitted. */
export type CloudRuntimeRelayRefusal =
  | "closed"
  | "pending"
  | "rate_limited"
  | "unauthorized"
  | "unavailable"
  | "instance_limit"
  | "workspace_limit"
  | "read_only_workspace_limit"
  | "abandoned";
/** Why an admitted connection ended. */
export type CloudRuntimeRelayRetirement =
  | "client_closed"
  | "upstream_closed"
  | "upstream_failed"
  | "unavailable"
  | "handshake_timeout"
  | "authority"
  | "heartbeat"
  | "message_limit"
  | "target_buffer"
  | "outbound_budget"
  | "inbound_budget"
  | "shutdown";
const REFUSALS: readonly CloudRuntimeRelayRefusal[] = [
  "closed",
  "pending",
  "rate_limited",
  "unauthorized",
  "unavailable",
  "instance_limit",
  "workspace_limit",
  "read_only_workspace_limit",
  "abandoned",
];
const RETIREMENTS: readonly CloudRuntimeRelayRetirement[] = [
  "client_closed",
  "upstream_closed",
  "upstream_failed",
  "unavailable",
  "handshake_timeout",
  "authority",
  "heartbeat",
  "message_limit",
  "target_buffer",
  "outbound_budget",
  "inbound_budget",
  "shutdown",
];
/** Reasons operators should see as they happen rather than in the summary. */
const REPORTED = new Set<string>([
  "pending",
  "rate_limited",
  "unavailable",
  "instance_limit",
  "workspace_limit",
  "read_only_workspace_limit",
  "message_limit",
  "target_buffer",
  "outbound_budget",
  "inbound_budget",
]);

/** Counters and gauges only: no identifiers, addresses or credentials. */
export type CloudRuntimeRelayStats = {
  limits: CloudRuntimeRelayLimits;
  /** Admitted connections, including those still opening their engine end. */
  active: number;
  activeWriters: number;
  activeReadOnly: number;
  pending: number;
  admitted: number;
  rejected: Record<CloudRuntimeRelayRefusal, number>;
  retired: Record<CloudRuntimeRelayRetirement, number>;
  outboundQueuedBytes: number;
  peakOutboundQueuedBytes: number;
  inboundReservedBytes: number;
  peakInboundReservedBytes: number;
};

type Destination = CloudEngineRelayGrant & {
  endpoint: CloudProviderEngineEndpoint;
};
type Pair = {
  socket: Duplex;
  client: WebSocket | null;
  upstream: WebSocket | null;
  grant: Destination | null;
  /** Outbound reservations whose sends have not completed. */
  queued: number;
  /** Inbound budget held by this pair's partially received messages. */
  charged: number;
  retire: (reason: CloudRuntimeRelayRetirement, status?: number) => void;
  refuse: (reason: CloudRuntimeRelayRefusal, status?: number) => void;
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
      autoPong: false,
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
function oversized(error: unknown): boolean {
  return (
    (error as { code?: unknown } | null)?.code ===
    "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
  );
}
function mib(value: number): string {
  return `${(value / MiB).toFixed(1)}MiB`;
}
function counts<Key extends string>(keys: readonly Key[]): Record<Key, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
}

/** Stateless, horizontally distributable transport. The engine redeems the
 * one-use client proof; the relay keeps provider credentials server-side and
 * rechecks database authority throughout the connection. It never owns agent
 * execution or replays client commands after a transport failure.
 *
 * Memory is bounded by budgets rather than by the connection count alone:
 * each socket assembles at most one 64 MiB message, partially received
 * messages above 64 KiB are charged to a shared inbound budget from their
 * frame header, and queued output is charged to a shared outbound budget. The
 * defaults (64 connections, ten writers and ten readers per workspace, 128 MiB outbound, 256 MiB
 * inbound) need at least 2 GiB; see the sizing table in
 * docs/cloud-workspace/relay-capacity.md before raising them. */
export class CloudRuntimeBridgeRelay {
  private readonly server = new WebSocketServer({
    noServer: true,
    autoPong: false,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: (protocols) =>
      protocols.has("zeros-v1") ? "zeros-v1" : false,
  });
  private readonly pairs = new Set<Pair>();
  private pending = 0;
  private closed = false;
  private readonly limits: CloudRuntimeRelayLimits;
  /** A reconnect wave after a deploy can reach the whole connection ceiling;
   * the sustained refill still bounds random-token lookups. */
  private readonly admissionBurst: number;
  private admissionTokens: number;
  private lastAdmissionRefill = performance.now();
  private readonly maxPending: number;
  private readonly authorityCheckMs: number;
  private outboundQueued = 0;
  private inboundCharged = 0;
  private admittedTotal = 0;
  private readonly rejected = counts(REFUSALS);
  private readonly retired = counts(RETIREMENTS);
  private peakOutbound = 0;
  private peakInbound = 0;
  private windowPeakOutbound = 0;
  private windowPeakInbound = 0;
  private reported = new Map<string, { at: number; suppressed: number }>();
  private summarized = {
    admitted: 0,
    rejected: counts(REFUSALS),
    retired: counts(RETIREMENTS),
  };
  private readonly summaryTimer: ReturnType<typeof setInterval>;
  private readonly log: (line: string, level: "info" | "warn") => void;
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
      maxConnectionsPerWorkspace?: number;
      maxReadOnlyConnectionsPerWorkspace?: number;
      outboundBudgetBytes?: number;
      inboundBudgetBytes?: number;
      authorityCheckMs?: number;
      /** Receives operational lines; defaults to the console. */
      log?: (line: string, level: "info" | "warn") => void;
    },
  ) {
    this.maxPending = limit(options.maxPending, 32, 1, 32);
    this.limits = cloudRuntimeRelayLimits({
      maxConnections: options.maxConnections,
      maxConnectionsPerWorkspace: options.maxConnectionsPerWorkspace,
      maxReadOnlyConnectionsPerWorkspace:
        options.maxReadOnlyConnectionsPerWorkspace,
      outboundBudgetBytes: options.outboundBudgetBytes,
      inboundBudgetBytes: options.inboundBudgetBytes,
    });
    this.authorityCheckMs = limit(options.authorityCheckMs, 5_000, 25, 5_000);
    this.admissionBurst = Math.max(ADMISSION_BURST, this.limits.maxConnections);
    this.admissionTokens = this.admissionBurst;
    this.log =
      options.log ??
      ((line, level) =>
        level === "warn" ? console.warn(line) : console.log(line));
    this.summaryTimer = setInterval(
      () => this.summarize(),
      SUMMARY_INTERVAL_MS,
    );
    this.summaryTimer.unref();
  }
  get pendingCount(): number {
    return this.pending;
  }

  stats(): CloudRuntimeRelayStats {
    const active = this.activeCount();
    let activeReadOnly = 0;
    for (const pair of this.pairs)
      if (pair.grant?.readOnly) activeReadOnly += 1;
    return {
      limits: { ...this.limits },
      active,
      activeWriters: active - activeReadOnly,
      activeReadOnly,
      pending: this.pending,
      admitted: this.admittedTotal,
      rejected: { ...this.rejected },
      retired: { ...this.retired },
      outboundQueuedBytes: this.outboundQueued,
      peakOutboundQueuedBytes: this.peakOutbound,
      inboundReservedBytes: this.inboundCharged,
      peakInboundReservedBytes: this.peakInbound,
    };
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
    const refuse = (reason: CloudRuntimeRelayRefusal, status: number) => {
      this.count(null, reason);
      reject(status);
      return true;
    };
    if (this.closed) return refuse("closed", 503);
    if (this.pending >= this.maxPending) return refuse("pending", 429);
    const token = runtimeBridgeToken(req.headers);
    if (!token || req.method !== "GET" || head.byteLength > MAX_FRAME_BYTES)
      return refuse("unauthorized", 401);
    // The upgrade listener runs before HTTP middleware. Bound valid-looking
    // random-token lookups here as well as bounding simultaneous handshakes.
    const now = performance.now();
    this.admissionTokens = Math.min(
      this.admissionBurst,
      this.admissionTokens +
        Math.max(0, now - this.lastAdmissionRefill) / ADMISSION_REFILL_MS,
    );
    this.lastAdmissionRefill = now;
    if (this.admissionTokens < 1) return refuse("rate_limited", 429);
    this.admissionTokens -= 1;
    let retired = false;
    let upgraded = false;
    let authorityTimer: ReturnType<typeof setInterval> | undefined;
    let authorityDeadline: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const handshake = setTimeout(
      () =>
        pair.grant
          ? pair.retire("handshake_timeout", 503)
          : pair.refuse("unavailable", 503),
      10_000,
    );
    handshake.unref();
    const end = (
      reason: CloudRuntimeRelayRefusal | CloudRuntimeRelayRetirement,
      admitted: boolean,
      status: number | undefined,
    ) => {
      if (retired) return;
      retired = true;
      clearTimeout(handshake);
      clearTimeout(authorityDeadline);
      clearInterval(authorityTimer);
      clearInterval(pingTimer);
      this.pairs.delete(pair);
      this.release(pair);
      this.count(
        admitted ? (reason as CloudRuntimeRelayRetirement) : null,
        admitted ? null : (reason as CloudRuntimeRelayRefusal),
      );
      pair.client?.terminate();
      pair.upstream?.terminate();
      if (!upgraded && status) reject(status);
      else socket.destroy();
    };
    const pair: Pair = {
      socket,
      client: null,
      upstream: null,
      grant: null,
      queued: 0,
      charged: 0,
      retire: (reason, status) => end(reason, true, status),
      refuse: (reason, status) => end(reason, false, status),
    };
    this.pairs.add(pair);
    socket.once("close", () =>
      pair.grant ? pair.retire("client_closed") : pair.refuse("abandoned"),
    );
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
        pair.refuse("unauthorized", 401);
        return;
      }
      let active = 0;
      let sameWorkspace = 0;
      for (const candidate of this.pairs) {
        if (candidate.grant === null) continue;
        active += 1;
        if (
          candidate.grant.workspaceId === destination.workspaceId &&
          candidate.grant.readOnly === destination.readOnly
        )
          sameWorkspace += 1;
      }
      if (active >= this.limits.maxConnections) {
        pair.refuse("instance_limit", 429);
        return;
      }
      if (
        sameWorkspace >=
        (destination.readOnly
          ? this.limits.maxReadOnlyConnectionsPerWorkspace
          : this.limits.maxConnectionsPerWorkspace)
      ) {
        pair.refuse(
          destination.readOnly
            ? "read_only_workspace_limit"
            : "workspace_limit",
          429,
        );
        return;
      }
      pair.grant = destination;
      this.admittedTotal += 1;
      const upstream = upstreamOptions(destination.endpoint, token);
      const remote = (
        this.options.openUpstream ??
        ((url, options) => new WebSocket(url, options))
      )(upstream.url, upstream.options);
      pair.upstream = remote;
      let remoteSocket: Duplex | null = null;
      remote.once("upgrade", (response) => {
        remoteSocket = response.socket;
        this.meter(pair, response.socket, remote, () => retired);
      });
      remote.on("error", (error) =>
        pair.retire(
          oversized(error)
            ? "message_limit"
            : upgraded
              ? "upstream_closed"
              : "upstream_failed",
          502,
        ),
      );
      remote.once("unexpected-response", (_request, response) => {
        response.destroy();
        pair.retire("upstream_failed", 502);
      });
      remote.once("close", () =>
        pair.retire(upgraded ? "upstream_closed" : "upstream_failed", 502),
      );
      remote.once("open", () => {
        if (retired || this.closed) {
          pair.retire("shutdown");
          return;
        }
        const engineSocket: Duplex | null = remoteSocket;
        if (!engineSocket) {
          pair.retire("upstream_failed", 502);
          return;
        }
        try {
          this.server.handleUpgrade(req, socket, head, (client) => {
            upgraded = true;
            pair.client = client;
            clearTimeout(handshake);
            // `ws` buffers a whole message before emitting it; charge large
            // ones to the shared budget from their header onwards.
            this.meter(pair, socket, client, () => retired);
            client.on("error", (error) =>
              pair.retire(oversized(error) ? "message_limit" : "client_closed"),
            );
            client.once("close", () => pair.retire("client_closed"));
            const queueOutput = (
              target: WebSocket,
              size: number,
              write: (callback: (error?: Error) => void) => void,
            ) => {
              if (retired) return;
              const closedPeer =
                target === client ? "client_closed" : "upstream_closed";
              if (target.readyState !== WebSocket.OPEN) {
                pair.retire(closedPeer);
                return;
              }
              if (size > MAX_FRAME_BYTES) {
                pair.retire("message_limit");
                return;
              }
              if (target.bufferedAmount + size > MAX_FRAME_BYTES) {
                pair.retire("target_buffer");
                return;
              }
              const reservation = cloudRuntimeRelayOutboundBytes(size);
              if (!this.reserveOutbound(pair, reservation)) return;
              pair.queued += reservation;
              this.outboundQueued += reservation;
              this.peakOutbound = Math.max(
                this.peakOutbound,
                this.outboundQueued,
              );
              this.windowPeakOutbound = Math.max(
                this.windowPeakOutbound,
                this.outboundQueued,
              );
              write((error) => {
                if (!retired) {
                  pair.queued -= reservation;
                  this.outboundQueued -= reservation;
                }
                if (error) pair.retire(closedPeer);
              });
            };
            const forward = (
              target: WebSocket,
              data: RawData,
              binary: boolean,
            ) =>
              queueOutput(target, bytes(data), (callback) =>
                target.send(data, { binary, compress: false }, callback),
              );
            remote.on("message", (data, binary) =>
              forward(client, data, binary),
            );
            client.on("message", (data, binary) =>
              forward(remote, data, binary),
            );
            client.on("ping", (data) =>
              queueOutput(client, data.byteLength, (callback) =>
                client.pong(data, undefined, callback),
              ),
            );
            remote.on("ping", (data) =>
              queueOutput(remote, data.byteLength, (callback) =>
                remote.pong(data, undefined, callback),
              ),
            );
            let authorityExpiresAt = 0;
            const renew = () => {
              clearTimeout(authorityDeadline);
              const leaseMs = Math.max(100, this.authorityCheckMs * 2);
              authorityExpiresAt = performance.now() + leaseMs;
              authorityDeadline = setTimeout(
                () => pair.retire("authority"),
                leaseMs,
              );
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
                    else pair.retire("authority");
                  },
                  () => pair.retire("authority"),
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
                pair.retire("heartbeat");
                return;
              }
              clientAlive = false;
              upstreamAlive = false;
              queueOutput(client, 0, (callback) =>
                client.ping(undefined, undefined, callback),
              );
              queueOutput(remote, 0, (callback) =>
                remote.ping(undefined, undefined, callback),
              );
            }, 25_000);
            pingTimer.unref();
          });
        } catch {
          pair.retire("upstream_failed", 502);
        }
      });
    };
    void admit().catch(() =>
      pair.grant
        ? pair.retire("unavailable", 503)
        : pair.refuse("unavailable", 503),
    );
    return true;
  }

  close(): void {
    this.closed = true;
    for (const pair of [...this.pairs])
      if (pair.grant) pair.retire("shutdown");
      else pair.refuse("closed");
    this.server.close();
    clearInterval(this.summaryTimer);
    this.summarize();
  }

  private activeCount(): number {
    let active = 0;
    for (const pair of this.pairs) if (pair.grant !== null) active += 1;
    return active;
  }

  /** Watches one raw socket's frame headers and charges each message above
   * the uncharged size to the inbound budget until ws emits the message. */
  private meter(
    pair: Pair,
    socket: Duplex,
    receiver: WebSocket,
    ended: () => boolean,
  ): void {
    let charged = 0;
    const completed: number[] = [];
    const meter = new WebSocketFrameMeter({
      grow: (declared) => {
        if (ended()) return false;
        // Oversized messages are refused by `ws` itself with close code 1009.
        if (declared <= UNCHARGED_MESSAGE_BYTES || declared > MAX_FRAME_BYTES)
          return true;
        const extra = declared - charged;
        if (this.inboundCharged + extra > this.limits.inboundBudgetBytes) {
          pair.retire("inbound_budget");
          return false;
        }
        charged = declared;
        pair.charged += extra;
        this.inboundCharged += extra;
        this.peakInbound = Math.max(this.peakInbound, this.inboundCharged);
        this.windowPeakInbound = Math.max(
          this.windowPeakInbound,
          this.inboundCharged,
        );
        return true;
      },
      complete: () => {
        if (ended() || charged === 0) return;
        completed.push(charged);
        charged = 0;
      },
    });
    const releaseMessage = (data: RawData) => {
      if (ended() || bytes(data) <= UNCHARGED_MESSAGE_BYTES) return;
      const reservation = completed.shift() ?? 0;
      pair.charged -= reservation;
      this.inboundCharged -= reservation;
    };
    const feed = (chunk: Buffer) => meter.feed(chunk);
    receiver.on("message", releaseMessage);
    socket.prependListener("data", feed);
    socket.once("close", () => {
      socket.off("data", feed);
      receiver.off("message", releaseMessage);
      completed.length = 0;
    });
  }

  /** Admits `size` more queued bytes under the shared outbound budget. When
   * it is exhausted, the connection holding the most queued output (counting
   * this message for its sender) is retired; on a tie the sender yields. A
   * stalled reader with a larger backlog yields to a healthy sender. */
  private reserveOutbound(pair: Pair, size: number): boolean {
    while (this.outboundQueued + size > this.limits.outboundBudgetBytes) {
      let largest = pair;
      let most = pair.queued + size;
      for (const candidate of this.pairs)
        if (candidate.queued > most) {
          largest = candidate;
          most = candidate.queued;
        }
      largest.retire("outbound_budget");
      if (largest === pair) return false;
    }
    return true;
  }

  private release(pair: Pair): void {
    this.outboundQueued -= pair.queued;
    this.inboundCharged -= pair.charged;
    pair.queued = 0;
    pair.charged = 0;
  }

  private count(
    retirement: CloudRuntimeRelayRetirement | null,
    refusal: CloudRuntimeRelayRefusal | null,
  ): void {
    if (retirement) this.retired[retirement] += 1;
    if (refusal) this.rejected[refusal] += 1;
    const reason = retirement ?? refusal;
    if (!reason || !REPORTED.has(reason)) return;
    const now = performance.now();
    const last = this.reported.get(reason);
    if (last && now - last.at < REPORT_INTERVAL_MS) {
      last.suppressed += 1;
      return;
    }
    this.reported.set(reason, { at: now, suppressed: 0 });
    this.log(
      `[cloud-bridge] ${retirement ? "closed" : "refused"} connection: ${reason} ` +
        `active=${this.activeCount()}/${this.limits.maxConnections} pending=${this.pending} ` +
        `queued=${mib(this.outboundQueued)}/${mib(this.limits.outboundBudgetBytes)} ` +
        `inbound=${mib(this.inboundCharged)}/${mib(this.limits.inboundBudgetBytes)}` +
        (last?.suppressed ? ` repeats=${last.suppressed}` : ""),
      "warn",
    );
  }

  /** One line per interval with activity: deltas since the previous line,
   * current occupancy and the interval's peak budget use. */
  private summarize(): void {
    const changed = <Key extends string>(
      now: Record<Key, number>,
      before: Record<Key, number>,
    ) =>
      (Object.keys(now) as Key[])
        .filter((key) => now[key] !== before[key])
        .map((key) => `${key}=${now[key] - before[key]}`)
        .join(" ");
    const admitted = this.admittedTotal - this.summarized.admitted;
    const refused = changed(this.rejected, this.summarized.rejected);
    const closed = changed(this.retired, this.summarized.retired);
    const busy = this.windowPeakOutbound > 0 || this.windowPeakInbound > 0;
    if (!admitted && !refused && !closed && !busy) return;
    this.log(
      `[cloud-bridge] summary active=${this.activeCount()}/${this.limits.maxConnections} ` +
        `admitted=${admitted}` +
        (refused ? ` refused(${refused})` : "") +
        (closed ? ` closed(${closed})` : "") +
        ` peak_queued=${mib(this.windowPeakOutbound)}/${mib(this.limits.outboundBudgetBytes)}` +
        ` peak_inbound=${mib(this.windowPeakInbound)}/${mib(this.limits.inboundBudgetBytes)}`,
      "info",
    );
    this.summarized = {
      admitted: this.admittedTotal,
      rejected: { ...this.rejected },
      retired: { ...this.retired },
    };
    this.windowPeakOutbound = this.outboundQueued;
    this.windowPeakInbound = this.inboundCharged;
  }
}
