// Auth0 Authorization Code + PKCE flow for app.zeros.build.
//
// Moved verbatim-in-spirit from the retired auth.zeros.build project (its
// lib/session.ts) — one web app, one env surface, one host. Sessions still live
// in Cloudflare KV (the cookie only carries an opaque session id; see
// lib/session.ts for reads).
//
// COOKIE SCOPE CHANGE from the two-subdomain era: cookies are now HOST-ONLY
// (no Domain attribute). The old flow minted the session on auth.zeros.build
// and read it on app.zeros.build, which forced Domain=.zeros.build — readable
// and plantable by every *.zeros.build sibling. Same-host means we can drop
// that. Legacy domain-wide cookies still exist in the wild until they expire
// (30d), so sign-in and sign-out explicitly expire the domain-wide variant too
// (`domainWide` option below).

import { appOrigin, redirectUri } from "./hosts";
import { SESSION_COOKIE, SESSION_TTL_S, type Env, type SessionData } from "./session";
import { b64url, sha256B64url } from "./util";

/** @deprecated Prefer redirectUri(env). Kept as the production default string
 *  for docs/tests that assert the Auth0 callback URL. */
export const REDIRECT_URI = "https://app.zeros.build/auth/callback";

/** The Auth0 API identifier (same value as the backend's AUTH_AUDIENCE). MUST
 *  be requested on /authorize, or Auth0 returns an opaque access token instead
 *  of a JWT the backend can verify. It's a public, stable identifier — not a
 *  secret — so a code default keeps the env surface at three vars; an env var
 *  still wins if set. */
const DEFAULT_AUDIENCE = "https://api.zeros.build";

interface CookieOptions {
  path?: string;
  maxAge?: number;
  /** Emit Domain=.zeros.build — ONLY for expiring legacy cookies written by the
   *  retired auth.zeros.build project. Never used for new cookies. */
  domainWide?: boolean;
}

export interface PendingCookie {
  name: string;
  value: string;
  options: CookieOptions;
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  let str = `${name}=${value}`;
  if (options.domainWide) str += `; Domain=.zeros.build`;
  str += `; Path=${options.path ?? "/"}`;
  if (typeof options.maxAge === "number") str += `; Max-Age=${options.maxAge}`;
  str += `; SameSite=Lax`;
  str += `; Secure`;
  str += `; HttpOnly`;
  return str;
}

/** Buffers Set-Cookie writes so callers can flush them onto a Response. */
export function cookieJar(): { pending: PendingCookie[]; applyCookies: (res: Response) => Response } {
  const pending: PendingCookie[] = [];
  return {
    pending,
    applyCookies(res: Response): Response {
      for (const c of pending) res.headers.append("Set-Cookie", serializeCookie(c.name, c.value, c.options));
      return res;
    },
  };
}

/** Allow ONLY https zeros.build (+ subdomains) and zeros.design as a post-login
 *  return target, so ?return= can't be used as an open redirect to an attacker's
 *  site. Fallback is the app origin (hub). */
export function safeReturn(
  url: string | null,
  fallback: string = `${REDIRECT_URI.replace(/\/auth\/callback$/, "")}/`,
): string {
  if (!url) return fallback;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return fallback;
    const host = u.hostname.toLowerCase();
    if (host === "zeros.build" || host.endsWith(".zeros.build")) return url;
    // Marketing alias still in the wild (docs/auth-simplification-plan.md).
    if (host === "zeros.design" || host.endsWith(".zeros.design")) return url;
  } catch {
    /* not a URL */
  }
  return fallback;
}

/** safeReturn with env-aware fallback (APP_ORIGIN). */
export function safeReturnFor(env: Env, url: string | null): string {
  return safeReturn(url, `${appOrigin(env)}/`);
}

const SOCIAL_CONNECTIONS: Record<string, string> = {
  google: "google-oauth2",
  github: "github",
};

/** Build the Auth0 /authorize URL for a specific social connection — pins the
 *  `connection` so Auth0 skips its own account-picker and goes straight to the
 *  provider, matching the "Continue with X" UX.
 *
 *  Deliberately NO `prompt` parameter: `prompt=consent` forces AUTH0'S OWN
 *  "Authorize App" interstitial on every login (tried 2026-07-06, reverted) —
 *  it does NOT resurface Google/GitHub's consent pages. The providers show
 *  their real consent exactly once, on a user's first-ever authorization, then
 *  silently re-approve — the standard first-party UX. Pair with the API's
 *  "Allow Skipping User Consent" setting in the Auth0 dashboard so first-time
 *  users never see Auth0's interstitial either. */
export function authorizeUrl(
  env: Env,
  opts: { provider: string; state: string; codeChallenge: string },
): string {
  const connection = SOCIAL_CONNECTIONS[opts.provider];
  if (!connection) throw new Error(`unknown provider: ${opts.provider}`);
  const p = new URLSearchParams({
    response_type: "code",
    client_id: env.AUTH0_CLIENT_ID,
    redirect_uri: redirectUri(env),
    scope: "openid profile email offline_access",
    audience: env.AUTH0_AUDIENCE || DEFAULT_AUDIENCE,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    connection,
  });
  return `https://${env.AUTH0_DOMAIN}/authorize?${p.toString()}`;
}

export function isKnownProvider(provider: string): boolean {
  return provider in SOCIAL_CONNECTIONS;
}

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  expires_in: number;
};

export async function exchangeCode(
  env: Env,
  opts: { code: string; codeVerifier: string },
): Promise<TokenResponse> {
  const res = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: env.AUTH0_CLIENT_ID,
      client_secret: env.AUTH0_CLIENT_SECRET,
      code: opts.code,
      redirect_uri: redirectUri(env),
      code_verifier: opts.codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`Auth0 token exchange failed: ${res.status}`);
  return res.json();
}

// Namespace our Post-Login Action stamps custom claims under (Auth0 requires
// custom claims to be namespaced). Keep in sync with backend/src/auth.ts CLAIM_NS
// and the Action. The id_token natively carries email/email_verified for the
// `email` scope, so these reads prefer the namespaced claim and fall back to the
// native one — robust whether or not the Action also stamps the id_token.
const CLAIM_NS = "https://zeros.build/";

function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split(".")[1] ?? "";
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json);
}

function claimStr(claims: Record<string, unknown>, key: string): string {
  const ns = claims[CLAIM_NS + key];
  if (typeof ns === "string") return ns;
  const top = claims[key];
  return typeof top === "string" ? top : "";
}

function claimBool(claims: Record<string, unknown>, key: string): boolean {
  const ns = claims[CLAIM_NS + key];
  if (typeof ns === "boolean") return ns;
  return claims[key] === true;
}

/** Create a browser session in KV from a fresh Auth0 token response, returning
 *  the opaque session id to set as the SESSION_COOKIE value. Rejects an
 *  unverified email — the invitation accept flow trusts email as its sole
 *  anti-takeover control (docs/teams.md Part F). */
export async function createSession(
  env: Env,
  tokens: TokenResponse,
): Promise<{ sessionId: string; email: string; emailVerified: boolean }> {
  if (!env.SESSIONS) {
    throw new Error(
      "SESSIONS KV binding is not configured on this Pages project/environment — check Settings > Functions > KV namespace bindings.",
    );
  }
  const claims = decodeIdTokenClaims(tokens.id_token);
  // Fail CLOSED: only an explicit `email_verified: true` counts. A MISSING claim
  // is treated as unverified — the invitation accept flow trusts email as its
  // sole anti-takeover control, so a connection that omits the claim must not be
  // silently trusted. Google/GitHub both stamp it on the OIDC id_token; if a
  // future connection doesn't, verify its claim mapping rather than loosening
  // this. (Backend mirrors this in backend/src/auth.ts.)
  const emailVerified = claimBool(claims, "email_verified");
  const sessionId = randomToken();
  const data: SessionData = {
    sub: claimStr(claims, "sub"),
    email: claimStr(claims, "email"),
    name: claimStr(claims, "name") || null,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    verifiedAt: Date.now(), // just proven live via the code exchange
  };
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(data), {
    expirationTtl: SESSION_TTL_S,
  });
  return { sessionId, email: data.email, emailVerified };
}

export function sessionCookie(sessionId: string): PendingCookie {
  return { name: SESSION_COOKIE, value: sessionId, options: { maxAge: SESSION_TTL_S } };
}

/** Expire the session cookie in BOTH scopes: the new host-only cookie and the
 *  legacy Domain=.zeros.build one written by the retired auth.zeros.build
 *  project (they are distinct cookies to the browser; clearing one does not
 *  clear the other). */
export function clearSessionCookies(pending: PendingCookie[]): void {
  pending.push({ name: SESSION_COOKIE, value: "", options: { maxAge: 0 } });
  pending.push({ name: SESSION_COOKIE, value: "", options: { maxAge: 0, domainWide: true } });
}
