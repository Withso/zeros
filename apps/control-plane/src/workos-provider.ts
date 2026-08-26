import { WorkOS, type User } from "@workos-inc/node";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

import type { AuthBackendConfig, WorkOSBackendConfig } from "./config.js";

const SOCIAL_PROVIDERS = new Set(["GoogleOAuth", "GitHubOAuth"]);
const AUTH_CLAIM_NAMESPACE = "https://zeros.build/";

export type WorkOSUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

export type WorkOSExchange = {
  sealedSession: string;
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  user: WorkOSUser;
};

export type WorkOSRefreshResult =
  | ({ status: "active" } & WorkOSExchange)
  | {
      status: "transient";
      reason: string;
      retryAfter?: number;
      /** WorkOS may rotate before a later local verification step fails. */
      sealedSession?: string;
    }
  | { status: "terminal"; reason: string };

export type WorkOSRestoreResult =
  | ({ status: "active" } & WorkOSExchange)
  | { status: "terminal"; reason: string };

export interface WorkOSBrowserProvider {
  authorizationUrl(options: {
    provider: string;
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
  exchange(options: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<WorkOSExchange>;
  restore(sealedSession: string): Promise<WorkOSRestoreResult>;
  refresh(sealedSession: string): Promise<WorkOSRefreshResult>;
  logoutUrl(options: { sessionId: string; returnTo: string }): string;
  revokeSession(sessionId: string): Promise<void>;
}

export interface WorkOSDesktopProvider {
  verifyDesktopBearer(accessToken: string): Promise<{
    subject: string;
    sessionId: string;
  }>;
  listSessions(
    subject: string,
    options: { limit: number; after?: string },
  ): Promise<{
    data: Array<{ id: string; status: string }>;
    listMetadata: { after: string | null };
  }>;
  revokeSession(sessionId: string): Promise<void>;
}

/** Adopt a provider's own email verification as WorkOS verification.
 *
 *  WorkOS auto-verifies Google, Apple, Magic Auth and SSO, but NOT GitHub, so a
 *  GitHub user is created unverified and cannot authenticate until it proves
 *  ownership by one-time code. GitHub does verify addresses before reporting
 *  them, so Zeros elects to trust that assertion exactly as WorkOS already
 *  trusts Google's — see docs/workos-authentication-migration.md. */
export interface WorkOSEmailAdoptionProvider {
  adoptProviderVerifiedEmail(userId: string): Promise<void>;
}

export interface WorkOSDesktopAuthorizationProvider {
  desktopAuthorizationUrl(options: {
    provider: string;
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
}

type WorkOSAuthConfig = Extract<AuthBackendConfig, { provider: "workos" }>;

function accessTokenExpiresAt(accessToken: string): number {
  const claims = decodeJwt(accessToken);
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new Error("WorkOS access token has no expiration");
  }
  return claims.exp * 1_000;
}

export class RailwayWorkOSProvider
  implements
    WorkOSBrowserProvider,
    WorkOSDesktopProvider,
    WorkOSDesktopAuthorizationProvider,
    WorkOSEmailAdoptionProvider
{
  private readonly client: WorkOS;
  private readonly desktopJwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly auth: WorkOSAuthConfig,
    private readonly backend: WorkOSBackendConfig,
  ) {
    this.client = new WorkOS({
      apiKey: backend.apiKey,
      clientId: auth.webClientId,
      timeout: 8_000,
      maxRetries: 2,
    });
    this.desktopJwks = createRemoteJWKSet(new URL(auth.jwksUrl), {
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

  desktopAuthorizationUrl(options: {
    provider: string;
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    if (!SOCIAL_PROVIDERS.has(options.provider)) {
      throw new Error("Unsupported WorkOS provider");
    }
    return this.client.userManagement.getAuthorizationUrl({
      clientId: this.auth.desktopClientId,
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
      cookiePassword: this.backend.cookiePassword,
    });
    const authenticated = await loaded.authenticate();
    if (!authenticated.authenticated) {
      throw new Error(
        `WorkOS sealed session rejected: ${authenticated.reason}`,
      );
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
        cookiePassword: this.backend.cookiePassword,
      },
    });
    if (!response.sealedSession) {
      throw new Error("WorkOS did not return a sealed session");
    }
    return this.verifiedExchange(response.sealedSession, response.user);
  }

  async restore(sealedSession: string): Promise<WorkOSRestoreResult> {
    const loaded = this.client.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword: this.backend.cookiePassword,
    });
    const authenticated = await loaded.authenticate();
    if (!authenticated.authenticated) {
      return { status: "terminal", reason: String(authenticated.reason) };
    }
    return {
      status: "active",
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

  async refresh(sealedSession: string): Promise<WorkOSRefreshResult> {
    const loaded = this.client.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword: this.backend.cookiePassword,
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
      return { status: "terminal", reason: "missing_sealed_session" };
    }
    try {
      return {
        status: "active",
        ...(await this.verifiedExchange(
          result.sealedSession,
          result.session?.user,
        )),
      };
    } catch {
      return {
        status: "transient",
        reason: "verification_unavailable",
        sealedSession: result.sealedSession,
      };
    }
  }

  logoutUrl(options: { sessionId: string; returnTo: string }): string {
    return this.client.userManagement.getLogoutUrl(options);
  }

  async verifyDesktopBearer(accessToken: string): Promise<{
    subject: string;
    sessionId: string;
  }> {
    const { payload } = await jwtVerify(accessToken, this.desktopJwks, {
      issuer: this.auth.issuer,
      audience: this.auth.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "sid", "jti", "client_id"],
    });
    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    const sessionId = typeof payload.sid === "string" ? payload.sid.trim() : "";
    if (
      !subject ||
      !sessionId ||
      payload.client_id !== this.auth.desktopClientId ||
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
  ): Promise<{
    data: Array<{ id: string; status: string }>;
    listMetadata: { after: string | null };
  }> {
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

  /** Idempotent by construction: the field is only ever set to `true`, so a
   *  replayed webhook is a redundant write rather than a state change. */
  async adoptProviderVerifiedEmail(userId: string): Promise<void> {
    await this.client.userManagement.updateUser({
      userId,
      emailVerified: true,
    });
  }
}
