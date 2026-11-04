// Browser-session facade. WorkOS sessions are opaque-cookie lookups through the
// control plane and never expose refresh material to Pages or the browser.

import {
  readWorkOSBrowserSession,
  refreshWorkOSBrowserSession,
} from "./workos-browser.mjs";

export interface Env {
  /** Explicit deployment identity. Required by the Cloudflare build guard. */
  ZEROS_DEPLOY_ENV?: "alpha" | "beta" | "production";
  /** Separate Pages projects use the same code with an isolated host surface. */
  ZEROS_SURFACE?: "app" | "ops";
  /**
   * Canonical app origin (no trailing slash). Defaults to https://app.zeros.build.
   * Used for hub self-URLs and marketing→app redirects.
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

/** Read the opaque session cookie through the control plane. */
export async function getSessionWithId(
  env: Env,
  request: Request,
): Promise<SessionSnapshot | null> {
  return readWorkOSBrowserSession(env, request);
}

/** The control plane re-proves every WorkOS session it reads, so a verified
 * read is the same lookup; the name stays for callers that need that promise. */
export async function getVerifiedSessionWithId(
  env: Env,
  request: Request,
): Promise<SessionSnapshot | null> {
  return getSessionWithId(env, request);
}

export type BrowserSessionRefreshResult =
  | { ok: true; data: SessionData; revision?: number }
  | { ok: false; terminal: boolean };

/** Refresh under the control plane's durable session authority. */
export async function refreshBrowserSession(
  env: Env,
  sessionId: string,
  _current: SessionData,
  revision?: number,
): Promise<BrowserSessionRefreshResult> {
  const result = await refreshWorkOSBrowserSession(env, sessionId, revision);
  if (result.status === "active") return { ok: true, data: result.data };
  return { ok: false, terminal: result.status === "terminal" };
}
