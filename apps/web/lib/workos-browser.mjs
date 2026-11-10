import { fetchWorkOSRailway } from "./workos-railway.mjs";
import { readBoundedResponseBody } from "./control-plane-policy.mjs";
import { PROVIDER_LOGOS, shell } from "./page.ts";

export const WORKOS_FLOW_COOKIE = "__Host-zeros_auth_flow";
export const WORKOS_SESSION_COOKIE = "__Host-zeros_session";
/** Railway's one-time Hosted AuthKit hand-off marker; its only value is "1". */
export const WORKOS_HANDOFF_COOKIE = "__Host-zeros_auth_handoff";

const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;
const MAX_RAILWAY_SESSION_BYTES = 256 * 1024;

// The sign-in page's two choices. Each starts that provider directly; every
// other start (Ops, a workspace page, a step-up) stays on Hosted AuthKit.
const SOCIAL_PROVIDERS = Object.freeze([
  { provider: "google", label: "Continue with Google" },
  { provider: "github", label: "Continue with GitHub" },
]);
const SOCIAL_PROVIDER_IDS = new Set(SOCIAL_PROVIDERS.map((entry) => entry.provider));

function routePrefix(env) {
  const prefix = String(env.WORKOS_BROWSER_ROUTE_PREFIX || "").trim();
  if (prefix !== "" && prefix !== "/ops") {
    throw new Error("WORKOS_BROWSER_ROUTE_PREFIX must be empty or /ops");
  }
  return prefix;
}

function upstreamBrowserPath(env, pathname) {
  return `${routePrefix(env)}${pathname}`;
}

function cookies(request) {
  const parsed = new Map();
  for (const segment of (request.headers.get("cookie") || "").split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    const name = equals < 0 ? trimmed : trimmed.slice(0, equals);
    if (!parsed.has(name)) {
      parsed.set(name, equals < 0 ? "" : trimmed.slice(equals + 1));
    }
  }
  return parsed;
}

async function safeJson(response) {
  const bounded = await readBoundedResponseBody(
    response,
    MAX_RAILWAY_SESSION_BYTES,
  );
  if (!bounded.ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bounded.body));
  } catch {
    return null;
  }
}

function validSessionData(value, { allowEmptyBearer = false } = {}) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.sub === "string" &&
    value.sub.length > 0 &&
    typeof value.email === "string" &&
    value.email.length > 0 &&
    (typeof value.name === "string" || value.name === null) &&
    typeof value.accessToken === "string" &&
    (allowEmptyBearer || value.accessToken.length > 0) &&
    value.refreshToken === null &&
    typeof value.verifiedAt === "number"
  );
}

function failureResponse() {
  return new Response(
    shell(
      "Sign-in didn’t finish",
      `<div class="title">Sign-in didn’t finish</div>
          <div class="sub">Sign-in is unavailable right now. Try again shortly.</div>
          <div class="acts"><a class="btn" href="/">Try again</a></div>`,
    ),
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function setCookieValues(headers) {
  // Cloudflare Workers retains getAll() specifically for Set-Cookie, while
  // Node's standards implementation exposes getSetCookie(). Never split the
  // ordinary get() value on commas: Expires attributes may contain commas.
  if (typeof headers.getAll === "function") {
    return headers.getAll("Set-Cookie");
  }
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function browserFacingResponse(upstream) {
  // A fetch() response carries an immutable, origin-facing header guard. Pages
  // must re-home it before returning it to the browser, and Set-Cookie must be
  // appended as distinct fields (RFC 6265 forbids folding them). This matters
  // most on the callback, which sets the session cookie and expires several
  // one-time/compatibility cookies in the same redirect.
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (name.toLowerCase() !== "set-cookie") headers.append(name, value);
  }
  for (const cookie of setCookieValues(upstream.headers)) {
    headers.append("set-cookie", cookie);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyBrowserGet(request, env, pathname, options = {}) {
  const url = new URL(request.url);
  const headers = new Headers();
  const cookieName =
    pathname === "/auth/callback"
      ? WORKOS_FLOW_COOKIE
      : pathname === "/auth/logout"
        ? WORKOS_SESSION_COOKIE
        : null;
  const cookie = cookieName ? cookies(request).get(cookieName) : null;
  const forwarded = [];
  if (cookieName && cookie && OPAQUE_ID.test(cookie)) {
    forwarded.push(`${cookieName}=${cookie}`);
  }
  if (
    pathname === "/auth/callback" &&
    cookies(request).get(WORKOS_HANDOFF_COOKIE) === "1"
  ) {
    forwarded.push(`${WORKOS_HANDOFF_COOKIE}=1`);
  }
  if (forwarded.length > 0) headers.set("cookie", forwarded.join("; "));
  try {
    const upstream = await fetchWorkOSRailway(
      env,
      `${upstreamBrowserPath(env, pathname)}${url.search}`,
      { method: "GET", headers },
      options.fetch || fetch,
    );
    return browserFacingResponse(upstream);
  } catch {
    return failureResponse();
  }
}

/** The signed-out hub's choices: Google and GitHub, each started directly. */
export function browserAuthStartOptions(returnTo) {
  return SOCIAL_PROVIDERS.map(({ provider, label }) => ({
    label,
    provider,
    href: `/auth/start?return=${encodeURIComponent(returnTo)}&provider=${provider}`,
  }));
}

function browserAuthStartButton({ label, provider, href }) {
  return `<a class="btn" href="${href.replaceAll("&", "&amp;")}">${PROVIDER_LOGOS[provider]}${label}</a>`;
}

/** The signed-out hub: one page, Google and GitHub stacked at 260px. */
export function signInPage(returnTo) {
  const buttons = browserAuthStartOptions(returnTo).map(browserAuthStartButton).join("\n            ");
  return shell(
    "Sign in to Zeros",
    `<div class="title">Sign in to Zeros</div>
          <div class="sub">Sign in or create an account to continue.</div>
          <div class="acts stack">
            ${buttons}
          </div>`,
  );
}

/** Cloudflare Pages is a stateless same-origin facade. Railway creates PKCE
 * state and cookies and returns the redirect response unchanged. */
export function beginWorkOSBrowserAuth(request, env, options = {}) {
  const source = new URL(request.url);
  const sanitized = new URL("/auth/start", source.origin);
  const returnTo = source.searchParams.get("return");
  if (returnTo !== null) sanitized.searchParams.set("return", returnTo);
  if (source.searchParams.get("max_age") === "300") {
    sanitized.searchParams.set("max_age", "300");
  }
  // Only the app's sign-in page names a provider; Ops keeps Hosted AuthKit.
  const providers = source.searchParams.getAll("provider");
  if (
    String(env.WORKOS_BROWSER_ROUTE_PREFIX || "").trim() === "" &&
    providers.length === 1 &&
    SOCIAL_PROVIDER_IDS.has(providers[0])
  ) {
    sanitized.searchParams.set("provider", providers[0]);
  }
  return proxyBrowserGet(
    new Request(sanitized, { headers: request.headers }),
    env,
    "/auth/start",
    options,
  );
}

export function finishWorkOSBrowserAuth(request, env, options = {}) {
  return proxyBrowserGet(request, env, "/auth/callback", options);
}

export function logoutWorkOSBrowserSession(request, env, options = {}) {
  return proxyBrowserGet(request, env, "/auth/logout", options);
}

export async function readWorkOSBrowserSession(env, request, options = {}) {
  const sessionId = cookies(request).get(WORKOS_SESSION_COOKIE) || "";
  if (!OPAQUE_ID.test(sessionId)) return null;
  const response = await fetchWorkOSRailway(
    env,
    upstreamBrowserPath(env, "/auth/browser/session"),
    {
      method: "GET",
      headers: {
        accept: "application/json",
        cookie: `${WORKOS_SESSION_COOKIE}=${sessionId}`,
      },
    },
    options.fetch || fetch,
  );
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok)
    throw new Error("Railway WorkOS session service is unavailable");
  const result = await safeJson(response);
  if (
    !result ||
    !["active", "transient"].includes(result.status) ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 1 ||
    !validSessionData(result.data, {
      allowEmptyBearer: result.status === "transient",
    })
  ) {
    throw new Error(
      "Railway WorkOS session service returned an invalid response",
    );
  }
  return {
    sessionId,
    data: result.data,
    refreshStatus: result.status,
    revision: result.revision,
  };
}

export async function refreshWorkOSBrowserSession(
  env,
  sessionId,
  expectedRevision,
  options = {},
) {
  if (!OPAQUE_ID.test(sessionId)) {
    return { status: "terminal", reason: "invalid_session" };
  }
  const headers = new Headers({
    accept: "application/json",
    cookie: `${WORKOS_SESSION_COOKIE}=${sessionId}`,
  });
  if (Number.isSafeInteger(expectedRevision) && expectedRevision > 0) {
    headers.set("x-zeros-session-revision", String(expectedRevision));
  }
  let response;
  try {
    response = await fetchWorkOSRailway(
      env,
      upstreamBrowserPath(env, "/auth/browser/refresh"),
      { method: "POST", headers },
      options.fetch || fetch,
    );
  } catch {
    return { status: "transient", reason: "unavailable" };
  }
  const result = await safeJson(response);
  if (response.status === 401 && result?.status === "terminal") return result;
  if (!response.ok) return { status: "transient", reason: "unavailable" };
  if (
    !result ||
    !["active", "transient", "terminal"].includes(result.status) ||
    (result.status === "active" && !validSessionData(result.data)) ||
    (result.status === "transient" &&
      result.data !== undefined &&
      !validSessionData(result.data, { allowEmptyBearer: true }))
  ) {
    return { status: "transient", reason: "unavailable" };
  }
  return result;
}
