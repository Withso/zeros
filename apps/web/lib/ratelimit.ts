// Best-effort fixed-window rate limiter backed by the SESSIONS KV.
//
// Pages Functions run across many isolates, so an in-memory counter wouldn't
// hold — KV is the shared store. KV has no atomic increment and is eventually
// consistent, so this is an ABUSE CEILING, not a security boundary: the real
// protection on the handoff endpoints is the 256-bit token/ticket entropy and
// Auth0's own controls. This just caps single-source hammering of the
// /handoff/refresh oracle and brute-force probing of /handoff/redeem.
//
// The window is anchored by a `resetAt` stored IN the value (not by the KV TTL,
// which each put would otherwise slide), so the count genuinely resets once the
// window elapses. TTL is only for eventual cleanup (clamped to KV's 60s floor).

const WINDOW_FLOOR_TTL_S = 60; // Cloudflare KV minimum expirationTtl.

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets — send as Retry-After on a block. */
  retryAfter: number;
}

/** Increment the caller's counter for `bucket`; block once it exceeds `limit`
 *  within `windowS`. Keyed by client IP. Fails OPEN on any KV error — a limiter
 *  outage must never take down a legitimate sign-in/refresh. */
export async function rateLimit(
  kv: KVNamespace,
  bucket: string,
  clientIp: string,
  limit: number,
  windowS: number,
  now: number,
): Promise<RateLimitResult> {
  const key = `rl:${bucket}:${clientIp}`;
  try {
    const raw = await kv.get(key);
    let count = 0;
    let resetAt = now + windowS * 1000;
    if (raw) {
      try {
        const b = JSON.parse(raw) as { count?: unknown; resetAt?: unknown };
        // Only carry over a window that hasn't elapsed yet.
        if (typeof b.resetAt === "number" && b.resetAt > now) {
          resetAt = b.resetAt;
          count = typeof b.count === "number" ? b.count : 0;
        }
      } catch {
        /* corrupt entry — start a fresh window */
      }
    }
    if (count >= limit) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
    }
    const ttl = Math.max(WINDOW_FLOOR_TTL_S, Math.ceil((resetAt - now) / 1000));
    await kv.put(key, JSON.stringify({ count: count + 1, resetAt }), { expirationTtl: ttl });
    return { ok: true, retryAfter: 0 };
  } catch {
    // KV unavailable — don't block the user; entropy is the real guard.
    return { ok: true, retryAfter: 0 };
  }
}

/** Client IP for keying. CF-Connecting-IP is set by Cloudflare on every edge
 *  request and can't be spoofed by the client (Cloudflare overwrites it). */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
