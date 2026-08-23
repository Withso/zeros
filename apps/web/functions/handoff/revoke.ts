// app.zeros.build/handoff/revoke  (POST, refresh-token-authed, no cookie)
//
// The compromise-recovery action ("sign out everywhere"): revokes a refresh
// token server-side via Auth0's /oauth/revoke, using the confidential client's
// secret. The desktop calls this instead of holding the secret itself.

import { json, TOKENISH } from "../../lib/handoff-security";
import type { Env } from "../../lib/session";
import { legacyDesktopHandoffEnabled } from "../../lib/workos-browser.mjs";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!legacyDesktopHandoffEnabled(env)) {
    return json({ error: "desktop_auth_migration_pending" }, 409, {
      "cache-control": "no-store",
    });
  }
  let body: { refresh_token?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!TOKENISH.test(refreshToken)) return json({ error: "bad_request" }, 400);

  const res = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.AUTH0_CLIENT_ID,
      client_secret: env.AUTH0_CLIENT_SECRET,
      token: refreshToken,
    }),
  });
  // Auth0's /oauth/revoke returns 200 even for an already-invalid token — that's
  // still "revoked" from the caller's perspective, so only a non-2xx is an error.
  if (!res.ok) return json({ error: "revoke_failed" }, 502);
  return json({ ok: true });
};
