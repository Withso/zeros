// ──────────────────────────────────────────────────────────
// Browser-side WebSocket client for the Zeros engine
// ──────────────────────────────────────────────────────────
//
// Connects to the Zeros engine on localhost.
// Port resolution order (first match wins):
//   1. window.__ZEROS_PORT__   — optional native-shell injection
//   2. native get_engine_port command — source of truth in the Mac app
//   3. DEFAULT_ENGINE_PORT     — plain browser dev harness fallback
//      (stable 24193 / beta 24203 / dev 24293, matching the engine channel)
//
// Reconnect strategy uses exponential backoff (1s → 15s cap) so a
// briefly-flaky engine respawns quickly without hammering the port
// once it's genuinely down. Requests made during a transient
// disconnect are queued for RECONNECT_GRACE_MS; inside that window
// we trust the watchdog to bring the engine back, and the queued
// message flushes on open — the user never sees the blip. After
// the grace window a queued request rejects with a soft-fail error
// the UI can match to show a muted "Reconnecting…" line.
// ──────────────────────────────────────────────────────────

import type { BridgeMessage } from "./messages";
import { createMessageId } from "./messages";
import { PROTOCOL_VERSION } from "@zeros/protocol/version";
import { cloudBridgeCloseDiagnostic } from "@zeros/protocol/cloud-bridge-diagnostics";
import { RuntimeConnectionTargetSchema, type CloudRuntimeConnectionTarget, type RuntimeConnectionTarget } from "@zeros/protocol/cloud-runtime-connection";
import { CloudAgentBootConversationSchema, type CloudAgentBootConversation, type CloudAgentBootScope } from "@zeros/protocol/cloud-agent-bootstrap";
export type { CloudRuntimeConnectionTarget, RuntimeConnectionTarget } from "@zeros/protocol/cloud-runtime-connection";
import { CloudRuntimeAccessError } from "./cloud-runtime-access-error";
import {
  MAX_BRIDGE_FRAME_BYTES,
  safeParseBridgeMessage,
} from "@zeros/protocol/schemas";
import {
  ENGINE_BASE_PORT_ALPHA,
  ENGINE_BASE_PORT_BETA,
  ENGINE_BASE_PORT_DEV,
  ENGINE_BASE_PORT_PROD,
} from "../../../engine/runtime";
import { getAuthAccessToken } from "../../features/auth/auth-token";
import { CHANNEL, type Channel } from "../../config/release-channel";

// Fallback only — in the Mac app, native get_engine_port (step 2) always wins
// and returns the engine's actually-bound port. This matters solely for a
// plain browser harness, where it must match the engine channel baked into the
// renderer. Native get_engine_port remains authoritative in every desktop app.
//
// A total Record (not a ternary chain) so adding a channel is a COMPILE ERROR
// here instead of silently falling through to Production's port — which would
// point an Alpha harness at the Stable engine.
const ENGINE_PORT_BY_CHANNEL: Record<Channel, number> = {
  dev: ENGINE_BASE_PORT_DEV,
  alpha: ENGINE_BASE_PORT_ALPHA,
  beta: ENGINE_BASE_PORT_BETA,
  stable: ENGINE_BASE_PORT_PROD,
};
const DEFAULT_ENGINE_PORT = ENGINE_PORT_BY_CHANNEL[CHANNEL];

/** Ladder for reconnect backoff in ms. Index = consecutive-failure count. */
const RECONNECT_LADDER = [1_000, 2_000, 4_000, 8_000, 15_000];

/** How long to buffer requests made while the socket is briefly down, before
 *  giving up and surfacing a soft-fail error. Must OUTLAST a cold-boot connect:
 *  the renderer fires WORKSPACE_REQUESTs (chat backfill/mirror, history hydrate,
 *  worktree list) before the bridge is stably open, and the local↔relay
 *  handshake plus the reconnect ladder above (…8s, 15s) routinely exceeds 7s on
 *  a cold/dev start. At 7s — SHORTER than the ladder's own 15s top step — those
 *  queued requests rejected with "Request timeout: … (reconnecting)" and the
 *  initial server-state reads fail before the engine came up. 20s lets them
 *  survive the connect and flush once the bridge settles. NOTE: decoupled from
 *  the chat UI's 7s "Reconnecting…" indicator — the indicator may show while
 *  requests keep patiently buffering; they are separate concerns. */
const RECONNECT_GRACE_MS = 20_000;
const CLOUD_DIRECT_READY_MS = 5_000;

/** Cap on the number of requests we'll queue during a disconnect so
 *  a runaway caller can't pin unbounded memory. The previous 32 was
 *  too tight for realistic multi-chat use — every project switch
 *  triggers a brief disconnect, every chat that's mid-mount fires
 *  AGENT_LOAD_SESSION, and listAgents from the empty composer adds
 *  one more. With 7+ live chats and a 7s reconnect grace window,
 *  hitting the cap was easy and surfaced as "queue full" timeouts on
 *  random chats. 256 covers the realistic upper bound (every chat
 *  the user has open + a handful of registry probes) without burning
 *  meaningful memory. The deadline check still expires entries so a
 *  stuck reconnect doesn't grow the queue forever. */
const MAX_QUEUED_REQUESTS = 256;

/** Parse the untrusted local/cloud WebSocket boundary. The protocol schema
 * keeps per-message validation centralized; unknown future message types are
 * deliberately ignored (as dispatch already did) so a rolling engine update
 * does not sever a mixed-version renderer connection. */
export function parseInboundBridgeWebSocketFrame(
  raw: unknown,
): BridgeMessage | null {
  if (
    typeof raw !== "string" ||
    new TextEncoder().encode(raw).byteLength > MAX_BRIDGE_FRAME_BYTES
  ) {
    return null;
  }
  try {
    const message = safeParseBridgeMessage(JSON.parse(raw) as unknown);
    return message?.source === "engine" ? message : null;
  } catch {
    return null;
  }
}

/** Per-type cap on queued requests for high-fan-out
 *  message types that React effects can re-fire while disconnected.
 *  AGENT_LOAD_SESSION is the worst offender: every chat-view mount
 *  emits one, and a chat-switch storm during a brief reconnect can
 *  pile up dozens for the same chatId. We cap each type at 50 entries
 *  in the queue and drop the oldest when the cap is reached. The
 *  newest write always wins because session state is monotonic. */
const PER_TYPE_QUEUE_CAP: Record<string, number> = {
  AGENT_LOAD_SESSION: 50,
  AGENT_LIST_SESSIONS: 50,
  // AGENT_NEW_SESSION is high-fan-out AND expensive: each one the engine
  // handles spawns a fresh agent subprocess (a codex app-server child per
  // session). A rebuild storm (many chats failing at once, or queued sends
  // draining into an unhealthy chat) could otherwise pile up hundreds and
  // fork-bomb the machine. Cap it low — the newest rebuild wins, older
  // queued spawns are dropped. AGENT_LIST_AGENTS is cheap but re-fires from
  // effects on every error-state flip; cap it too so a reconnect storm
  // doesn't flood the registry probe.
  AGENT_NEW_SESSION: 12,
  AGENT_LIST_AGENTS: 24,
};

/**
 * Resolve the engine port. Cached at module level so the reconnect
 * timer doesn't hit native IPC on every retry. The cache can be
 * invalidated via `invalidateEnginePort()` — used by the in-place
 * project swap, where Electron respawns the engine on a fresh port
 * and we need to drop the old value before the next connect().
 */
let cachedPortPromise: Promise<number> | null = null;
let cachedTokenPromise: Promise<string> | null = null;
function resolveEnginePort(): Promise<number> {
  if (cachedPortPromise) return cachedPortPromise;
  cachedPortPromise = (async () => {
    if (typeof window === "undefined") return DEFAULT_ENGINE_PORT;

    const injected = (window as unknown as { __ZEROS_PORT__?: number })
      .__ZEROS_PORT__;
    if (
      typeof injected === "number" &&
      Number.isFinite(injected) &&
      injected > 0
    ) {
      return injected;
    }

    const { isExpectedElectron, isNativeRuntime, nativeInvoke } =
      await import("../runtime");
    if (isNativeRuntime()) {
      try {
        const port = await nativeInvoke<number | null>("get_engine_port");
        if (typeof port === "number" && port > 0) return port;
        throw new Error("native engine port is not ready");
      } catch (err) {
        // A native app must never guess the base port: a previous process or
        // sibling instance may own it. Clear the rejected promise and retry the
        // authoritative IPC resolution on the reconnect ladder instead.
        console.warn("[Zeros] get_engine_port failed:", err);
        void import("../observability/analytics/posthog").then((m) =>
          m.reportError(err, { source: "get_engine_port" }),
        );
        throw err;
      }
    }
    if (isExpectedElectron()) {
      throw new Error("native preload bridge is not ready");
    }

    return DEFAULT_ENGINE_PORT;
  })().catch((error) => {
    cachedPortPromise = null;
    throw error;
  });
  return cachedPortPromise;
}

/** Drop the cached engine port. Call when the engine respawns on a
 *  new port (in-place project swap) — the next connect() will
 *  re-resolve via native IPC. */
export function invalidateEnginePort(): void {
  cachedPortPromise = null;
}

/** Port and bearer identify one sidecar generation and must rotate together. */
export function invalidateEngineToken(): void {
  cachedTokenPromise = null;
}

/**
 * Resolve the loopback /ws auth token. The engine requires it on the
 * upgrade so a website that opens a cross-origin ws:// to 127.0.0.1 can't pose
 * as the renderer. Cached for one engine generation; forceReconnect clears it
 * because every replacement engine mints a fresh authority token.
 */
function resolveEngineToken(): Promise<string> {
  if (cachedTokenPromise) return cachedTokenPromise;
  cachedTokenPromise = (async () => {
    if (typeof window === "undefined") return "";
    const injected = (window as unknown as { __ZEROS_WS_TOKEN__?: string })
      .__ZEROS_WS_TOKEN__;
    if (typeof injected === "string" && injected) return injected;
    try {
      const { isNativeRuntime, nativeInvoke } = await import("../runtime");
      if (isNativeRuntime()) {
        const token = await nativeInvoke<string | null>("get_engine_token");
        if (typeof token === "string" && token) return token;
      }
    } catch (err) {
      console.warn("[Zeros] get_engine_token failed:", err);
    }
    // No token (standalone dev harness against a tokenless engine) → connect
    // without one; a token-gated engine will simply reject and we retry.
    return "";
  })();
  return cachedTokenPromise;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

const CLOUD_RUNTIME_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOUD_RUNTIME_TOKEN_PATTERN = /^zw[sa]_[A-Za-z0-9_-]{43}$/;
const CLOUD_RPC_IN_FLIGHT = 16;
const CLOUD_CONTROL_REQUESTS = new Set(["AGENT_CANCEL", "AGENT_STOP_BACKGROUND_TASK", "AGENT_STEER",
  "AGENT_CLOSE_SESSION", "AGENT_PERMISSION_RESPONSE", "AGENT_QUESTION_RESPONSE"]);
const DIAGNOSTIC_REQUEST_TYPES = new Set(["WORKSPACE_REQUEST", "PTY_LIST", "PTY_CREATE", "PTY_WRITE", "PTY_KILL",
  "AGENT_LIST_AGENTS", "AGENT_INIT_AGENT", "AGENT_NEW_SESSION", "AGENT_LOAD_SESSION", "AGENT_PROMPT", ...CLOUD_CONTROL_REQUESTS]);
const DIAGNOSTIC_OPERATIONS = new Set(["workspace.list", "workspace.get", "workspace.lifecycleStatus", "github.nativeGrant",
  "cloudEvents.request", "cloudCommands.request", "cloudCommands.conversation", "cloudCommands.createConversation", "cloudCommands.setMode",
  "cloudActions.request", "cloudLsp.request", "chats.list", "chats.replaceAll", "messages.window", "messages.windowOlder",
  "git.status", "git.diff", "git.log", "git.reviewHunks", "file.read", "file.list", "design.status"]);
type CloudDiagnosticScope = Pick<CloudRuntimeConnectionTarget, "workspaceId" | "generation" | "connectionSequence" | "channel">;
type CloudDiagnosticEvent = "close" | "request_failed" | "reconnect" | "connect" | "ready" | "rejection";
function requestDiagnostic(msg: Partial<BridgeMessage> & { type: string }) {
  const operation = "op" in msg ? msg.op : undefined;
  return { requestType: DIAGNOSTIC_REQUEST_TYPES.has(msg.type) ? msg.type : "other",
    operation: typeof operation === "string" && DIAGNOSTIC_OPERATIONS.has(operation) ? operation : "other" };
}

/** Secret-free execution identity. Credentials, loopback ports, expiry, and
 * reconnect sequence are deliberately excluded from keyed renderer state. */
export type RuntimeExecutionIdentity =
  | { readonly kind: "local"; readonly sidecar: "active" }
  | {
      readonly kind: "cloud";
      readonly organizationId: string;
      readonly workspaceId: string;
      readonly generation: number;
      readonly authorityEpoch: number;
      readonly engineInstanceId: string;
      readonly bootScope?: CloudAgentBootScope;
    };

function cloudRuntimeBootScope(target: RuntimeConnectionTarget): CloudAgentBootScope | undefined {
  return target.kind === "cloud" && (target.channel === "direct-provider-websocket" || target.channel === "control-plane-websocket")
    ? target.bootScope : undefined;
}

export function runtimeExecutionIdentity(
  target: RuntimeConnectionTarget,
): RuntimeExecutionIdentity {
  return target.kind === "local"
    ? { kind: "local", sidecar: "active" }
    : {
        kind: "cloud",
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        generation: target.generation,
        authorityEpoch: target.authorityEpoch,
        engineInstanceId: target.engineInstanceId,
        ...(cloudRuntimeBootScope(target) ? { bootScope: cloudRuntimeBootScope(target) } : {}),
      };
}

export function runtimeExecutionKey(
  identity: RuntimeExecutionIdentity,
): string {
  return identity.kind === "local"
    ? "local:sidecar"
    : [
        "cloud",
        identity.organizationId,
        identity.workspaceId,
        identity.generation,
        identity.authorityEpoch,
        identity.engineInstanceId,
        ...(identity.bootScope ? [identity.bootScope.bootId, identity.bootScope.writerEpoch, identity.bootScope.fundingOwnerUserId, identity.bootScope.fundingOwnerEpoch] : []),
      ].join(":");
}

export interface ConnectionTargetExpiredEvent {
  readonly kind: "cloud";
  readonly expiresAt: number;
}

export type CloudRuntimeConnectionTargetRefresher = (
  target: CloudRuntimeConnectionTarget,
) => Promise<RuntimeConnectionTarget>;

export function parseRuntimeConnectionTarget(
  raw: unknown,
  now: number = Date.now(),
): RuntimeConnectionTarget {
  const parsed = RuntimeConnectionTargetSchema.safeParse(raw);
  if (!parsed.success) throw new Error("cloud runtime connection target is invalid");
  const target = parsed.data;
  if (target.kind === "local") return Object.freeze(target);
  if (!Number.isSafeInteger(now) || target.expiresAt - now < 5_000 || target.expiresAt - now > 16 * 60_000)
    throw new Error("cloud runtime connection target is invalid");
  if (target.channel === "control-plane-websocket") {
    const base = new URL((import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) || "https://api.zeros.build");
    if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
        (base.protocol !== "https:" && !(import.meta.env.DEV && base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))))
      throw new Error("cloud control-plane origin is invalid");
    const expected = new URL("/v1/cloud-workspaces/bridge", base);
    expected.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    if (target.url !== expected.toString()) throw new Error("cloud runtime connection URL is invalid");
  }
  return Object.freeze({ ...target, ...("bootScope" in target && target.bootScope ? { bootScope: Object.freeze(target.bootScope) } : {}) });
}

function base64urlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function cloudRuntimeWebSocketProtocols(cloudToken: string): string[] {
  if (!CLOUD_RUNTIME_TOKEN_PATTERN.test(cloudToken)) {
    throw new Error("cloud runtime connection token is invalid");
  }
  return ["zeros-v1", `zeros-cloud-token.${base64urlUtf8(cloudToken)}`];
}

// ── Connection-rejection recovery (pure helpers) ──────────
//
// CONNECTION_REJECTED is TERMINAL for the reconnect ladder (retrying the same
// client/token would just be refused again), so someone must consume it or the
// app sits in a silent "disconnected" state until relaunch. The always-mounted
// BridgeProvider (use-bridge.tsx) is that consumer; these helpers keep its
// policy pure and unit-testable.

/** Payload of an engine CONNECTION_REJECTED as recorded by the client. `reason`
 *  is one of ConnectionRejectedMessage's literals, kept as `string` here so an
 *  engine newer than this client can still hand us an unrecognised reason. */
export interface ConnectionRejection {
  reason: string;
  message: string;
  code?: string;
}

/** Whether an engine RESPAWN (watchdog `engine-restarted`) can plausibly cure a
 *  rejection, so the recovery layer may clear the latch and retry:
 *    • protocol-too-old / protocol-too-new — version skew against a STALE
 *      engine process; the respawned binary may match. Worst case the fresh
 *      engine re-rejects and the latch re-arms — one retry per respawn, never
 *      a hammer loop.
 *    • auth-required / desktop-unbound — the engine had no (or not-yet-seeded)
 *      owner binding; a respawn re-seeds from the local CONNECTED token.
 *  NOT retryable: auth-invalid / auth-wrong-account — the CLIENT's credential
 *  is the problem, and a new engine process rejects the same token the same
 *  way. Those wait for clearRejection() after a re-login/token refresh. */
export function isRejectionRetryableAfterEngineRestart(
  reason: string | null | undefined,
): boolean {
  switch (reason) {
    case "protocol-too-old":
    case "protocol-too-new":
    case "auth-required":
    case "desktop-unbound":
      return true;
    default:
      return false;
  }
}

/** Map a rejection to user-facing toast copy. Reason-specific so the user gets
 *  an actionable instruction instead of a generic dead "disconnected" state.
 *  The engine's own `message` is developer-facing (protocol numbers etc.), so
 *  it only backs the fallback description for unknown reasons. */
export function describeConnectionRejection(rejection: ConnectionRejection): {
  headline: string;
  description: string;
} {
  switch (rejection.reason) {
    case "protocol-too-old":
      return {
        headline: "Zeros needs an update to talk to this engine",
        description: "Install the latest Zeros update, then relaunch the app.",
      };
    case "protocol-too-new":
      return {
        headline: "The Zeros engine is out of date",
        description: "Restart Zeros so it can relaunch the engine.",
      };
    case "auth-invalid":
    case "auth-required":
      return {
        headline: "Sign in again to reconnect",
        description: "Your session expired or could not be verified.",
      };
    case "auth-wrong-account":
      return {
        headline: "This desktop belongs to a different account",
        description: "Sign in with the account that owns this Mac.",
      };
    case "desktop-unbound":
      return {
        headline: "Sign in to Zeros on your Mac",
        description:
          "The desktop has no signed-in owner yet — you'll reconnect automatically once it does.",
      };
    default:
      return {
        headline: "The engine refused the connection",
        description: rejection.message || "Restart Zeros to reconnect.",
      };
  }
}

interface PendingRequest {
  resolve: (msg: BridgeMessage) => void;
  reject: (err: Error) => void;
  timer: number | null;
  signal?: AbortSignal;
  onAbort?: () => void;
  diagnostic: ReturnType<typeof requestDiagnostic>;
  scope?: CloudDiagnosticScope;
  startedAt: number;
}

interface QueuedRequest {
  msg: Partial<BridgeMessage> & { type: string };
  timeoutMs: number;
  resolve: (msg: BridgeMessage) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** Absolute-time deadline. If we're still disconnected at this moment,
   *  the request rejects with a soft-fail error. */
  deadline: number;
}

interface RequestOptions {
  /** 0 or a negative value disables the response timer. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

function normalizeRequestOptions(input: number | RequestOptions | undefined): {
  timeoutMs: number;
  signal?: AbortSignal;
} {
  if (typeof input === "number") return { timeoutMs: input };
  return {
    timeoutMs: input?.timeoutMs ?? 5000,
    signal: input?.signal,
  };
}

function makeRequestAbortError(type: string): Error & { code?: string } {
  const err = new Error(`Request aborted: ${type}`) as Error & {
    code?: string;
  };
  err.code = "REQUEST_ABORTED";
  return err;
}

function clearPendingRequest(pending: PendingRequest): void {
  if (pending.timer !== null) {
    window.clearTimeout(pending.timer);
    pending.timer = null;
  }
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.onAbort = undefined;
  }
}

// Renderer-process retirement memory also covers a late IPC result delivered
// after BridgeProvider was replaced. A descriptor lives at most sixteen minutes.
const retiredCloudRuntimes = new Map<string, number>();
let cloudRetirementOverflowUntil = 0;
function assertCloudRuntimeNotRetired(target: RuntimeConnectionTarget): void {
  const now = Date.now();
  for (const [id, deadline] of retiredCloudRuntimes) if (deadline <= now) retiredCloudRuntimes.delete(id);
  if (target.kind === "cloud" && (retiredCloudRuntimes.has(target.runtimeId) || cloudRetirementOverflowUntil > now)) {
    throw new Error("Cloud runtime connection has been retired");
  }
}

export class RuntimeClient {
  private ws: WebSocket | null = null;
  /** A WebSocket that's been created but hasn't fired onopen yet.
   *  Tracking this prevents `connect()` from racing with itself: HMR
   *  reloads or rapid status churn used to stack orphan sockets, each
   *  holding an open connection to the engine. The engine broadcasts to
   *  every client, so 3 orphans = every chunk arriving at the renderer
   *  3 times = one bubble with the response text concatenated 3x.
   *  See coalesce logic in use-agent-session.tsx:appendText. */
  private pendingWs: WebSocket | null = null;
  private handlers = new Map<string, Set<(msg: BridgeMessage) => void>>();
  private pendingRequests = new Map<string, PendingRequest>();
  private queuedRequests: QueuedRequest[] = [];
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private _status: ConnectionStatus = "disconnected";
  private _disposed = false;
  // Terminal rejection (engine refused the connection: protocol skew or
  // account-binding). When set, the blind reconnect loop is suspended — retrying
  // the same client would just be rejected again. Cleared by a successful connect
  // or clearRejection() (e.g. after a token refresh / re-login).
  private _rejected = false;
  lastRejection: ConnectionRejection | null = null;
  private rejectionListeners = new Set<(r: ConnectionRejection) => void>();
  private connectionTarget: RuntimeConnectionTarget = { kind: "local" };
  private connectionTargetEpoch = 0;
  private expiredConnectionTargetEpoch = -1;
  private connectionTargetExpiryTimer: ReturnType<typeof setTimeout> | null =
    null;
  private connectionTargetExpiryListeners = new Set<
    (event: ConnectionTargetExpiredEvent) => void
  >();
  private executionIdentityListeners = new Set<
    (identity: RuntimeExecutionIdentity) => void
  >();
  private readonly refreshCloudConnectionTarget?: CloudRuntimeConnectionTargetRefresher;
  private cloudTargetNeedsRefresh = false;
  private cloudTargetRefreshPromise: Promise<boolean> | null = null;
  private cloudRefreshFailures = 0;
  private cloudConnectFailures = 0;
  private directReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly readyWaiters = new Set<(error?: Error) => void>();

  constructor(
    target: RuntimeConnectionTarget = { kind: "local" },
    options: {
      refreshCloudConnectionTarget?: CloudRuntimeConnectionTargetRefresher;
    } = {},
  ) {
    const parsedTarget = parseRuntimeConnectionTarget(target);
    assertCloudRuntimeNotRetired(parsedTarget);
    this.connectionTarget = parsedTarget;
    this.refreshCloudConnectionTarget = options.refreshCloudConnectionTarget;
    this.armConnectionTargetExpiry();
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get executionIdentity(): RuntimeExecutionIdentity {
    return runtimeExecutionIdentity(this.connectionTarget);
  }

  /** Socket construction is not readiness. Startup reads wait outside the RPC
   * queue until the actor and exact boot handshake have both completed. */
  waitUntilReady(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    if (this._disposed) return Promise.reject(new Error("Client disposed"));
    if (options.signal?.aborted) return Promise.reject(makeRequestAbortError("runtime readiness"));
    if (this._rejected) return Promise.reject(new Error(this.lastRejection?.message || "Runtime connection rejected"));
    if (this._status === "connected" && this.isOpen()) return Promise.resolve();
    const identity = runtimeExecutionKey(this.executionIdentity);
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.readyWaiters.delete(finish);
        offStatus(); offRejection(); offIdentity();
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const check = () => {
        if (this._rejected) finish(new Error(this.lastRejection?.message || "Runtime connection rejected"));
        else if (this._status === "connected" && this.isOpen()) finish();
      };
      const abort = () => finish(makeRequestAbortError("runtime readiness"));
      const timer = setTimeout(() => finish(new CloudRuntimeAccessError({ code: "cloud_actor_runtime_unavailable", status: 503 })), options.timeoutMs ?? 30_000);
      const offStatus = this.onStatusChange(check);
      const offRejection = this.onConnectionRejected(check);
      const offIdentity = this.onExecutionIdentityChange(next => {
        if (runtimeExecutionKey(next) !== identity) finish(new Error("Runtime execution identity changed while connecting"));
      });
      this.readyWaiters.add(finish);
      options.signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  private engineCapabilities = new Set<string>();
  supportsEngineCapability(capability: string): boolean {
    return this._status === "connected" && this.isOpen() && this.engineCapabilities.has(capability);
  }

  /** Passive observations never enter the reconnect queue or start admission.
   * Check and send in the same synchronous turn at the socket owner. */
  requestConnected<T extends BridgeMessage = BridgeMessage>(
    msg: Partial<BridgeMessage> & { type: string },
    timeoutOrOptions: number | RequestOptions = 5000,
  ): Promise<T> {
    const opts = normalizeRequestOptions(timeoutOrOptions);
    if (this._disposed || this._status !== "connected" || !this.isOpen())
      return Promise.reject(new Error("Cloud workspace is disconnected"));
    if (this.connectionTarget.kind === "cloud" &&
        (this.pendingRequests.size >= CLOUD_RPC_IN_FLIGHT || this.queuedRequests.length))
      return Promise.reject(new Error("Cloud workspace transport is busy"));
    return this.sendRequest<T>(msg, opts.timeoutMs, opts.signal);
  }

  /** Whether the engine is connected and ready */
  private _engineConnected = false;
  private handshakeReady = false;
  private activatedCloudBinding: CloudAgentBootConversation | null = null;
  private finishCloudHandshake: (() => void) | null = null;
  get activatedCloudAgentBootBinding(): CloudAgentBootConversation | null {
    return this.connectionTarget.kind === "cloud" && this._status === "connected" && this.isOpen() &&
      this.engineCapabilities.has("cloud.localCommands.v1") ? this.activatedCloudBinding : null;
  }
  private diagnostics = { at: 0, suppressed: 0, counts: { close: 0, request_failed: 0, reconnect: 0, connect: 0, ready: 0, rejection: 0 } };
  get extensionConnected(): boolean {
    return this._engineConnected;
  }

  async connect(): Promise<void> {
    if (this._disposed || (this.connectionTarget.kind === "cloud" && this._rejected)) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    // In-flight guard. Without it, two concurrent connect() calls both
    // await enginePortPromise then both `new WebSocket(...)` — the
    // earlier one is orphaned (its onopen never wins the assignment to
    // this.ws) but its TCP connection stays open until GC. The engine
    // broadcasts to every connected client, so the renderer sees every
    // chunk multiplied by the orphan count.
    if (this.pendingWs) return;

    if (
      this.connectionTarget.kind === "cloud" &&
      this.connectionTarget.expiresAt <= Date.now()
    ) {
      this.cloudTargetNeedsRefresh = true;
    }
    if (
      this.connectionTarget.kind === "cloud" &&
      this.cloudTargetNeedsRefresh
    ) {
      const refreshed = await this.refreshCurrentCloudTarget();
      if (!refreshed) {
        this.setStatus("disconnected");
        this.scheduleReconnect();
        return;
      }
    }

    const targetEpoch = this.connectionTargetEpoch;
    let wsUrl: string;
    let protocols: string[] | undefined;
    if (this.connectionTarget.kind === "cloud") {
      const target = this.connectionTarget;
      if (target.expiresAt <= Date.now()) {
        this.expireConnectionTarget(this.connectionTargetEpoch);
        return;
      }
      wsUrl = target.url;
      protocols = cloudRuntimeWebSocketProtocols(target.cloudToken);
    } else {
      let port: number;
      let token: string;
      try {
        port = await resolveEnginePort();
        token = await resolveEngineToken();
      } catch {
        if (this._disposed) return;
        invalidateEnginePort();
        this.setStatus("disconnected");
        this.scheduleReconnect();
        return;
      }
      // Present the per-launch token on the local upgrade. Omitted only when
      // the host couldn't provide one (a tokenless standalone engine).
      wsUrl = token
        ? `ws://localhost:${port}/ws?token=${encodeURIComponent(token)}`
        : `ws://localhost:${port}/ws`;
    }
    if (this._disposed || targetEpoch !== this.connectionTargetEpoch) return;
    // Re-check after the async hop — another connect() could have won
    // the race and we'd duplicate.
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.pendingWs) return;

    this.setStatus("connecting");
    this.cloudDiagnostic("connect", { attempt: this.reconnectAttempts });

    let ws: WebSocket;
    try {
      ws = protocols ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);
    } catch {
      this.setStatus("disconnected");
      this.scheduleReconnect();
      return;
    }
    this.pendingWs = ws;
    if (this.connectionTarget.kind === "cloud" && this.connectionTarget.channel === "direct-provider-websocket") {
      this.clearDirectReadyTimer();
      this.directReadyTimer = setTimeout(() => {
        this.directReadyTimer = null;
        if (this._disposed || this._rejected || targetEpoch !== this.connectionTargetEpoch || this.handshakeReady ||
            this.pendingWs !== ws && this.ws !== ws) return;
        this.cloudDiagnostic("close", { class: "direct_ready_timeout", stage: this.pendingWs === ws ? "upgrade" : "handshake" });
        if (this.pendingWs === ws) this.pendingWs = null;
        if (this.ws === ws) this.ws = null;
        try { ws.close(); } catch { /* already closed */ }
        this.afterDisconnect();
      }, CLOUD_DIRECT_READY_MS);
    }
    ws.onopen = () => {
      // If we were disposed (or another socket beat us to it) while
      // pending, drop this one rather than promoting it.
      if (this._disposed || this.pendingWs !== ws || targetEpoch !== this.connectionTargetEpoch) {
        try {
          ws.close();
        } catch {
          /* already dead */
        }
        return;
      }
      this.pendingWs = null;
      this.ws = ws;
      // Actor admission expires before use. Once admitted, the server's live
      // actor lease governs the stream; ordinary reconnect always mints anew.
      if (this.connectionTarget.kind === "cloud" &&
          this.connectionTarget.channel !== "electron-ssh-tunnel" &&
          this.connectionTargetExpiryTimer) {
        clearTimeout(this.connectionTargetExpiryTimer);
        this.connectionTargetExpiryTimer = null;
      }
      this.onTransportOpen();
    };

    ws.onmessage = (event) => {
      if (this._disposed || this.ws !== ws || targetEpoch !== this.connectionTargetEpoch) return;
      const msg = parseInboundBridgeWebSocketFrame(event.data);
      if (msg) this.handleIncoming(msg);
    };

    ws.onclose = (event) => {
      // Clear whichever slot held this socket; an orphan that lost the
      // race could close after the winner promoted itself, and we
      // don't want to null out the live this.ws.
      if (this._disposed || targetEpoch !== this.connectionTargetEpoch) return;
      const wasPending = this.pendingWs === ws;
      if (wasPending) this.pendingWs = null;
      if (this.ws !== ws && !wasPending) return;
      this.clearDirectReadyTimer();
      this.cloudDiagnostic("close", { ...cloudBridgeCloseDiagnostic(event?.code, event?.reason),
        stage: wasPending ? "upgrade" : this.handshakeReady ? "ready" : "handshake" });
      if (this.ws === ws) this.ws = null;
      if (this.connectionTarget.kind === "cloud") {
        const category = cloudBridgeCloseDiagnostic(event?.code, event?.reason).class;
        if (["authority_revoked", "account_binding_required", "actor_forbidden"].includes(category))
          this.rejectCloudConnection(new CloudRuntimeAccessError({ code: "cloud_workspace_access_revoked", status: 403 }));
        else if (category === "protocol_mismatch")
          this.rejectCloudConnection(new CloudRuntimeAccessError({ code: "cloud_workspace_client_update_required", status: 409 }));
        else if (!this.handshakeReady && ++this.cloudConnectFailures >= 5)
          this.rejectCloudConnection(new CloudRuntimeAccessError({ code: "cloud_actor_runtime_unavailable", status: 503 }));
      }
      this.afterDisconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  /** Send a message (fire-and-forget) over the local socket. */
  send(msg: Partial<BridgeMessage> & { type: string }): void {
    if (!this.isOpen()) return;

    const envelope = {
      id: createMessageId(),
      source: "browser",
      timestamp: Date.now(),
      ...msg,
    };
    this.rawSend(envelope);
  }

  /** Tell the engine the desktop owner signed out, so it forgets the bound owner
   *  account and drops connected relay devices (account-binding hardening — a
   *  remote device must not keep access under a signed-out account). Fire-and-
   *  forget over the LOCAL bridge; the engine ignores it from a relay client.
   *  Best-effort: if the socket is already closed there is nothing bound to clear
   *  (a dead engine holds no clients, and the next sign-in re-seeds the owner). */
  signalOwnerSignedOut(): void {
    this.send({ type: "OWNER_SIGNED_OUT" });
  }

  /** Switch this stable bridge client between its local sidecar and a freshly
   * minted cloud descriptor. The descriptor remains memory-only. */
  async setConnectionTarget(target: RuntimeConnectionTarget): Promise<void> {
    const previousKey = runtimeExecutionKey(this.executionIdentity);
    const parsedTarget = parseRuntimeConnectionTarget(target);
    assertCloudRuntimeNotRetired(parsedTarget);
    this.connectionTarget = parsedTarget;
    this.cloudTargetNeedsRefresh = false;
    this.cloudRefreshFailures = 0;
    this.cloudConnectFailures = 0;
    this.armConnectionTargetExpiry();
    this._rejected = false;
    this.lastRejection = null;
    // Retire old slots and queued RPCs synchronously before identity listeners
    // can start reads against the replacement target.
    const connecting = this.forceReconnect({ refreshCloudTarget: false });
    if (runtimeExecutionKey(this.executionIdentity) !== previousKey) {
      this.notifyExecutionIdentityChanged();
    }
    await connecting;
  }

  /** Native retirement is exact-handle scoped and never waits for network revoke. */
  retireCloudRuntime(runtimeId: string): void {
    if (!CLOUD_RUNTIME_UUID_PATTERN.test(runtimeId)) return;
    const deadline = Date.now() + 16 * 60_000;
    assertCloudRuntimeNotRetired({ kind: "local" }); // prune expired tombstones
    if (retiredCloudRuntimes.size >= 512 && !retiredCloudRuntimes.has(runtimeId)) {
      // A storm cannot evict a still-valid retirement proof. Fail closed for
      // the maximum remaining descriptor lifetime using bounded memory.
      cloudRetirementOverflowUntil = deadline;
    } else retiredCloudRuntimes.set(runtimeId, deadline);
    if (this.connectionTarget.kind !== "cloud" || this.connectionTarget.runtimeId !== runtimeId) return;
    void this.setConnectionTarget({ kind: "local" }).catch(() => undefined);
  }

  onExecutionIdentityChange(
    listener: (identity: RuntimeExecutionIdentity) => void,
  ): () => void {
    this.executionIdentityListeners.add(listener);
    return () => this.executionIdentityListeners.delete(listener);
  }

  private notifyExecutionIdentityChanged(): void {
    const identity = this.executionIdentity;
    for (const listener of this.executionIdentityListeners) {
      try {
        listener(identity);
      } catch (error) {
        console.error(
          "[Zeros] runtime execution identity listener failed:",
          error,
        );
      }
    }
  }

  /** Subscribe to expiry of the exact cloud descriptor currently installed.
   * The event is secret-free and fires once per descriptor, allowing the
   * trusted coordinator to mint and install a replacement without a stale
   * reconnect loop. */
  onConnectionTargetExpired(
    listener: (event: ConnectionTargetExpiredEvent) => void,
  ): () => void {
    this.connectionTargetExpiryListeners.add(listener);
    return () => {
      this.connectionTargetExpiryListeners.delete(listener);
    };
  }

  /**
   * Send a message and await a correlated response. When disconnected,
   * the request is held in an in-memory queue for RECONNECT_GRACE_MS
   * to let a watchdog-driven engine respawn complete silently. Only
   * after that grace period do we reject with a soft-fail error that
   * upstream retry loops recognise.
   */
  request<T extends BridgeMessage = BridgeMessage>(
    msg: Partial<BridgeMessage> & { type: string },
    timeoutOrOptions: number | RequestOptions = 5000,
  ): Promise<T> {
    const opts = normalizeRequestOptions(timeoutOrOptions);
    // Happy path — transport ready (local socket or relay channel), go now.
    if (this.isOpen() && (this.connectionTarget.kind === "local" || CLOUD_CONTROL_REQUESTS.has(msg.type) ||
        (this.pendingRequests.size < CLOUD_RPC_IN_FLIGHT && !this.queuedRequests.length))) {
      return this.sendRequest<T>(msg, opts.timeoutMs, opts.signal);
    }
    if (opts.signal?.aborted) {
      return Promise.reject(makeRequestAbortError(msg.type));
    }

    // Disconnected: queue under the grace window. A connection attempt
    // is already running (onclose → scheduleReconnect), so we just
    // wait for onopen → flushQueue() to pick this up.

    // Dedup by (type, sessionId). For idempotent
    // requests like AGENT_LOAD_SESSION targeting the same session, the
    // newer call supersedes any older queued copy: chat-view mount
    // effects and chat-switch storms used to stack 5× the same call.
    // Drop older copies with a "superseded" reject so upstream retry
    // loops can decide what to do.
    this.dedupSupersededInQueue(msg);

    // Per-type cap — for message types that can balloon under
    // a sustained disconnect, drop the oldest of that type rather than
    // overflowing the global cap and rejecting unrelated traffic.
    const typeCap = PER_TYPE_QUEUE_CAP[msg.type];
    if (typeCap !== undefined) {
      const sameType = this.queuedRequests.filter(
        (q) => q.msg.type === msg.type,
      );
      if (sameType.length >= typeCap) {
        const oldest = sameType[0];
        oldest.reject(new Error(`Queued ${msg.type} dropped (per-type cap)`));
        const idx = this.queuedRequests.indexOf(oldest);
        if (idx >= 0) this.queuedRequests.splice(idx, 1);
      }
    }

    if (this.queuedRequests.length >= MAX_QUEUED_REQUESTS) {
      this.cloudDiagnostic("request_failed", { ...requestDiagnostic(msg), class: "queue_full" });
      return Promise.reject(
        new Error(`Request timeout: ${msg.type} (queue full)`),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const q: QueuedRequest = {
        msg,
        timeoutMs: opts.timeoutMs,
        resolve: (m) => {
          cleanup();
          resolve(m as T);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
        signal: opts.signal,
        deadline: Date.now() + RECONNECT_GRACE_MS,
      };
      function cleanup() {
        if (q.signal && q.onAbort) {
          q.signal.removeEventListener("abort", q.onAbort);
          q.onAbort = undefined;
        }
      }
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(makeRequestAbortError(msg.type));
          return;
        }
        q.onAbort = () => {
          const idx = this.queuedRequests.indexOf(q);
          if (idx >= 0) this.queuedRequests.splice(idx, 1);
          q.reject(makeRequestAbortError(msg.type));
        };
        opts.signal.addEventListener("abort", q.onAbort, { once: true });
      }
      this.queuedRequests.push(q);
      // Kick off a best-effort connect if somehow no reconnect is
      // scheduled yet (e.g. first request before connect() ever ran).
      if (!this.reconnectTimer && !this._disposed) {
        void this.connect();
      }
    });
  }

  /** Reject any queued request that the incoming message supersedes.
   *  Two queued requests with the same `type` AND same `sessionId`/
   *  `chatId` are by definition redundant — the newer one carries the
   *  newer caller's intent. Older copies surface as "superseded" so
   *  upstream callers know they've been replaced rather than vanishing. */
  private dedupSupersededInQueue(
    incoming: Partial<BridgeMessage> & { type: string },
  ): void {
    const inSession = (incoming as Record<string, unknown>).sessionId as
      | string
      | undefined;
    const inChat = (incoming as Record<string, unknown>).chatId as
      | string
      | undefined;
    // Only dedup when there's *some* identity key — a bare type match
    // would over-collapse legitimate distinct calls.
    if (!inSession && !inChat) return;
    const before = this.queuedRequests.length;
    this.queuedRequests = this.queuedRequests.filter((q) => {
      if (q.msg.type !== incoming.type) return true;
      const qSession = (q.msg as Record<string, unknown>).sessionId as
        | string
        | undefined;
      const qChat = (q.msg as Record<string, unknown>).chatId as
        | string
        | undefined;
      const sameKey =
        (inSession && qSession === inSession) || (inChat && qChat === inChat);
      if (!sameKey) return true;
      q.reject(new Error(`${q.msg.type} superseded by newer queued copy`));
      return false;
    });
    void before; // helper for future logging if we need to see hit-rate
  }

  /** Subscribe to a specific message type. Returns an unsubscribe function. */
  on(type: string, handler: (msg: BridgeMessage) => void): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /** Subscribe to connection status changes. */
  onStatusChange(cb: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  /** Drop the current connection and reconnect, re-resolving the
   *  engine port. Used by the in-place project swap when Electron
   *  respawns the engine on a fresh port. The client object survives
   *  (consumer hooks keep their ref) — only the underlying socket and
   *  in-flight state are reset. Pending RPCs and queued requests are
   *  rejected immediately so callers don't wait on a server that no
   *  longer knows about them. */
  async forceReconnect(
    options: { refreshCloudTarget?: boolean } = {},
  ): Promise<void> {
    if (this._disposed) return;
    this.clearDirectReadyTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (
      this.connectionTarget.kind === "cloud" &&
      options.refreshCloudTarget !== false
    ) {
      this.cloudTargetNeedsRefresh = true;
    }
    // Reject anything in flight — those request ids are bound to a
    // server process that's about to die. Soft-fail so upstream retry
    // loops can decide to resend; we don't requeue silently because
    // the new engine is a different process entirely.
    //
    // Tag with `code: "ENGINE_SWAPPING"` so failure.ts can identify
    // these without relying solely on message-string matching. The
    // string itself is still matched by TRANSPORT_RX as a defense-in-
    // depth fallback.
    const makeSwapError = (): Error & { code?: string } => {
      const e = new Error("Engine swapping — request aborted") as Error & {
        code?: string;
      };
      e.code = "ENGINE_SWAPPING";
      return e;
    };
    for (const [, pending] of this.pendingRequests) {
      clearPendingRequest(pending);
      pending.reject(makeSwapError());
    }
    this.pendingRequests.clear();
    for (const q of this.queuedRequests) {
      q.reject(makeSwapError());
    }
    this.queuedRequests = [];
    // Close any live or pending socket. Closing flips us to
    // "disconnected" via onclose, but we set it explicitly here to
    // cover the (rare) case where neither socket fires the event.
    const retiredSocket = this.ws, retiredPending = this.pendingWs;
    this.ws = null;
    this.pendingWs = null;
    try { retiredSocket?.close(); } catch { /* already dead */ }
    try { retiredPending?.close(); } catch { /* already dead */ }
    this._engineConnected = false;
    this.handshakeReady = false;
    this.setStatus("disconnected");
    invalidateEnginePort();
    invalidateEngineToken();
    // Kick the reconnect immediately rather than going through the
    // backoff ladder — the user just clicked "Open Workspace" and is
    // actively waiting for the new engine.
    await this.connect();
  }

  dispose(): void {
    this._disposed = true;
    this.clearDirectReadyTimer();
    for (const finish of this.readyWaiters) finish(new Error("Client disposed"));
    if (this.connectionTargetExpiryTimer) {
      clearTimeout(this.connectionTargetExpiryTimer);
      this.connectionTargetExpiryTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, pending] of this.pendingRequests) {
      clearPendingRequest(pending);
      pending.reject(new Error("Client disposed"));
    }
    this.pendingRequests.clear();
    for (const q of this.queuedRequests) {
      q.reject(new Error("Client disposed"));
    }
    this.queuedRequests = [];
    this.handlers.clear();
    this.statusListeners.clear();
    this.connectionTargetExpiryListeners.clear();
    this.executionIdentityListeners.clear();
    // Close BOTH the active socket and any in-flight pending one — an
    // un-disposed pendingWs would keep its TCP connection to the engine
    // open even though this client is gone, and on next mount the new
    // client would see itself as the 2nd connection.
    try {
      this.ws?.close();
    } catch {
      /* already dead */
    }
    try {
      this.pendingWs?.close();
    } catch {
      /* already dead */
    }
    this.ws = null;
    this.pendingWs = null;
  }

  // ── Internals ───────────────────────────────────────────

  private diagnosticScope(): CloudDiagnosticScope | undefined {
    const target = this.connectionTarget;
    return target.kind === "cloud" ? { workspaceId: target.workspaceId, generation: target.generation,
      connectionSequence: target.connectionSequence, channel: target.channel } : undefined;
  }
  private cloudDiagnostic(event: CloudDiagnosticEvent, data: Record<string, string | number | null | undefined>,
    scope = this.diagnosticScope()): void {
    if (!scope) return;
    const now = performance.now();
    if (now - this.diagnostics.at >= 60_000) {
      this.diagnostics.at = now;
      for (const key of Object.keys(this.diagnostics.counts) as CloudDiagnosticEvent[]) this.diagnostics.counts[key] = 0;
    }
    if (this.diagnostics.counts[event]++ >= 8) { this.diagnostics.suppressed++; return; }
    console.warn("[Zeros cloud bridge] " + JSON.stringify({ event, ...scope, ...data, suppressed: this.diagnostics.suppressed }));
    this.diagnostics.suppressed = 0;
  }

  /** True when the local socket is ready to send. */
  private isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.handshakeReady;
  }

  /** Send a pre-built envelope over the local socket as JSON text. */
  private rawSend(envelope: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(envelope));
    }
  }

  /** Shared post-connect handling for both transports: mark connected, reset
   *  backoff, announce ourselves, and flush the disconnect queue. */
  private onTransportOpen(): void {
    this.handshakeReady = false;
    this.activatedCloudBinding = null;
    this.finishCloudHandshake = null;
    // A successful transport open clears any prior terminal rejection.
    this._rejected = false;
    this.lastRejection = null;

    // Announce ourselves. Attach the current access token (when signed
    // in) so the engine can bind the connection to an account:
    //   • LOCAL (desktop renderer): the token ESTABLISHES the engine's owner
    //     account (the account signed into this Mac). Local clients are never
    //     gated; this just records who owns the desktop.
    //   • CLOUD: the control plane already admitted the exact account and
    //     authority epoch, so no reusable account bearer crosses into sandbox.
    // Read synchronously from the auth bridge (AuthProvider keeps it fresh).
    // Local sidecars use the desktop session to seed their owner binding. A
    // cloud engine was already admitted through the control plane and must
    // never receive the reusable WorkOS bearer inside its sandbox.
    const authToken =
      this.connectionTarget.kind === "local" ? getAuthAccessToken() : "";
    this.rawSend({
      id: createMessageId(), timestamp: Date.now(),
      type: "CONNECTED",
      source: "browser",
      capabilities: ["element-select"],
      protocolVersion: PROTOCOL_VERSION,
      ...(authToken ? { authToken } : {}),
    });

    const socket = this.ws;
    let actorConfirmed = false;
    const ready = () => {
      if (!actorConfirmed || cloudRuntimeBootScope(this.connectionTarget) && !this.activatedCloudBinding) return;
      if (this._disposed || this.ws !== socket || socket?.readyState !== WebSocket.OPEN || this._rejected) return;
      this.handshakeReady = true;
      this.clearDirectReadyTimer();
      this.cloudConnectFailures = 0;
      this._engineConnected = true;
      this.reconnectAttempts = 0;
      this.cloudDiagnostic("ready", {});
      // Make room for synchronous status-listener RPCs even when the
      // disconnect queue was full. The concurrency bound still applies.
      if (this.connectionTarget.kind === "cloud") this.flushQueue();
      this.setStatus("connected");
      this.flushQueue();
    };
    if (this.connectionTarget.kind === "local") { actorConfirmed = true; ready(); return; }
    this.finishCloudHandshake = ready;

    // Existing engines announce ENGINE_READY before authenticating CONNECTED.
    // One harmless read proves that their CONNECTED handler has settled. Keep
    // application requests queued until then, so a 256-request reconnect and
    // synchronous connected listeners cannot overflow the 64-frame auth queue.
    void this.sendRequest({ type: "WORKSPACE_REQUEST", op: "workspace.list", params: {} }, 10_000)
      .then(response => {
        if (response.type !== "WORKSPACE_RESPONSE") throw new Error("Cloud handshake read failed");
        actorConfirmed = true;
        ready();
      }).catch(() => {
        if (this.ws === socket) socket?.close(1000, "cloud handshake failed");
      });
  }

  /** Shared inbound-message handling for both transports. The local socket
   *  passes a parsed object; the relay channel delivers an already-decrypted
   *  app message object. */
  private handleIncoming(msg: BridgeMessage): void {
    if (msg.type === "ENGINE_READY") {
      const wire = msg as unknown as { capabilities?: unknown; cloudLocalCommands?: unknown };
      const capabilities = new Set(Array.isArray(wire.capabilities) && wire.capabilities.length <= 64
        ? wire.capabilities.filter((value): value is string => typeof value === "string" && value.length <= 128) : []);
      const target = this.connectionTarget;
      const scope = cloudRuntimeBootScope(target);
      if (target.kind === "cloud" && scope) {
        const parsed = CloudAgentBootConversationSchema.safeParse(wire.cloudLocalCommands);
        if (!capabilities.has("cloud.localCommands.v1") || !parsed.success) {
          this.rejectCloudConnection(new CloudRuntimeAccessError({ code: "cloud_workspace_client_update_required", status: 409 }));
          this.ws?.close(); return;
        }
        if (parsed.data.authorityEpoch !== target.authorityEpoch ||
            Object.entries(scope).some(([key, value]) => parsed.data[key as keyof CloudAgentBootConversation] !== value)) {
          this.rejectCloudConnection(new CloudRuntimeAccessError({ code: "cloud_workspace_access_superseded", status: 409 }));
          this.ws?.close(); return;
        }
        this.activatedCloudBinding = Object.freeze({ ...parsed.data,
          initialAdoptions: Object.freeze(parsed.data.initialAdoptions.map(value => Object.freeze(value))) }) as CloudAgentBootConversation;
      } else if (target.kind === "cloud") {
        // A legacy admission never silently adopts a grant-free boot mode.
        capabilities.delete("cloud.localCommands.v1");
      }
      this.engineCapabilities = capabilities;
      this.finishCloudHandshake?.();
    }
    // ENGINE_READY confirms the engine is fully initialized.
    if (msg.type === "ENGINE_READY" && (this.connectionTarget.kind === "local" || this.handshakeReady)) {
      this._engineConnected = true;
    }

    // Engine REFUSED the connection — protocol skew or account-binding. Stop the
    // blind reconnect loop (a retry with the same client/token would just be
    // rejected again) and surface it so the UI can act: prompt an app update
    // (protocol-*) or a token refresh / re-login (auth-*). BridgeProvider
    // (use-bridge.tsx) is the consumer: it shows reason-specific toast copy and
    // calls clearRejection() once there is a path forward (a watchdog engine
    // respawn for the retryable reasons, a fresh token for the auth ones).
    if (msg.type === "CONNECTION_REJECTED") {
      const m = msg as { reason?: string; message?: string };
      this._rejected = true;
      this.clearDirectReadyTimer();
      this.lastRejection = {
        reason: m.reason ?? "unknown",
        message: m.message ?? "",
      };
      this.cloudDiagnostic("rejection", { class: ["auth-required", "auth-invalid", "auth-wrong-account", "desktop-unbound",
        "protocol-too-old", "protocol-too-new"].includes(m.reason ?? "") ? m.reason : "other" });
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.setStatus("disconnected");
      for (const cb of this.rejectionListeners) cb(this.lastRejection);
      return;
    }

    // Resolve pending request-response.
    const requestId =
      "requestId" in msg
        ? (msg as { requestId?: string }).requestId
        : undefined;
    if (requestId && this.pendingRequests.has(requestId)) {
      const pending = this.pendingRequests.get(requestId)!;
      clearPendingRequest(pending);
      this.pendingRequests.delete(requestId);
      queueMicrotask(() => this.flushQueue());
      // Correlated protocol envelopes resolve intact. Their owning façade
      // classifies domain errors: workspaceOp turns WORKSPACE_ERROR into a
      // structured error with code + remediation, while the agent façade reads
      // its failure.kind. Rejecting here used to erase that metadata and left
      // target-branch failures as an unhelpful message-only toast.
      pending.resolve(msg);
    }

    // Notify type-based listeners.
    const listeners = this.handlers.get(msg.type);
    if (listeners) {
      for (const handler of listeners) handler(msg);
    }
  }

  /** Shared disconnect handling for both transports: flip to disconnected,
   *  reject in-flight RPCs (soft-fail), schedule a reconnect, expire the
   *  queue. The caller has already cleared its transport slot. */
  private afterDisconnect(): void {
    this.clearDirectReadyTimer();
    this.handshakeReady = false;
    this.setStatus("disconnected");
    this._engineConnected = false;
    const now = Date.now();
    // In-flight requests after a disconnect can't be replayed safely (the
    // server lost our request id); reject with the soft-fail shape so the
    // sessions-provider retry loop re-sends at the application level.
    this.rejectInFlightSoftFail();
    if (this.connectionTarget.kind === "cloud") {
      this.cloudTargetNeedsRefresh = true;
    }
    this.scheduleReconnect();
    // Reject any queue entries whose deadlines have elapsed.
    this.expireQueue(now);
  }

  private sendRequest<T extends BridgeMessage>(
    msg: Partial<BridgeMessage> & { type: string },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(makeRequestAbortError(msg.type));
    }
    return new Promise<T>((resolve, reject) => {
      const id = createMessageId();
      const pending: PendingRequest = {
        resolve: resolve as (msg: BridgeMessage) => void,
        reject,
        timer: null,
        signal,
        diagnostic: requestDiagnostic(msg), scope: this.diagnosticScope(), startedAt: performance.now(),
      };
      const rejectPending = (err: Error) => {
        clearPendingRequest(pending);
        this.pendingRequests.delete(id);
        queueMicrotask(() => this.flushQueue());
        reject(err);
      };

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timer = window.setTimeout(() => {
          this.cloudDiagnostic("request_failed", { ...pending.diagnostic, class: "timeout",
            elapsedMs: Math.round(performance.now() - pending.startedAt) }, pending.scope);
          rejectPending(new Error(`Request timeout: ${msg.type}`));
        }, timeoutMs);
      }
      if (signal) {
        pending.onAbort = () => {
          rejectPending(makeRequestAbortError(msg.type));
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }

      this.pendingRequests.set(id, pending);
      this.rawSend({ source: "browser", timestamp: Date.now(), ...msg, id });
    });
  }

  private flushQueue(): void {
    if (!this.isOpen() || !this.queuedRequests.length) return;
    const now = Date.now();
    const pending = this.queuedRequests;
    this.queuedRequests = [];
    for (const q of pending) {
      if (q.deadline <= now) {
        this.cloudDiagnostic("request_failed", { ...requestDiagnostic(q.msg), class: "queue_expired" });
        q.reject(new Error(`Request timeout: ${q.msg.type} (reconnecting)`));
        continue;
      }
      if (this.connectionTarget.kind === "cloud" && this.pendingRequests.size >= CLOUD_RPC_IN_FLIGHT &&
          !CLOUD_CONTROL_REQUESTS.has(q.msg.type)) {
        this.queuedRequests.push(q);
        continue;
      }
      // Re-enter through sendRequest so the new request gets a fresh id
      // and lands in pendingRequests.
      if (q.signal && q.onAbort) {
        q.signal.removeEventListener("abort", q.onAbort);
        q.onAbort = undefined;
      }
      this.sendRequest(q.msg, q.timeoutMs, q.signal)
        .then(q.resolve)
        .catch(q.reject);
    }
  }

  private expireQueue(now: number): void {
    if (!this.queuedRequests.length) return;
    const keep: QueuedRequest[] = [];
    for (const q of this.queuedRequests) {
      if (q.deadline <= now) {
        this.cloudDiagnostic("request_failed", { ...requestDiagnostic(q.msg), class: "queue_expired" });
        q.reject(new Error(`Request timeout: ${q.msg.type} (reconnecting)`));
      } else {
        keep.push(q);
      }
    }
    this.queuedRequests = keep;
  }

  private rejectInFlightSoftFail(): void {
    // Called from onclose. Any request that was already on the wire
    // when the socket dropped — we can't replay safely (response id
    // is lost), so we reject with the soft-fail shape. Upstream retry
    // loops (sessions-provider.ensureSession) recognise this and back
    // off silently.
    for (const [id, pending] of this.pendingRequests) {
      this.cloudDiagnostic("request_failed", { ...pending.diagnostic, class: "disconnected",
        elapsedMs: Math.round(performance.now() - pending.startedAt) }, pending.scope);
      clearPendingRequest(pending);
      pending.reject(new Error("Request timeout: engine disconnected"));
      this.pendingRequests.delete(id);
    }
  }

  private setStatus(status: ConnectionStatus) {
    this._status = status;
    if (status === "disconnected") this.engineCapabilities.clear();
    for (const cb of this.statusListeners) cb(status);
  }

  /** Subscribe to terminal connection rejections (protocol skew / account
   *  binding). Returns an unsubscribe. The recovery layer (BridgeProvider in
   *  use-bridge.tsx) uses this to surface reason-specific toast copy. */
  onConnectionRejected(cb: (r: ConnectionRejection) => void): () => void {
    this.rejectionListeners.add(cb);
    // Replay the latest rejection to a late subscriber so it isn't missed.
    if (this.lastRejection) cb(this.lastRejection);
    return () => {
      this.rejectionListeners.delete(cb);
    };
  }

  /** Clear a terminal rejection — call after resolving the cause (a refreshed
   *  token / re-login / app update / engine respawn). Reconnects immediately by
   *  default; pass `{ reconnect: false }` when the caller drives its own
   *  reconnect (e.g. forceReconnect() after an `engine-restarted` respawn —
   *  a second concurrent connect() here would race it and could latch onto the
   *  STALE cached port before forceReconnect invalidates it). No-op if not
   *  rejected. */
  clearRejection(opts: { reconnect?: boolean } = {}): void {
    if (!this._rejected) return;
    this._rejected = false;
    this.lastRejection = null;
    this.reconnectAttempts = 0;
    this.cloudRefreshFailures = 0;
    this.cloudConnectFailures = 0;
    if (opts.reconnect === false) return;
    void this.connect().catch(() => {
      /* scheduleReconnect handles retries */
    });
  }

  private scheduleReconnect() {
    if (this._disposed) return;
    if (
      this.connectionTarget.kind === "cloud" &&
      this.connectionTarget.expiresAt <= Date.now() &&
      !this.cloudTargetNeedsRefresh
    ) {
      this.expireConnectionTarget(this.connectionTargetEpoch);
      return;
    }
    if (
      this.connectionTarget.kind === "cloud" &&
      this.cloudTargetNeedsRefresh &&
      !this.refreshCloudConnectionTarget
    ) {
      return;
    }
    // Engine refused us — don't hammer it; wait for clearRejection() to retry.
    if (this._rejected) return;
    if (this.reconnectTimer) return;
    const delay =
      RECONNECT_LADDER[
        Math.min(this.reconnectAttempts, RECONNECT_LADDER.length - 1)
      ];
    this.reconnectAttempts += 1;
    this.cloudDiagnostic("reconnect", { attempt: this.reconnectAttempts, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        if (this.connectionTarget.kind === "cloud") this.cloudDiagnostic("connect", { class: "failed" });
        else console.warn("[Zeros] reconnect failed:", err);
      });
    }, delay);
  }

  private armConnectionTargetExpiry(): void {
    this.clearDirectReadyTimer();
    this.connectionTargetEpoch += 1;
    this.expiredConnectionTargetEpoch = -1;
    if (this.connectionTargetExpiryTimer) {
      clearTimeout(this.connectionTargetExpiryTimer);
      this.connectionTargetExpiryTimer = null;
    }
    if (this.connectionTarget.kind !== "cloud") return;
    const epoch = this.connectionTargetEpoch;
    const delay = Math.max(0, this.connectionTarget.expiresAt - Date.now());
    this.connectionTargetExpiryTimer = setTimeout(
      () => this.expireConnectionTarget(epoch),
      delay,
    );
  }

  private expireConnectionTarget(epoch: number): void {
    if (
      this._disposed ||
      epoch !== this.connectionTargetEpoch ||
      this.expiredConnectionTargetEpoch === epoch ||
      this.connectionTarget.kind !== "cloud" ||
      this.connectionTarget.expiresAt > Date.now()
    ) {
      return;
    }
    this.expiredConnectionTargetEpoch = epoch;
    if (this.connectionTargetExpiryTimer) {
      clearTimeout(this.connectionTargetExpiryTimer);
      this.connectionTargetExpiryTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const activeSocket = this.ws;
    const pendingSocket = this.pendingWs;
    this.ws = null;
    this.pendingWs = null;
    try {
      activeSocket?.close();
    } catch {
      /* already dead */
    }
    try {
      pendingSocket?.close();
    } catch {
      /* already dead */
    }
    this.rejectInFlightSoftFail();
    this.cloudTargetNeedsRefresh = true;
    this._engineConnected = false;
    this.setStatus("disconnected");
    const event: ConnectionTargetExpiredEvent = {
      kind: "cloud",
      expiresAt: this.connectionTarget.expiresAt,
    };
    for (const listener of this.connectionTargetExpiryListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(
          "[Zeros] cloud connection expiry listener failed:",
          error,
        );
      }
    }
    this.scheduleReconnect();
  }

  private refreshCurrentCloudTarget(): Promise<boolean> {
    if (this.cloudTargetRefreshPromise) return this.cloudTargetRefreshPromise;
    const current = this.connectionTarget;
    const refresh = this.refreshCloudConnectionTarget;
    if (current.kind !== "cloud" || !refresh) return Promise.resolve(false);
    const epoch = this.connectionTargetEpoch;
    this.cloudTargetRefreshPromise = (async () => {
      try {
        const candidate = parseRuntimeConnectionTarget(await refresh(current));
        assertCloudRuntimeNotRetired(candidate);
        const previousBoot = cloudRuntimeBootScope(current), nextBoot = cloudRuntimeBootScope(candidate);
        if (
          candidate.kind !== "cloud" ||
          candidate.runtimeId !== current.runtimeId ||
          candidate.organizationId !== current.organizationId ||
          candidate.workspaceId !== current.workspaceId ||
          candidate.connectionSequence !== current.connectionSequence + 1 ||
          previousBoot && (candidate.authorityEpoch !== current.authorityEpoch || !nextBoot ||
            Object.entries(previousBoot).some(([key, value]) => nextBoot[key as keyof CloudAgentBootScope] !== value) ||
            candidate.cloudToken === current.cloudToken)
        ) {
          throw new CloudRuntimeAccessError({ code: "cloud_workspace_access_superseded", status: 409 });
        }
        if (
          this._disposed ||
          epoch !== this.connectionTargetEpoch ||
          this.connectionTarget !== current
        ) {
          return true;
        }
        const previousKey = runtimeExecutionKey(this.executionIdentity);
        this.connectionTarget = candidate;
        this.cloudTargetNeedsRefresh = false;
        this.cloudRefreshFailures = 0;
        this.armConnectionTargetExpiry();
        if (runtimeExecutionKey(this.executionIdentity) !== previousKey) {
          this.notifyExecutionIdentityChanged();
        }
        return true;
      } catch (error) {
        if (this._disposed || epoch !== this.connectionTargetEpoch || this.connectionTarget !== current) return false;
        const failure = new CloudRuntimeAccessError(error);
        this.cloudRefreshFailures++;
        if (failure.category !== "transient" || this.cloudRefreshFailures >= 5) {
          this.rejectCloudConnection(failure);
        }
        return false;
      } finally {
        this.cloudTargetRefreshPromise = null;
      }
    })();
    return this.cloudTargetRefreshPromise;
  }
  private rejectCloudConnection(failure: CloudRuntimeAccessError): void {
    this._rejected = true;
    this.clearDirectReadyTimer();
    this.lastRejection = { reason: `cloud-${failure.category}`, message: failure.message, code: failure.code };
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.setStatus("disconnected");
    for (const listener of this.rejectionListeners) listener(this.lastRejection);
  }

  private clearDirectReadyTimer(): void {
    if (this.directReadyTimer) clearTimeout(this.directReadyTimer);
    this.directReadyTimer = null;
  }
}
