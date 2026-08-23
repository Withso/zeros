import type {
  WorkOSAuthenticationMethod,
  WorkOSDesktopRefreshOutcome,
} from "./workos-desktop-client";

interface StoredTokenBase {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  sub: string;
  email: string;
  name: string | null;
}

export interface Auth0StoredTokens extends StoredTokenBase {
  provider: "auth0";
  accountId?: string;
}

export interface WorkOSStoredTokens extends StoredTokenBase {
  provider: "workos";
  accountId: string;
  sessionId: string;
  clientKind: "desktop";
  authenticationMethod: WorkOSAuthenticationMethod;
}

export type StoredTokens = Auth0StoredTokens | WorkOSStoredTokens;

export interface StoredTokenSnapshot {
  raw: string;
  tokens: StoredTokens;
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseStoredTokenSnapshot(
  raw: string | null,
): StoredTokenSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      !requiredString(value.accessToken) ||
      !requiredString(value.refreshToken) ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt) ||
      !requiredString(value.sub) ||
      !requiredString(value.email) ||
      (value.name !== null && typeof value.name !== "string")
    ) {
      return null;
    }
    const base: StoredTokenBase = {
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: value.expiresAt,
      sub: value.sub,
      email: value.email,
      name: value.name,
    };
    if (value.provider === undefined || value.provider === "auth0") {
      if (value.accountId !== undefined && !requiredString(value.accountId)) {
        return null;
      }
      return {
        raw,
        tokens: {
          ...base,
          provider: "auth0",
          ...(typeof value.accountId === "string"
            ? { accountId: value.accountId }
            : {}),
        },
      };
    }
    if (
      value.provider !== "workos" ||
      !requiredString(value.accountId) ||
      !requiredString(value.sessionId) ||
      value.clientKind !== "desktop" ||
      (value.authenticationMethod !== null &&
        value.authenticationMethod !== undefined &&
        typeof value.authenticationMethod !== "string")
    ) {
      return null;
    }
    return {
      raw,
      tokens: {
        ...base,
        provider: "workos",
        accountId: value.accountId,
        sessionId: value.sessionId,
        clientKind: "desktop",
        authenticationMethod:
          typeof value.authenticationMethod === "string"
            ? (value.authenticationMethod as WorkOSAuthenticationMethod)
            : null,
      },
    };
  } catch {
    return null;
  }
}

export type WorkOSRefreshMerge =
  | { status: "active"; tokens: WorkOSStoredTokens }
  | { status: "terminal"; tokens: WorkOSStoredTokens }
  | { status: "transient"; tokens: WorkOSStoredTokens };

export function mergeWorkOSRefresh(
  current: WorkOSStoredTokens,
  outcome: WorkOSDesktopRefreshOutcome,
): WorkOSRefreshMerge {
  if (outcome.status === "terminal") {
    return { status: "terminal", tokens: current };
  }
  if (outcome.status === "transient") {
    return {
      status: "transient",
      tokens: outcome.replacementRefreshToken
        ? { ...current, refreshToken: outcome.replacementRefreshToken }
        : current,
    };
  }
  const session = outcome.session;
  if (
    session.providerSubject !== current.sub ||
    session.sessionId !== current.sessionId ||
    session.clientKind !== "desktop"
  ) {
    return { status: "transient", tokens: current };
  }
  return {
    status: "active",
    tokens: {
      ...current,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      email: session.email,
      name: session.name,
      authenticationMethod: session.authenticationMethod,
    },
  };
}
