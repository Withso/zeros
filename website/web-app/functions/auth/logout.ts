// app.zeros.build/auth/logout?return=<https zeros.build url>
//
// Ends the BROWSER session. Three steps, in order:
//   1. delete the KV session record(s) (so the opaque cookie id stops resolving),
//   2. expire the session cookie — BOTH the host-only one and the legacy
//      .zeros.build-scoped one from the retired auth.zeros.build project,
//   3. bounce through Auth0's /v2/logout so the IdP session dies too — otherwise
//      the next "Sign in" silently re-authenticates without a prompt.
//
// GET (not POST) so a plain link works; it only tears down the caller's own
// session, so there's no CSRF-worthy state change to protect (the worst a forged
// request does is sign the victim out — annoying, not dangerous). `returnTo`
// MUST be registered in Auth0's Allowed Logout URLs, and is host-allow-listed
// here via safeReturn so it can't be an open redirect.

import { clearSessionCookies, cookieJar, safeReturnFor } from "../../lib/oauth";
import { parseCookieHeader, SESSION_COOKIE, type Env } from "../../lib/session";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const returnTo = safeReturnFor(env, url.searchParams.get("return"));

  // Delete EVERY session id presented under this cookie name — during the
  // legacy-cookie overlap window a browser can hold two zeros_session cookies
  // (host-only + domain-wide) pointing at different KV records.
  const cookies = parseCookieHeader(request.headers.get("Cookie") ?? "");
  const sessionIds = [...new Set(cookies.filter((c) => c.name === SESSION_COOKIE).map((c) => c.value))];
  if (env.SESSIONS) {
    for (const id of sessionIds) {
      if (id) await env.SESSIONS.delete(`session:${id}`);
    }
  }

  const { applyCookies, pending } = cookieJar();
  clearSessionCookies(pending);

  const logoutUrl =
    `https://${env.AUTH0_DOMAIN}/v2/logout` +
    `?client_id=${encodeURIComponent(env.AUTH0_CLIENT_ID)}` +
    `&returnTo=${encodeURIComponent(returnTo)}`;

  return applyCookies(new Response(null, { status: 303, headers: { Location: logoutUrl } }));
};
