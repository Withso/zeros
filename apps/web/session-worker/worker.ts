import { WorkOS, type User } from "@workos-inc/node/worker";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { safeWorkOSReturnPath } from "../lib/workos-browser.mjs";
import {
  revokeWorkOSDesktopSessions,
  type WorkOSDesktopSessionPage,
} from "../lib/workos-desktop-revocation.mjs";
import {
  WorkOSSessionCoordinator,
  type WorkOSCoordinatorProvider,
  type WorkOSCoordinatorRecord,
  type WorkOSCoordinatorStorage,
  type WorkOSExchange,
  type WorkOSFlowRecord,
} from "../lib/workos-session-core.mjs";

interface Env {
  APP_ORIGIN: string;
  WORKOS_API_KEY: string;
  WORKOS_WEB_CLIENT_ID: string;
  WORKOS_COOKIE_PASSWORD: string;
  AUTH_DESKTOP_CLIENT_ID: string;
  AUTH_ISSUER: string;
  AUTH_JWKS_URL: string;
  AUTH_AUDIENCE: string;
}

const RECORD_KEY = "auth";
const SOCIAL_PROVIDERS = new Set(["GoogleOAuth", "GitHubOAuth"]);
const AUTH_CLAIM_NAMESPACE = "https://zeros.build/";
const MAX_BEARER_BYTES = 64 * 1_024;

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

function accessTokenExpiresAt(accessToken: string): number {
  const payload = accessToken.split(".")[1];
  if (!payload) throw new Error("WorkOS access token is malformed");
  const padded = payload
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(payload.length / 4) * 4, "=");
  const claims = JSON.parse(atob(padded)) as { exp?: unknown };
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new Error("WorkOS access token has no expiration");
  }
  return claims.exp * 1_000;
}

function exactAppOrigin(raw: string): string {
  const parsed = new URL(raw);
  const loopback =
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if (
    (parsed.protocol !== "https:" && !loopback) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "APP_ORIGIN must be an HTTPS origin or a local loopback origin",
    );
  }
  return parsed.origin;
}

function exactHttpsUrl(raw: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an exact HTTPS URL`);
  }
  return raw;
}

function validateEnv(env: Env): string {
  const origin = exactAppOrigin(env.APP_ORIGIN);
  if (!env.WORKOS_API_KEY || !env.WORKOS_WEB_CLIENT_ID) {
    throw new Error("WorkOS server configuration is incomplete");
  }
  if (
    !env.AUTH_DESKTOP_CLIENT_ID ||
    env.AUTH_DESKTOP_CLIENT_ID === env.WORKOS_WEB_CLIENT_ID
  ) {
    throw new Error("WorkOS Desktop Application configuration is incomplete");
  }
  exactHttpsUrl(env.AUTH_ISSUER, "AUTH_ISSUER");
  exactHttpsUrl(env.AUTH_JWKS_URL, "AUTH_JWKS_URL");
  if (!env.AUTH_AUDIENCE?.trim()) {
    throw new Error("AUTH_AUDIENCE must be configured");
  }
  if (!env.WORKOS_COOKIE_PASSWORD || env.WORKOS_COOKIE_PASSWORD.length < 32) {
    throw new Error(
      "WORKOS_COOKIE_PASSWORD must contain at least 32 characters",
    );
  }
  return origin;
}

class DurableStorageAdapter implements WorkOSCoordinatorStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  async getRecord(): Promise<WorkOSCoordinatorRecord | null> {
    return (
      (await this.storage.get<WorkOSCoordinatorRecord>(RECORD_KEY)) ?? null
    );
  }

  async putRecord(record: WorkOSCoordinatorRecord): Promise<void> {
    await this.storage.put(RECORD_KEY, record);
  }

  async claimFlow(
    state: string,
    now: number,
  ): Promise<WorkOSFlowRecord | null> {
    return this.storage.transaction(async (transaction) => {
      const record = await transaction.get<WorkOSCoordinatorRecord>(RECORD_KEY);
      if (
        !record ||
        record.kind !== "flow" ||
        record.expiresAt <= now ||
        record.claimedAt !== null ||
        record.state !== state
      ) {
        return null;
      }
      const claimed = { ...record, claimedAt: now };
      await transaction.put(RECORD_KEY, claimed);
      return claimed;
    });
  }

  async deleteAll(): Promise<void> {
    await this.storage.deleteAll();
    await this.storage.deleteAlarm();
  }

  async setExpiry(epochMs: number): Promise<void> {
    await this.storage.setAlarm(epochMs);
  }
}

class WorkOSProvider implements WorkOSCoordinatorProvider {
  private readonly client: WorkOS;
  private readonly desktopJwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly env: Env) {
    this.client = new WorkOS({
      apiKey: env.WORKOS_API_KEY,
      clientId: env.WORKOS_WEB_CLIENT_ID,
      timeout: 8_000,
      maxRetries: 2,
    });
    this.desktopJwks = createRemoteJWKSet(new URL(env.AUTH_JWKS_URL), {
      cooldownDuration: 5 * 60_000,
    });
  }

  authorizationUrl(options: {
    provider: string;
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    if (!SOCIAL_PROVIDERS.has(options.provider)) {
      throw new Error("Unsupported WorkOS provider");
    }
    return this.client.userManagement.getAuthorizationUrl({
      provider: options.provider,
      state: options.state,
      codeChallenge: options.codeChallenge,
      codeChallengeMethod: "S256",
      redirectUri: options.redirectUri,
    });
  }

  private async verifiedExchange(
    sealedSession: string,
    expectedUser?: User,
  ): Promise<WorkOSExchange> {
    const loaded = this.client.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword: this.env.WORKOS_COOKIE_PASSWORD,
    });
    const authenticated = await loaded.authenticate();
    if (!authenticated.authenticated) {
      throw new Error("WorkOS returned an invalid sealed session");
    }
    if (expectedUser && authenticated.user.id !== expectedUser.id) {
      throw new Error("WorkOS sealed-session user mismatch");
    }
    return {
      sealedSession,
      sessionId: authenticated.sessionId,
      accessToken: authenticated.accessToken,
      accessTokenExpiresAt: accessTokenExpiresAt(authenticated.accessToken),
      user: {
        id: authenticated.user.id,
        email: authenticated.user.email,
        emailVerified: authenticated.user.emailVerified,
        name: authenticated.user.name,
      },
    };
  }

  async exchange(options: {
    code: string;
    codeVerifier: string;
  }): Promise<WorkOSExchange> {
    const response = await this.client.userManagement.authenticateWithCode({
      code: options.code,
      codeVerifier: options.codeVerifier,
      session: {
        sealSession: true,
        cookiePassword: this.env.WORKOS_COOKIE_PASSWORD,
      },
    });
    if (!response.sealedSession) {
      throw new Error("WorkOS did not return a sealed session");
    }
    return this.verifiedExchange(response.sealedSession, response.user);
  }

  async refresh(options: { sealedSession: string }): Promise<
    | ({ status: "active" } & WorkOSExchange)
    | {
        status: "transient";
        reason: string;
        retryAfter?: number;
        sealedSession?: string;
      }
    | { status: "terminal"; reason: string }
  > {
    const loaded = this.client.userManagement.loadSealedSession({
      sessionData: options.sealedSession,
      cookiePassword: this.env.WORKOS_COOKIE_PASSWORD,
    });
    const result = await loaded.refresh();
    if (!result.authenticated) {
      return result.retryable
        ? {
            status: "transient",
            reason: String(result.reason),
            ...(typeof result.retryAfter === "number"
              ? { retryAfter: result.retryAfter }
              : {}),
          }
        : { status: "terminal", reason: String(result.reason) };
    }
    if (!result.sealedSession) {
      // The provider accepted the refresh, so the prior rotation state may no
      // longer be usable. Without the replacement seal there is no safe retry.
      return { status: "terminal", reason: "missing_sealed_session" };
    }
    let verified: WorkOSExchange;
    try {
      verified = await this.verifiedExchange(
        result.sealedSession,
        result.session?.user,
      );
    } catch {
      // The refresh itself already rotated. Preserve the replacement seal, but
      // do not release an access token until its local verification succeeds.
      return {
        status: "transient",
        reason: "verification_unavailable",
        sealedSession: result.sealedSession,
      };
    }
    return { status: "active", ...verified };
  }

  logoutUrl(options: { sessionId: string; returnTo: string }): string {
    return this.client.userManagement.getLogoutUrl(options);
  }

  async verifyDesktopBearer(accessToken: string): Promise<{
    subject: string;
    sessionId: string;
  }> {
    const { payload } = await jwtVerify(accessToken, this.desktopJwks, {
      issuer: this.env.AUTH_ISSUER,
      audience: this.env.AUTH_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "sid", "jti", "client_id"],
    });
    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    const sessionId = typeof payload.sid === "string" ? payload.sid.trim() : "";
    if (
      !subject ||
      !sessionId ||
      payload.client_id !== this.env.AUTH_DESKTOP_CLIENT_ID ||
      payload[`${AUTH_CLAIM_NAMESPACE}email_verified`] !== true ||
      typeof payload[`${AUTH_CLAIM_NAMESPACE}email`] !== "string" ||
      !(payload[`${AUTH_CLAIM_NAMESPACE}email`] as string).trim()
    ) {
      throw new Error("Desktop access-token contract rejected");
    }
    return { subject, sessionId };
  }

  async listSessions(
    subject: string,
    options: { limit: number; after?: string },
  ): Promise<WorkOSDesktopSessionPage> {
    const page = await this.client.userManagement.listSessions(
      subject,
      options,
    );
    return {
      data: page.data.map((session) => ({
        id: session.id,
        status: session.status,
      })),
      listMetadata: { after: page.listMetadata.after ?? null },
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.client.userManagement.revokeSession({ sessionId });
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (
    !header.startsWith("Bearer ") ||
    header.length === 7 ||
    header.length > MAX_BEARER_BYTES ||
    /\s/.test(header.slice(7))
  ) {
    return null;
  }
  return header.slice(7);
}

async function requestBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class AuthSession {
  private readonly coordinator: WorkOSSessionCoordinator;
  private readonly origin: string;
  private readonly storage: DurableStorageAdapter;
  private readonly provider: WorkOSProvider;

  constructor(state: DurableObjectState, env: Env) {
    this.origin = validateEnv(env);
    this.storage = new DurableStorageAdapter(state.storage);
    this.provider = new WorkOSProvider(env);
    this.coordinator = new WorkOSSessionCoordinator({
      storage: this.storage,
      provider: this.provider,
      randomToken,
      pkceChallenge,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/desktop/revoke") {
      const token = bearerToken(request);
      const body = await requestBody(request);
      const scope = body?.scope;
      if (!token || (scope !== "current" && scope !== "all")) {
        return json({ error: "bad_request" }, 400);
      }
      let claims: { subject: string; sessionId: string };
      try {
        claims = await this.provider.verifyDesktopBearer(token);
      } catch {
        return json({ error: "unauthorized" }, 401);
      }
      try {
        const result = await revokeWorkOSDesktopSessions({
          scope,
          subject: claims.subject,
          sessionId: claims.sessionId,
          provider: this.provider,
        });
        return json(result);
      } catch {
        return json({ error: "unavailable" }, 503);
      }
    }
    if (request.method === "POST" && url.pathname === "/flow/start") {
      const body = await requestBody(request);
      const provider = typeof body?.provider === "string" ? body.provider : "";
      const returnPath = safeWorkOSReturnPath(
        typeof body?.returnPath === "string" ? body.returnPath : null,
        this.origin,
      );
      if (!SOCIAL_PROVIDERS.has(provider))
        return json({ error: "bad_request" }, 400);
      const result = await this.coordinator.startFlow({
        provider,
        returnPath,
        redirectUri: `${this.origin}/auth/callback`,
      });
      return json(result, 201);
    }

    if (request.method === "POST" && url.pathname === "/flow/complete") {
      const body = await requestBody(request);
      const result = await this.coordinator.completeFlow({
        code: typeof body?.code === "string" ? body.code : "",
        state: typeof body?.state === "string" ? body.state : "",
      });
      return json(result, result.ok ? 200 : 401);
    }

    if (request.method === "POST" && url.pathname === "/flow/cancel") {
      await this.coordinator.cancelFlow();
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/session") {
      const result = await this.coordinator.getSession();
      return json(result, result.status === "terminal" ? 401 : 200);
    }

    if (request.method === "POST" && url.pathname === "/session/refresh") {
      const result = await this.coordinator.refreshSession();
      return json(result, result.status === "terminal" ? 401 : 200);
    }

    if (request.method === "POST" && url.pathname === "/session/logout") {
      const body = await requestBody(request);
      const returnPath = safeWorkOSReturnPath(
        typeof body?.returnTo === "string" ? body.returnTo : null,
        this.origin,
      );
      const result = await this.coordinator.logout(
        new URL(returnPath, `${this.origin}/`).toString(),
      );
      return json(result);
    }

    return json({ error: "not_found" }, 404);
  }

  async alarm(): Promise<void> {
    await this.storage.deleteAll();
  }
}

export default {
  fetch(): Response {
    // This Worker is an implementation host for its Durable Object namespace,
    // not a public authentication endpoint. Pages reaches it only by binding.
    return new Response("Not found", { status: 404 });
  },
};
