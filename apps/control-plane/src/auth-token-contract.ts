import type { JWTPayload, JWTVerifyOptions } from "jose";

export const AUTH_CLAIM_NAMESPACE = "https://zeros.build/";

export type AuthClientKind = "web" | "desktop";

export interface AuthTokenContractConfig {
  issuer: string;
  audience: string;
  webClientId: string;
  desktopClientId: string;
}

export interface AuthTokenClaims {
  providerSubject: string;
  sessionId: string;
  tokenId: string;
  clientId: string;
  clientKind: AuthClientKind;
  email: string;
  emailVerified: true;
  displayName: string | null;
  avatarUrl: string | null;
  issuedAt: number;
  expiresAt: number;
}

export class AuthTokenContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthTokenContractError";
  }
}

function requireConfigured(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AuthTokenContractError(
      "AUTH_CONTRACT_CONFIG_INVALID",
      `${name} must be configured`,
    );
  }
  return normalized;
}

function normalizedConfig(
  config: AuthTokenContractConfig,
): AuthTokenContractConfig {
  const normalized = {
    issuer: requireConfigured(config.issuer, "issuer"),
    audience: requireConfigured(config.audience, "audience"),
    webClientId: requireConfigured(config.webClientId, "webClientId"),
    desktopClientId: requireConfigured(
      config.desktopClientId,
      "desktopClientId",
    ),
  };
  if (normalized.webClientId === normalized.desktopClientId) {
    throw new AuthTokenContractError(
      "AUTH_CONTRACT_CONFIG_INVALID",
      "web and desktop client ids must be different",
    );
  }
  return normalized;
}

function requiredString(
  payload: JWTPayload,
  key: string,
  code: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new AuthTokenContractError(code, `required claim ${key} is missing`);
  }
  return value.trim();
}

function optionalString(payload: JWTPayload, key: string): string | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new AuthTokenContractError(
      "AUTH_PROFILE_CLAIM_INVALID",
      `optional claim ${key} must be a string or null`,
    );
  }
  const normalized = value.trim();
  return normalized || null;
}

function optionalHttpsUrl(payload: JWTPayload, key: string): string | null {
  const value = optionalString(payload, key);
  if (!value || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function requiredTimestamp(payload: JWTPayload, key: "iat" | "exp"): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AuthTokenContractError(
      "AUTH_TIME_CLAIM_INVALID",
      `required claim ${key} is missing`,
    );
  }
  return value;
}

/**
 * Signature and registered-claim checks for the resource server and the live
 * contract probe. Application claims are validated separately below so the
 * same policy can be exercised without a network-backed JWKS in unit tests.
 */
export function authTokenVerifyOptions(
  config: AuthTokenContractConfig,
): JWTVerifyOptions {
  const value = normalizedConfig(config);
  return {
    issuer: value.issuer,
    audience: value.audience,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "sub", "sid", "jti", "client_id"],
  };
}

/**
 * Validate the WorkOS application/session and Zeros profile claims after JOSE
 * has verified the signature, issuer, audience, algorithm, and time claims.
 * Error messages deliberately omit claim values so diagnostics cannot disclose
 * identity data.
 */
export function validateAuthTokenClaims(
  payload: JWTPayload,
  config: AuthTokenContractConfig,
): AuthTokenClaims {
  const value = normalizedConfig(config);
  const clientId = requiredString(
    payload,
    "client_id",
    "AUTH_CLIENT_ID_MISSING",
  );
  let clientKind: AuthClientKind;
  if (clientId === value.webClientId) {
    clientKind = "web";
  } else if (clientId === value.desktopClientId) {
    clientKind = "desktop";
  } else {
    throw new AuthTokenContractError(
      "AUTH_CLIENT_ID_REJECTED",
      "access token client id is not allowed",
    );
  }

  const emailKey = `${AUTH_CLAIM_NAMESPACE}email`;
  const verifiedKey = `${AUTH_CLAIM_NAMESPACE}email_verified`;
  if (payload[verifiedKey] !== true) {
    throw new AuthTokenContractError(
      "AUTH_EMAIL_UNVERIFIED",
      "access token does not assert a verified email",
    );
  }

  const issuedAt = requiredTimestamp(payload, "iat");
  const expiresAt = requiredTimestamp(payload, "exp");
  if (expiresAt <= issuedAt) {
    throw new AuthTokenContractError(
      "AUTH_TIME_CLAIM_INVALID",
      "access token expiry must follow its issue time",
    );
  }

  return {
    providerSubject: requiredString(payload, "sub", "AUTH_SUBJECT_MISSING"),
    sessionId: requiredString(payload, "sid", "AUTH_SESSION_ID_MISSING"),
    tokenId: requiredString(payload, "jti", "AUTH_TOKEN_ID_MISSING"),
    clientId,
    clientKind,
    email: requiredString(payload, emailKey, "AUTH_EMAIL_MISSING"),
    emailVerified: true,
    displayName: optionalString(payload, `${AUTH_CLAIM_NAMESPACE}name`),
    avatarUrl: optionalHttpsUrl(payload, `${AUTH_CLAIM_NAMESPACE}picture`),
    issuedAt,
    expiresAt,
  };
}
