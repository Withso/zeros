import { fetchWorkOSRailway } from "./workos-railway.mjs";

export const WORKOS_FLOW_COOKIE = "__Host-zeros_auth_flow";
export const WORKOS_SESSION_COOKIE = "__Host-zeros_session";

const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;

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

function safeJson(response) {
  return response.json().catch(() => null);
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
    "Sign-in didn't finish. The sign-in service is temporarily unavailable. Nothing was changed; please try again.",
    {
      status: 400,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
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
  if (cookieName && cookie && OPAQUE_ID.test(cookie)) {
    headers.set("cookie", `${cookieName}=${cookie}`);
  }
  try {
    return await fetchWorkOSRailway(
      env,
      `${pathname}${url.search}`,
      { method: "GET", headers },
      options.fetch || fetch,
    );
  } catch {
    return failureResponse();
  }
}

export function configuredAuthProvider(env) {
  const provider = (env.AUTH_PROVIDER || "auth0").trim().toLowerCase();
  if (provider === "auth0" || provider === "workos") return provider;
  throw new Error("AUTH_PROVIDER must be auth0 or workos");
}

/** Keep the legacy provider-pinned links only while Auth0 is the selected
 * rollback path. WorkOS has exactly one application-owned entry point because
 * Hosted AuthKit owns every authentication-method choice. */
export function browserAuthStartOptions(env, returnTo) {
  const returnQuery = `return=${encodeURIComponent(returnTo)}`;
  if (configuredAuthProvider(env) === "workos") {
    return [{ label: "Continue", href: `/auth/start?${returnQuery}` }];
  }
  return [
    {
      label: "Continue with Google",
      href: `/auth/start?provider=google&${returnQuery}`,
    },
    {
      label: "Continue with GitHub",
      href: `/auth/start?provider=github&${returnQuery}`,
    },
  ];
}

export function legacyDesktopHandoffEnabled(env) {
  return configuredAuthProvider(env) === "auth0";
}

/** Cloudflare Pages is a stateless same-origin facade. Railway creates PKCE
 * state and cookies and returns the redirect response unchanged. */
export function beginWorkOSBrowserAuth(request, env, options = {}) {
  const source = new URL(request.url);
  const sanitized = new URL("/auth/start", source.origin);
  const returnTo = source.searchParams.get("return");
  if (returnTo !== null) sanitized.searchParams.set("return", returnTo);
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
    "/auth/browser/session",
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
      "/auth/browser/refresh",
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
