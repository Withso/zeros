const WORKOS_PROVIDERS = new Map([
  ["google", "GoogleOAuth"],
  ["github", "GitHubOAuth"],
]);

export const WORKOS_FLOW_COOKIE = "__Host-zeros_auth_flow";
export const WORKOS_SESSION_COOKIE = "__Host-zeros_session";
export const WORKOS_FLOW_TTL_S = 10 * 60;
export const WORKOS_SESSION_TTL_S = 30 * 24 * 60 * 60;

const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;
const INTERNAL_ORIGIN = "https://auth-session.internal";

function appOrigin(env) {
  return (env.APP_ORIGIN || "https://app.zeros.build").replace(/\/+$/, "");
}

function randomOpaqueId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookies(request) {
  const parsed = new Map();
  for (const segment of (request.headers.get("cookie") || "").split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    const name = equals < 0 ? trimmed : trimmed.slice(0, equals);
    if (!parsed.has(name)) parsed.set(name, equals < 0 ? "" : trimmed.slice(equals + 1));
  }
  return parsed;
}

function serializeHostCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure; HttpOnly`;
}

function expireCookie(name, { domainWide = false } = {}) {
  return `${name}=; ${domainWide ? "Domain=.zeros.build; " : ""}Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`;
}

function appendSessionCleanup(headers) {
  headers.append("set-cookie", expireCookie(WORKOS_SESSION_COOKIE));
  headers.append("set-cookie", expireCookie("zeros_session"));
  headers.append("set-cookie", expireCookie("zeros_session", { domainWide: true }));
}

function appendFlowCleanup(headers) {
  headers.append("set-cookie", expireCookie(WORKOS_FLOW_COOKIE));
  for (const name of ["zeros_pkce_verifier", "zeros_oauth_state", "zeros_return_to"]) {
    headers.append("set-cookie", expireCookie(name));
  }
}

function failureResponse(reason) {
  const descriptions = {
    missing_callback: "The sign-in link was missing required callback data.",
    invalid_flow: "This sign-in attempt expired, was already used, or did not match this browser.",
    email_unverified: "Verify your email address with the provider before continuing.",
    exchange_failed: "The sign-in service could not complete this attempt.",
    provider_error: "The identity provider did not complete this attempt.",
    unavailable: "The sign-in service is temporarily unavailable.",
  };
  const message = descriptions[reason] || descriptions.unavailable;
  return new Response(`Sign-in didn't finish. ${message} Nothing was changed; please try again.`, {
    status: 400,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function binding(env) {
  if (!env.AUTH_SESSIONS) {
    throw new Error("AUTH_SESSIONS Durable Object binding is not configured");
  }
  return env.AUTH_SESSIONS;
}

function stubFor(env, opaqueId) {
  if (!OPAQUE_ID.test(opaqueId)) return null;
  const namespace = binding(env);
  return namespace.get(namespace.idFromName(opaqueId));
}

async function coordinatorRequest(env, opaqueId, pathname, init = {}) {
  const stub = stubFor(env, opaqueId);
  if (!stub) return null;
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return stub.fetch(
    new Request(`${INTERNAL_ORIGIN}${pathname}`, {
      method: init.method || (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

function safeJson(response) {
  return response.json().catch(() => null);
}

function validSessionData(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.sub === "string" &&
    typeof value.email === "string" &&
    (typeof value.name === "string" || value.name === null) &&
    typeof value.accessToken === "string" &&
    value.refreshToken === null &&
    typeof value.verifiedAt === "number"
  );
}

export function workosProvider(provider) {
  return WORKOS_PROVIDERS.get(provider) || null;
}

export function configuredAuthProvider(env) {
  const provider = (env.AUTH_PROVIDER || "auth0").trim().toLowerCase();
  if (provider === "auth0" || provider === "workos") return provider;
  throw new Error("AUTH_PROVIDER must be auth0 or workos");
}

export function legacyDesktopHandoffEnabled(env) {
  return configuredAuthProvider(env) === "auth0";
}

export function safeWorkOSReturnPath(raw, origin) {
  if (!raw) return "/";
  try {
    const expected = new URL(origin);
    const target = new URL(raw, expected);
    if (target.origin !== expected.origin || target.username || target.password) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

export function workosFlowCookie(opaqueId) {
  if (!OPAQUE_ID.test(opaqueId)) throw new TypeError("invalid opaque flow id");
  return serializeHostCookie(WORKOS_FLOW_COOKIE, opaqueId, WORKOS_FLOW_TTL_S);
}

export function workosSessionCookie(opaqueId) {
  if (!OPAQUE_ID.test(opaqueId)) throw new TypeError("invalid opaque session id");
  return serializeHostCookie(WORKOS_SESSION_COOKIE, opaqueId, WORKOS_SESSION_TTL_S);
}

export function isWorkOSSessionId(value) {
  return OPAQUE_ID.test(value);
}

export async function beginWorkOSBrowserAuth(request, env, options = {}) {
  const url = new URL(request.url);
  const provider = workosProvider(url.searchParams.get("provider") || "");
  if (!provider) return new Response("Unknown provider", { status: 400 });

  const origin = appOrigin(env);
  const returnPath = safeWorkOSReturnPath(url.searchParams.get("return"), origin);
  const sessionId = (options.randomId || randomOpaqueId)();
  if (!OPAQUE_ID.test(sessionId)) throw new Error("random session id has an invalid shape");

  let response;
  try {
    response = await coordinatorRequest(env, sessionId, "/flow/start", {
      body: { provider, returnPath },
    });
  } catch {
    return failureResponse("unavailable");
  }
  if (!response || response.status !== 201) return failureResponse("unavailable");
  const result = await safeJson(response);
  if (!result || typeof result.authorizationUrl !== "string") {
    return failureResponse("unavailable");
  }
  let authorizationUrl;
  try {
    authorizationUrl = new URL(result.authorizationUrl);
    if (authorizationUrl.protocol !== "https:") throw new Error("unsafe authorization URL");
  } catch {
    return failureResponse("unavailable");
  }

  const headers = new Headers({ location: authorizationUrl.toString(), "cache-control": "no-store" });
  headers.append("set-cookie", workosFlowCookie(sessionId));
  return new Response(null, { status: 303, headers });
}

export async function finishWorkOSBrowserAuth(request, env) {
  const url = new URL(request.url);
  const cookie = cookies(request);
  const sessionId = cookie.get(WORKOS_FLOW_COOKIE) || "";
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error_description") || url.searchParams.get("error");

  if (providerError || !code || !state || !OPAQUE_ID.test(sessionId)) {
    if (OPAQUE_ID.test(sessionId)) {
      try {
        await coordinatorRequest(env, sessionId, "/flow/cancel", { body: {} });
      } catch {
        // The browser cookie is still cleared below. The abandoned flow has a
        // ten-minute Durable Object alarm and cannot create a session itself.
      }
    }
    const failed = failureResponse(providerError ? "provider_error" : "missing_callback");
    appendFlowCleanup(failed.headers);
    return failed;
  }

  let response;
  try {
    response = await coordinatorRequest(env, sessionId, "/flow/complete", {
      body: { code, state },
    });
  } catch {
    response = null;
  }
  const result = response ? await safeJson(response) : null;
  if (!response || !response.ok || !result?.ok) {
    const failed = failureResponse(
      typeof result?.reason === "string" ? result.reason : "unavailable",
    );
    appendFlowCleanup(failed.headers);
    return failed;
  }

  const returnPath = safeWorkOSReturnPath(result.returnPath, appOrigin(env));
  const headers = new Headers({
    location: new URL(returnPath, `${appOrigin(env)}/`).toString(),
    "cache-control": "no-store",
  });
  headers.append("set-cookie", workosSessionCookie(sessionId));
  appendFlowCleanup(headers);
  // Remove every Auth0-era browser session cookie so provider selection can
  // never depend on header ordering during the compatibility window.
  headers.append("set-cookie", expireCookie("zeros_session"));
  headers.append("set-cookie", expireCookie("zeros_session", { domainWide: true }));
  return new Response(null, { status: 303, headers });
}

export async function readWorkOSBrowserSession(env, request) {
  const sessionId = cookies(request).get(WORKOS_SESSION_COOKIE) || "";
  if (!OPAQUE_ID.test(sessionId)) return null;
  const response = await coordinatorRequest(env, sessionId, "/session");
  if (!response || response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error("WorkOS session coordinator is unavailable");
  const result = await safeJson(response);
  if (
    !result ||
    !["active", "transient"].includes(result.status) ||
    !validSessionData(result.data)
  ) {
    throw new Error("WorkOS session coordinator returned an invalid response");
  }
  return {
    sessionId,
    data: result.data,
    refreshStatus: result.status,
  };
}

export async function refreshWorkOSBrowserSession(env, sessionId) {
  if (!OPAQUE_ID.test(sessionId)) return { status: "terminal", reason: "invalid_session" };
  let response;
  try {
    response = await coordinatorRequest(env, sessionId, "/session/refresh", { body: {} });
  } catch {
    return { status: "transient", reason: "unavailable" };
  }
  const result = response ? await safeJson(response) : null;
  if (!result || !["active", "transient", "terminal"].includes(result.status)) {
    return { status: "transient", reason: "unavailable" };
  }
  return result;
}

export async function logoutWorkOSBrowserSession(request, env) {
  const origin = appOrigin(env);
  const url = new URL(request.url);
  const returnPath = safeWorkOSReturnPath(url.searchParams.get("return"), origin);
  const returnTo = new URL(returnPath, `${origin}/`).toString();
  const sessionId = cookies(request).get(WORKOS_SESSION_COOKIE) || "";
  let location = returnTo;

  if (OPAQUE_ID.test(sessionId)) {
    try {
      const response = await coordinatorRequest(env, sessionId, "/session/logout", {
        body: { returnTo },
      });
      const result = response ? await safeJson(response) : null;
      if (response?.ok && typeof result?.logoutUrl === "string") {
        const logoutUrl = new URL(result.logoutUrl);
        if (logoutUrl.protocol === "https:") location = logoutUrl.toString();
      }
    } catch {
      // Clearing the opaque browser credential is unconditional. A copied
      // credential remains bounded by the server-side maximum-session alarm.
    }
  }

  const headers = new Headers({ location, "cache-control": "no-store" });
  appendSessionCleanup(headers);
  appendFlowCleanup(headers);
  return new Response(null, { status: 303, headers });
}
