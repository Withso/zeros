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

export interface WorkOSDesktopVerificationChallenge {
  pendingAuthenticationToken: string;
  emailVerificationId: string;
}

export interface WorkOSDesktopVerificationSession {
  accessToken: string;
  refreshToken: string;
  authenticationMethod: string | null;
  user: WorkOSUser;
}

export interface WorkOSDesktopVerificationProvider {
  completeGitHubVerification(
    challenge: WorkOSDesktopVerificationChallenge,
  ): Promise<WorkOSDesktopVerificationSession>;
}

export class WorkOSDesktopVerificationError extends Error {
  constructor(
    public readonly code:
      | "challenge_rejected"
      | "identity_rejected"
      | "contract_rejected",
  ) {
    super(code);
    this.name = "WorkOSDesktopVerificationError";
  }
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

interface GitHubIdentityUserManagement {
  getEmailVerification(emailVerificationId: string): Promise<{
    id: string;
    userId: string;
    email: string;
    expiresAt: string;
    code: string;
  }>;
  getUserIdentities(
    userId: string,
  ): Promise<Array<{ type: string; provider: string }>>;
}

interface GitHubVerificationUserManagement extends GitHubIdentityUserManagement {
  authenticateWithEmailVerification(options: {
    clientId: string;
    code: string;
    pendingAuthenticationToken: string;
    session?: {
      sealSession: true;
      cookiePassword: string;
    };
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    authenticationMethod?: string;
    sealedSession?: string;
    user: {
      id: string;
      email: string;
      emailVerified: boolean;
      name: string | null;
    };
  }>;
}

interface GitHubVerificationDependencies {
  userManagement: GitHubVerificationUserManagement;
  desktopClientId: string;
  verifyDesktopBearer(accessToken: string): Promise<{
    subject: string;
    sessionId: string;
  }>;
  revokeSession(sessionId: string): Promise<void>;
  now?: () => number;
}

type GitHubVerification = Awaited<
  ReturnType<GitHubIdentityUserManagement["getEmailVerification"]>
>;

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function normalizedEmail(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function isProviderRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 429
  );
}

function emailVerificationChallengeFromError(
  error: unknown,
): WorkOSDesktopVerificationChallenge | null {
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    pendingAuthenticationToken?: unknown;
    rawData?: unknown;
  };
  if (
    candidate.status !== 400 ||
    !candidate.rawData ||
    typeof candidate.rawData !== "object"
  ) {
    return null;
  }
  const raw = candidate.rawData as Record<string, unknown>;
  if (
    candidate.code !== "email_verification_required" ||
    raw.code !== "email_verification_required" ||
    !bounded(raw.pending_authentication_token, 8_192) ||
    !bounded(raw.email_verification_id, 512) ||
    (candidate.pendingAuthenticationToken !== undefined &&
      candidate.pendingAuthenticationToken !== raw.pending_authentication_token)
  ) {
    return null;
  }
  return {
    pendingAuthenticationToken: raw.pending_authentication_token,
    emailVerificationId: raw.email_verification_id,
  };
}

async function resolveWorkOSGitHubVerification(
  challenge: WorkOSDesktopVerificationChallenge,
  deps: {
    userManagement: GitHubIdentityUserManagement;
    now?: () => number;
  },
): Promise<GitHubVerification> {
  if (
    !bounded(challenge.pendingAuthenticationToken, 8_192) ||
    !bounded(challenge.emailVerificationId, 512)
  ) {
    throw new WorkOSDesktopVerificationError("challenge_rejected");
  }

  let verification: GitHubVerification;
  try {
    verification = await deps.userManagement.getEmailVerification(
      challenge.emailVerificationId,
    );
  } catch (error) {
    if (isProviderRefusal(error)) {
      throw new WorkOSDesktopVerificationError("challenge_rejected");
    }
    throw error;
  }
  const expiresAt = Date.parse(verification.expiresAt);
  if (
    verification.id !== challenge.emailVerificationId ||
    !bounded(verification.userId, 512) ||
    !bounded(verification.email, 1_024) ||
    !bounded(verification.code, 128) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= (deps.now ?? Date.now)()
  ) {
    throw new WorkOSDesktopVerificationError("challenge_rejected");
  }

  let identities: Array<{ type: string; provider: string }>;
  try {
    identities = await deps.userManagement.getUserIdentities(
      verification.userId,
    );
  } catch (error) {
    if (isProviderRefusal(error)) {
      throw new WorkOSDesktopVerificationError("identity_rejected");
    }
    throw error;
  }
  if (
    !identities.some(
      (identity) =>
        identity.type === "OAuth" && identity.provider === "GitHubOAuth",
    )
  ) {
    throw new WorkOSDesktopVerificationError("identity_rejected");
  }
  return verification;
}

/** Complete the challenge WorkOS returned only after proving that the exact
 * challenged user owns a GitHub OAuth identity. The pending token and code are
 * still checked together by WorkOS; no client can ask this boundary to mark an
 * arbitrary user or email verified. */
export async function completeWorkOSGitHubVerification(
  challenge: WorkOSDesktopVerificationChallenge,
  deps: GitHubVerificationDependencies,
): Promise<WorkOSDesktopVerificationSession> {
  const verification = await resolveWorkOSGitHubVerification(challenge, deps);

  let authentication: Awaited<
    ReturnType<
      GitHubVerificationUserManagement["authenticateWithEmailVerification"]
    >
  >;
  try {
    authentication =
      await deps.userManagement.authenticateWithEmailVerification({
        clientId: deps.desktopClientId,
        code: verification.code,
        pendingAuthenticationToken: challenge.pendingAuthenticationToken,
      });
  } catch (error) {
    if (isProviderRefusal(error)) {
      throw new WorkOSDesktopVerificationError("challenge_rejected");
    }
    throw error;
  }

  const responseContractValid =
    bounded(authentication.accessToken, 64 * 1_024) &&
    bounded(authentication.refreshToken, 64 * 1_024) &&
    authentication.user?.id === verification.userId &&
    authentication.user.emailVerified === true &&
    bounded(authentication.user.email, 1_024) &&
    normalizedEmail(authentication.user.email) ===
      normalizedEmail(verification.email) &&
    (authentication.user.name === null ||
      bounded(authentication.user.name, 1_024));
  let bearer: { subject: string; sessionId: string } | null = null;
  if (responseContractValid) {
    try {
      bearer = await deps.verifyDesktopBearer(authentication.accessToken);
    } catch {
      bearer = null;
    }
  }
  if (
    !responseContractValid ||
    !bearer ||
    bearer.subject !== verification.userId ||
    authentication.authenticationMethod !== "GitHubOAuth"
  ) {
    if (bearer?.sessionId) {
      await deps.revokeSession(bearer.sessionId).catch(() => undefined);
    }
    throw new WorkOSDesktopVerificationError("contract_rejected");
  }

  return {
    accessToken: authentication.accessToken,
    refreshToken: authentication.refreshToken,
    authenticationMethod: authentication.authenticationMethod,
    user: {
      id: authentication.user.id,
      email: authentication.user.email,
      emailVerified: true,
      name: authentication.user.name,
    },
  };
}

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
    WorkOSDesktopVerificationProvider
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

  private async completeBrowserGitHubVerification(
    challenge: WorkOSDesktopVerificationChallenge,
  ): Promise<WorkOSExchange> {
    const verification = await resolveWorkOSGitHubVerification(challenge, {
      userManagement: {
        getEmailVerification: (id) =>
          this.client.userManagement.getEmailVerification(id),
        getUserIdentities: (userId) =>
          this.client.userManagement.getUserIdentities(userId),
      },
    });

    let response: Awaited<
      ReturnType<
        typeof this.client.userManagement.authenticateWithEmailVerification
      >
    >;
    try {
      response =
        await this.client.userManagement.authenticateWithEmailVerification({
          clientId: this.auth.webClientId,
          code: verification.code,
          pendingAuthenticationToken: challenge.pendingAuthenticationToken,
          session: {
            sealSession: true,
            cookiePassword: this.backend.cookiePassword,
          },
        });
    } catch (error) {
      if (isProviderRefusal(error)) {
        throw new WorkOSDesktopVerificationError("challenge_rejected");
      }
      throw error;
    }

    const responseContractValid =
      bounded(response.accessToken, 64 * 1_024) &&
      bounded(response.refreshToken, 64 * 1_024) &&
      bounded(response.sealedSession, 64 * 1_024) &&
      response.user?.id === verification.userId &&
      response.user.emailVerified === true &&
      bounded(response.user.email, 1_024) &&
      normalizedEmail(response.user.email) ===
        normalizedEmail(verification.email) &&
      (response.user.name === null || bounded(response.user.name, 1_024));
    let exchange: WorkOSExchange | null = null;
    if (responseContractValid && response.sealedSession) {
      try {
        exchange = await this.verifiedExchange(
          response.sealedSession,
          response.user,
        );
      } catch {
        exchange = null;
      }
    }
    if (
      !responseContractValid ||
      !exchange ||
      exchange.user.id !== verification.userId ||
      exchange.user.emailVerified !== true ||
      normalizedEmail(exchange.user.email) !==
        normalizedEmail(verification.email) ||
      response.authenticationMethod !== "GitHubOAuth"
    ) {
      if (exchange?.sessionId) {
        await this.revokeSession(exchange.sessionId).catch(() => undefined);
      }
      throw new WorkOSDesktopVerificationError("contract_rejected");
    }
    return exchange;
  }

  async exchange(options: {
    code: string;
    codeVerifier: string;
  }): Promise<WorkOSExchange> {
    let response: Awaited<
      ReturnType<typeof this.client.userManagement.authenticateWithCode>
    >;
    try {
      response = await this.client.userManagement.authenticateWithCode({
        code: options.code,
        codeVerifier: options.codeVerifier,
        session: {
          sealSession: true,
          cookiePassword: this.backend.cookiePassword,
        },
      });
    } catch (error) {
      const challenge = emailVerificationChallengeFromError(error);
      if (!challenge) throw error;
      return this.completeBrowserGitHubVerification(challenge);
    }
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

  async completeGitHubVerification(
    challenge: WorkOSDesktopVerificationChallenge,
  ): Promise<WorkOSDesktopVerificationSession> {
    return completeWorkOSGitHubVerification(challenge, {
      desktopClientId: this.auth.desktopClientId,
      userManagement: {
        getEmailVerification: (id) =>
          this.client.userManagement.getEmailVerification(id),
        getUserIdentities: (userId) =>
          this.client.userManagement.getUserIdentities(userId),
        authenticateWithEmailVerification: (options) =>
          this.client.userManagement.authenticateWithEmailVerification(options),
      },
      verifyDesktopBearer: (accessToken) =>
        this.verifyDesktopBearer(accessToken),
      revokeSession: (sessionId) => this.revokeSession(sessionId),
    });
  }
}
