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

// Organization GitHub requests are metadata-only at the desktop boundary.
// User OAuth tokens are supplied by Electron main, never by renderer callers.
import { z } from "zod";
export const cloudGithubNativeSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), leaseId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("terminal"), actorSessionId: z.string().uuid() }).strict(),
]);
export type CloudGithubNativeSource = z.infer<typeof cloudGithubNativeSourceSchema>;
export const cloudGithubNativePreparationSchema = z.object({
  requestId: z.string().uuid(), generation: z.number().int().positive().safe(),
  engineInstanceId: z.string().uuid(), source: cloudGithubNativeSourceSchema,
  branch: z.string().min(1).max(512).nullable(),
}).strict();
export type CloudGithubNativePreparation = z.infer<typeof cloudGithubNativePreparationSchema>;
export const cloudGithubNativeContextSchema = z.object({
  actorUserId: z.string().uuid(), organizationId: z.string().uuid(), workspaceId: z.string().uuid(),
  generation: z.number().int().positive().safe(), engineInstanceId: z.string().uuid(),
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  repositoryId: z.string().regex(/^[1-9][0-9]*$/),
}).strict();
export const cloudGithubNativeGrantRequestSchema = cloudGithubNativeContextSchema.extend({
  operation: z.enum(["git.push", "git.fetch"]), paramsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  native: cloudGithubNativePreparationSchema,
}).strict();
export type CloudGithubNativeGrantRequest = z.infer<typeof cloudGithubNativeGrantRequestSchema>;
export const cloudGithubNativeDesktopSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }).strict(),
  z.object({ kind: z.literal("reply"), requestId: z.string().uuid(),
    grant: z.string().regex(/^zgw_[A-Za-z0-9_-]{43}$/).nullable() }).strict(),
]);
export const CLOUD_GITHUB_DESKTOP_REQUIRED = "Open Zeros to authorize GitHub push for this cloud workspace";
const cloudGithubScope = { organizationId: z.string().uuid() };
export const CLOUD_GITHUB_WRITE_OPERATIONS = ["git.push", "gh.prCreate", "gh.prUpdate", "gh.prMarkReady", "gh.prMerge", "gh.prComment"] as const;
export const cloudGithubWriteGrantSchema = z.object({ grant: z.string().regex(/^zgw_[A-Za-z0-9_-]{43}$/) });
export function isCloudGithubWriteOperation(value: unknown): value is typeof CLOUD_GITHUB_WRITE_OPERATIONS[number] {
  return typeof value === "string" && (CLOUD_GITHUB_WRITE_OPERATIONS as readonly string[]).includes(value);
}
const cloudGithubName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
export const cloudGithubRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...cloudGithubScope, action: z.literal("prepareWrite"), workspaceId: z.string().uuid(), operation: z.enum([...CLOUD_GITHUB_WRITE_OPERATIONS, "git.fetch"]), prNumber: z.number().int().positive().max(2147483647).optional(), paramsSha256: z.string().regex(/^[a-f0-9]{64}$/), native: cloudGithubNativePreparationSchema.optional() }).strict(),
  z.object({ ...cloudGithubScope, action: z.literal("catalog") }).strict(),
  z.object({ ...cloudGithubScope, action: z.literal("connect"), installationId: z.string().uuid() }).strict(),
  z.object({ ...cloudGithubScope, action: z.literal("disconnect"), installationId: z.string().uuid() }).strict(),
  z.object({ ...cloudGithubScope, action: z.literal("repositories"), installationId: z.string().uuid(), page: z.number().int().min(1).max(100) }).strict(),
  z.object({ ...cloudGithubScope, action: z.literal("source"), owner: cloudGithubName, repository: cloudGithubName, installationId: z.string().uuid().optional() }).strict(),
]);
export type CloudGithubRequest = z.infer<typeof cloudGithubRequestSchema>;
export const cloudGithubRepositorySchema = z.object({ id: z.string().regex(/^[1-9][0-9]{0,39}$/), owner: cloudGithubName, name: cloudGithubName,
  defaultBranch: z.string().min(1).max(512), private: z.boolean() });
export type CloudGithubRepository = z.infer<typeof cloudGithubRepositorySchema>;
export const cloudGithubCatalogSchema = z.object({ login: cloudGithubName, complete: z.boolean(), installUrl: z.string().regex(/^https:\/\/github\.com\/apps\/[a-zA-Z0-9-]+\/installations\/new$/), installations: z.array(z.object({
  id: z.string().uuid(), accountLogin: cloudGithubName, accountType: z.enum(["User", "Organization"]), connected: z.boolean(), suspendedAt: z.string().nullable(),
})).max(1000) });
export const cloudGithubRepositoriesSchema = z.object({ repositories: z.array(cloudGithubRepositorySchema).max(100), nextPage: z.number().int().min(2).max(100).nullable() });
export const cloudGithubSourceSchema = z.object({ installationId: z.string().uuid(), repository: cloudGithubRepositorySchema });
export const cloudGithubConnectedSchema = z.object({ connected: z.literal(true), installationId: z.string().uuid() });
export const cloudGithubDisconnectedSchema = z.object({ disconnected: z.literal(true) });
export function parseCloudGithubResponse(request: CloudGithubRequest, value: unknown) {
  switch (request.action) {
    case "prepareWrite": return cloudGithubWriteGrantSchema.parse(value);
    case "catalog": return cloudGithubCatalogSchema.parse(value);
    case "repositories": return cloudGithubRepositoriesSchema.parse(value);
    case "source": return cloudGithubSourceSchema.parse(value);
    case "connect": return cloudGithubConnectedSchema.parse(value);
    case "disconnect": return cloudGithubDisconnectedSchema.parse(value);
  }
}
