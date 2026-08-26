import { WorkOS, type User } from "@workos-inc/node";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

import type { AuthBackendConfig, WorkOSBackendConfig } from "./config.js";

const SOCIAL_PROVIDERS = new Set(["GoogleOAuth", "GitHubOAuth"]);
const AUTH_CLAIM_NAMESPACE = "https://zeros.build/";
const GITHUB_VERIFICATION_EVENT_WINDOW_MS = 10_000;
const GITHUB_VERIFICATION_EVENT_PAIR_MS = 5_000;
const GITHUB_VERIFICATION_PROOF_ATTEMPTS = 3;
const GITHUB_VERIFICATION_PROOF_RETRY_MS = 150;

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
    createdAt: string;
  }>;
  getUserIdentities(
    userId: string,
  ): Promise<Array<{ type: string; provider: string }>>;
}

type GitHubVerificationEvent = {
  event: string;
  createdAt: string;
  context: Record<string, unknown> | undefined;
  data: unknown;
};

interface GitHubVerificationEvents {
  listEvents(options: {
    events: Array<
      "authentication.oauth_succeeded" | "email_verification.created"
    >;
    rangeStart: string;
    rangeEnd: string;
    limit: number;
    order: "asc" | "desc";
  }): Promise<{ data: GitHubVerificationEvent[] }>;
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
  events: GitHubVerificationEvents;
  desktopClientId: string;
  verifyDesktopBearer(accessToken: string): Promise<{
    subject: string;
    sessionId: string;
  }>;
  revokeSession(sessionId: string): Promise<void>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function eventUsesClient(
  event: GitHubVerificationEvent,
  clientId: string,
): boolean {
  return event.context?.client_id === clientId;
}

function nearEventTimestamp(
  createdAt: string,
  expectedAt: number,
): number | null {
  const eventAt = Date.parse(createdAt);
  return Number.isFinite(eventAt) &&
    Math.abs(eventAt - expectedAt) <= GITHUB_VERIFICATION_EVENT_WINDOW_MS
    ? eventAt
    : null;
}

function hasGitHubVerificationEventEvidence(
  events: GitHubVerificationEvent[],
  verification: GitHubVerification,
  clientId: string,
): boolean {
  const verificationCreatedAt = Date.parse(verification.createdAt);
  const exactVerificationCreatedAt: number[] = [];
  const oauthSucceededAt: number[] = [];
  for (const event of events) {
    if (!eventUsesClient(event, clientId)) continue;
    const eventAt = nearEventTimestamp(event.createdAt, verificationCreatedAt);
    if (eventAt === null) continue;
    const data = record(event.data);
    if (!data) continue;
    if (
      event.event === "email_verification.created" &&
      data.id === verification.id &&
      data.userId === verification.userId &&
      typeof data.email === "string" &&
      normalizedEmail(data.email) === normalizedEmail(verification.email)
    ) {
      exactVerificationCreatedAt.push(eventAt);
    }
    if (
      event.event === "authentication.oauth_succeeded" &&
      data.userId === verification.userId &&
      typeof data.email === "string" &&
      normalizedEmail(data.email) === normalizedEmail(verification.email) &&
      data.type === "oauth" &&
      data.status === "succeeded"
    ) {
      oauthSucceededAt.push(eventAt);
    }
  }
  return exactVerificationCreatedAt.some((verificationEventAt) =>
    oauthSucceededAt.some(
      (oauthEventAt) =>
        Math.abs(verificationEventAt - oauthEventAt) <=
        GITHUB_VERIFICATION_EVENT_PAIR_MS,
    ),
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function hasLinkedGitHubIdentity(
  userManagement: Pick<GitHubIdentityUserManagement, "getUserIdentities">,
  userId: string,
  waitForRetry: (milliseconds: number) => Promise<void> = wait,
): Promise<boolean> {
  for (
    let attempt = 0;
    attempt < GITHUB_VERIFICATION_PROOF_ATTEMPTS;
    attempt++
  ) {
    let identities: Array<{ type: string; provider: string }>;
    try {
      identities = await userManagement.getUserIdentities(userId);
    } catch (error) {
      if (isProviderRefusal(error)) {
        throw new WorkOSDesktopVerificationError("identity_rejected");
      }
      throw error;
    }
    if (
      identities.some(
        (identity) =>
          identity.type === "OAuth" && identity.provider === "GitHubOAuth",
      )
    ) {
      return true;
    }
    if (attempt + 1 < GITHUB_VERIFICATION_PROOF_ATTEMPTS) {
      await waitForRetry(GITHUB_VERIFICATION_PROOF_RETRY_MS * (attempt + 1));
    }
  }
  return false;
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
    events: GitHubVerificationEvents;
    clientId: string;
    now?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
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
  const createdAt = Date.parse(verification.createdAt);
  if (
    verification.id !== challenge.emailVerificationId ||
    !bounded(verification.userId, 512) ||
    !bounded(verification.email, 1_024) ||
    !bounded(verification.code, 128) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= (deps.now ?? Date.now)()
  ) {
    throw new WorkOSDesktopVerificationError("challenge_rejected");
  }

  const rangeStart = new Date(
    createdAt - GITHUB_VERIFICATION_EVENT_WINDOW_MS,
  ).toISOString();
  const rangeEnd = new Date(
    createdAt + GITHUB_VERIFICATION_EVENT_WINDOW_MS,
  ).toISOString();
  for (
    let attempt = 0;
    attempt < GITHUB_VERIFICATION_PROOF_ATTEMPTS;
    attempt++
  ) {
    let events: GitHubVerificationEvent[];
    try {
      ({ data: events } = await deps.events.listEvents({
        events: [
          "authentication.oauth_succeeded",
          "email_verification.created",
        ],
        rangeStart,
        rangeEnd,
        limit: 100,
        order: "desc",
      }));
    } catch (error) {
      if (isProviderRefusal(error)) {
        throw new WorkOSDesktopVerificationError("identity_rejected");
      }
      throw error;
    }
    if (
      hasGitHubVerificationEventEvidence(events, verification, deps.clientId)
    ) {
      return verification;
    }
    if (attempt + 1 < GITHUB_VERIFICATION_PROOF_ATTEMPTS) {
      await (deps.wait ?? wait)(
        GITHUB_VERIFICATION_PROOF_RETRY_MS * (attempt + 1),
      );
    }
  }
  throw new WorkOSDesktopVerificationError("identity_rejected");
}

/** Complete a WorkOS challenge only when its exact creation event immediately
 * followed a successful OAuth event for the same user, email, and application.
 * WorkOS links a first-time GitHub identity only after this grant, so that
 * provider identity is checked again on the completed user before returning a
 * session. */
export async function completeWorkOSGitHubVerification(
  challenge: WorkOSDesktopVerificationChallenge,
  deps: GitHubVerificationDependencies,
): Promise<WorkOSDesktopVerificationSession> {
  const verification = await resolveWorkOSGitHubVerification(challenge, {
    userManagement: deps.userManagement,
    events: deps.events,
    clientId: deps.desktopClientId,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.wait ? { wait: deps.wait } : {}),
  });

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
    (authentication.authenticationMethod !== undefined &&
      authentication.authenticationMethod !== "GitHubOAuth")
  ) {
    if (bearer?.sessionId) {
      await deps.revokeSession(bearer.sessionId).catch(() => undefined);
    }
    throw new WorkOSDesktopVerificationError("contract_rejected");
  }

  try {
    if (
      !(await hasLinkedGitHubIdentity(
        deps.userManagement,
        verification.userId,
        deps.wait,
      ))
    ) {
      throw new WorkOSDesktopVerificationError("identity_rejected");
    }
  } catch (error) {
    await deps.revokeSession(bearer.sessionId).catch(() => undefined);
    throw error;
  }

  return {
    accessToken: authentication.accessToken,
    refreshToken: authentication.refreshToken,
    authenticationMethod: authentication.authenticationMethod ?? null,
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
      events: {
        listEvents: (options) => this.client.events.listEvents(options),
      },
      clientId: this.auth.webClientId,
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
      (response.authenticationMethod !== undefined &&
        response.authenticationMethod !== "GitHubOAuth")
    ) {
      if (exchange?.sessionId) {
        await this.revokeSession(exchange.sessionId).catch(() => undefined);
      }
      throw new WorkOSDesktopVerificationError("contract_rejected");
    }
    try {
      if (
        !(await hasLinkedGitHubIdentity(
          this.client.userManagement,
          verification.userId,
        ))
      ) {
        throw new WorkOSDesktopVerificationError("identity_rejected");
      }
    } catch (error) {
      await this.revokeSession(exchange.sessionId).catch(() => undefined);
      throw error;
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
      events: {
        listEvents: (options) => this.client.events.listEvents(options),
      },
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
