// app.zeros.build/handoff/redeem  (POST, verifier-authed)
//
// Called by the DESKTOP main process (over HTTPS — no cookie). Authenticated by
// possession of { valid single-use ticket + the handoff-PKCE verifier }. On
// success, atomically consumes the ticket and returns a desktop-specific opaque
// refresh capability plus the current access token, never in a URL. The
// PostgreSQL authority serializes redemption, rotation and revocation.

import { type Env } from "../../lib/session";
import {
  sha256B64url,
  json,
  TOKENISH,
} from "../../lib/handoff-security";
import { clientIp, rateLimit } from "../../lib/ratelimit";
import { legacyDesktopHandoffEnabled } from "../../lib/workos-browser.mjs";
import { auth0SessionAuthority } from "../../lib/auth0-session-authority";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!legacyDesktopHandoffEnabled(env)) {
    return json({ error: "desktop_auth_migration_pending" }, 409, {
      "cache-control": "no-store",
    });
  }
  // Cap brute-force probing of the ticket space (256-bit, so infeasible anyway —
  // this is just an abuse ceiling). Fails open if KV is unavailable.
  if (env.SESSIONS) {
    const rl = await rateLimit(env.SESSIONS, "redeem", clientIp(request), 30, 60, Date.now());
    if (!rl.ok) {
      return json({ error: "rate_limited" }, 429, {
        "cache-control": "no-store",
        "retry-after": String(rl.retryAfter),
      });
    }
  }

  let body: { ticket?: unknown; verifier?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const ticket = typeof body.ticket === "string" ? body.ticket : "";
  const verifier = typeof body.verifier === "string" ? body.verifier : "";
  if (!TOKENISH.test(ticket) || !TOKENISH.test(verifier)) {
    return json({ error: "bad_request" }, 400);
  }

  // handoff-PKCE: prove possession of the verifier (it never crossed zeros://)
  // BEFORE consuming the ticket. Deleting first would let an attacker who
  // intercepted the ticket burn it with a junk verifier, denying the legitimate
  // desktop its one redemption; on a mismatch the ticket stays live for the real
  // caller (and dies by TTL regardless).
  const expected = await sha256B64url(verifier);
  const redeemed = await auth0SessionAuthority(env, { action: "redeem", sessionId: ticket, challenge: expected });
  if (redeemed.status === "terminal") return json({ error: "invalid_or_used" }, 401, { "cache-control": "no-store" });
  if (redeemed.status !== "active" || !redeemed.desktopCredential) return json({ error: "temporarily_unavailable" }, 503, { "cache-control": "no-store" });
  const stored = redeemed.data;

  return json({
    access_token: stored.accessToken,
    refresh_token: redeemed.desktopCredential,
    sub: stored.sub,
    email: stored.email,
    name: stored.name,
  }, 200, { "cache-control": "no-store" });
};
