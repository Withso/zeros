// app.zeros.build/auth/callback?code=&state=
//
// Auth0 redirects here after consent. We exchange the code for tokens using
// the PKCE verifier cookie set by /auth/start, decode the id_token, write a
// session into KV, set the host-only session cookie, and bounce back to where
// the user started (usually the hub — whose zeros_handoff cookie means a
// desktop sign-in resumes exactly where it left off).
//
// Failures render a styled page with a Try-again link instead of raw text —
// the hub's handoff cookie survives, so retrying re-enters the same desktop
// sign-in without relaunching from the app.

import { cookieJar, createSession, exchangeCode, safeReturnFor, sessionCookie } from "../../lib/oauth";
import { parseCookieHeader, SESSION_COOKIE, type Env } from "../../lib/session";
import { esc, html, shell } from "../../lib/page";
import { appOrigin } from "../../lib/hosts";
import {
  configuredAuthProvider,
  finishWorkOSBrowserAuth,
} from "../../lib/workos-browser.mjs";

function failPage(env: Env, reason: string): Response {
  const inner = `<div class="title">Sign-in didn't finish</div>
          <div class="sub">${esc(reason)} Nothing was changed — you can just try again.</div>
          <a class="btn" href="${appOrigin(env)}/">Try again</a>`;
  return html(shell("Sign-in didn't finish", inner), 400);
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (configuredAuthProvider(env) === "workos") {
    return finishWorkOSBrowserAuth(request, env);
  }
  const url = new URL(request.url);
  const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (providerError) {
    return failPage(env, `The provider reported: ${providerError}.`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return failPage(env, "The sign-in link was missing its authorization code.");

  const cookies = parseCookieHeader(request.headers.get("Cookie") ?? "");
  const codeVerifier = cookies.find((c) => c.name === "zeros_pkce_verifier")?.value;
  const expectedState = cookies.find((c) => c.name === "zeros_oauth_state")?.value;
  const encodedReturnTo = cookies.find((c) => c.name === "zeros_return_to")?.value;
  if (!codeVerifier || !expectedState || state !== expectedState) {
    return failPage(env, "This sign-in attempt expired or didn't match this browser.");
  }
  // Re-validate on READ, not just at write time in /auth/start: cookies aren't
  // origin-isolated (legacy .zeros.build-scoped cookies still exist), so a
  // planted zeros_return_to cookie must not become a same-site open redirect.
  const returnTo = safeReturnFor(env, encodedReturnTo ? decodeURIComponent(encodedReturnTo) : null);

  let tokens;
  try {
    tokens = await exchangeCode(env, { code, codeVerifier });
  } catch {
    return failPage(env, "We couldn't complete the token exchange with the sign-in service.");
  }

  const { sessionId, emailVerified } = await createSession(env, tokens);
  if (!emailVerified) {
    return failPage(env, "Your email address isn't verified with the provider yet — verify it there first.");
  }

  const { applyCookies, pending } = cookieJar();
  pending.push(sessionCookie(sessionId));
  // Expire the LEGACY domain-wide session cookie (written by the retired
  // auth.zeros.build project) so the browser doesn't carry two zeros_session
  // cookies — reads take the first match, which could be the stale one.
  pending.push({ name: SESSION_COOKIE, value: "", options: { maxAge: 0, domainWide: true } });
  // Clear the one-time PKCE/state/return-to cookies now that the exchange is done.
  pending.push({ name: "zeros_pkce_verifier", value: "", options: { path: "/auth", maxAge: 0 } });
  pending.push({ name: "zeros_oauth_state", value: "", options: { path: "/auth", maxAge: 0 } });
  pending.push({ name: "zeros_return_to", value: "", options: { path: "/auth", maxAge: 0 } });

  return applyCookies(new Response(null, { status: 303, headers: { Location: returnTo } }));
};
