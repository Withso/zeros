// Provider-neutral browser-session facade. Auth0 compatibility sessions
// use a PostgreSQL authority; WorkOS sessions are opaque-cookie lookups through
// the control plane and never expose refresh material to Pages or the browser.
//
import {
  configuredAuthProvider,
  readWorkOSBrowserSession,
  refreshWorkOSBrowserSession,
} from "./workos-browser.mjs";

import { auth0SessionAuthority } from "./auth0-session-authority";

export interface Env {
  /** Explicit deployment identity. Required by the Cloudflare build guard. */
  ZEROS_DEPLOY_ENV?: "alpha" | "beta" | "production";
  /** Separate Pages projects use the same code with an isolated host surface. */
  ZEROS_SURFACE?: "app" | "ops";
  /** Selects the compatibility Auth0 flow or the WorkOS browser flow. */
  AUTH_PROVIDER?: "auth0" | "workos";
  AUTH0_DOMAIN: string;
  AUTH0_CLIENT_ID: string;
  AUTH0_CLIENT_SECRET: string;
  /** Server-only key shared with the PostgreSQL session authority. */
  AUTH0_SESSION_AUTHORITY_KEY?: string;
  /** Auth0 API identifier (defaults in lib/oauth.ts to https://api.zeros.build). */
  AUTH0_AUDIENCE?: string;
  /**
   * Canonical app origin (no trailing slash). Defaults to https://app.zeros.build.
   * Used for Auth0 redirect_uri, hub self-URLs, and marketing→app redirects.
   */
  APP_ORIGIN?: string;
  /** Comma-separated app hostnames. Defaults to hostname of APP_ORIGIN. */
  APP_HOSTS?: string;
  /** Upstream Railway namespace for the isolated Ops browser session. */
  WORKOS_BROWSER_ROUTE_PREFIX?: "" | "/ops";
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
  SESSIONS: KVNamespace;
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
   *  deleted/blocked user's 30-day session doesn't keep showing "signed in".
   *  Optional: sessions minted before this field existed revalidate on next read. */
  verifiedAt?: number;
};

export type SessionSnapshot = {
  sessionId: string;
  data: SessionData;
  /** A transient WorkOS refresh failure retains identity/session state but has
   *  no bearer that should be sent upstream until a later retry succeeds. */
  refreshStatus?: "active" | "transient";
  /** Railway session revision observed with this bearer. */
  revision?: number;
};

export const SESSION_COOKIE = "zeros_session";
export const SESSION_TTL_S = 60 * 60 * 24 * 30; // Immutable absolute browser-session lifetime

/** How stale a session may get before the next read re-proves it against Auth0.
 * Durable revocation and the absolute expiry are checked on every read. */
export const SESSION_REVALIDATE_AFTER_MS = 60 * 60 * 24 * 1000; // 24h

export function parseCookieHeader(
  header: string,
): { name: string; value: string }[] {
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

/** Read the opaque cookie through the selected durable session authority. */
export async function getSessionWithId(
  env: Env,
  request: Request,
): Promise<SessionSnapshot | null> {
  if (configuredAuthProvider(env) === "workos") {
    return readWorkOSBrowserSession(env, request);
  }
  const cookies = parseCookieHeader(request.headers.get("Cookie") ?? "");
  const sessionId = cookies.find(c => c.name === SESSION_COOKIE)?.value;
  if (!sessionId || !/^[A-Za-z0-9_-]{43}$/.test(sessionId)) return null;
  const result = await auth0SessionAuthority(env, { action: "read", sessionId });
  return result.status === "terminal" ? null : {
    sessionId, data: result.data, revision: result.revision,
    refreshStatus: result.status === "busy" ? "transient" : "active",
  };
}

/** Convenience wrapper for callers that only need the session data. */
export async function getSession(
  env: Env,
  request: Request,
): Promise<SessionData | null> {
  const result = await getSessionWithId(env, request);
  return result?.data ?? null;
}

/** Revalidate Auth0 periodically. The durable refresh lease serializes token
 * rotation across regions; no cache write can create or revive a session. */
export async function getVerifiedSessionWithId(
  env: Env,
  request: Request,
): Promise<SessionSnapshot | null> {
  const found = await getSessionWithId(env, request);
  if (!found || configuredAuthProvider(env) === "workos" || found.refreshStatus === "transient") return found;
  if (Date.now() - (found.data.verifiedAt ?? 0) < SESSION_REVALIDATE_AFTER_MS || !found.data.refreshToken) return found;
  const refreshed = await refreshBrowserSession(env, found.sessionId, found.data, found.revision);
  if (refreshed.ok) return { sessionId: found.sessionId, data: refreshed.data, revision: refreshed.revision };
  return refreshed.terminal ? null : { ...found, data: { ...found.data, accessToken: "", refreshToken: null }, refreshStatus: "transient" };
}

/** Verified session data for page-render callers that do not need to rotate it
 * again. API proxy callers use the with-id variant so verification and
 * upstream authorization share one coherent provider snapshot. */
export async function getVerifiedSession(
  env: Env,
  request: Request,
): Promise<SessionData | null> {
  const found = await getVerifiedSessionWithId(env, request);
  return found?.data ?? null;
}

type RefreshResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

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
  | { ok: false; terminal: boolean; ambiguous?: boolean };

export type BrowserSessionRefreshResult =
  | { ok: true; data: SessionData; revision?: number }
  | { ok: false; terminal: boolean };

/** Refresh under the selected provider\'s durable session authority. */
export async function refreshBrowserSession(
  env: Env,
  sessionId: string,
  current: SessionData,
  revision?: number,
): Promise<BrowserSessionRefreshResult> {
  if (configuredAuthProvider(env) === "workos") {
    const result = await refreshWorkOSBrowserSession(env, sessionId, revision);
    if (result.status === "active") return { ok: true, data: result.data };
    return { ok: false, terminal: result.status === "terminal" };
  }
  let admitted;
  try {
    const observed = revision === undefined ? await auth0SessionAuthority(env, { action: "read", sessionId }) : null;
    if (observed?.status === "terminal") return { ok: false, terminal: true };
    if (observed?.status === "busy") return { ok: false, terminal: false };
    admitted = await auth0SessionAuthority(env, { action: "begin", sessionId, revision: revision ?? observed!.revision });
    if (admitted.status === "terminal") return { ok: false, terminal: true };
    if (admitted.status === "busy") return { ok: false, terminal: false };
    if (admitted.status === "active") return { ok: true, data: admitted.data, revision: admitted.revision };
    const lease = admitted.lease!;
    if (!admitted.data.refreshToken) {
      await auth0SessionAuthority(env, { action: "release", sessionId, lease, terminal: false });
      return { ok: false, terminal: false };
    }
    const granted = await refreshGrant(env, admitted.data.refreshToken);
    if (!granted.ok) {
      // A lost provider response may already have rotated the token. Leave the
      // lease fenced until its deadline; never start a second ambiguous grant.
      if (!granted.ambiguous)
        await auth0SessionAuthority(env, { action: "release", sessionId, lease, terminal: granted.terminal });
      return granted;
    }
    const committed = await auth0SessionAuthority(env, { action: "commit", sessionId, lease, data: {
      ...admitted.data, accessToken: granted.data.access_token,
      refreshToken: granted.data.refresh_token ?? admitted.data.refreshToken, verifiedAt: Date.now(),
    } });
    return committed.status === "active"
      ? { ok: true, data: committed.data, revision: committed.revision }
      : { ok: false, terminal: committed.status === "terminal" };
  } catch { return { ok: false, terminal: false }; }
}

/** Exchange the provider grant only while holding the durable refresh lease.
 * The caller commits any rotated token before exposing the replacement bearer.
 * Device capabilities are separately revocable references to this grant;
 * another refresh call does not create an independent provider token family. */
export async function refreshGrant(
  env: Env,
  refreshToken: string,
): Promise<RefreshResult> {
  let res: Response;
  try {
    res = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
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
    return { ok: false, terminal: false, ambiguous: true };
  }
  if (res.ok) {
    try {
      const data = (await res.json()) as RefreshResponse;
      if (typeof data.access_token !== "string" || !data.access_token || data.access_token.length > 32_768 ||
        (data.refresh_token !== undefined && (typeof data.refresh_token !== "string" || !data.refresh_token || data.refresh_token.length > 32_768)) ||
        !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error("Invalid grant");
      return { ok: true, data };
    } catch {
      return { ok: false, terminal: false, ambiguous: true };
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
  return { ok: false, terminal, ambiguous: !terminal && res.status !== 429 };
}
