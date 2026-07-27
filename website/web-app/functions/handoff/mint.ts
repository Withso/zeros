// app.zeros.build/handoff/mint  (POST, cookie-authed)
//
// Called by /launch when a signed-in user clicks "Launch Zeros". Mints an
// opaque, single-use, short-TTL ticket bound to the desktop's handoff-PKCE
// challenge + nonce, backed by an INDEPENDENT Auth0 token pair (a fresh
// refresh-grant call, distinct from the browser hub's own session tokens) —
// not the browser's literal tokens. We store ONLY the ticket's SHA-256 hash as
// the KV key — never the ticket itself.

import { getSessionWithId, putSession, refreshGrant, SESSION_TTL_S, type Env } from "../../lib/session";
import { b64url, sha256Hex, json, TOKENISH } from "../../lib/util";

const TICKET_TTL_S = 90; // ≤120s per the OAuth browser-session-handoff draft.

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
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

  // Must be a signed-in browser session (the .zeros.build cookie → KV).
  const session = await getSessionWithId(env, request);
  if (!session?.data.refreshToken) return json({ error: "unauthorized" }, 401);

  // One extra refresh-grant call: mints a token pair independent of whatever
  // the browser hub is currently holding. If the tenant has Refresh Token
  // Rotation on, this invalidates the OLD refresh token — write the rotated
  // value back into the browser's own session so its next refresh doesn't fail.
  const granted = await refreshGrant(env, session.data.refreshToken);
  if (!granted.ok) {
    // A terminal failure means the browser's own refresh token is dead — the
    // hub should re-authenticate; a transient one is a momentary Auth0 outage.
    return json({ error: "mint_failed" }, granted.terminal ? 401 : 503);
  }
  if (granted.data.refresh_token && granted.data.refresh_token !== session.data.refreshToken) {
    await putSession(
      env,
      session.sessionId,
      {
        ...session.data,
        accessToken: granted.data.access_token,
        refreshToken: granted.data.refresh_token,
        verifiedAt: Date.now(), // this grant just re-proved the session live
      },
      SESSION_TTL_S,
    );
  }

  const ticket = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const ticketHash = await sha256Hex(ticket);
  await env.SESSIONS.put(
    `ticket:${ticketHash}`,
    JSON.stringify({
      challenge,
      nonce,
      accessToken: granted.data.access_token,
      refreshToken: granted.data.refresh_token ?? session.data.refreshToken,
      // Threaded through explicitly rather than left for the desktop to decode
      // from the access token — an API-audience access token carries scope/aud
      // claims, not profile claims, so this is the only place identity is known.
      sub: session.data.sub,
      email: session.data.email,
      name: session.data.name,
    }),
    { expirationTtl: TICKET_TTL_S },
  );

  // The opaque ticket is the ONLY thing returned; it crosses zeros:// but is
  // useless without the verifier the desktop holds (verified at /handoff/redeem).
  return json({ ticket });
};
