// Provider-neutral browser-session facade. Auth0 compatibility sessions remain
// in KV; WorkOS sessions are opaque-cookie lookups into a strongly consistent
// Durable Object and never expose refresh material to Pages or the browser.
//
import {
  configuredAuthProvider,
  readWorkOSBrowserSession,
  refreshWorkOSBrowserSession,
} from "./workos-browser.mjs";

export interface Env {
  /** Explicit deployment identity. Required by the Cloudflare build guard. */
  ZEROS_DEPLOY_ENV?: "alpha" | "beta" | "production";
  /** Selects the compatibility Auth0 flow or the WorkOS browser flow. */
  AUTH_PROVIDER?: "auth0" | "workos";
  AUTH0_DOMAIN: string;
  AUTH0_CLIENT_ID: string;
  AUTH0_CLIENT_SECRET: string;
  /** Auth0 API identifier (defaults in lib/oauth.ts to https://api.zeros.build). */
  AUTH0_AUDIENCE?: string;
  /**
   * Canonical app origin (no trailing slash). Defaults to https://app.zeros.build.
   * Used for Auth0 redirect_uri, hub self-URLs, and marketing→app redirects.
   */
  APP_ORIGIN?: string;
  /** Comma-separated app hostnames. Defaults to hostname of APP_ORIGIN. */
  APP_HOSTS?: string;
  /**
   * Canonical marketing origin (no trailing slash). Defaults to https://zeros.build.
   * Used when linking off the invite page, etc.
   */
  MARKETING_ORIGIN?: string;
  /**
   * Comma-separated marketing hostnames that should serve the SPA (not the hub).
   * Defaults to zeros.build,www.zeros.build,zeros.design.
   */
  MARKETING_HOSTS?: string;
  /** Authenticated organization API. Defaults to https://api.zeros.build. */
  CONTROL_PLANE_URL?: string;
  /** WorkOS webhook verification and the independent broker-to-resource-server
   * credential. Neither value is the WorkOS API key. */
  WORKOS_WEBHOOK_SECRET?: string;
  AUTH_BROKER_SECRET?: string;
  SESSIONS: KVNamespace;
  /** Strong WorkOS flow/session authority, hosted by session-worker/worker.ts. */
  AUTH_SESSIONS?: DurableObjectNamespace;
  /**
   * Cloudflare Pages static-asset binding. Used by `_middleware.ts` to serve the
   * marketing SPA on marketing hosts without running app Functions (which would
   * otherwise win on `/` via functions/index.ts).
   */
  ASSETS: Fetcher;
}

export type SessionData = {
  sub: string;
  email: string;
  name: string | null;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms of the last time this session was proven live against Auth0
   *  (created or successfully refreshed). Drives periodic revalidation so a
   *  deleted/blocked user's 30-day KV session doesn't keep showing "signed in".
   *  Optional: sessions minted before this field existed revalidate on next read. */
  verifiedAt?: number;
};

export type SessionSnapshot = {
  sessionId: string;
  data: SessionData;
  /** A transient WorkOS refresh failure retains identity/session state but has
   *  no bearer that should be sent upstream until a later retry succeeds. */
  refreshStatus?: "active" | "transient";
};

export const SESSION_COOKIE = "zeros_session";
export const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days — the KV entry's TTL

/** How stale a session may get before the next read re-proves it against Auth0.
 *  A KV session is otherwise a 30-day cache that never rechecks the IdP. */
export const SESSION_REVALIDATE_AFTER_MS = 60 * 60 * 24 * 1000; // 24h

export function parseCookieHeader(header: string): { name: string; value: string }[] {
  if (!header) return [];
  const out: { name: string; value: string }[] = [];
  for (const part of header.split(";")) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf("=");
    out.push({
      name: eq === -1 ? seg : seg.slice(0, eq),
      value: eq === -1 ? "" : seg.slice(eq + 1),
    });
  }
  return out;
}

/** Read the live browser session (cookie → KV lookup), with its session id —
 *  needed by callers that may write an updated session back (see refreshGrant's
 *  rotation note). Returns null if signed out or the session has expired/been
 *  evicted. */
export async function getSessionWithId(
  env: Env,
  request: Request,
): Promise<SessionSnapshot | null> {
  if (configuredAuthProvider(env) === "workos") {
    return readWorkOSBrowserSession(env, request);
  }
  if (!env.SESSIONS) {
    throw new Error(
      "SESSIONS KV binding is not configured on this Pages project/environment — check Settings > Functions > KV namespace bindings.",
    );
  }
  const cookies = parseCookieHeader(request.headers.get("Cookie") ?? "");
  const sessionId = cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!sessionId) return null;
  const raw = await env.SESSIONS.get(`session:${sessionId}`);
  return raw ? { sessionId, data: JSON.parse(raw) as SessionData } : null;
}

/** Convenience wrapper for callers that only need the session data. */
export async function getSession(env: Env, request: Request): Promise<SessionData | null> {
  const result = await getSessionWithId(env, request);
  return result?.data ?? null;
}

/** Like getSession, but re-proves the session against Auth0 once it's older than
 *  SESSION_REVALIDATE_AFTER_MS. Returns null (and clears the KV record) if the
 *  refresh grant is terminally rejected — i.e. the user was deleted, blocked, or
 *  their tokens revoked — so the hub stops rendering "signed in" for a dead
 *  account. Transient Auth0 outages keep the session (fail safe). Use this on
 *  page-render paths; mint/redeem already refresh, so they use getSession*.
 *
 *  Rotation-race guard: with Refresh Token Rotation on, two concurrent tabs
 *  could each consume the same refresh token — the loser gets invalid_grant and
 *  would wrongly nuke a LIVE session. A short KV lock collapses that to one
 *  revalidation at a time (best-effort; KV isn't atomic, but it removes the
 *  common multi-tab case). */
export async function getVerifiedSessionWithId(
  env: Env,
  request: Request,
): Promise<SessionSnapshot | null> {
  // The WorkOS coordinator refreshes before returning a near-expiry access
  // token and serializes every exchange for this opaque session id.
  if (configuredAuthProvider(env) === "workos") {
    return getSessionWithId(env, request);
  }
  const found = await getSessionWithId(env, request);
  if (!found) return null;
  const { sessionId, data } = found;

  const age = Date.now() - (data.verifiedAt ?? 0);
  if (age < SESSION_REVALIDATE_AFTER_MS) return found; // still fresh
  if (!data.refreshToken) return found; // nothing to re-prove with; leave as-is

  const lockKey = `reval-lock:${sessionId}`;
  if (await env.SESSIONS.get(lockKey)) return found; // another request is on it
  await env.SESSIONS.put(lockKey, "1", { expirationTtl: 60 });

  const granted = await refreshGrant(env, data.refreshToken);
  if (granted.ok) {
    const updated: SessionData = {
      ...data,
      accessToken: granted.data.access_token,
      refreshToken: granted.data.refresh_token ?? data.refreshToken,
      verifiedAt: Date.now(),
    };
    await putSession(env, sessionId, updated, SESSION_TTL_S);
    return { sessionId, data: updated };
  }
  if (granted.terminal) {
    await env.SESSIONS.delete(`session:${sessionId}`);
    return null;
  }
  return found; // transient outage — keep the session, retry on the next read
}

/** Verified session data for page-render callers that do not need to rotate it
 * again. API proxy callers use the with-id variant so verification and
 * upstream authorization share one coherent KV snapshot. */
export async function getVerifiedSession(
  env: Env,
  request: Request,
): Promise<SessionData | null> {
  const found = await getVerifiedSessionWithId(env, request);
  return found?.data ?? null;
}

type RefreshResponse = { access_token: string; refresh_token?: string; expires_in: number };

/** Outcome of a refresh-grant call, split so callers can tell a genuinely dead
 *  refresh token apart from a momentary outage:
 *    • ok        — a fresh token pair.
 *    • terminal  — Auth0 rejected the GRANT itself (token expired/revoked/reused
 *                  under rotation). The refresh token is dead; clear the session.
 *    • transient — couldn't reach Auth0, or it answered 429/5xx. The token may
 *                  still be perfectly valid, so the caller MUST keep it and retry
 *                  rather than sign the user out on a network blip. */
export type RefreshResult =
  | { ok: true; data: RefreshResponse }
  | { ok: false; terminal: boolean };

export type BrowserSessionRefreshResult =
  | { ok: true; data: SessionData }
  | { ok: false; terminal: boolean };

/** Refresh the selected provider's browser session. WorkOS performs and
 * persists the rotation inside the per-session Durable Object. Auth0 retains
 * the released KV behavior until the compatibility provider is removed. */
export async function refreshBrowserSession(
  env: Env,
  sessionId: string,
  current: SessionData,
): Promise<BrowserSessionRefreshResult> {
  if (configuredAuthProvider(env) === "workos") {
    const result = await refreshWorkOSBrowserSession(env, sessionId);
    if (result.status === "active") return { ok: true, data: result.data };
    return { ok: false, terminal: result.status === "terminal" };
  }
  if (!current.refreshToken) return { ok: false, terminal: false };
  const granted = await refreshGrant(env, current.refreshToken);
  if (!granted.ok) return granted;
  const updated: SessionData = {
    ...current,
    accessToken: granted.data.access_token,
    refreshToken: granted.data.refresh_token ?? current.refreshToken,
    verifiedAt: Date.now(),
  };
  await putSession(env, sessionId, updated, SESSION_TTL_S);
  return { ok: true, data: updated };
}

/** One extra /oauth/token refresh-grant call against Auth0, producing a token
 *  pair distinct from whatever the browser hub is currently holding — this is
 *  what makes the desktop's handoff session independently revocable rather than
 *  a literal copy of the browser's tokens.
 *
 *  NOTE: whether this call rotates the underlying Auth0 refresh token (and thus
 *  requires writing the rotated value back into the browser's own KV session so
 *  its NEXT refresh doesn't fail) depends on the tenant's Refresh Token Rotation
 *  setting — verify against the Auth0 dashboard during setup. This function
 *  always returns the response verbatim; the caller decides what to persist
 *  where. */
export async function refreshGrant(env: Env, refreshToken: string): Promise<RefreshResult> {
  let res: Response;
  try {
    res = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: env.AUTH0_CLIENT_ID,
        client_secret: env.AUTH0_CLIENT_SECRET,
        refresh_token: refreshToken,
      }),
    });
  } catch {
    // Network/DNS/TLS failure reaching Auth0 — transient, do NOT treat the
    // refresh token as dead.
    return { ok: false, terminal: false };
  }
  if (res.ok) {
    try {
      return { ok: true, data: (await res.json()) as RefreshResponse };
    } catch {
      return { ok: false, terminal: false };
    }
  }
  // Only an explicit Auth0 rejection of the grant is terminal (invalid_grant on
  // a 400, or an auth failure). 429 and 5xx are transient — Auth0 is momentarily
  // unavailable, the refresh token is likely still valid, so fail SAFE (keep it).
  let errorCode = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    errorCode = typeof body.error === "string" ? body.error : "";
  } catch {
    /* non-JSON error body — fall through to status-based classification */
  }
  const terminal =
    res.status === 401 ||
    res.status === 403 ||
    (res.status === 400 && errorCode === "invalid_grant");
  return { ok: false, terminal };
}

export async function putSession(env: Env, sessionId: string, data: SessionData, ttlSeconds: number): Promise<void> {
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(data), { expirationTtl: ttlSeconds });
}
