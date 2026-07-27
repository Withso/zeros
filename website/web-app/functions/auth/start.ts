// app.zeros.build/auth/start?provider=&return=
//
// Kicks off Auth0's Authorization Code + PKCE flow for a specific social
// connection. We mint the code_verifier + a CSRF state token ourselves and
// stash them in short-lived cookies, then 303 the browser to Auth0's
// /authorize endpoint (which redirects straight to the provider's consent
// page — no Auth0-branded intermediate screen). After consent, Auth0 returns
// to /auth/callback, which completes the exchange using that same verifier.
//
// (Moved from the retired auth.zeros.build project; the PKCE cookies are now
// host-only — see lib/oauth.ts.)

import { authorizeUrl, cookieJar, isKnownProvider, randomToken, safeReturnFor } from "../../lib/oauth";
import { sha256B64url } from "../../lib/util";
import type { Env } from "../../lib/session";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? "";
  if (!isKnownProvider(provider)) {
    return new Response("Unknown provider", { status: 400 });
  }
  const returnTo = safeReturnFor(env, url.searchParams.get("return"));

  const codeVerifier = randomToken();
  const codeChallenge = await sha256B64url(codeVerifier);
  const state = randomToken(16);

  // Separate cookies for state and returnTo — NOT concatenated with a "."
  // delimiter, because encodeURIComponent() doesn't escape "." and returnTo
  // (a full https://app.zeros.build/... URL) contains real dots from the
  // domain name itself, which broke a naive split(".") in callback.ts.
  const { applyCookies, pending } = cookieJar();
  pending.push({ name: "zeros_pkce_verifier", value: codeVerifier, options: { maxAge: 600, path: "/auth" } });
  pending.push({ name: "zeros_oauth_state", value: state, options: { maxAge: 600, path: "/auth" } });
  pending.push({
    name: "zeros_return_to",
    value: encodeURIComponent(returnTo),
    options: { maxAge: 600, path: "/auth" },
  });

  const location = authorizeUrl(env, { provider, state, codeChallenge });
  return applyCookies(new Response(null, { status: 303, headers: { Location: location } }));
};
