// Host-aware gate for the unified zeros-web Pages project.
//
// Runs before every Functions route. Marketing hosts (zeros.build, …) must
// never execute hub/auth/handoff handlers — those stay on app.zeros.build.
//
// CRITICAL: calling `next()` on a marketing request for `/` would still invoke
// functions/index.ts (Pages Functions win over static). So marketing traffic
// is served via env.ASSETS.fetch() and never reaches app Functions.

import {
  applyHostHeaders,
  classifyHost,
  isAppOnlyPath,
  appOrigin,
  normalizeMarketingPath,
  robotsTxt,
  type HostKind,
} from "../lib/hosts";
import type { Env } from "../lib/session";

/** Marketing client routes that must fall back to the SPA entrypoint.
 *  KEEP IN SYNC with apps/marketing/src/routes.tsx and the SPA_REDIRECTS
 *  list in scripts/assemble-marketing.mjs — middleware does this explicitly
 *  because env.ASSETS.fetch() does not always honor _redirects the same way as
 *  a bare static hit (observed as 308→/ for /changelog under wrangler pages
 *  dev). Anything NOT listed here gets the static 404.html. */
const MARKETING_SPA_PATHS = new Set(["/changelog", "/privacy", "/terms"]);

function withHeaders(res: Response, kind: HostKind): Response {
  return applyHostHeaders(res, kind);
}

async function fetchMarketingAsset(
  env: Env,
  request: Request,
  url: URL,
): Promise<Response> {
  const path = normalizeMarketingPath(url.pathname);
  // Known client routes → always serve index.html (the SPA resolver takes over).
  if (MARKETING_SPA_PATHS.has(path)) {
    return env.ASSETS.fetch(new URL("/index.html", url.origin).toString());
  }
  return env.ASSETS.fetch(request);
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const kind = classifyHost(url.hostname, env);

  // Host-specific robots.txt (static public/robots.txt is app-only Disallow;
  // marketing must stay crawlable for zeros.build SEO + schema discovery).
  if (url.pathname === "/robots.txt" && request.method === "GET") {
    return withHeaders(robotsTxt(kind), kind);
  }

  if (kind === "marketing") {
    // App surfaces must not be reachable on the marketing host (would mint
    // host-only cookies on the wrong origin / confuse users).
    if (isAppOnlyPath(url.pathname)) {
      const target = new URL(url.pathname + url.search, appOrigin(env));
      return withHeaders(Response.redirect(target.toString(), 302), kind);
    }
    // Serve the assembled marketing SPA (and SPA-fallback known client routes).
    // Do NOT call next() — that would run functions/index.ts on `/`.
    const res = await fetchMarketingAsset(env, request, url);
    return withHeaders(res, kind);
  }

  // App host: run the matching Functions route (or static fallback).
  const res = await next();
  return withHeaders(res, kind);
};
