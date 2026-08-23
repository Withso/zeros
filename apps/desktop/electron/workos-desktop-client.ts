import type { JWTPayload } from "jose";

export const AUTH_CLAIM_NAMESPACE = "https://zeros.build/";

const WORKOS_API_ORIGIN = "https://api.workos.com";
const AUTHENTICATE_PATH = "/user_management/authenticate";
const AUTHORIZE_PATH = "/user_management/authorize";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REFRESH_ATTEMPTS = 3;
const REFRESH_RETRY_BASE_DELAY_MS = 250;
const MAX_REFRESH_RETRY_DELAY_MS = 2_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TOKEN_BYTES = 64 * 1024;

const RETRYABLE_REFRESH_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const AUTHENTICATION_METHODS = new Set([
  "SSO",
  "Password",
  "Passkey",
  "AppleOAuth",
  "BitbucketOAuth",
  "DiscordOAuth",
  "GitHubOAuth",
  "GitLabOAuth",
  "GoogleOAuth",
  "GrokOAuth",
  "XOAuth",
  "IntuitOAuth",
  "LinkedInOAuth",
  "MicrosoftOAuth",
  "SalesforceOAuth",
  "SlackOAuth",
  "VercelMarketplaceOAuth",
  "VercelOAuth",
  "XeroOAuth",
  "MagicAuth",
  "CrossAppAuth",
  "ExternalAuth",
  "MigratedSession",
  "Impersonation",
] as const);

export type WorkOSAuthenticationMethod =
  | (typeof AUTHENTICATION_METHODS extends Set<infer T> ? T : never)
  | null;

export interface WorkOSDesktopClientConfig {
  clientId: string;
  issuer: string;
  jwksUrl: string;
  audience: string;
}

export interface WorkOSDesktopTokenClaims {
  providerSubject: string;
  sessionId: string;
  tokenId: string;
  clientId: string;
  clientKind: "desktop";
  email: string;
  emailVerified: true;
  displayName: string | null;
  issuedAt: number;
  expiresAt: number;
}

export interface WorkOSDesktopSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  providerSubject: string;
  sessionId: string;
  clientKind: "desktop";
  email: string;
  name: string | null;
  authenticationMethod: WorkOSAuthenticationMethod;
}

export type WorkOSDesktopRefreshOutcome =
  | { status: "active"; session: WorkOSDesktopSession }
  | { status: "terminal"; reason: "invalid_grant" }
  | {
      status: "transient";
      reason:
        | "network"
        | "provider_unavailable"
        | "bad_response"
        | "verification_unavailable"
        | "contract_rejected";
      replacementRefreshToken?: string;
    };

export class WorkOSDesktopClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 0,
  ) {
    super(message);
    this.name = "WorkOSDesktopClientError";
  }
}

function requiredString(
  payload: Record<string, unknown>,
  key: string,
  code: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkOSDesktopClientError(
      code,
      `Required claim ${key} is missing`,
    );
  }
  return value.trim();
}

function requiredTimestamp(
  payload: Record<string, unknown>,
  key: "iat" | "exp",
): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkOSDesktopClientError(
      "token_time_invalid",
      `Required claim ${key} is missing`,
    );
  }
  return value;
}

function optionalString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new WorkOSDesktopClientError(
      "token_profile_invalid",
      `Optional claim ${key} must be a string`,
    );
  }
  return value.trim() || null;
}

export function validateWorkOSDesktopTokenClaims(
  rawPayload: JWTPayload | Record<string, unknown>,
  config: WorkOSDesktopClientConfig,
): WorkOSDesktopTokenClaims {
  const payload = rawPayload as Record<string, unknown>;
  const clientId = requiredString(payload, "client_id", "token_client_missing");
  if (clientId !== config.clientId) {
    throw new WorkOSDesktopClientError(
      "token_client_rejected",
      "Access token belongs to another application",
    );
  }
  if (payload[`${AUTH_CLAIM_NAMESPACE}email_verified`] !== true) {
    throw new WorkOSDesktopClientError(
      "email_unverified",
      "Access token does not assert a verified email",
    );
  }
  const issuedAt = requiredTimestamp(payload, "iat");
  const expiresAt = requiredTimestamp(payload, "exp");
  if (issuedAt <= 0 || expiresAt <= issuedAt) {
    throw new WorkOSDesktopClientError(
      "token_time_invalid",
      "Access token timestamps are invalid",
    );
  }
  return {
    providerSubject: requiredString(payload, "sub", "token_subject_missing"),
    sessionId: requiredString(payload, "sid", "token_session_missing"),
    tokenId: requiredString(payload, "jti", "token_id_missing"),
    clientId,
    clientKind: "desktop",
    email: requiredString(
      payload,
      `${AUTH_CLAIM_NAMESPACE}email`,
      "token_email_missing",
    ),
    emailVerified: true,
    displayName: optionalString(payload, `${AUTH_CLAIM_NAMESPACE}name`),
    issuedAt,
    expiresAt,
  };
}

function boundedString(value: unknown, max = MAX_TOKEN_BYTES): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (!text || text.length > MAX_RESPONSE_BYTES) return null;
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

function normalizedEmail(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function authenticationMethod(value: unknown): WorkOSAuthenticationMethod {
  return typeof value === "string" &&
    AUTHENTICATION_METHODS.has(
      value as Exclude<WorkOSAuthenticationMethod, null>,
    )
    ? (value as Exclude<WorkOSAuthenticationMethod, null>)
    : null;
}

export interface WorkOSDesktopClientOptions {
  config: WorkOSDesktopClientConfig;
  fetch?: typeof fetch;
  verifyAccessToken?: (
    accessToken: string,
  ) => Promise<WorkOSDesktopTokenClaims>;
  apiOrigin?: string;
  timeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(raw) - Date.now();
  if (!Number.isFinite(delay) || delay < 0) return null;
  return Math.min(delay, MAX_REFRESH_RETRY_DELAY_MS);
}

export class WorkOSDesktopClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiOrigin: string;
  private readonly timeoutMs: number;
  private readonly sleepImpl: (delayMs: number) => Promise<void>;
  private readonly verifyToken: (
    accessToken: string,
  ) => Promise<WorkOSDesktopTokenClaims>;

  constructor(private readonly options: WorkOSDesktopClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleepImpl = options.sleep ?? sleep;
    this.apiOrigin = new URL(options.apiOrigin ?? WORKOS_API_ORIGIN).origin;
    this.verifyToken =
      options.verifyAccessToken ?? this.createRemoteVerifier(options.config);
  }

  private async waitBeforeRefreshRetry(
    failedAttempt: number,
    response?: Response,
  ): Promise<void> {
    const retryAfter = response ? retryAfterMs(response) : null;
    const exponential = Math.min(
      REFRESH_RETRY_BASE_DELAY_MS * 2 ** failedAttempt,
      MAX_REFRESH_RETRY_DELAY_MS,
    );
    await this.sleepImpl(retryAfter ?? exponential);
  }

  private createRemoteVerifier(config: WorkOSDesktopClientConfig) {
    let remoteJwks:
      | ReturnType<(typeof import("jose"))["createRemoteJWKSet"]>
      | undefined;
    return async (accessToken: string): Promise<WorkOSDesktopTokenClaims> => {
      const { createRemoteJWKSet, jwtVerify } = await import("jose");
      remoteJwks ??= createRemoteJWKSet(new URL(config.jwksUrl), {
        cooldownDuration: 5 * 60_000,
      });
      const { payload } = await jwtVerify(accessToken, remoteJwks, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "sub", "sid", "jti", "client_id"],
      });
      return validateWorkOSDesktopTokenClaims(payload, config);
    };
  }

  authorizationUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    const url = new URL(AUTHORIZE_PATH, this.apiOrigin);
    url.searchParams.set("provider", "authkit");
    url.searchParams.set("client_id", this.options.config.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  private async authenticate(
    body: Record<string, string>,
  ): Promise<{ response: Response; body: Record<string, unknown> | null }> {
    const response = await this.fetchImpl(
      new URL(AUTHENTICATE_PATH, this.apiOrigin),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    return { response, body: await responseJson(response) };
  }

  private async verifiedSession(
    body: Record<string, unknown>,
  ): Promise<WorkOSDesktopSession> {
    const accessToken = boundedString(body.access_token);
    const refreshToken = boundedString(body.refresh_token);
    const user = record(body.user);
    if (!accessToken || !refreshToken || !user) {
      throw new WorkOSDesktopClientError(
        "bad_response",
        "WorkOS returned an incomplete authentication response",
      );
    }
    const userId = boundedString(user.id, 512);
    const email = boundedString(user.email, 1_024);
    const nameValue = user.name;
    const name =
      nameValue === null || nameValue === undefined
        ? null
        : boundedString(nameValue, 1_024);
    if (
      !userId ||
      !email ||
      user.email_verified !== true ||
      (nameValue !== null && nameValue !== undefined && name === null)
    ) {
      throw new WorkOSDesktopClientError(
        "identity_response_invalid",
        "WorkOS returned invalid verified-user data",
      );
    }

    const claims = await this.verifyToken(accessToken);
    if (
      claims.providerSubject !== userId ||
      normalizedEmail(claims.email) !== normalizedEmail(email)
    ) {
      throw new WorkOSDesktopClientError(
        "identity_mismatch",
        "WorkOS token and user response do not match",
      );
    }
    return {
      accessToken,
      refreshToken,
      expiresAt: claims.expiresAt * 1_000,
      providerSubject: claims.providerSubject,
      sessionId: claims.sessionId,
      clientKind: "desktop",
      email: claims.email,
      name: name ?? claims.displayName,
      authenticationMethod: authenticationMethod(body.authentication_method),
    };
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
  }): Promise<WorkOSDesktopSession> {
    if (
      !boundedString(input.code, 8_192) ||
      !boundedString(input.codeVerifier, 256)
    ) {
      throw new WorkOSDesktopClientError(
        "invalid_exchange_input",
        "Authorization callback data is invalid",
      );
    }
    let result: Awaited<ReturnType<WorkOSDesktopClient["authenticate"]>>;
    try {
      result = await this.authenticate({
        grant_type: "authorization_code",
        client_id: this.options.config.clientId,
        code: input.code,
        code_verifier: input.codeVerifier,
      });
    } catch {
      throw new WorkOSDesktopClientError(
        "exchange_unavailable",
        "WorkOS authentication is temporarily unavailable",
      );
    }
    if (!result.response.ok || !result.body) {
      throw new WorkOSDesktopClientError(
        "exchange_rejected",
        "WorkOS did not complete authentication",
        result.response.status,
      );
    }
    return this.verifiedSession(result.body);
  }

  async refresh(input: {
    refreshToken: string;
    expectedSubject: string;
    expectedSessionId: string;
  }): Promise<WorkOSDesktopRefreshOutcome> {
    let result:
      | Awaited<ReturnType<WorkOSDesktopClient["authenticate"]>>
      | undefined;
    for (let attempt = 0; attempt < DEFAULT_REFRESH_ATTEMPTS; attempt += 1) {
      try {
        result = await this.authenticate({
          grant_type: "refresh_token",
          client_id: this.options.config.clientId,
          refresh_token: input.refreshToken,
        });
      } catch {
        if (attempt + 1 === DEFAULT_REFRESH_ATTEMPTS) {
          return { status: "transient", reason: "network" };
        }
        await this.waitBeforeRefreshRetry(attempt);
        continue;
      }
      if (!result.response.ok) {
        if (result.body?.error === "invalid_grant") {
          return { status: "terminal", reason: "invalid_grant" };
        }
        if (
          RETRYABLE_REFRESH_STATUS.has(result.response.status) &&
          attempt + 1 < DEFAULT_REFRESH_ATTEMPTS
        ) {
          await this.waitBeforeRefreshRetry(attempt, result.response);
          continue;
        }
        return { status: "transient", reason: "provider_unavailable" };
      }
      if (!result.body || !boundedString(result.body.refresh_token)) {
        if (attempt + 1 < DEFAULT_REFRESH_ATTEMPTS) {
          await this.waitBeforeRefreshRetry(attempt, result.response);
          continue;
        }
        return { status: "transient", reason: "bad_response" };
      }
      break;
    }
    if (!result?.body) {
      return { status: "transient", reason: "bad_response" };
    }
    const replacementRefreshToken = boundedString(result.body.refresh_token);
    if (!replacementRefreshToken) {
      return { status: "transient", reason: "bad_response" };
    }
    let session: WorkOSDesktopSession;
    try {
      session = await this.verifiedSession(result.body);
    } catch (error) {
      if (
        error instanceof WorkOSDesktopClientError &&
        (error.code === "identity_mismatch" ||
          error.code === "identity_response_invalid")
      ) {
        return { status: "transient", reason: "contract_rejected" };
      }
      return {
        status: "transient",
        reason: "verification_unavailable",
        replacementRefreshToken,
      };
    }
    if (
      session.providerSubject !== input.expectedSubject ||
      session.sessionId !== input.expectedSessionId
    ) {
      return { status: "transient", reason: "contract_rejected" };
    }
    return { status: "active", session };
  }
}
