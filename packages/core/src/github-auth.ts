// Shared GitHub authentication model.
//
// Method selection is non-secret durable state. Credential values are secret
// and must stay in the host/engine boundary; renderer-facing status objects use
// GithubCredentialSummary instead.

export const GITHUB_AUTH_METHODS = [
  "gh-cli",
  "github-app",
  "pat",
] as const;

export type GithubAuthMethod = (typeof GITHUB_AUTH_METHODS)[number];

export const GITHUB_GIT_HOST = "github.com";
export const GITHUB_GIT_HTTP_USERNAME = "x-access-token";
const GITHUB_REFRESH_BINDING_RE =
  /^zghrb_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Git's HTTPS identity belongs to the credential, not to a host switch in the
 * broker. Other forges use different magic usernames, so persisting both
 * fields now keeps the broker provider-neutral even while GitHub is the only
 * configured forge. */
export interface GitHttpCredentialIdentity {
  /** Lowercase hostname without a port. */
  gitHost: string;
  gitHttpUsername: string;
}

export type GithubCredential = GitHttpCredentialIdentity &
  (
  | {
      method: "gh-cli";
      accessToken: string;
      login?: string;
    }
  | {
      method: "pat";
      accessToken: string;
      login?: string;
    }
  | {
      method: "github-app";
      accessToken: string;
      refreshToken?: string;
      /** Server-signed proof binding the refresh token to the Auth0 owner.
       * Main-process only; it is never projected into the engine. */
      refreshBinding?: string;
      login?: string;
      /** Auth0 subject that completed the backend-bound handoff. Main process
       *  refuses to serve this credential to a different signed-in account. */
      ownerSub?: string;
      expiresAtMs?: number;
      refreshTokenExpiresAtMs?: number;
      variantKey?: string;
      /** Last server-confirmed installation aggregate. Metadata only. */
      installationCount?: number;
      activeInstallationCount?: number;
      repositoryCount?: number;
      allRepositories?: boolean;
    }
  );

export type GithubCredentialHealth =
  | "connected"
  | "not-connected"
  | "unavailable"
  | "invalid"
  | "rate-limited"
  | "sso-required"
  | "not-installed"
  | "suspended";

/** Secret-free renderer/wire representation of one method. */
export interface GithubCredentialSummary {
  method: GithubAuthMethod;
  health: GithubCredentialHealth;
  /** Whether this method has a configured source, independent of health. */
  configured: boolean;
  login?: string;
  available?: boolean;
  detail?: string;
  expiresAtMs?: number;
  installationCount?: number;
  activeInstallationCount?: number;
  repositoryCount?: number;
  allRepositories?: boolean;
}

export interface GithubAuthSnapshot {
  selectedMethod: GithubAuthMethod;
  methods: Record<GithubAuthMethod, GithubCredentialSummary>;
}

/** Slot-addressed store. There is deliberately no clear-all operation. */
export interface GithubCredentialStore {
  getSelectedMethod(): Promise<GithubAuthMethod>;
  setSelectedMethod(method: GithubAuthMethod): Promise<void>;
  get(method: GithubAuthMethod): Promise<GithubCredential | null>;
  set(method: GithubAuthMethod, credential: GithubCredential): Promise<void>;
  clear(method: GithubAuthMethod): Promise<void>;
}

const METHOD_SET = new Set<string>(GITHUB_AUTH_METHODS);

export function isGithubAuthMethod(value: unknown): value is GithubAuthMethod {
  return typeof value === "string" && METHOD_SET.has(value);
}

export function githubCredentialToken(
  credential: GithubCredential | null,
): string | null {
  return credential?.accessToken ?? null;
}

/** Parse data read from encrypted JSON slots. Invalid records fail closed. */
export function sanitizeGithubCredential(
  value: unknown,
): GithubCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!isGithubAuthMethod(input.method)) return null;

  const accessToken =
    typeof input.accessToken === "string" ? input.accessToken.trim() : "";
  if (
    !accessToken ||
    accessToken.length > 4096 ||
    /[\0\r\n]/.test(accessToken)
  ) {
    return null;
  }

  const login =
    typeof input.login === "string" &&
    input.login.trim() &&
    input.login.trim().length <= 100 &&
    !/[\0\r\n]/.test(input.login)
      ? input.login.trim()
      : undefined;
  if (input.login !== undefined && login === undefined) return null;
  const gitHostInput =
    input.gitHost === undefined ? GITHUB_GIT_HOST : input.gitHost;
  const gitHost =
    typeof gitHostInput === "string"
      ? gitHostInput.trim().toLowerCase().replace(/\.$/, "")
      : "";
  const gitHttpUsernameInput =
    input.gitHttpUsername === undefined
      ? GITHUB_GIT_HTTP_USERNAME
      : input.gitHttpUsername;
  const gitHttpUsername =
    typeof gitHttpUsernameInput === "string"
      ? gitHttpUsernameInput.trim()
      : "";
  if (
    !gitHost ||
    gitHost.length > 253 ||
    /[\s/:?#@\\\0\r\n]/.test(gitHost) ||
    !gitHttpUsername ||
    gitHttpUsername.length > 256 ||
    /[:\0\r\n]/.test(gitHttpUsername)
  ) {
    return null;
  }

  if (input.method === "github-app") {
    const refreshToken =
      typeof input.refreshToken === "string" &&
      input.refreshToken.trim() &&
      input.refreshToken.trim().length <= 4096 &&
      !/[\0\r\n]/.test(input.refreshToken)
        ? input.refreshToken.trim()
        : undefined;
    if (input.refreshToken !== undefined && refreshToken === undefined) {
      return null;
    }
    const refreshBinding =
      typeof input.refreshBinding === "string" &&
      input.refreshBinding.trim() &&
      input.refreshBinding.length <= 4096 &&
      GITHUB_REFRESH_BINDING_RE.test(input.refreshBinding.trim())
        ? input.refreshBinding.trim()
        : undefined;
    if (
      input.refreshBinding !== undefined &&
      refreshBinding === undefined
    ) {
      return null;
    }
    const expiresAtMs =
      typeof input.expiresAtMs === "number" &&
      Number.isSafeInteger(input.expiresAtMs) &&
      input.expiresAtMs > 0
        ? input.expiresAtMs
        : undefined;
    const refreshTokenExpiresAtMs =
      typeof input.refreshTokenExpiresAtMs === "number" &&
      Number.isSafeInteger(input.refreshTokenExpiresAtMs) &&
      input.refreshTokenExpiresAtMs > 0
        ? input.refreshTokenExpiresAtMs
        : undefined;
    const variantKey =
      typeof input.variantKey === "string" &&
      input.variantKey.trim() &&
      input.variantKey.trim().length <= 253 &&
      /^[A-Za-z0-9.-]+$/.test(input.variantKey.trim())
        ? input.variantKey.trim()
        : undefined;
    if (input.variantKey !== undefined && variantKey === undefined) {
      return null;
    }
    const ownerSub =
      typeof input.ownerSub === "string" &&
      input.ownerSub.trim() &&
      input.ownerSub.trim().length <= 512 &&
      !/[\0\r\n]/.test(input.ownerSub)
        ? input.ownerSub.trim()
        : undefined;
    if (input.ownerSub !== undefined && ownerSub === undefined) return null;
    const nonNegativeInteger = (candidate: unknown): number | undefined =>
      typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0
        ? candidate
        : undefined;
    const installationCount = nonNegativeInteger(input.installationCount);
    const activeInstallationCount = nonNegativeInteger(
      input.activeInstallationCount,
    );
    const repositoryCount = nonNegativeInteger(input.repositoryCount);
    const allRepositories =
      typeof input.allRepositories === "boolean"
        ? input.allRepositories
        : undefined;
    return {
      method: "github-app",
      accessToken,
      gitHost,
      gitHttpUsername,
      ...(refreshToken ? { refreshToken } : {}),
      ...(refreshBinding ? { refreshBinding } : {}),
      ...(login ? { login } : {}),
      ...(ownerSub ? { ownerSub } : {}),
      ...(expiresAtMs ? { expiresAtMs } : {}),
      ...(refreshTokenExpiresAtMs ? { refreshTokenExpiresAtMs } : {}),
      ...(variantKey ? { variantKey } : {}),
      ...(installationCount !== undefined ? { installationCount } : {}),
      ...(activeInstallationCount !== undefined
        ? { activeInstallationCount }
        : {}),
      ...(repositoryCount !== undefined ? { repositoryCount } : {}),
      ...(allRepositories !== undefined ? { allRepositories } : {}),
    };
  }

  return {
    method: input.method,
    accessToken,
    gitHost,
    gitHttpUsername,
    ...(login ? { login } : {}),
  };
}
