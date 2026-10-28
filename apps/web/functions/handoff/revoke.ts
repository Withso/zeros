// app.zeros.build/handoff/revoke  (POST, refresh-token-authed, no cookie)
//
// The compromise-recovery action ("sign out everywhere"): revokes a refresh
// token server-side via Auth0's /oauth/revoke, using the confidential client's
// secret. The desktop calls this instead of holding the secret itself.

import { json, TOKENISH } from "../../lib/handoff-security";
import type { Env } from "../../lib/session";
import { legacyDesktopHandoffEnabled } from "../../lib/workos-browser.mjs";
import { auth0SessionAuthority } from "../../lib/auth0-session-authority";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!legacyDesktopHandoffEnabled(env)) {
    return json({ error: "desktop_auth_migration_pending" }, 409, {
      "cache-control": "no-store",
    });
  }
  let body: { refresh_token?: unknown; scope?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!TOKENISH.test(refreshToken)) return json({ error: "bad_request" }, 400);

  if (!/^z0d_[A-Za-z0-9_-]{43}$/.test(refreshToken)) return json({ error: "reauthentication_required" }, 401, { "cache-control": "no-store" });
  if (body.scope !== undefined && body.scope !== "current" && body.scope !== "all") return json({ error: "bad_request" }, 400);
  const result = await auth0SessionAuthority(env, { action: "revoke", sessionId: refreshToken, all: body.scope !== "current" });
  if (body.scope !== "current" && (result.status !== "terminal" || result.revokedAll !== true))
    return json({ error: "reauthentication_required" }, 401, { "cache-control": "no-store" });
  return json({ ok: true }, 200, { "cache-control": "no-store" });
};
