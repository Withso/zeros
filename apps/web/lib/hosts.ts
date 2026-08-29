// Host classification for the unified zeros-web Cloudflare Pages project.
//
// One deployment serves BOTH:
//   • zeros.build (+ www / zeros.design)  → marketing SPA (static)
//   • app.zeros.build                     → hub / auth / handoff / invite
//
// Cloudflare attaches multiple custom domains to the SAME project, so every
// request shares one Functions tree. We branch on hostname (never widen the
// session cookie to Domain=.zeros.build — keep app cookies host-only).

import type { Env } from "./session";

export const DEFAULT_APP_ORIGIN = "https://app.zeros.build";
export const DEFAULT_MARKETING_ORIGIN = "https://zeros.build";

/** Default marketing hostnames when MARKETING_HOSTS env is unset. */
const DEFAULT_MARKETING_HOSTS = [
  "zeros.build",
  "www.zeros.build",
  "zeros.design",
];

export type HostKind = "app" | "marketing";

export function appOrigin(env: Pick<Env, "APP_ORIGIN"> | Env): string {
  const raw = (env.APP_ORIGIN || DEFAULT_APP_ORIGIN).trim();
  return raw.replace(/\/$/, "") || DEFAULT_APP_ORIGIN;
}

export function marketingOrigin(
  env: Pick<Env, "MARKETING_ORIGIN"> | Env,
): string {
  const raw = (env.MARKETING_ORIGIN || DEFAULT_MARKETING_ORIGIN).trim();
  return raw.replace(/\/$/, "") || DEFAULT_MARKETING_ORIGIN;
}

/** Auth0 callback URL — must stay listed in Auth0 Allowed Callback URLs. */
export function redirectUri(env: Pick<Env, "APP_ORIGIN"> | Env): string {
  return `${appOrigin(env)}/auth/callback`;
}

function splitHosts(raw: string | undefined, fallback: string[]): string[] {
  if (!raw || !raw.trim()) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function marketingHosts(
  env: Pick<Env, "MARKETING_HOSTS"> | Env,
): string[] {
  return splitHosts(env.MARKETING_HOSTS, DEFAULT_MARKETING_HOSTS);
}

export function appHosts(
  env: Pick<Env, "APP_ORIGIN" | "APP_HOSTS"> | Env,
): string[] {
  const fromEnv = splitHosts(env.APP_HOSTS, []);
  if (fromEnv.length) return fromEnv;
  try {
    return [new URL(appOrigin(env)).hostname.toLowerCase()];
  } catch {
    return ["app.zeros.build"];
  }
}

export function isMarketingHost(hostname: string, env: Env): boolean {
  return marketingHosts(env).includes(hostname.toLowerCase());
}

export function isAppHost(hostname: string, env: Env): boolean {
  return appHosts(env).includes(hostname.toLowerCase());
}

/**
 * Classify the request host.
 *
 * Unknown hosts (*.pages.dev, localhost, 127.0.0.1) default to **app** so
 * preview/local keep today's hub/auth behavior. To preview marketing on those
 * hosts, set MARKETING_HOSTS to include them (e.g. `127.0.0.1,localhost`).
 */
export function classifyHost(hostname: string, env: Env): HostKind {
  const host = hostname.toLowerCase();
  if (isMarketingHost(host, env)) return "marketing";
  if (isAppHost(host, env)) return "app";
  return "app";
}

/** Match the marketing client's case-insensitive, trailing-slash-tolerant
 * route normalization before deciding whether the edge should serve its SPA
 * entrypoint. */
export function normalizeMarketingPath(pathname: string): string {
  return pathname.length > 1
    ? pathname.replace(/\/+$/, "").toLowerCase()
    : pathname;
}

/** Paths that belong only on the app host — redirect away from marketing. */
export function isAppOnlyPath(pathname: string): boolean {
  return (
    pathname === "/launch" ||
    pathname === "/invite" ||
    pathname === "/github/connected" ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/handoff/")
  );
}

/** Strict CSP for app.zeros.build (inline scripts on hub/invite). */
export const APP_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

/** Marketing CSP — allows Google Fonts used by apps/marketing/index.html. */
export const MARKETING_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

const SHARED_SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** Apply per-host CSP + shared security headers onto a Response. */
export function applyHostHeaders(res: Response, kind: HostKind): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SHARED_SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  if (!headers.has("Content-Security-Policy")) {
    headers.set(
      "Content-Security-Policy",
      kind === "marketing" ? MARKETING_CSP : APP_CSP,
    );
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export function robotsTxt(kind: HostKind): Response {
  const body =
    kind === "marketing"
      ? "User-agent: *\nAllow: /\n"
      : "User-agent: *\nDisallow: /\n";
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
