import type { JWTPayload } from "jose";

export const AUTH_CLAIM_NAMESPACE = "https://zeros.build/";

const WORKOS_API_ORIGIN = "https://api.workos.com";
const AUTHENTICATE_PATH = "/user_management/authenticate";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REFRESH_ATTEMPTS = 3;
const REFRESH_RETRY_BASE_DELAY_MS = 250;
const MAX_REFRESH_RETRY_DELAY_MS = 2_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TOKEN_BYTES = 64 * 1024;
const WORKOS_IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,512}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Authorization starts on the hosted Zeros app; this client exchanges and
// refreshes only.
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
  "LinkedInOAuth", // gitleaks:allow — WorkOS authentication method name, not a client identifier
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
  authTime: number | null;
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
    /** WorkOS's own refusal code (e.g. `email_verification_required`) when the
     *  API named one. Kept separate from `code` so callers still branch on our
     *  stable taxonomy while reporting the provider's actual reason. */
    public readonly providerCode: string | null = null,
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

function requiredIdentifier(
  payload: Record<string, unknown>,
  key: string,
  code: string,
): string {
  const value = requiredString(payload, key, code);
  if (!WORKOS_IDENTIFIER_RE.test(value)) {
    throw new WorkOSDesktopClientError(code, `Required claim ${key} is invalid`);
  }
  return value;
}

function requiredEmailClaim(
  payload: Record<string, unknown>,
  key: string,
): string {
  const email = requiredString(payload, key, "token_email_invalid")
    .toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new WorkOSDesktopClientError(
      "token_email_invalid",
      "Access token email is invalid",
    );
  }
  return email;
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

function optionalTimestamp(
  payload: Record<string, unknown>,
  key: "auth_time",
): number | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new WorkOSDesktopClientError(
      "token_time_invalid",
      `Optional claim ${key} is invalid`,
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
  const normalized = value.trim();
  if (normalized.length > 500) {
    throw new WorkOSDesktopClientError(
      "token_profile_invalid",
      `Optional claim ${key} is too large`,
    );
  }
  return normalized || null;
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
  const authTime = optionalTimestamp(payload, "auth_time");
  if (issuedAt <= 0 || expiresAt <= issuedAt) {
    throw new WorkOSDesktopClientError(
      "token_time_invalid",
      "Access token timestamps are invalid",
    );
  }
  if (authTime !== null && authTime > issuedAt + 60) {
    throw new WorkOSDesktopClientError(
      "token_time_invalid",
      "Access token authentication time is invalid",
    );
  }
  return {
    providerSubject: requiredIdentifier(
      payload,
      "sub",
      "token_subject_invalid",
    ),
    sessionId: requiredIdentifier(
      payload,
      "sid",
      "token_session_invalid",
    ),
    tokenId: requiredIdentifier(payload, "jti", "token_id_invalid"),
    clientId,
    clientKind: "desktop",
    email: requiredEmailClaim(
      payload,
      `${AUTH_CLAIM_NAMESPACE}email`,
    ),
    emailVerified: true,
    displayName: optionalString(payload, `${AUTH_CLAIM_NAMESPACE}name`),
    authTime,
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
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel("response too large").catch(() => undefined);
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel("response too large").catch(() => undefined);
        return null;
      }
      chunks.push(part.value.slice());
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return record(JSON.parse(new TextDecoder().decode(bytes)));
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
    // An EMPTY display name is absent, not malformed. GitHub accounts commonly
    // carry none, and `boundedString` rejects "" — so the old check turned a
    // presentation gap into a failed sign-in, contradicting this contract's own
    // rule that profile loss must never be an authentication failure. A wrong
    // TYPE still fails, which is the case that check was really for.
    const nameAbsent =
      nameValue === null || nameValue === undefined || nameValue === "";
    const name = nameAbsent ? null : boundedString(nameValue, 1_024);
    if (!userId || !email || (!nameAbsent && name === null)) {
      throw new WorkOSDesktopClientError(
        "identity_response_invalid",
        "WorkOS returned invalid verified-user data",
      );
    }
    // Split out of the guard above: an unverified address is a specific,
    // actionable provider state, not malformed data, and only its own code lets
    // the sign-in screen say what the user must actually do about it.
    if (user.email_verified !== true) {
      throw new WorkOSDesktopClientError(
        "user_email_unverified",
        "WorkOS has not verified this account's email address",
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
      // Keep only WorkOS's bounded refusal code for diagnostics and calm UI
      // mapping. Hosted AuthKit owns every verification continuation; pending
      // credentials must never leave that hosted ceremony or reach app code.
      const refusal = boundedString(result.body?.code, 128);
      throw new WorkOSDesktopClientError(
        "exchange_rejected",
        "WorkOS did not complete authentication",
        result.response.status,
        refusal,
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
