// ──────────────────────────────────────────────────────────
// A small in-memory fixed-window limiter, keyed per user + bucket.
// Deliberately simple:
// one control-plane instance at this scale, no Redis. Abusive spikes on
// the sensitive endpoints (invite send/accept, secret reads) are capped;
// legitimate use never comes close.
//
// NOT a security boundary on its own (authz is) — it's abuse control, so
// an in-memory window that resets on deploy is acceptable. Swap for a
// shared store if the service ever runs multi-instance.
// ──────────────────────────────────────────────────────────

import type { MiddlewareHandler } from "hono";
import { HttpError } from "./authz.js";

type Bucket = { count: number; resetAt: number };
const windows = new Map<string, Bucket>();

// Bounded cleanup: drop expired buckets when the map grows, so a churn of
// distinct users can't leak memory unboundedly.
function sweep(now: number): void {
  if (windows.size < 10_000) return;
  for (const [k, b] of windows) if (b.resetAt <= now) windows.delete(k);
}

/** Fixed-window limiter middleware. `key` names the bucket; the acting
 *  user id (from the verified JWT) scopes it. Throws 429 on exceed. */
export function rateLimit(
  bucket: string,
  limit: number,
  windowMs: number,
): MiddlewareHandler {
  return async (c, next) => {
    const now = Date.now();
    const user = c.get("user");
    const key = `${bucket}:${user?.id ?? "anon"}`;
    const existing = windows.get(key);
    if (!existing || existing.resetAt <= now) {
      sweep(now);
      windows.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      existing.count += 1;
      if (existing.count > limit) {
        const retry = Math.ceil((existing.resetAt - now) / 1000);
        c.header("Retry-After", String(retry));
        throw new HttpError(429, "rate_limited", "Too many requests — slow down");
      }
    }
    await next();
  };
}
