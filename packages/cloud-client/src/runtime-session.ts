// SDK runtime session (S3 Part 3): the connect race over the direct and relay
// routes, the zeros-cap.v1 auth handshake with proof-of-possession (S1), and
// in-band capability renewal. Platform-neutral: Electron main and the renderer
// both import this module, so it uses only web-standard globals.

import type { Capabilities, ConnectResponse, Route } from "./generated/rest";
import type { ClientAuth, ClientAuthRenew, Proof } from "./generated/runtime-auth";
import { isRuntimeHandshakeFrame, parseRuntimeAuthFrame } from "./runtime-auth";
import { readRuntimeBinding, type RuntimeBindingTarget } from "./runtime-binding";

export const RUNTIME_SUBPROTOCOL = "zeros-cap.v1";
export const RUNTIME_LEGACY_SUBPROTOCOL = "zeros-v1";
export const RUNTIME_AUTH_CONTRACT = 1;
/** S3 Part 3: the server closes 4401 when `auth` has not arrived 10 s after the
 * upgrade; the client waits as long for `auth.ok`. */
export const RUNTIME_AUTH_TIMEOUT_MS = 10_000;
/** An attempt whose socket has not opened by then fails with `connect_timeout`. */
export const RUNTIME_CONNECT_TIMEOUT_MS = 10_000;
export const RUNTIME_RENEW_TIMEOUT_MS = 10_000;
/** S3 runtime connect: `relayHedgeMs` is clamped to 300-500 ms. */
export const RUNTIME_RELAY_HEDGE_MIN_MS = 300;
export const RUNTIME_RELAY_HEDGE_MAX_MS = 500;
export const CAPABILITY_POP_DOMAIN = "zeros-cap-pop-v1";

/** Used when `relayHedgeMs` is not a finite number. */
const RELAY_HEDGE_DEFAULT_MS = 400;
/** Engine messages held for the first listener; the next one closes the connection. */
const MAX_QUEUED_MESSAGES = 256;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/;

export type RuntimeRouteKind = "direct" | "relay";

export interface RuntimeSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}
export interface RuntimeSocketHandlers {
  /** `protocol` is the subprotocol the server selected ("" when none). */
  open(protocol: string): void;
  message(text: string): void;
  close(code: number, reason: string): void;
}
/** Opens a WebSocket offering `protocols`. Adapters deliver text messages only
 * and call the handlers asynchronously (never from inside the factory call). */
export type RuntimeSocketFactory = (
  url: string,
  protocols: readonly string[],
  handlers: RuntimeSocketHandlers,
) => RuntimeSocket;

export type CapabilityProofFields = Readonly<{
  aud: string; wsp: string; jti: string; timestampMs: number; nonce: string; route: RuntimeRouteKind;
}>;

export interface RuntimeSessionOptions {
  /** Lowercase UUID naming this client's runtime session (S3). */
  clientSessionId: string;
  /** The request's exact target, supplied by the host's admission boundary. */
  target?: RuntimeBindingTarget;
  /** Cancels pending route attempts. Once connected, the owner closes the
   * returned RuntimeConnection; the race removes its signal listener. */
  signal?: AbortSignal;
  createSocket: RuntimeSocketFactory;
  /** Ed25519 signature with the device key over the UTF-8 bytes of `message`,
   * base64url without padding (86 characters). */
  signProof: (message: string) => Promise<string>;
  /** 16 random bytes, base64url without padding (22 characters). */
  nonce?: () => string;
  now?: () => number;
}

export type RuntimeAttemptFailure = Readonly<{
  route: RuntimeRouteKind;
  /** The WebSocket close code, or null when the attempt never got one. */
  closeCode: number | null;
  reason: string;
}>;

export type RuntimeConnectResult =
  | { kind: "connected"; connection: RuntimeConnection }
  /** A route's server selected `zeros-v1`: it does not speak this contract;
   * the caller uses the legacy admission for this workspace. */
  | { kind: "legacy"; route: RuntimeRouteKind };

type CapabilityClaims = { aud: string; wsp: string; jti: string; exp: number; iat?: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToText(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (char) =>
    char.charCodeAt(0),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The parsed JSON value, or undefined for text that is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function capabilityProofMessage(fields: CapabilityProofFields): string {
  return [
    CAPABILITY_POP_DOMAIN,
    fields.aud,
    fields.wsp,
    fields.jti,
    String(fields.timestampMs),
    fields.nonce,
    fields.route,
  ].join("\n");
}

/** Unverified read of a capability's claims. The control plane verifies the
 * token; the client only needs the audience, workspace and jti to sign for it. */
export function decodeCapabilityClaims(token: string): CapabilityClaims | null {
  try {
    const payload = COMPACT_JWS_PATTERN.exec(token)?.[1];
    if (payload === undefined) return null;
    const claims: unknown = JSON.parse(base64urlToText(payload));
    if (!isRecord(claims)) return null;
    const { aud, wsp, jti, exp, iat } = claims;
    if (typeof aud !== "string" || typeof wsp !== "string" || typeof jti !== "string") return null;
    if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return null;
    // A missing or non-integer iat is left out; it never makes the claims unusable.
    if (typeof iat === "number" && Number.isSafeInteger(iat)) return { aud, wsp, jti, exp, iat };
    return { aud, wsp, jti, exp };
  } catch {
    return null;
  }
}

export function defaultNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export function relayHedgeDelayMs(value: number): number {
  if (!Number.isFinite(value)) return RELAY_HEDGE_DEFAULT_MS;
  return Math.min(RUNTIME_RELAY_HEDGE_MAX_MS, Math.max(RUNTIME_RELAY_HEDGE_MIN_MS, value));
}

export class RuntimeConnectError extends Error {
  constructor(readonly code: string, readonly failures: readonly RuntimeAttemptFailure[]) {
    super(`Runtime connect failed: ${code}`);
    this.name = "RuntimeConnectError";
  }
}

/** Races the routes of a workspace and resolves with the first authenticated
 * connection, the legacy admission, or a RuntimeConnectError. */
export function connectRuntime(
  connect: ConnectResponse,
  options: RuntimeSessionOptions,
): Promise<RuntimeConnectResult> {
  if (!UUID_PATTERN.test(options.clientSessionId)) {
    throw new TypeError("clientSessionId must be a lowercase UUID");
  }
  try { readRuntimeBinding(connect, options.target); }
  catch { return Promise.reject(new RuntimeConnectError("runtime_binding_invalid", [])); }
  const routes = routesToTry(connect.routes);
  if (routes.length === 0) {
    return Promise.reject(new RuntimeConnectError("runtime_unreachable", []));
  }
  return new Promise<RuntimeConnectResult>((resolve, reject) => {
    const race = new RouteRace(connect, options, routes, resolve, reject);
    race.start();
  });
}

/** The first route of each kind, by ascending priority (the sort is stable). */
function routesToTry(routes: readonly Route[]): Route[] {
  const picked: Route[] = [];
  for (const route of [...routes].sort((a, b) => a.priority - b.priority)) {
    if (!picked.some((existing) => existing.kind === route.kind)) picked.push(route);
  }
  return picked;
}

/** An established runtime connection. Only connectRuntime constructs one. */
export class RuntimeConnection {
  readonly route: RuntimeRouteKind;
  readonly sessionId: string;
  readonly scopes: readonly string[];
  private expiresAt: number;
  private isClosed = false;
  private closeRecord: { code: number; reason: string } | undefined;
  private readonly socket: RuntimeSocket;
  private readonly proofs: ProofSource;
  private readonly listeners = new Set<(text: string) => void>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();
  /** Engine messages received before the first listener; undefined once one is added. */
  private queued: string[] | undefined = [];
  private renewal: PendingRenewal | undefined;

  constructor(init: RuntimeConnectionInit) {
    this.route = init.route;
    this.sessionId = init.sessionId;
    this.scopes = init.scopes;
    this.expiresAt = init.expiresAtMs;
    this.socket = init.socket;
    this.proofs = init.proofs;
  }

  get expiresAtMs(): number {
    return this.expiresAt;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send(text: string): void {
    if (this.isClosed) throw new Error("runtime connection is closed");
    this.socket.send(text);
  }

  onMessage(listener: (text: string) => void): () => void {
    if (this.isClosed) return () => {};
    this.listeners.add(listener);
    const queued = this.queued;
    if (queued) {
      this.queued = undefined;
      for (const text of queued) { if (this.isClosed) break; listener(text); }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    const record = this.closeRecord;
    if (record) {
      let active = true;
      void Promise.resolve().then(() => {
        if (active) listener(record.code, record.reason);
      });
      return () => {
        active = false;
      };
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  renew(capabilities: Capabilities): Promise<number> {
    if (this.isClosed) return Promise.reject(new Error("runtime connection is closed"));
    if (this.renewal) return this.renewal.deferred.promise;
    const claims = decodeCapabilityClaims(capabilities.engine.token);
    if (!claims) return Promise.reject(new Error("capability_malformed"));
    const renewal: PendingRenewal = { deferred: deferred<number>() };
    this.renewal = renewal;
    void this.sendRenewal(renewal, capabilities.engine.token, claims);
    return renewal.deferred.promise;
  }

  close(code = 1000, reason = "client_closed"): void {
    if (this.isClosed) return;
    // Owner retirement is synchronous even if an adapter never delivers a
    // final close callback. It must settle renewal and release queued frames.
    this.socketClosed(code, reason);
    this.socket.close(code, reason);
  }

  /** @internal Handles one text message from the socket; connectRuntime calls it. */
  receive(text: string): void {
    if (this.isClosed) return;
    if (!isRuntimeHandshakeFrame(parseJson(text))) {
      this.deliver(text);
      return;
    }
    const expiresAtMs = parseRenewed(text);
    if (expiresAtMs === null) {
      this.close(4400, "unexpected_handshake_frame");
      return;
    }
    this.expiresAt = expiresAtMs;
    const renewal = this.renewal;
    if (renewal) {
      this.renewal = undefined;
      clearTimeout(renewal.timer);
      renewal.deferred.resolve(expiresAtMs);
    }
  }

  /** @internal Records the socket's close event; connectRuntime calls it. */
  socketClosed(code: number, reason: string): void {
    if (this.closeRecord) return;
    this.closeRecord = { code, reason };
    this.isClosed = true;
    this.queued = undefined;
    this.listeners.clear();
    const renewal = this.renewal;
    if (renewal) this.failRenewal(renewal, "runtime connection closed");
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) listener(code, reason);
  }

  private deliver(text: string): void {
    const queued = this.queued;
    if (!queued) {
      for (const listener of this.listeners) listener(text);
      return;
    }
    if (queued.length === MAX_QUEUED_MESSAGES) {
      // Not 1008: a browser WebSocket accepts only 1000 and 3000-4999 from a client.
      this.close(1000, "message_queue_full");
      return;
    }
    queued.push(text);
  }

  private async sendRenewal(renewal: PendingRenewal, token: string, claims: CapabilityClaims): Promise<void> {
    let proof: Proof;
    try {
      proof = await makeProof(this.proofs, claims, this.route);
    } catch {
      this.failRenewal(renewal, "proof_failed");
      return;
    }
    if (this.renewal !== renewal) return;
    if (this.isClosed) {
      this.failRenewal(renewal, "runtime connection is closed");
      return;
    }
    const frame: ClientAuthRenew = { t: "auth.renew", d: { capability: token, proof } };
    this.socket.send(JSON.stringify(frame));
    if (this.renewal === renewal)
      renewal.timer = setTimeout(() => this.failRenewal(renewal, "renew_timeout"), RUNTIME_RENEW_TIMEOUT_MS);
  }

  private failRenewal(renewal: PendingRenewal, message: string): void {
    if (this.renewal !== renewal) return;
    this.renewal = undefined;
    clearTimeout(renewal.timer);
    renewal.deferred.reject(new Error(message));
  }
}

interface RuntimeConnectionInit {
  route: RuntimeRouteKind;
  sessionId: string;
  scopes: readonly string[];
  expiresAtMs: number;
  socket: RuntimeSocket;
  proofs: ProofSource;
}

interface ProofSource {
  signProof: (message: string) => Promise<string>;
  now: () => number;
  nonce: () => string;
}

interface PendingRenewal {
  deferred: Deferred<number>;
  timer?: ReturnType<typeof setTimeout>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One proof for `claims` on `route`, with a fresh timestamp and nonce. */
async function makeProof(source: ProofSource, claims: CapabilityClaims, route: RuntimeRouteKind): Promise<Proof> {
  const timestampMs = source.now();
  const nonce = source.nonce();
  const message = capabilityProofMessage({
    aud: claims.aud,
    wsp: claims.wsp,
    jti: claims.jti,
    timestampMs,
    nonce,
    route,
  });
  return { timestampMs, nonce, signature: await source.signProof(message) };
}

interface AuthOk {
  sessionId: string;
  scopes: string[];
  expiresAtMs: number;
}

/** The fields of a valid auth.ok frame, or null for any other text. */
function parseAuthOk(text: string): AuthOk | null {
  const parsed = parseRuntimeAuthFrame(text);
  if (parsed.kind !== "known" || parsed.frame.t !== "auth.ok") return null;
  const d: unknown = parsed.frame.d;
  if (!isRecord(d) || !hasExactKeys(d, ["sessionId", "scopes", "expiresAtMs"])) return null;
  const { sessionId, scopes, expiresAtMs } = d;
  if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) return null;
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 32) return null;
  if (!scopes.every((scope) => typeof scope === "string" && scope.length >= 1 && scope.length <= 128)) {
    return null;
  }
  if (!isTimestamp(expiresAtMs)) return null;
  return { sessionId, scopes, expiresAtMs };
}

/** The expiry of a valid auth.renewed frame, or null for any other text. */
function parseRenewed(text: string): number | null {
  const parsed = parseRuntimeAuthFrame(text);
  if (parsed.kind !== "known" || parsed.frame.t !== "auth.renewed") return null;
  const d: unknown = parsed.frame.d;
  if (!isRecord(d) || !hasExactKeys(d, ["expiresAtMs"]) || !isTimestamp(d.expiresAtMs)) return null;
  return d.expiresAtMs;
}

function connectErrorCode(failures: readonly RuntimeAttemptFailure[]): string {
  const revoked = failures.find(
    (failure) => failure.closeCode === 4403 || failure.closeCode === 4426 || failure.closeCode === 4409,
  );
  if (revoked) return revoked.reason;
  const unauthorized = failures.find((failure) => failure.closeCode === 4401);
  return unauthorized ? unauthorized.reason : "runtime_unreachable";
}

type AttemptPhase = "connecting" | "authenticating" | "won" | "ended";

/** Stands in until the factory returns, and for an attempt whose socket could not be created. */
const UNOPENED_SOCKET: RuntimeSocket = { send: () => undefined, close: () => undefined };

interface Attempt {
  readonly route: RuntimeRouteKind;
  socket: RuntimeSocket;
  phase: AttemptPhase;
  /** The connect timer until the socket opens, then the auth timer. */
  timer?: ReturnType<typeof setTimeout>;
  failure?: RuntimeAttemptFailure;
  connection?: RuntimeConnection;
}

/** The state of one connectRuntime call. Attempts are indexed in route order, so
 * failures reach the caller in that order however the sockets complete. */
class RouteRace {
  private readonly attempts: Attempt[] = [];
  private readonly proofs: ProofSource;
  private settled = false;
  private hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly cancel = () => {
    if (this.settled) return;
    this.settled = true;
    this.detachSignal();
    clearTimeout(this.hedgeTimer);
    for (const attempt of this.attempts) {
      attempt.phase = "ended"; clearTimeout(attempt.timer);
      try { attempt.socket.close(1000, "cancelled"); } catch { /* retired regardless of adapter state */ }
    }
    this.reject(new RuntimeConnectError("runtime_cancelled", []));
  };

  constructor(
    private readonly connect: ConnectResponse,
    private readonly options: RuntimeSessionOptions,
    private readonly routes: readonly Route[],
    private readonly resolve: (result: RuntimeConnectResult) => void,
    private readonly reject: (error: RuntimeConnectError) => void,
  ) {
    this.proofs = {
      signProof: options.signProof,
      now: options.now ?? (() => Date.now()),
      nonce: options.nonce ?? defaultNonce,
    };
  }

  start(): void {
    if (this.options.signal?.aborted) { this.cancel(); return; }
    this.options.signal?.addEventListener("abort", this.cancel, { once: true });
    this.startAttempt(0);
    if (this.routes.length > 1 && !this.settled && this.attempts.length === 1) {
      this.hedgeTimer = setTimeout(() => this.startAttempt(1), relayHedgeDelayMs(this.connect.relayHedgeMs));
    }
  }

  private startAttempt(index: number): void {
    if (this.settled || index !== this.attempts.length || index >= this.routes.length) return;
    clearTimeout(this.hedgeTimer);
    const route = this.routes[index];
    const attempt: Attempt = { route: route.kind, socket: UNOPENED_SOCKET, phase: "connecting" };
    this.attempts.push(attempt);
    attempt.timer = setTimeout(() => {
      this.abort(attempt, 1000, "connect_timeout", { route: attempt.route, closeCode: null, reason: "connect_timeout" });
    }, RUNTIME_CONNECT_TIMEOUT_MS);
    try {
      attempt.socket = this.options.createSocket(route.url, [RUNTIME_SUBPROTOCOL, RUNTIME_LEGACY_SUBPROTOCOL], {
        open: (protocol) => this.onOpen(index, protocol),
        message: (text) => this.onMessage(index, text),
        close: (code, reason) => this.onClose(index, code, reason),
      });
      if (this.options.signal?.aborted) attempt.socket.close(1000, "cancelled");
    } catch {
      // For example a browser WebSocket refusing the URL.
      this.fail(attempt, { route: attempt.route, closeCode: null, reason: "socket_failed" });
    }
  }

  private onOpen(index: number, protocol: string): void {
    const attempt = this.attempts[index];
    if (attempt.phase !== "connecting") return;
    if (protocol === RUNTIME_LEGACY_SUBPROTOCOL) {
      this.legacy(attempt);
      return;
    }
    if (protocol !== RUNTIME_SUBPROTOCOL) {
      this.abort(attempt, 1000, "protocol_unsupported", {
        route: attempt.route,
        closeCode: null,
        reason: "protocol_unsupported",
      });
      return;
    }
    attempt.phase = "authenticating";
    clearTimeout(attempt.timer);
    attempt.timer = setTimeout(() => {
      this.abort(attempt, 1000, "auth_timeout", { route: attempt.route, closeCode: null, reason: "auth_timeout" });
    }, RUNTIME_AUTH_TIMEOUT_MS);
    void this.sendAuth(attempt);
  }

  private onMessage(index: number, text: string): void {
    const attempt = this.attempts[index];
    if (attempt.connection) {
      attempt.connection.receive(text);
      return;
    }
    if (attempt.phase !== "authenticating") return;
    const ok = parseAuthOk(text);
    if (ok) {
      this.win(attempt, ok);
      return;
    }
    this.abort(attempt, 4400, "unexpected_frame", {
      route: attempt.route,
      closeCode: 4400,
      reason: "unexpected_frame",
    });
  }

  private onClose(index: number, code: number, reason: string): void {
    const attempt = this.attempts[index];
    if (attempt.connection) {
      attempt.connection.socketClosed(code, reason);
      return;
    }
    if (attempt.phase === "connecting" || attempt.phase === "authenticating") {
      this.fail(attempt, { route: attempt.route, closeCode: code, reason: reason || "closed" });
    }
  }

  private async sendAuth(attempt: Attempt): Promise<void> {
    const built = await this.buildAuth(attempt.route);
    // settle() already closed a superseded attempt; a won or failed one must stay as it is.
    if (attempt.phase !== "authenticating") return;
    if (typeof built === "string") {
      this.abort(attempt, 1000, built, { route: attempt.route, closeCode: null, reason: built });
      return;
    }
    attempt.socket.send(JSON.stringify(built));
  }

  private async buildAuth(
    route: RuntimeRouteKind,
  ): Promise<ClientAuth | "capability_malformed" | "proof_failed"> {
    const { engine, realtime } = this.connect.capabilities;
    const engineClaims = decodeCapabilityClaims(engine.token);
    const routeClaims = route === "relay" ? decodeCapabilityClaims(realtime.token) : engineClaims;
    if (!engineClaims || !routeClaims) return "capability_malformed";
    const clientSessionId = this.options.clientSessionId;
    try {
      if (route === "direct") {
        const proof = await makeProof(this.proofs, engineClaims, "direct");
        return {
          t: "auth",
          d: { capability: engine.token, proof, clientSessionId, contract: RUNTIME_AUTH_CONTRACT },
        };
      }
      const realtimeProof = await makeProof(this.proofs, routeClaims, "relay");
      const engineProof = await makeProof(this.proofs, engineClaims, "relay");
      return {
        t: "auth",
        d: {
          capability: realtime.token,
          proof: realtimeProof,
          clientSessionId,
          contract: RUNTIME_AUTH_CONTRACT,
          engine: { capability: engine.token, proof: engineProof },
        },
      };
    } catch {
      return "proof_failed";
    }
  }

  private win(attempt: Attempt, ok: AuthOk): void {
    clearTimeout(attempt.timer);
    attempt.phase = "won";
    this.settle(attempt);
    attempt.connection = new RuntimeConnection({
      route: attempt.route,
      sessionId: ok.sessionId,
      scopes: ok.scopes,
      expiresAtMs: ok.expiresAtMs,
      socket: attempt.socket,
      proofs: this.proofs,
    });
    this.resolve({ kind: "connected", connection: attempt.connection });
  }

  private legacy(attempt: Attempt): void {
    clearTimeout(attempt.timer);
    attempt.phase = "ended";
    attempt.socket.close(1000, "legacy");
    if (this.settled) return;
    this.settle(attempt);
    this.resolve({ kind: "legacy", route: attempt.route });
  }

  /** Ends the race with `winner`: every other open attempt closes as superseded. */
  private settle(winner: Attempt): void {
    this.settled = true;
    this.detachSignal();
    clearTimeout(this.hedgeTimer);
    for (const other of this.attempts) {
      if (other === winner || other.phase === "won" || other.phase === "ended") continue;
      other.phase = "ended";
      clearTimeout(other.timer);
      other.socket.close(1000, "superseded");
    }
  }

  private abort(attempt: Attempt, code: number, reason: string, failure: RuntimeAttemptFailure): void {
    // Ended first, so a close event the adapter raises inside close() is ignored.
    attempt.phase = "ended";
    attempt.socket.close(code, reason);
    this.fail(attempt, failure);
  }

  private fail(attempt: Attempt, failure: RuntimeAttemptFailure): void {
    clearTimeout(attempt.timer);
    attempt.phase = "ended";
    attempt.failure = failure;
    if (this.settled) return;
    this.startAttempt(this.attempts.length);
    if (this.attempts.length < this.routes.length) return;
    if (!this.attempts.every((item) => item.phase === "ended")) return;
    this.settled = true;
    this.detachSignal();
    clearTimeout(this.hedgeTimer);
    const failures = this.attempts.flatMap((item) => (item.failure ? [item.failure] : []));
    this.reject(new RuntimeConnectError(connectErrorCode(failures), failures));
  }

  private detachSignal(): void { this.options.signal?.removeEventListener("abort", this.cancel); }
}
