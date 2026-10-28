// app.zeros.build/handoff/refresh  (POST, desktop-capability-authed, no cookie)
//
// Called by the DESKTOP main process with its opaque z0d_ capability. The
// durable authority checks expiry/revocation and serializes provider rotation;
// raw Auth0 refresh tokens are not accepted as desktop authority.

import { refreshBrowserSession, type Env } from "../../lib/session";
import { auth0SessionAuthority } from "../../lib/auth0-session-authority";
import { json, TOKENISH } from "../../lib/handoff-security";
import { clientIp, rateLimit } from "../../lib/ratelimit";
import { legacyDesktopHandoffEnabled } from "../../lib/workos-browser.mjs";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!legacyDesktopHandoffEnabled(env)) {
    return json({ error: "desktop_auth_migration_pending" }, 409, {
      "cache-control": "no-store",
    });
  }
  // Abuse ceiling on the refresh endpoint: possession of a desktop capability is the
  // only credential here, so cap single-source hammering (a stolen-token replay
  // farm / DoS). Generous — a real desktop refreshes rarely; brute force is
  // infeasible against 256-bit tokens regardless. Fails open if KV is down.
  if (env.SESSIONS) {
    const rl = await rateLimit(env.SESSIONS, "refresh", clientIp(request), 60, 60, Date.now());
    if (!rl.ok) {
      return json({ error: "rate_limited" }, 429, {
        "cache-control": "no-store",
        "retry-after": String(rl.retryAfter),
      });
    }
  }

  let body: { refresh_token?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!TOKENISH.test(refreshToken)) return json({ error: "bad_request" }, 400);

  if (!/^z0d_[A-Za-z0-9_-]{43}$/.test(refreshToken)) return json({ error: "invalid_grant" }, 401, { "cache-control": "no-store" });
  const current = await auth0SessionAuthority(env, { action: "read", sessionId: refreshToken });
  if (current.status === "terminal") return json({ error: "invalid_grant" }, 401, { "cache-control": "no-store" });
  if (current.status === "busy") return json({ error: "refresh_unavailable" }, 503, { "cache-control": "no-store" });
  const granted = await refreshBrowserSession(env, refreshToken, current.data, current.revision);
  if (!granted.ok) {
    // Terminal (dead refresh token) → 401 so the desktop clears its session and
    // re-signs-in. Transient (Auth0 rate-limit / 5xx / unreachable) → 503 so the
    // desktop KEEPS its tokens and retries later instead of hard-logging-out on a
    // momentary outage. `no-store` on both so no intermediary caches the outcome.
    return granted.terminal
      ? json({ error: "invalid_grant" }, 401, { "cache-control": "no-store" })
      : json({ error: "refresh_unavailable" }, 503, { "cache-control": "no-store" });
  }

  return json(
    {
      access_token: granted.data.accessToken,
      refresh_token: refreshToken,
    },
    200,
    { "cache-control": "no-store" },
  );
};
