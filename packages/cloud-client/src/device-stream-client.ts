// Device-stream (S3 Part 2) connection manager shared by every client
// platform. The host supplies the WebSocket and the POST /v1/device-sessions
// call; this class owns ticket -> hello -> ready, the resume cursor, acks,
// liveness, reconnect backoff and the S3 close codes, and declares the
// attachments and presence again on every new connection (the server keeps
// both per connection). Catalog state stays with the consumer: it receives
// frames and `snapshot_required`, and supplies the resume base. Tickets,
// cursors and capabilities stay in memory and are never logged.

import { parseDeviceStreamFrame } from "./device-stream";
import type { DeviceStreamServerEvent, ServerReady } from "./generated/device-stream";
import { CloudRestError, retryDelayMs } from "./rest-client";

export const DEVICE_STREAM_CLIENT_CONTRACT: Readonly<{ min: number; max: number }> = Object.freeze({ min: 1, max: 1 });
/** S3: 45 s without traffic at the 20 s heartbeat means the stream is dead. */
export const DEVICE_STREAM_DEAD_AFTER_MS = 45_000;
/** The server ignores acks less than 1 s apart; the margin absorbs jitter. */
export const DEVICE_STREAM_ACK_INTERVAL_MS = 1_250;
/** Client frame budget per connection: half the server's burst of 40 and 20/s. */
export const DEVICE_STREAM_SEND_BURST = 20;
export const DEVICE_STREAM_SEND_PER_SECOND = 10;
/** A ready stream that stays open this long resets the reconnect backoff. */
export const DEVICE_STREAM_STABLE_MS = 10_000;
/** The server's hello accepts at most this many held workspace versions. */
export const DEVICE_STREAM_MAX_RESUME_WORKSPACES = 1_000;
/** The client's own close code for a stream that went silent. */
export const DEVICE_STREAM_DEAD_CLOSE_CODE = 4000;

const MAX_DRAIN_DELAY_MS = 60_000;
const MAX_DEAD_AFTER_MS = 125_000;
const MAX_ATTEMPT = 20;
const CLOSE_FRAME_INVALID = 4400;
const CLOSE_DISABLED = 4404;
const CLOSE_SUPERSEDED = 4409;
const CLOSE_CONTRACT_UNSUPPORTED = 4426;
const CLOSE_DRAINING = 4503;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRESENCE_STATES: ReadonlySet<string> = new Set(["active", "idle", "away"]);

export type DeviceStreamPresenceState = "active" | "idle" | "away";

export interface DeviceStreamSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface DeviceStreamSocketHandlers {
  open(): void;
  message(text: string): void;
  close(code: number, reason: string): void;
}

/**
 * Opens a WebSocket to `url`. Adapters deliver text messages only, call the
 * handlers asynchronously (never from inside the factory call), and keep the
 * platform's automatic ping replies: the server closes 4408 after 45 s
 * without a pong.
 */
export type DeviceStreamSocketFactory = (url: string, handlers: DeviceStreamSocketHandlers) => DeviceStreamSocket;

/** The parts of a `POST /v1/device-sessions` answer the stream needs. */
export type DeviceSessionGrant = { deviceSessionId: string; url: string; ticket: string };

/** The consumer's last confirmed catalog snapshot, sent with a resume. */
export type DeviceStreamResumeBase = { catalogVersion: number; workspaces?: Record<string, number> };

export type DeviceStreamStopReason =
  | "stopped"
  | "disabled"
  | "contract_unsupported"
  | "unauthenticated"
  | "rejected"
  | "invalid_stream_url";

export type DeviceStreamState =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "open"; deviceSessionId: string }
  | { kind: "waiting"; attempt: number; delayMs: number }
  | { kind: "stopped"; reason: DeviceStreamStopReason; code?: string };

export type DeviceStreamPayloadFrame = Extract<
  DeviceStreamServerEvent,
  { t: "catalog.changed" | "lifecycle.changed" | "presence.changed" | "notification" | "capability.renewed" | "capability.revoked" }
>;

export type DeviceStreamEvent =
  | { type: "state"; state: DeviceStreamState }
  | { type: "ready"; ready: ServerReady["d"] }
  /** Read the REST snapshot: "not_resumed" after a fresh stream, else the catalog.reset reason. */
  | { type: "snapshot_required"; reason: string }
  | { type: "frame"; frame: DeviceStreamPayloadFrame }
  | { type: "error"; code: string; message: string; fatal: boolean };

export interface DeviceStreamClientOptions {
  /** `POST /v1/device-sessions`; the held id keeps the device session (and its resume). */
  openSession: (deviceSessionId: string | null) => Promise<DeviceSessionGrant>;
  createSocket: DeviceStreamSocketFactory;
  /** Null until the consumer holds a confirmed snapshot; there is no resume without one. */
  resumeBase: () => DeviceStreamResumeBase | null;
  /** Called synchronously, in stream order. A throwing consumer does not stop the stream. */
  onEvent: (event: DeviceStreamEvent) => void;
  contract?: { min: number; max: number };
  random?: () => number;
}

type Timer = ReturnType<typeof setTimeout>;

type Connection = {
  socket: DeviceStreamSocket | null;
  ready: boolean;
  readyAtMs: number | null;
  /** The next frame may be the catalog.reset that explains an unresumed ready. */
  foldReset: boolean;
  drainAfterMs: number | null;
  ackDue: string | null;
  acked: string | null;
  lastAckAtMs: number;
  /** What this connection told the server; the server forgets both on close. */
  attached: Set<string>;
  presence: Map<string, DeviceStreamPresenceState>;
  tokens: number;
  refilledAtMs: number;
};

type Outgoing = { frame: { t: string; d: Record<string, unknown> }; commit: () => void };

export class DeviceStreamClient {
  private readonly options: DeviceStreamClientOptions;
  private readonly contract: { min: number; max: number };
  private readonly random: () => number;
  private stateValue: DeviceStreamState = { kind: "idle" };
  private current: Connection | null = null;
  /** Bumped by every attempt and every halt; stale async results compare it. */
  private generation = 0;
  private attempt = 0;
  private sessionId: string | null = null;
  private cursor: string | null = null;
  private deadAfterMs = DEVICE_STREAM_DEAD_AFTER_MS;
  private readonly attachments = new Set<string>();
  private readonly presence = new Map<string, DeviceStreamPresenceState>();
  private retryTimer: Timer | null = null;
  private deadTimer: Timer | null = null;
  private flushTimer: Timer | null = null;

  constructor(options: DeviceStreamClientOptions) {
    this.options = options;
    this.contract = { ...(options.contract ?? DEVICE_STREAM_CLIENT_CONTRACT) };
    this.random = options.random ?? Math.random;
  }

  get state(): DeviceStreamState { return this.stateValue; }
  get deviceSessionId(): string | null { return this.sessionId; }

  start(): void {
    const kind = this.stateValue.kind;
    if (kind === "connecting" || kind === "open" || kind === "waiting") return;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    if (this.stateValue.kind === "idle" || this.stateValue.kind === "stopped") return;
    this.halt("stopped");
  }

  /** Skips the remaining backoff, e.g. when the network comes back. */
  reconnectNow(): void {
    if (this.stateValue.kind === "waiting") void this.connect();
  }

  attach(workspaceId: string, clientSessionId: string): void {
    this.attachments.add(attachmentKey(workspaceId, clientSessionId));
    this.kick();
  }

  detach(workspaceId: string, clientSessionId: string): void {
    this.attachments.delete(attachmentKey(workspaceId, clientSessionId));
    this.kick();
  }

  /** Presence on transitions only (S3 behavior 6); null forgets the
   * workspace without sending a frame. */
  setPresence(workspaceId: string, state: DeviceStreamPresenceState | null): void {
    assertUuid(workspaceId, "workspaceId");
    if (state === null) this.presence.delete(workspaceId);
    else {
      if (!PRESENCE_STATES.has(state)) throw new TypeError("presence state must be active, idle or away");
      this.presence.set(workspaceId, state);
    }
    this.kick();
  }

  private async connect(): Promise<void> {
    this.clearTimer("retryTimer");
    const generation = ++this.generation;
    this.setState({ kind: "connecting", attempt: this.attempt });
    if (generation !== this.generation) return;
    let grant: DeviceSessionGrant;
    try {
      grant = await this.options.openSession(this.sessionId);
    } catch (error) {
      if (generation === this.generation) this.sessionFailed(error);
      return;
    }
    if (generation !== this.generation) return;
    if (grant.deviceSessionId !== this.sessionId) {
      // A new device session has no history to resume.
      this.sessionId = grant.deviceSessionId;
      this.cursor = null;
    }
    if (!/^wss:\/\//.test(grant.url)) {
      this.halt("invalid_stream_url");
      return;
    }
    const connection: Connection = {
      socket: null, ready: false, readyAtMs: null, foldReset: false, drainAfterMs: null,
      ackDue: null, acked: null, lastAckAtMs: Number.NEGATIVE_INFINITY,
      attached: new Set(), presence: new Map(),
      tokens: DEVICE_STREAM_SEND_BURST, refilledAtMs: Date.now(),
    };
    this.current = connection;
    this.armDeadTimer(connection);
    const ticket = grant.ticket;
    try {
      connection.socket = this.options.createSocket(grant.url, {
        open: () => { if (this.current === connection) this.sendHello(connection, ticket); },
        message: text => { if (this.current === connection) this.receive(connection, text); },
        close: code => { if (this.current === connection) this.closed(connection, code); },
      });
    } catch {
      this.release(connection);
      this.scheduleRetry({});
    }
  }

  private sendHello(connection: Connection, ticket: string): void {
    const d: Record<string, unknown> = { contract: { ...this.contract }, ticket };
    let base: DeviceStreamResumeBase | null = null;
    if (this.cursor !== null) {
      try { base = this.options.resumeBase(); } catch { base = null; }
    }
    const resume = this.cursor === null ? null : resumeFrom(this.cursor, base);
    if (resume) d.resume = resume;
    this.write(connection, { t: "hello", d });
  }

  private receive(connection: Connection, text: string): void {
    this.armDeadTimer(connection);
    const parsed = parseDeviceStreamFrame(text);
    if (parsed.kind !== "known") return;
    const frame = parsed.frame;
    const fold = connection.foldReset;
    connection.foldReset = false;
    if (!connection.ready) {
      if (frame.t === "ready") this.ready(connection, frame.d);
      else if (frame.t === "error") this.emit(errorEvent(frame.d));
      return;
    }
    switch (frame.t) {
      case "catalog.reset":
        if (!fold) this.emit({ type: "snapshot_required", reason: typeof frame.d.reason === "string" ? frame.d.reason : "server_reset" });
        return;
      case "drain":
        connection.drainAfterMs = drainDelay(frame.d.reconnectAfterMs);
        return;
      case "error":
        this.emit(errorEvent(frame.d));
        return;
      case "catalog.changed":
      case "lifecycle.changed":
      case "notification":
      case "capability.revoked":
      case "presence.changed":
      case "capability.renewed": {
        const cursor = frameCursor(frame);
        if (cursor !== null) {
          this.cursor = cursor;
          connection.ackDue = cursor;
        }
        this.emit({ type: "frame", frame });
        if (cursor !== null && this.current === connection) this.flush(connection);
        return;
      }
      default:
        // heartbeat and pong only refresh liveness; a repeated ready and
        // client frame types are ignored.
        return;
    }
  }

  private ready(connection: Connection, d: ServerReady["d"]): void {
    if (typeof d.deviceSessionId !== "string" || typeof d.cursor !== "string" || d.cursor.length === 0 ||
        typeof d.resumed !== "boolean") {
      this.abandon(connection, 1002, "ready_invalid");
      return;
    }
    connection.ready = true;
    connection.readyAtMs = Date.now();
    this.sessionId = d.deviceSessionId;
    this.cursor = d.cursor;
    if (typeof d.heartbeatIntervalMs === "number" && Number.isFinite(d.heartbeatIntervalMs) && d.heartbeatIntervalMs > 0)
      this.deadAfterMs = Math.min(MAX_DEAD_AFTER_MS, Math.max(DEVICE_STREAM_DEAD_AFTER_MS, 2 * d.heartbeatIntervalMs + 5_000));
    this.armDeadTimer(connection);
    this.setState({ kind: "open", deviceSessionId: d.deviceSessionId });
    if (this.current !== connection) return;
    this.emit({ type: "ready", ready: d });
    if (this.current !== connection) return;
    if (!d.resumed) {
      connection.foldReset = true;
      this.emit({ type: "snapshot_required", reason: "not_resumed" });
      if (this.current !== connection) return;
    }
    this.flush(connection);
  }

  private closed(connection: Connection, code: number): void {
    const stable = connection.readyAtMs !== null && Date.now() - connection.readyAtMs >= DEVICE_STREAM_STABLE_MS;
    this.release(connection);
    switch (code) {
      case CLOSE_DISABLED:
        this.forgetSession();
        this.halt("disabled");
        return;
      case CLOSE_CONTRACT_UNSUPPORTED:
        this.halt("contract_unsupported");
        return;
      case CLOSE_SUPERSEDED:
        // Another hello took this device session: start a new one instead
        // of taking it back.
        this.forgetSession();
        break;
      case CLOSE_FRAME_INVALID:
        this.cursor = null;
        break;
      case CLOSE_DRAINING:
        if (connection.drainAfterMs !== null) {
          this.scheduleRetry({ fixedMs: connection.drainAfterMs, stable });
          return;
        }
        break;
      default:
        // 4401 gets a new ticket with the next attempt; 4408, 4429, 1000,
        // 1001, 1006, 1011 and the rest resume with backoff.
        break;
    }
    this.scheduleRetry({ stable });
  }

  private sessionFailed(error: unknown): void {
    if (error instanceof CloudRestError) {
      if (error.status === 404) {
        this.forgetSession();
        this.halt("disabled");
        return;
      }
      if (error.status === 409 && error.code === "contract_unsupported") {
        this.halt("contract_unsupported", error.code);
        return;
      }
      if (error.status === 401 || error.status === 403) {
        this.halt("unauthenticated", error.code);
        return;
      }
      const retryable = error.status === 0 || error.retryable || error.status === 429 || error.status >= 500;
      if (!retryable) {
        this.halt("rejected", error.code);
        return;
      }
      this.scheduleRetry(error.retryAfterMs === undefined ? {} : { minMs: error.retryAfterMs });
      return;
    }
    this.scheduleRetry({});
  }

  private scheduleRetry(options: { fixedMs?: number; minMs?: number; stable?: boolean }): void {
    if (options.stable) this.attempt = 0;
    let delayMs: number;
    if (options.fixedMs !== undefined) delayMs = options.fixedMs;
    else {
      delayMs = Math.max(options.minMs ?? 0, retryDelayMs(this.attempt, this.random));
      this.attempt = Math.min(MAX_ATTEMPT, this.attempt + 1);
    }
    this.clearTimer("retryTimer");
    // Armed before the state event, so a consumer that stops the client
    // from that event also cancels this retry.
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delayMs);
    this.setState({ kind: "waiting", attempt: this.attempt, delayMs });
  }

  private halt(reason: DeviceStreamStopReason, code?: string): void {
    this.generation += 1;
    this.clearTimer("retryTimer");
    const connection = this.current;
    if (connection) {
      this.release(connection);
      try { connection.socket?.close(1000, reason === "stopped" ? "client_stop" : reason); } catch { /* already closed */ }
    }
    this.setState(code === undefined ? { kind: "stopped", reason } : { kind: "stopped", reason, code });
  }

  /** Closes a connection the client gave up on and retries; its late
   * events are ignored. */
  private abandon(connection: Connection, code: number, reason: string): void {
    this.release(connection);
    try { connection.socket?.close(code, reason); } catch { /* already closed */ }
    this.scheduleRetry({});
  }

  private release(connection: Connection): void {
    if (this.current !== connection) return;
    this.current = null;
    this.clearTimer("deadTimer");
    this.clearTimer("flushTimer");
  }

  private forgetSession(): void {
    this.sessionId = null;
    this.cursor = null;
  }

  private kick(): void {
    const connection = this.current;
    if (connection?.ready) this.flush(connection);
  }

  /** Sends what the server is missing within the frame budget, ack first. */
  private flush(connection: Connection): void {
    this.clearTimer("flushTimer");
    if (this.current !== connection || !connection.ready) return;
    const now = Date.now();
    connection.tokens = Math.min(DEVICE_STREAM_SEND_BURST,
      connection.tokens + ((now - connection.refilledAtMs) / 1_000) * DEVICE_STREAM_SEND_PER_SECOND);
    connection.refilledAtMs = now;
    const { work, ackWaitMs } = this.pending(connection, now);
    let sent = 0;
    while (sent < work.length && connection.tokens >= 1) {
      const next = work[sent]!;
      connection.tokens -= 1;
      next.commit();
      this.write(connection, next.frame);
      sent += 1;
      if (this.current !== connection) return;
    }
    let waitMs = Number.POSITIVE_INFINITY;
    if (sent < work.length) waitMs = Math.ceil(((1 - connection.tokens) / DEVICE_STREAM_SEND_PER_SECOND) * 1_000);
    if (ackWaitMs !== null) waitMs = Math.min(waitMs, ackWaitMs);
    if (!Number.isFinite(waitMs)) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush(connection);
    }, Math.max(1, waitMs));
  }

  private pending(connection: Connection, now: number): { work: Outgoing[]; ackWaitMs: number | null } {
    const work: Outgoing[] = [];
    let ackWaitMs: number | null = null;
    const ack = connection.ackDue;
    if (ack !== null && ack !== connection.acked) {
      const dueInMs = connection.lastAckAtMs + DEVICE_STREAM_ACK_INTERVAL_MS - now;
      if (dueInMs <= 0)
        work.push({ frame: { t: "ack", d: { cursor: ack } }, commit: () => { connection.acked = ack; connection.lastAckAtMs = now; } });
      else ackWaitMs = dueInMs;
    }
    for (const key of connection.attached) {
      if (this.attachments.has(key)) continue;
      work.push({ frame: { t: "detach", d: attachmentFields(key) }, commit: () => { connection.attached.delete(key); } });
    }
    for (const key of this.attachments) {
      if (connection.attached.has(key)) continue;
      work.push({ frame: { t: "attach", d: attachmentFields(key) }, commit: () => { connection.attached.add(key); } });
    }
    for (const [workspaceId, state] of this.presence) {
      if (connection.presence.get(workspaceId) === state) continue;
      work.push({ frame: { t: "presence.set", d: { workspaceId, state } }, commit: () => { connection.presence.set(workspaceId, state); } });
    }
    return { work, ackWaitMs };
  }

  private write(connection: Connection, frame: { t: string; d: Record<string, unknown> }): void {
    try { connection.socket?.send(JSON.stringify(frame)); } catch { /* the close handler reports it */ }
  }

  private armDeadTimer(connection: Connection): void {
    this.clearTimer("deadTimer");
    this.deadTimer = setTimeout(() => {
      this.deadTimer = null;
      if (this.current === connection) this.abandon(connection, DEVICE_STREAM_DEAD_CLOSE_CODE, "heartbeat_timeout");
    }, this.deadAfterMs);
  }

  private clearTimer(name: "retryTimer" | "deadTimer" | "flushTimer"): void {
    const timer = this[name];
    if (timer !== null) clearTimeout(timer);
    this[name] = null;
  }

  private setState(state: DeviceStreamState): void {
    this.stateValue = state;
    this.emit({ type: "state", state });
  }

  private emit(event: DeviceStreamEvent): void {
    try { this.options.onEvent(event); } catch { /* a consumer bug must not stop the stream */ }
  }
}

function attachmentKey(workspaceId: string, clientSessionId: string): string {
  assertUuid(workspaceId, "workspaceId");
  assertUuid(clientSessionId, "clientSessionId");
  return `${workspaceId} ${clientSessionId}`;
}

function attachmentFields(key: string): { workspaceId: string; clientSessionId: string } {
  const [workspaceId = "", clientSessionId = ""] = key.split(" ");
  return { workspaceId, clientSessionId };
}

function assertUuid(value: string, name: string): void {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${name} must be a lowercase UUID`);
}

const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function resumeFrom(cursor: string, base: DeviceStreamResumeBase | null): Record<string, unknown> | null {
  if (!base || !isVersion(base.catalogVersion)) return null;
  const resume: Record<string, unknown> = { cursor, catalogVersion: base.catalogVersion };
  if (base.workspaces) {
    const entries = Object.entries(base.workspaces).filter(([id, version]) => UUID.test(id) && isVersion(version));
    if (entries.length <= DEVICE_STREAM_MAX_RESUME_WORKSPACES) resume.workspaces = Object.fromEntries(entries);
  }
  return resume;
}

function frameCursor(frame: object): string | null {
  const cursor = (frame as { c?: unknown }).c;
  return typeof cursor === "string" && cursor.length > 0 && cursor.length <= 256 ? cursor : null;
}

function errorEvent(d: Record<string, unknown>): DeviceStreamEvent {
  return {
    type: "error",
    code: typeof d.code === "string" ? d.code : "unknown",
    message: typeof d.message === "string" ? d.message : "",
    fatal: d.fatal === true,
  };
}

function drainDelay(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_DRAIN_DELAY_MS, Math.max(0, Math.floor(value)))
    : null;
}
