// Renewal of a runtime connection's engine capability (S3 SDK behavior 5):
// device-stream capability.renewed pushes are applied in band, with a REST
// fallback at 80% of the token lifetime. Platform-neutral: Electron main and the
// renderer both import this module, so it uses no node: modules.

import type { ServerCapabilityRenewed, ServerCapabilityRevoked } from "./generated/device-stream";
import type { Capabilities } from "./generated/rest";
import { decodeCapabilityClaims } from "./runtime-session";
import { CloudRestError, RETRY_BASE_MS, RETRY_CAP_MS } from "./rest-client";

/** Once the engine token is past `exp` on an open connection (S1 outage
 * grace), REST retries back off to at most 5 s so the session renews inside
 * S1's 60 s recovery window. */
export const RUNTIME_RENEWAL_GRACE_RETRY_CAP_MS = 5_000;
/** Without an `iat` claim the REST fallback runs this long before `exp`. */
export const RUNTIME_RENEWAL_FALLBACK_LEAD_MS = 60_000;

/** REST statuses that are transient and retried; a body marked retryable is too. */
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

/** The part of a RuntimeConnection that renewal drives; RuntimeConnection satisfies it. */
export interface RenewableRuntimeConnection {
  readonly closed: boolean;
  renew(capabilities: Capabilities): Promise<number>;
  close(code?: number, reason?: string): void;
  onClose(listener: (code: number, reason: string) => void): () => void;
}

export type RuntimeRenewalEvent =
  /** The connection now runs on `capabilities`; `expiresAtMs` is the engine's answer. */
  | { type: "renewed"; source: "push" | "rest"; capabilities: Capabilities; expiresAtMs: number }
  /** A capability.revoked push applied to this session; renewal stopped and the connection was closed. */
  | { type: "revoked"; reason: string; scope: ServerCapabilityRevoked["d"]["scope"] }
  /** runtime/capabilities answered with a terminal error; renewal stopped. The
   * connection is left open (the engine closes it at `exp`); the owner decides. */
  | { type: "refused"; status: number; code: string };

export interface RuntimeRenewalOptions {
  workspaceId: string;
  clientSessionId: string;
  connection: RenewableRuntimeConnection;
  /** The capabilities the connection was opened with (the runtime/connect answer). */
  capabilities: Capabilities;
  /** POST …/runtime/capabilities for this workspace and client session; resolves with its `capabilities`. */
  fetchCapabilities: () => Promise<Capabilities>;
  onEvent: (event: RuntimeRenewalEvent) => void;
  now?: () => number;
  random?: () => number;
}

/** Capabilities waiting for, or undergoing, an in-band renewal. */
interface Offer {
  capabilities: Capabilities;
  source: "push" | "rest";
}

/** Keeps one runtime connection's engine capability renewed until it is stopped. */
export class RuntimeRenewal {
  private readonly workspaceId: string;
  private readonly clientSessionId: string;
  private readonly connection: RenewableRuntimeConnection;
  private readonly fetchCapabilities: () => Promise<Capabilities>;
  private readonly onEvent: (event: RuntimeRenewalEvent) => void;
  private readonly now: () => number;
  private readonly random: () => number;
  private applied: Capabilities;
  /** The offer whose renewal the connection is answering; at most one renewal is in flight. */
  private inFlight: Offer | undefined;
  /** The newest offer waiting for the in-flight renewal. */
  private pending: Offer | undefined;
  private fetching = false;
  /** Failures since the last in-band renewal; they set the retry backoff. */
  private attempts = 0;
  /** The one scheduled timer: the REST fallback or a retry. */
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private isStopped = false;

  constructor(options: RuntimeRenewalOptions) {
    this.workspaceId = options.workspaceId;
    this.clientSessionId = options.clientSessionId;
    this.connection = options.connection;
    this.fetchCapabilities = options.fetchCapabilities;
    this.onEvent = options.onEvent;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.applied = options.capabilities;
    if (this.connection.closed) {
      this.isStopped = true;
      return;
    }
    this.unsubscribe = this.connection.onClose(() => this.stop());
    this.scheduleFallback(this.applied);
  }

  /** The newest capabilities the engine accepted in band, initially the connect capabilities.
   * Its realtime grant is the one for the next relay admission. */
  get capabilities(): Capabilities {
    return this.applied;
  }

  get stopped(): boolean {
    return this.isStopped;
  }

  /** Feed every device-stream capability.renewed and capability.revoked frame. */
  handleFrame(frame: ServerCapabilityRenewed | ServerCapabilityRevoked): void {
    if (this.isStopped) return;
    switch (frame.t) {
      case "capability.renewed": {
        const { d } = frame;
        if (d.workspaceId !== this.workspaceId || d.clientSessionId !== this.clientSessionId) return;
        if (!isNewer(d.capabilities, this.newestKnown())) return;
        this.offer(d.capabilities, "push");
        return;
      }
      case "capability.revoked": {
        if (frame.d.workspaceId !== undefined && frame.d.workspaceId !== this.workspaceId) return;
        this.stop();
        this.connection.close(1000, "capability_revoked");
        this.onEvent({ type: "revoked", reason: frame.d.reason, scope: frame.d.scope });
        return;
      }
      default:
        return;
    }
  }

  /** Idempotent. Clears timers; later frames and late results are ignored. */
  stop(): void {
    this.isStopped = true;
    this.clearTimer();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Keeps at most one pending offer; a newer offer replaces an older pending one. */
  private offer(capabilities: Capabilities, source: Offer["source"]): void {
    if (this.pending === undefined || isNewer(capabilities, this.pending.capabilities)) {
      this.pending = { capabilities, source };
    }
    this.startPending();
  }

  /** Renews with the pending offer when no renewal is in flight; an offer that is not
   * newer than the applied capabilities is dropped. */
  private startPending(): void {
    const next = this.pending;
    if (this.isStopped || this.inFlight !== undefined || next === undefined) return;
    this.pending = undefined;
    if (isNewer(next.capabilities, this.applied)) this.renewInBand(next);
  }

  private renewInBand(offer: Offer): void {
    this.inFlight = offer;
    void this.connection.renew(offer.capabilities).then(
      (expiresAtMs) => this.onRenewed(offer, expiresAtMs),
      (error: unknown) => this.onRenewFailed(error),
    );
  }

  private onRenewed(offer: Offer, expiresAtMs: number): void {
    if (this.isStopped) return;
    this.inFlight = undefined;
    this.applied = offer.capabilities;
    this.attempts = 0;
    this.scheduleFallback(offer.capabilities);
    this.onEvent({ type: "renewed", source: offer.source, capabilities: offer.capabilities, expiresAtMs });
    this.startPending();
  }

  private onRenewFailed(error: unknown): void {
    if (this.isStopped || this.connection.closed) {
      this.stop();
      return;
    }
    this.inFlight = undefined;
    this.clearTimer();
    const next = this.pending;
    if (next !== undefined && isNewer(next.capabilities, this.applied)) {
      // A newer offer that waited behind this renewal is taken at once.
      this.attempts += 1;
      this.startPending();
      return;
    }
    this.pending = undefined;
    this.scheduleRetry(error);
  }

  /** The REST fallback, run by the fallback timer and by retries. */
  private renewFromRest(): void {
    if (this.isStopped || this.inFlight !== undefined || this.pending !== undefined || this.fetching) return;
    this.fetching = true;
    const appliedAtStart = this.applied;
    void this.fetchCapabilities().then(
      (answer) => this.onRestAnswer(appliedAtStart, answer),
      (error: unknown) => this.onRestFailed(appliedAtStart, error),
    );
  }

  private onRestAnswer(appliedAtStart: Capabilities, answer: Capabilities): void {
    this.fetching = false;
    // A push applied while the fetch was in flight supersedes its answer.
    if (this.isStopped || this.applied !== appliedAtStart) return;
    if (!isNewer(answer, this.newestKnown())) {
      this.scheduleRetry(undefined);
      return;
    }
    this.offer(answer, "rest");
  }

  private onRestFailed(appliedAtStart: Capabilities, error: unknown): void {
    this.fetching = false;
    if (this.isStopped) return;
    if (error instanceof CloudRestError && !isTransient(error)) {
      this.onEvent({ type: "refused", status: error.status, code: error.code });
      this.stop();
      return;
    }
    // A push applied while the fetch was in flight already rescheduled the fallback.
    if (this.applied !== appliedAtStart) return;
    this.scheduleRetry(error);
  }

  /** Counts a failure and schedules the next REST renewal after its backoff. */
  private scheduleRetry(error: unknown): void {
    const delayMs = this.retryDelayMs(error);
    this.attempts += 1;
    this.setTimer(() => this.renewFromRest(), delayMs);
  }

  /** Full jitter under an exponential bound, capped at 30 s or at 5 s once the token is
   * past exp; a Retry-After from the server takes its place when it has one. A retry
   * scheduled before exp lands at most 5 s past it, so a session in the outage grace
   * never waits out a 30 s backoff for its first retry. */
  private retryDelayMs(error: unknown): number {
    const appliedExpMs = expiryMs(this.applied);
    const now = this.now();
    const pastExp = appliedExpMs !== undefined && now >= appliedExpMs;
    const cap = pastExp ? RUNTIME_RENEWAL_GRACE_RETRY_CAP_MS : RETRY_CAP_MS;
    const retryAfterMs = error instanceof CloudRestError ? error.retryAfterMs : undefined;
    const delayMs = Math.min(cap, retryAfterMs ?? Math.floor(this.random() * Math.min(cap, RETRY_BASE_MS * 2 ** this.attempts)));
    return appliedExpMs === undefined || pastExp ? delayMs
      : Math.min(delayMs, appliedExpMs - now + RUNTIME_RENEWAL_GRACE_RETRY_CAP_MS);
  }

  /** The newest of the applied, in-flight and pending capabilities. */
  private newestKnown(): Capabilities {
    let newest = this.applied;
    for (const candidate of [this.inFlight, this.pending]) {
      if (candidate !== undefined && isNewer(candidate.capabilities, newest)) newest = candidate.capabilities;
    }
    return newest;
  }

  /** Arms the REST fallback for `capabilities`; unusable capabilities run it at once. */
  private scheduleFallback(capabilities: Capabilities): void {
    const claims = decodeCapabilityClaims(capabilities.engine.token);
    const delayMs = claims === null ? 0 : Math.max(0, fallbackAtMs(claims) - this.now());
    this.setTimer(() => this.renewFromRest(), delayMs);
  }

  /** Replaces the scheduled timer, so a fallback and a retry never both run. */
  private setTimer(callback: () => void, delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      callback();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Expiry in ms, or undefined when the engine token does not decode (the capabilities are unusable). */
function expiryMs(capabilities: Capabilities): number | undefined {
  const claims = decodeCapabilityClaims(capabilities.engine.token);
  return claims === null ? undefined : claims.exp * 1000;
}

/** Newer means a later expiry. An unusable value is never newer, and a usable one is newer
 * than an unusable one. */
function isNewer(candidate: Capabilities, previous: Capabilities): boolean {
  const candidateExpMs = expiryMs(candidate);
  if (candidateExpMs === undefined) return false;
  const previousExpMs = expiryMs(previous);
  return previousExpMs === undefined || candidateExpMs > previousExpMs;
}

/** When the REST fallback runs: 80% of the way from `iat` to `exp`, or 60 s before `exp`
 * when there is no usable `iat`. */
function fallbackAtMs(claims: { exp: number; iat?: number }): number {
  const expMs = claims.exp * 1000;
  if (claims.iat !== undefined && claims.iat < claims.exp) {
    const iatMs = claims.iat * 1000;
    return iatMs + Math.floor(0.8 * (expMs - iatMs));
  }
  return expMs - RUNTIME_RENEWAL_FALLBACK_LEAD_MS;
}

function isTransient(error: CloudRestError): boolean {
  return TRANSIENT_STATUSES.has(error.status) || error.retryable;
}
