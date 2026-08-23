// app.zeros.build/handoff/refresh  (POST, refresh-token-authed, no cookie)
//
// Called by the DESKTOP main process to renew its access token. Possession of a
// valid Auth0 refresh token IS the credential here (same trust model as Auth0's
// own /oauth/token endpoint) — this is a thin relay that holds the confidential
// client's secret server-side so the desktop binary never has to.

import { refreshGrant, type Env } from "../../lib/session";
import { json, TOKENISH } from "../../lib/handoff-security";
import { clientIp, rateLimit } from "../../lib/ratelimit";
import { legacyDesktopHandoffEnabled } from "../../lib/workos-browser.mjs";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!legacyDesktopHandoffEnabled(env)) {
    return json({ error: "desktop_auth_migration_pending" }, 409, {
      "cache-control": "no-store",
    });
  }
  // Abuse ceiling on the refresh oracle: possession of a refresh token is the
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

  const granted = await refreshGrant(env, refreshToken);
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
      access_token: granted.data.access_token,
      refresh_token: granted.data.refresh_token ?? refreshToken,
    },
    200,
    { "cache-control": "no-store" },
  );
};
