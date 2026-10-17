import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export type AdmissionLimits = {
  /** Process-wide ceiling: burst, refilled one token per `globalRefillMs`. */
  globalBurst: number;
  globalRefillMs: number;
  /** Per source address: burst and steady dials per second. */
  sourceBurst: number;
  sourcePerSecond: number;
  /** Sockets one source may hold between the upgrade and the welcome. */
  sourceMaxUnadmitted: number;
  /** Tracked sources; past it, idle full buckets are dropped first. */
  maxSources?: number;
};

type SourceState = { tokens: number; at: number; unadmitted: number };

export type AdmissionTicket = { release(): void };

/** Pre-authentication admission for the uplink upgrade. A source can take at
 * most its own bucket from the global one, so one address flooding shaped
 * tokens cannot starve another address's engines; the global bucket stays a
 * backstop for many sources together. */
export class UplinkAdmission {
  private readonly sources = new Map<string, SourceState>();
  private globalTokens: number;
  private globalAt: number;
  private readonly maxSources: number;

  constructor(private readonly limits: AdmissionLimits, private readonly now: () => number = () => performance.now()) {
    this.globalTokens = limits.globalBurst;
    this.globalAt = now();
    this.maxSources = limits.maxSources ?? 10_000;
  }

  /** A ticket the caller releases once the socket is welcomed or gone. */
  admit(source: string): AdmissionTicket | "rate_limited" | "capacity" {
    const now = this.now();
    const state = this.source(source, now);
    if (state.unadmitted >= this.limits.sourceMaxUnadmitted) return "capacity";
    state.tokens = Math.min(this.limits.sourceBurst, state.tokens + ((now - state.at) / 1_000) * this.limits.sourcePerSecond);
    state.at = now;
    this.globalTokens = Math.min(this.limits.globalBurst, this.globalTokens + (now - this.globalAt) / this.limits.globalRefillMs);
    this.globalAt = now;
    if (state.tokens < 1 || this.globalTokens < 1) return "rate_limited";
    state.tokens -= 1;
    this.globalTokens -= 1;
    state.unadmitted += 1;
    let released = false;
    return { release: () => { if (!released) { released = true; state.unadmitted -= 1; } } };
  }

  private source(key: string, now: number): SourceState {
    let state = this.sources.get(key);
    if (state) return state;
    if (this.sources.size >= this.maxSources) this.prune(now);
    state = { tokens: this.limits.sourceBurst, at: now, unadmitted: 0 };
    // Past the bound with every tracked source busy, new sources share one
    // bucket rather than growing the map.
    if (this.sources.size >= this.maxSources) key = "overflow";
    const shared = this.sources.get(key);
    if (shared) return shared;
    this.sources.set(key, state);
    return state;
  }

  private prune(now: number): void {
    for (const [key, state] of this.sources) {
      const refilled = state.tokens + ((now - state.at) / 1_000) * this.limits.sourcePerSecond;
      if (state.unadmitted === 0 && refilled >= this.limits.sourceBurst) this.sources.delete(key);
    }
  }
}

/** The client address under the same trust model as the HTTP engine paths'
 * pre-auth limits (app.ts): the platform proxy's `X-Real-IP`, else the
 * protected tunnel's `CF-Connecting-IP`, else the socket peer, each only when
 * it parses as an IP; anything else collapses into one `unknown` bucket. */
export function uplinkSourceAddress(request: IncomingMessage): string {
  const header = (name: string) => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  };
  for (const candidate of [header("x-real-ip"), header("cf-connecting-ip"), request.socket.remoteAddress ?? ""])
    if (candidate && isIP(candidate)) return candidate;
  return "unknown";
}
