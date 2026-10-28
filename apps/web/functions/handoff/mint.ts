// app.zeros.build/handoff/mint  (POST, cookie-authed)
//
// Called by /launch when a signed-in user clicks "Launch Zeros". Mints an
// opaque, single-use, short-TTL ticket bound to the desktop's handoff-PKCE
// challenge. The durable authority stores its digest and consumes it once,
// then issues an independently revocable desktop capability. Provider tokens
// remain encrypted behind that authority and never cross the deep link.

import { getSessionWithId, refreshBrowserSession, type Env } from "../../lib/session";
import {
  b64url,
  json,
  TOKENISH,
} from "../../lib/handoff-security";
import { auth0SessionAuthority } from "../../lib/auth0-session-authority";
import { legacyDesktopHandoffEnabled } from "../../lib/workos-browser.mjs";


export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!legacyDesktopHandoffEnabled(env)) {
    return json({ error: "desktop_auth_migration_pending" }, 409, {
      "cache-control": "no-store",
    });
  }
  let body: { challenge?: unknown; nonce?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const challenge = typeof body.challenge === "string" ? body.challenge : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  if (!TOKENISH.test(challenge) || !TOKENISH.test(nonce)) {
    return json({ error: "bad_request" }, 400);
  }

  // Must be a live browser session in the durable authority.
  const session = await getSessionWithId(env, request);
  if (!session?.data.refreshToken) return json({ error: "unauthorized" }, 401);

  // Refresh under the shared lease before minting the handoff. A rotated
  // provider grant is committed before any desktop capability can use it.
  const granted = await refreshBrowserSession(env, session.sessionId, session.data, session.revision);
  if (!granted.ok) {
    // A terminal failure means the browser's own refresh token is dead — the
    // hub should re-authenticate; a transient one is a momentary Auth0 outage.
    return json({ error: "mint_failed" }, granted.terminal ? 401 : 503);
  }

  const ticket = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const stored = await auth0SessionAuthority(env, { action: "ticket", sessionId: session.sessionId, ticket, challenge });
  if (stored.status !== "active") return json({ error: "mint_failed" }, stored.status === "terminal" ? 401 : 503);

  // The opaque ticket is the ONLY thing returned; it crosses zeros:// but is
  // useless without the verifier the desktop holds (verified at /handoff/redeem).
  return json({ ticket }, 200, { "cache-control": "no-store" });
};
