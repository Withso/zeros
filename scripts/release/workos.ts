import { createHash, createPublicKey, randomBytes, type JsonWebKey } from "node:crypto";
import { PromotionError, requireCheck, type PromotionConfig, type Surface } from "./contracts";

function publicSigningKey(key: Record<string, unknown>): boolean {
  try {
    return typeof key.kid === "string" && key.kid.length > 0 && ["RSA", "EC", "OKP"].includes(String(key.kty)) &&
      !["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(field => Object.hasOwn(key, field)) &&
      createPublicKey({ key: key as JsonWebKey, format: "jwk" }).type === "public";
  } catch { return false; }
}

export function workosVerificationConfig(env: NodeJS.ProcessEnv) {
  try {
    const issuer = new URL(env.AUTH_ISSUER ?? ""), jwks = new URL(env.AUTH_JWKS_URL ?? "");
    requireCheck([issuer, jwks].every(url => url.protocol === "https:" && !url.username && !url.password && !url.hash), "WorkOS verification requires qualified HTTPS issuer and JWKS URLs");
    requireCheck(/^client_[A-Za-z0-9]+$/.test(env.AUTH_WEB_CLIENT_ID ?? "") && /^client_[A-Za-z0-9]+$/.test(env.AUTH_DESKTOP_CLIENT_ID ?? "") &&
      env.AUTH_WEB_CLIENT_ID !== env.AUTH_DESKTOP_CLIENT_ID, "WorkOS verification requires distinct channel Web and Desktop client IDs");
    return { issuerOrigin: issuer.origin, jwksUrl: jwks.href, webClientId: env.AUTH_WEB_CLIENT_ID!, desktopClientId: env.AUTH_DESKTOP_CLIENT_ID! };
  } catch (error) {
    throw error instanceof PromotionError ? error : new PromotionError("WorkOS verification public configuration is missing or invalid");
  }
}

function authorizationRedirect(response: Response, issuerOrigin: string, request: {
  clientId: string; redirectUri: string; state?: string; codeChallenge?: string;
}) {
  requireCheck(response.status === 303 && response.headers.get("cache-control")?.includes("no-store"), "WorkOS sign-in facade is unavailable or cacheable");
  const authorization = new URL(response.headers.get("location") ?? "");
  requireCheck(authorization.origin === issuerOrigin && !authorization.username && !authorization.password && !authorization.hash &&
    authorization.pathname === "/user_management/authorize" && authorization.searchParams.get("client_id") === request.clientId &&
    authorization.searchParams.get("redirect_uri") === request.redirectUri && authorization.searchParams.get("response_type") === "code" &&
    authorization.searchParams.get("provider") === "authkit" && authorization.searchParams.get("code_challenge_method") === "S256" &&
    (request.codeChallenge ? authorization.searchParams.get("code_challenge") === request.codeChallenge : /^[A-Za-z0-9_-]{43}$/.test(authorization.searchParams.get("code_challenge") ?? "")) &&
    (request.state ? authorization.searchParams.get("state") === request.state : /^[A-Za-z0-9_-]{16,256}$/.test(authorization.searchParams.get("state") ?? "")),
  "WorkOS sign-in redirect does not match the channel's qualified PKCE contract");
  return authorization;
}

async function verifyProviderHandshake(authorization: URL, fetcher: typeof fetch) {
  const provider = await fetcher(authorization, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  requireCheck([200, 302, 303].includes(provider.status), "WorkOS rejected the channel authorization handshake");
  if (provider.status !== 200) {
    const location = new URL(provider.headers.get("location") ?? "", authorization);
    requireCheck(location.protocol === "https:" && !location.username && !location.password &&
      !["error", "error_code", "error_description"].some(name => location.searchParams.has(name)), "WorkOS authorization handshake returned an unsafe or rejected destination");
  }
}

export async function verifyWorkOS(config: Pick<PromotionConfig, "channel" | "app" | "ops" | "surfaces">, env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch) {
  const expected = workosVerificationConfig(env);
  try {
    for (const surface of config.surfaces) {
      const origin = surface === "ops" ? config.ops! : config.app;
      const start = new URL("/auth/start", origin); start.searchParams.set("return", `${origin}/`);
      const response = await fetcher(start, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const authorization = authorizationRedirect(response, expected.issuerOrigin, { clientId: expected.webClientId, redirectUri: `${origin}/auth/callback` });
      const cookies = response.headers.getSetCookie();
      requireCheck(cookies.some(cookie => /^__Host-zeros_auth_flow=[A-Za-z0-9_-]{43};/.test(cookie) &&
        !/;\s*Domain=/i.test(cookie) &&
        /;\s*Secure(?:;|$)/i.test(cookie) && /;\s*HttpOnly(?:;|$)/i.test(cookie) && /;\s*Path=\/(?:;|$)/i.test(cookie) && /;\s*SameSite=Lax(?:;|$)/i.test(cookie)),
      "WorkOS sign-in flow cookie lacks its host-only security contract");
      await verifyProviderHandshake(authorization, fetcher);
    }
    // Exercise the same branded entrypoint as the installed app. Browser-only
    // proof misses a broken Desktop client, PKCE forwarding or callback allowlist.
    const scheme = config.channel === "production" ? "zeros" : `zeros-${config.channel}`;
    const state = `${scheme}.${randomBytes(32).toString("base64url")}`;
    const codeChallenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
    const start = new URL("/auth/desktop", config.app);
    start.searchParams.set("state", state); start.searchParams.set("code_challenge", codeChallenge);
    const desktop = await fetcher(start, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const authorization = authorizationRedirect(desktop, expected.issuerOrigin, {
      clientId: expected.desktopClientId, redirectUri: `${config.app}/auth/desktop/callback`, state, codeChallenge,
    });
    requireCheck(desktop.headers.get("referrer-policy") === "no-referrer", "WorkOS desktop sign-in can disclose its handoff through the referrer");
    await verifyProviderHandshake(authorization, fetcher);
    const response = await fetcher(expected.jwksUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    requireCheck(response.ok, "WorkOS public signing keys are unavailable");
    const text = await response.text(); requireCheck(Buffer.byteLength(text) <= 64 * 1024, "WorkOS public signing keys exceed their size bound");
    const jwks = JSON.parse(text) as { keys?: Array<Record<string, unknown>> };
    requireCheck(Array.isArray(jwks.keys) && jwks.keys.length > 0 && jwks.keys.length <= 20 && jwks.keys.every(publicSigningKey), "WorkOS public signing keys are invalid");
    return { kind: "workos-handshake-v1" as const, surfaces: [...config.surfaces] as Surface[], desktopVerified: true as const, verifiedAt: new Date().toISOString() };
  } catch (error) {
    throw error instanceof PromotionError ? error : new PromotionError("WorkOS verification failed; private flow and provider diagnostics withheld");
  }
}
