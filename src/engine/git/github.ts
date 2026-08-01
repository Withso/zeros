// GitHub integration: Octokit + PR ops.
//
// Auth strategy:
//   - The token store is injected by the host process at boot
//     (electron/main.ts wires a safeStorage-backed store; tests
//     swap in an in-memory mock via setTokenStoreForTesting).
//     Default store throws on write so a missing wire-up fails
//     loudly instead of silently dropping the token.
//   - The migration off keytar happened on 2026-05-25 after the
//     native keytar.node binding aborted the main process — the
//     store interface is unchanged; only the backing layer moved.
//   - Interactive sign-in is NOT here. The host owns it (GitHub App browser
//     flow / PAT / borrowed gh CLI) and couriers the selected credential in;
//     this module only consumes it.
//   - On 401 we clear the cached token and surface NOT_AUTHENTICATED so
//     the renderer can re-trigger the sign-in flow.
//
// Tests inject mock implementations via the *ForTesting seams.
//
// ESM-only dep (2026-05-20 fix): @octokit/rest@22 is an ESM-only package.
// The Electron main process bundles as CommonJS, so `require()` of it
// throws ERR_REQUIRE_ESM. Use a type-only static import + a dynamic
// runtime import so the bundler emits an `import()` call (preserved as
// dynamic by tsup) that Node resolves correctly at runtime. The tsup
// configs also externalize it so it's never bundled.

import type { Octokit as OctokitClass } from "@octokit/rest";
import { createHash } from "node:crypto";
import { GitError, isGitError, type GitErrorCode } from "./errors";
import { getWorkspace } from "./worktree";
import { advanceLifecycle, updateWorkspace } from "./state";
import { isRepo } from "./repo";
import {
  assertSafeGitRef,
  classifyGitTransportError,
  runFile,
  runGit,
} from "./git-exec";
import { refExists } from "./default-branch";
import { resolveRepoGit } from "../settings/repo-git";
import { push } from "./ops";
import type { PR, PrState } from "./types";
import { setGitCredentialSource } from "./credential-broker";
import {
  GITHUB_GIT_HOST,
  GITHUB_GIT_HTTP_USERNAME,
  sanitizeGithubCredential,
  type GithubCredential,
  type GithubCredentialHealth,
} from "@zeros/core/github-auth";
import type { RunFileOptions, RunFileResult } from "./git-exec";

/** Lazy module cache for @octokit/rest. The module is resolved once
 *  via dynamic import (CJS-compatible) and shared by every callable. */
let _octokitMod: typeof import("@octokit/rest") | null = null;
async function loadOctokit(): Promise<typeof import("@octokit/rest")> {
  if (!_octokitMod) {
    _octokitMod = await import("@octokit/rest");
  }
  return _octokitMod;
}

// NOTE: the OAuth device flow that used to live here (plus its client-id
// resolution and the @octokit/auth-oauth-device dependency) is gone. Interactive
// GitHub sign-in is now owned by the host: the GitHub App browser flow, a PAT, or
// a borrowed gh CLI login, each committed to a method-addressed credential slot.
// This module only consumes whatever credential the host selects.

// ── Pluggable seams ──────────────────────────────────────

export interface TokenStore {
  get(): Promise<string | null>;
  /** Provider-aware working credential for Git-over-HTTPS. Older stores may
   * expose only get(); those safely retain the github.com defaults. */
  getCredential?(): Promise<GithubCredential | null>;
  /** Whether the selected method owns Git HTTPS for this host even while its
   * working credential is temporarily absent. This prevents an App/PAT gap
   * from falling through to an unrelated ambient credential helper. */
  ownsGitHost?(host: string): Promise<boolean>;
  /** Ask the credential owner to rotate a token that GitHub explicitly
   * rejected. A string means the replacement is already readable through
   * get()/getCredential(); null means rotation applied but could not produce a
   * usable replacement; undefined means this store does not support rotation. */
  refreshAfterRejection?(
    rejectedToken: string,
  ): Promise<string | null | undefined>;
  /** Clear only when the durable/working credential still equals the token
   * rejected by the retry. Production stores implement this as a CAS so a
   * concurrent reconnect can never be erased by an older request. */
  clearAfterRejection?(rejectedToken: string): Promise<boolean>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** Default store — refuses writes so a missing setTokenStore() at
 *  boot fails loudly rather than silently dropping the token. Reads
 *  return null so a renderer that probes auth before the host wires
 *  the store just sees "not signed in" instead of crashing. */
const NOT_CONFIGURED_STORE: TokenStore = {
  async get() {
    return null;
  },
  async set() {
    throw new Error(
      "github tokenStore not configured — host process must call setTokenStore() at boot",
    );
  },
  async clear() {
    /* no-op */
  },
};

let tokenStore: TokenStore = NOT_CONFIGURED_STORE;
/** Factory is async so it can dynamic-import @octokit/rest (ESM-only).
 *  Default implementation lazily constructs a real Octokit; tests can
 *  swap in a sync mock by returning Promise.resolve(mock). */
let octokitFactory: (token: string) => Promise<OctokitClass> = async (
  token,
) => {
  const { Octokit } = await loadOctokit();
  return new Octokit(token ? { auth: token } : undefined);
};
let cachedOctokit: OctokitClass | null = null;
/** The token `cachedOctokit` was built with. The cached client is reused ONLY
 *  while the current store token still equals this — so a sign-out or token swap
 *  (which nulls/replaces the store value) can never be served by a stale
 *  authenticated client. Without this guard, clearing the token left
 *  `cachedOctokit` live and every gh.* op (publish, PRs) kept working after
 *  sign-out, because getOctokit() returned the cache without re-reading the store. */
let cachedOctokitToken: string | null = null;
let ghRunFile: (
  command: string,
  args: string[],
  opts?: RunFileOptions,
) => Promise<RunFileResult> = runFile;

/**
 * The gh-cli method means "borrow gh's durable github.com login", not an
 * arbitrary token inherited by the app launcher. GH_TOKEN/GITHUB_TOKEN outrank
 * gh's config, so a stale shell export otherwise makes Settings report 401
 * even after a successful `gh auth login`. The PAT method is the explicit path
 * for user-supplied tokens.
 */
function ghCliStoredAuthOptions(): RunFileOptions {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return { timeoutMs: 5000, env };
}

function cacheOctokit(oct: OctokitClass, token: string): void {
  cachedOctokit = oct;
  cachedOctokitToken = token;
}

function clearOctokitCache(): void {
  cachedOctokit = null;
  cachedOctokitToken = null;
}

/** Wire the production token store. Electron main calls this once at
 *  app.whenReady() with a safeStorage-backed implementation. */
export function setTokenStore(s: TokenStore): void {
  tokenStore = s;
  configureGitCredentialSource(s);
  clearOctokitCache();
}

/** Override the token persistence layer. Used by tests to inject an
 *  in-memory store, and by the future remote-control surface that
 *  routes auth through a different mechanism. */
export function setTokenStoreForTesting(s: TokenStore | null): void {
  tokenStore = s ?? NOT_CONFIGURED_STORE;
  configureGitCredentialSource(tokenStore);
  clearOctokitCache();
}

function configureGitCredentialSource(store: TokenStore): void {
  const readCredential = async (): Promise<GithubCredential | null> => {
    if (store.getCredential) {
      return sanitizeGithubCredential(await store.getCredential());
    }
    const token = await store.get();
    return token
      ? {
          method: "pat",
          accessToken: token,
          gitHost: GITHUB_GIT_HOST,
          gitHttpUsername: GITHUB_GIT_HTTP_USERNAME,
        }
      : null;
  };
  setGitCredentialSource({
    supports(request) {
      return request.protocol === "https";
    },
    async shouldHandle(request) {
      if (store.ownsGitHost) return store.ownsGitHost(request.host);
      return (await readCredential())?.gitHost === request.host;
    },
    async getCredential(request) {
      const credential = await readCredential();
      return credential?.gitHost === request.host
        ? {
            username: credential.gitHttpUsername,
            password: credential.accessToken,
          }
        : null;
    },
    async credentialFingerprint(request) {
      const credential = await readCredential();
      if (!credential || credential.gitHost !== request.host) return null;
      return createHash("sha256").update(credential.accessToken).digest("hex");
    },
    async refreshAfterAuthenticationFailure(request, rejectedFingerprint) {
      const current = await readCredential();
      if (!current || current.gitHost !== request.host) return false;
      const currentFingerprint = createHash("sha256")
        .update(current.accessToken)
        .digest("hex");
      // A concurrent refresh or method switch already replaced the rejected
      // token. The retry can immediately ask the broker for that newer value.
      if (currentFingerprint !== rejectedFingerprint) return true;
      if (!store.refreshAfterRejection) return false;
      const replacement = await store.refreshAfterRejection(
        current.accessToken,
      );
      return typeof replacement === "string" && replacement.length > 0;
    },
  });
}

/** Override the Octokit factory. Used by tests to inject a mock client.
 *  The factory can be sync (return-an-instance) or async (return a
 *  promise). The override is wrapped to normalise into Promise<Octokit>. */
export function setOctokitFactoryForTesting(
  factory: ((token: string) => OctokitClass | Promise<OctokitClass>) | null,
): void {
  if (!factory) {
    octokitFactory = async (token) => {
      const { Octokit } = await loadOctokit();
      return new Octokit(token ? { auth: token } : undefined);
    };
  } else {
    octokitFactory = async (token) => factory(token);
  }
  clearOctokitCache();
}

/** Test seam for the `gh auth token` probe. */
export function setRunFileForTesting(
  fn:
    | ((
        command: string,
        args: string[],
        opts?: RunFileOptions,
      ) => Promise<RunFileResult>)
    | null,
): void {
  ghRunFile = fn ?? runFile;
}

// ── Auth ─────────────────────────────────────────────────

export interface AuthStatusResult {
  authenticated: boolean;
  login?: string;
  /** A successful identity probe can still be incomplete. GitHub returns
   *  `200` plus `X-GitHub-SSO: partial-results` when SAML-protected
   *  organizations were omitted, so callers must not cache that response as
   *  an exact capability snapshot. */
  warning?: {
    code: "GITHUB_SSO_REQUIRED";
    context: Record<string, unknown>;
  };
}

/** Last login GitHub confirmed for us, remembered across calls.
 *
 *  Exists for ONE caller: workspace creation, which prefixes the new branch
 *  with the login when Settings → Git says `branch_prefix_type = "github"`.
 *  Creating a workspace must not wait on (or fail because of) a /user round
 *  trip, so that path reads this cache and falls back to the default `zeros/`
 *  prefix when it is empty. Every code path that LEARNS a login writes here;
 *  a rejected credential and a credential swap clear it.
 *
 *  It is deliberately NOT read off the seeded credential's own `login` field:
 *  that field is only populated for the `github-app` method, so relying on it
 *  would make branch prefixing work for one sign-in method and silently not
 *  for the other two. */
let lastKnownLogin: string | null = null;

/** The last confirmed GitHub login, or null if we've never seen one this
 *  process (or the credential was since cleared). Synchronous and
 *  network-free — a best-effort hint, never an authorization signal. */
export function cachedGithubLogin(): string | null {
  return lastKnownLogin;
}

function rememberLogin(login: string | null | undefined): void {
  lastKnownLogin = login && login.trim() ? login.trim() : null;
}

/** Drop the remembered login without asserting a new one — for when the
 *  CREDENTIAL changed underneath us and the cached login stops being evidence
 *  of anything (see seedGithubCredential, the desktop's sign-in/sign-out
 *  route; the boot prime only covers launch). Branch prefixing then falls back
 *  to the default until the next getAuthStatus re-learns it, which is the safe
 *  direction: signing out and getting `zeros/Cream` is recoverable, whereas
 *  stamping a disconnected account's name onto a branch is permanent. */
export function forgetGithubLogin(): void {
  lastKnownLogin = null;
}

/** Probe whether we have a working token. Rotating App credentials get the
 * same one-shot owner refresh as normal API calls; borrowed/PAT credentials
 * retain the legacy retry-and-clear behavior after two explicit rejections. */
export async function getAuthStatus(): Promise<AuthStatusResult> {
  const token = await tokenStore.get();
  if (!token) {
    rememberLogin(null);
    return { authenticated: false };
  }
  try {
    const response = await withAuthRetry((octokit) =>
      octokit.users.getAuthenticated(),
    );
    const warning = partialSsoWarning(response.headers);
    rememberLogin(response.data.login);
    return {
      authenticated: true,
      login: response.data.login,
      ...(warning ? { warning } : {}),
    };
  } catch (err) {
    if (err instanceof GitError && err.code === "NOT_AUTHENTICATED") {
      rememberLogin(null);
      return { authenticated: false };
    }
    // A transient failure (offline, 5xx) is NOT evidence the login changed —
    // keep the cached one so branch prefixing survives a flaky network.
    throw err;
  }
}

export interface GhCliResult {
  /** Is the `gh` binary on PATH at all? */
  available: boolean;
  /** Did GitHub verify the CLI token during this probe? */
  authenticated: boolean;
  /** Did `gh auth token` return a configured credential? */
  configured: boolean;
  health: GithubCredentialHealth;
  login?: string;
  detail?: string;
}

async function probeGhCliCredential(): Promise<{
  available: boolean;
  configured: boolean;
  credential: GithubCredential | null;
  health: GithubCredentialHealth;
  login?: string;
  detail?: string;
}> {
  let token = "";
  try {
    const { stdout } = await ghRunFile(
      "gh",
      ["auth", "token", "--hostname", GITHUB_GIT_HOST],
      ghCliStoredAuthOptions(),
    );
    token = stdout.trim();
  } catch (err) {
    const available = (err as { code?: string }).code !== "ENOENT";
    const detail = `${(err as { stderr?: unknown }).stderr ?? ""} ${
      err instanceof Error ? err.message : ""
    }`;
    const signedOut =
      /not logged in|not logged into|no oauth token|authentication required/i.test(
        detail,
      );
    return {
      available,
      configured: false,
      credential: null,
      health: available && !signedOut ? "unavailable" : "not-connected",
      ...(available && !signedOut
        ? { detail: "GitHub CLI authentication could not be checked." }
        : {}),
    };
  }
  if (!token) {
    return {
      available: true,
      configured: false,
      credential: null,
      health: "not-connected",
    };
  }
  const unverifiedCredential: GithubCredential = {
    method: "gh-cli",
    accessToken: token,
    gitHost: GITHUB_GIT_HOST,
    gitHttpUsername: GITHUB_GIT_HTTP_USERNAME,
  };
  const octokit = await octokitFactory(token);
  try {
    const { data } = await octokit.users.getAuthenticated();
    // Deliberately does NOT rememberLogin(): this probes the gh CLI's own
    // credential, which since the three-way auth split is not necessarily the
    // ACTIVE one. Caching a login from here would let a signed-out CLI account
    // prefix branches for the App/PAT account actually in use. getAuthStatus()
    // is the only writer, because it is the only probe of the active
    // credential.
    return {
      available: true,
      configured: true,
      credential: {
        ...unverifiedCredential,
        login: data.login,
      },
      health: "connected",
      login: data.login,
    };
  } catch (error) {
    const classified = wrapApiError(
      error,
      "GitHub CLI authentication could not be checked",
    );
    if (classified.code === "NOT_AUTHENTICATED") {
      return {
        available: true,
        configured: true,
        credential: null,
        health: "invalid",
        detail: "GitHub rejected the GitHub CLI credential.",
      };
    }
    const health: GithubCredentialHealth =
      classified.code === "GITHUB_RATE_LIMITED"
        ? "rate-limited"
        : classified.code === "GITHUB_SSO_REQUIRED"
          ? "sso-required"
          : "unavailable";
    return {
      available: true,
      configured: true,
      // A transient health probe must not erase or withhold the CLI-owned
      // token. Git/gh can retry it directly when connectivity recovers.
      credential: unverifiedCredential,
      health,
      detail: classified.message,
    };
  }
}

/** Read the CLI-owned credential without persisting it elsewhere.
 *  Main uses this private-channel result to seed the active engine credential.
 *  This path intentionally does not add a `/user` request in front of every
 *  Git/gh operation: the remote operation is the authoritative validation and
 *  its one-shot rejection path disconnects an invalid token. Settings health
 *  uses detectGhCli(), which does verify the identity and returns no secret. */
export async function readGhCliCredential(): Promise<GithubCredential | null> {
  try {
    const { stdout } = await ghRunFile(
      "gh",
      ["auth", "token", "--hostname", GITHUB_GIT_HOST],
      ghCliStoredAuthOptions(),
    );
    const accessToken = stdout.trim();
    return accessToken
      ? {
          method: "gh-cli",
          accessToken,
          gitHost: GITHUB_GIT_HOST,
          gitHttpUsername: GITHUB_GIT_HTTP_USERNAME,
        }
      : null;
  } catch {
    return null;
  }
}

/** Pure health probe for the primary auth method. It never adopts or replaces
 *  the selected credential as a side effect of opening Settings or Refresh. */
export async function detectGhCli(): Promise<GhCliResult> {
  const probe = await probeGhCliCredential();
  return {
    available: probe.available,
    authenticated: probe.health === "connected",
    configured: probe.configured,
    health: probe.health,
    ...(probe.login ? { login: probe.login } : {}),
    ...(probe.detail ? { detail: probe.detail } : {}),
  };
}

/** Validate a candidate token without mutating the selected credential. */
export async function verifyGithubToken(
  token: string,
): Promise<{ login: string }> {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "GitHub token must be a non-empty string",
    });
  }
  const octokit = await octokitFactory(trimmed);
  try {
    const { data } = await octokit.users.getAuthenticated();
    // No rememberLogin() here either: this validates a CANDIDATE token and
    // deliberately does not mutate the selected credential, so it is not
    // evidence about the active account.
    return { login: data.login };
  } catch (err) {
    throw wrapApiError(err, "GitHub rejected the token");
  }
}

/** Get the cached Octokit instance, or lazy-init from the persisted
 *  token. Throws NOT_AUTHENTICATED if no token is present. */
async function getOctokit(): Promise<OctokitClass> {
  // Consult the token store on EVERY call so a sign-out / token swap can never
  // be served by a stale cached client. The cache is reused only when the
  // current token still matches the one the client was built with.
  const token = await tokenStore.get();
  if (!token) {
    clearOctokitCache();
    throw new GitError({
      code: "NOT_AUTHENTICATED",
      message: "Not signed in to GitHub",
      remediation: "Connect GitHub in Settings → Integrations.",
    });
  }
  if (cachedOctokit && cachedOctokitToken === token) return cachedOctokit;
  const oct = await octokitFactory(token);
  cacheOctokit(oct, token);
  return oct;
}

/** Prefer the persisted GitHub credential, but permit a public-data client
 *  when the user has not signed in. Account profiles are normally public, so
 *  this lets an SSH-cloned private repository still resolve its owner avatar;
 *  authenticated access also covers restricted Enterprise Managed Users.
 *  Unauthenticated clients are deliberately not put in the auth cache, whose
 *  token-identity invariant must remain exact. */
async function getOptionalAuthOctokit(): Promise<OctokitClass> {
  const token = await tokenStore.get();
  if (!token) {
    clearOctokitCache();
    return octokitFactory("");
  }
  if (cachedOctokit && cachedOctokitToken === token) return cachedOctokit;
  const oct = await octokitFactory(token);
  cacheOctokit(oct, token);
  return oct;
}

type GithubResponseHeaders = Record<
  string,
  string | number | string[] | undefined
>;

interface GithubErrorClassification {
  code: GitErrorCode;
  message: string;
  remediation?: string;
  context?: Record<string, unknown>;
}

function githubStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const shaped = err as {
    status?: number;
    response?: { status?: number };
  };
  return shaped.status ?? shaped.response?.status;
}

function githubHeaders(err: unknown): GithubResponseHeaders {
  if (!err || typeof err !== "object") return {};
  const response = (err as { response?: { headers?: unknown } }).response;
  if (!response?.headers || typeof response.headers !== "object") return {};
  return response.headers as GithubResponseHeaders;
}

function githubHeader(
  headers: GithubResponseHeaders | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || raw == null) continue;
    return Array.isArray(raw) ? raw.join(", ") : String(raw);
  }
  return undefined;
}

function parseAcceptedPermissions(
  header: string | undefined,
): Record<string, string> | undefined {
  if (!header) return undefined;
  const entries = header
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator < 1) return null;
      return [
        part.slice(0, separator).trim(),
        part.slice(separator + 1).trim(),
      ] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseSsoHeader(header: string | undefined): {
  authorizeUrl?: string;
  partialResults?: true;
  organizationIds?: string[];
} | null {
  if (!header) return null;
  const authorizeUrl = header.match(/(?:^|[;,]\s*)url=([^;,\s]+)/i)?.[1];
  const organizationIds = header
    .match(/(?:^|[;,]\s*)organizations=([0-9,\s]+)/i)?.[1]
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const partialResults = /(?:^|[;,\s])partial-results(?:[;,\s]|$)/i.test(
    header,
  );
  return {
    ...(authorizeUrl ? { authorizeUrl } : {}),
    ...(partialResults ? { partialResults: true as const } : {}),
    ...(organizationIds && organizationIds.length > 0
      ? { organizationIds }
      : {}),
  };
}

function partialSsoWarning(
  headers: GithubResponseHeaders | undefined,
): AuthStatusResult["warning"] | undefined {
  const details = parseSsoHeader(githubHeader(headers, "x-github-sso"));
  if (!details?.partialResults) return undefined;
  return {
    code: "GITHUB_SSO_REQUIRED",
    context: details,
  };
}

/** Only an explicit credential rejection is destructive. A 403 is normally a
 *  capability, policy, SSO, installation, or rate-limit response and must
 *  never sign the user out. GitHub has returned "Bad credentials" as a 403 in
 *  some edge paths, so retain that narrow message-based exception. */
function isCredentialInvalid(err: unknown): boolean {
  const status = githubStatus(err);
  if (status === 401) return true;
  if (status !== 403) return false;
  return /bad credentials|token.{0,40}(?:expired|revoked)/i.test(
    githubApiMessage(err) ?? "",
  );
}

function classifyGithubError(err: unknown): GithubErrorClassification | null {
  const status = githubStatus(err);
  const headers = githubHeaders(err);
  const apiMessage = githubApiMessage(err) ?? "";
  const rateLimitRemaining = Number(
    githubHeader(headers, "x-ratelimit-remaining"),
  );
  const rateLimitResetSeconds = Number(
    githubHeader(headers, "x-ratelimit-reset"),
  );
  const retryAfterSeconds = Number(githubHeader(headers, "retry-after"));

  if (isCredentialInvalid(err)) {
    return {
      code: "NOT_AUTHENTICATED",
      message: "GitHub no longer accepts this connection.",
      remediation: "Reconnect GitHub in Settings → Integrations.",
    };
  }

  if (
    status === 429 ||
    rateLimitRemaining === 0 ||
    Number.isFinite(retryAfterSeconds) ||
    /(?:secondary |api )?rate limit/i.test(apiMessage)
  ) {
    return {
      code: "GITHUB_RATE_LIMITED",
      message: "GitHub is temporarily rate-limiting requests.",
      remediation: "Wait for GitHub's limit to reset, then try again.",
      context: {
        ...(Number.isFinite(rateLimitRemaining) ? { rateLimitRemaining } : {}),
        ...(Number.isFinite(rateLimitResetSeconds)
          ? {
              rateLimitResetAt: new Date(
                rateLimitResetSeconds * 1000,
              ).toISOString(),
            }
          : {}),
        ...(Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds } : {}),
      },
    };
  }

  const sso = parseSsoHeader(githubHeader(headers, "x-github-sso"));
  if (sso || /saml|single sign-on|\bsso\b/i.test(apiMessage)) {
    return {
      code: "GITHUB_SSO_REQUIRED",
      message: "GitHub requires organization sign-in for this connection.",
      remediation: sso?.authorizeUrl
        ? "Authorize this connection with your organization on GitHub."
        : "Sign in to your organization on GitHub, then reconnect.",
      context: sso ?? undefined,
    };
  }

  if (
    /installation.{0,40}suspend|suspend.{0,40}installation/i.test(apiMessage)
  ) {
    return {
      code: "GITHUB_INSTALLATION_SUSPENDED",
      message: "This GitHub App installation is suspended.",
      remediation:
        "Ask the account owner who suspended the installation to restore it on GitHub.",
    };
  }

  if (status === 404) {
    return {
      code: "GITHUB_REPO_NOT_INSTALLED",
      message:
        "This repository or GitHub resource is not available to the selected connection.",
      remediation:
        "Grant the GitHub connection access to this repository, or verify that the remote still points to the right repository.",
    };
  }

  if (
    status === 403 &&
    /resource not accessible|insufficient permission|permission/i.test(
      apiMessage,
    )
  ) {
    const acceptedPermissions = parseAcceptedPermissions(
      githubHeader(headers, "x-accepted-github-permissions"),
    );
    return {
      code: "GITHUB_FORBIDDEN_SCOPE",
      message: "This GitHub connection does not have access to that action.",
      remediation:
        "Update the connection's repository permissions on GitHub, then try again.",
      context: acceptedPermissions ? { acceptedPermissions } : undefined,
    };
  }

  return null;
}

function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  if (code === "ENOTFOUND" || code === "ECONNRESET" || code === "ETIMEDOUT") {
    return true;
  }
  const msg = (err as Error).message ?? "";
  return /network|fetch|getaddrinfo/i.test(msg);
}

/** Pull GitHub's descriptive message out of an Octokit error for internal
 * classification only. Octokit's
 *  RequestError exposes the API message on `.response.data.message` plus a
 *  per-field `errors[]` array (e.g. the 422 "No commits between …" detail).
 *  Those strings can contain repository and branch names, so they must never
 *  be forwarded as renderer copy or analytics. */
function githubApiMessage(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as {
    response?: {
      data?: { message?: string; errors?: Array<{ message?: string }> };
    };
    message?: string;
  };
  const data = e.response?.data;
  const detail = (data?.errors ?? [])
    .map((x) => x?.message)
    .filter((m): m is string => !!m)
    .join("; ");
  const combined = [data?.message, detail].filter(Boolean).join(" — ");
  return combined || e.message || undefined;
}

function wrapApiError(err: unknown, fallbackMessage: string): GitError {
  if (isGitError(err)) return err;
  const classified = classifyGithubError(err);
  if (classified) {
    return new GitError({
      code: classified.code,
      message: classified.message,
      cause: err,
      remediation: classified.remediation,
      context: classified.context,
    });
  }
  if (isNetworkError(err)) {
    return new GitError({
      code: "NETWORK_ERROR",
      message: "Could not reach github.com",
      cause: err,
    });
  }
  // 4xx (esp. 422 Unprocessable) — classify GitHub's message into fixed,
  // metadata-only copy. The raw message can carry repository and branch names.
  const status = (err as { status?: number }).status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const ghMsg = githubApiMessage(err);
    const lower = (ghMsg ?? "").toLowerCase();
    let message = fallbackMessage;
    let remediation: string | undefined;
    let context: Record<string, unknown> | undefined;
    if (/no commits between/.test(lower)) {
      message = "This branch has no commits beyond its base.";
      remediation =
        "The branch has no commits beyond its base. Commit your work, then open the PR.";
    } else if (/already exist|pull request.*exists/.test(lower)) {
      message = "A pull request already exists for this branch.";
      remediation =
        "A pull request already exists for this branch — open it instead.";
    } else if (
      /draft/.test(lower) &&
      /(not|cannot|unsupported|isn't)/.test(lower)
    ) {
      message = "Draft pull requests aren't available for this repository.";
      remediation =
        "This repository or plan doesn't support draft pull requests — create a normal PR instead.";
      context = { reason: "draft-unsupported" };
    } else if (/head.*could not|no ref|sha.*can.?t be found/.test(lower)) {
      message = "GitHub couldn't find the pushed branch.";
      remediation = "Push the branch to the remote first, then open the PR.";
    } else if (status === 422) {
      message = "GitHub couldn't process this pull request.";
      remediation =
        "GitHub couldn't process the request — check the branch is pushed and the base/head refs are valid.";
    }
    return new GitError({
      code: "GITHUB_API_ERROR",
      message,
      remediation,
      context,
    });
  }
  return new GitError({
    code: "GITHUB_API_ERROR",
    message: fallbackMessage,
    cause: err,
  });
}

/** Wrap an Octokit call with a one-shot credential retry. A first 401 can be
 *  transient on GitHub's side, so rebuild the client from the still-stored
 *  token and try once more. Only a second explicit credential rejection may
 *  clear the durable credential. */
async function withAuthRetry<T>(
  fn: (octokit: OctokitClass) => Promise<T>,
): Promise<T> {
  const oct = await getOctokit();
  const rejectedToken = cachedOctokitToken;
  try {
    return await fn(oct);
  } catch (err) {
    if (!isCredentialInvalid(err)) {
      throw wrapApiError(err, "GitHub API call failed");
    }

    const replacement =
      rejectedToken && tokenStore.refreshAfterRejection
        ? await tokenStore
            .refreshAfterRejection(rejectedToken)
            .catch(() => null)
        : undefined;
    clearOctokitCache();
    // A rotating credential owner handled this rejection but could not safely
    // provide a replacement. Preserve its durable state and surface the
    // original rejection instead of clearing or immediately reusing it.
    if (replacement === null) {
      throw wrapApiError(err, "GitHub API call failed");
    }
    let retryToken: string | null = null;
    try {
      const retryOctokit = await getOctokit();
      retryToken = cachedOctokitToken;
      return await fn(retryOctokit);
    } catch (retryErr) {
      if (isCredentialInvalid(retryErr)) {
        clearOctokitCache();
        // GitHub has now rejected this credential twice, so whatever login it
        // once proved is no longer evidence of anything — drop it here rather
        // than only in getAuthStatus. This path is the one reachable from
        // ordinary background traffic (gh.prSync and every other gh.* op),
        // and without it `cachedGithubLogin()` keeps returning the
        // signed-out account while `resolveNewBranchPrefix` stamps it onto
        // every branch created from here on. That direction is permanent;
        // falling back to `zeros/` until the next getAuthStatus re-learns the
        // login is not (see forgetGithubLogin).
        //
        // Unconditional, and deliberately not gated on whether the CAS below
        // actually cleared: `false` there means a concurrent reconnect won
        // with a NEWER credential, which may well belong to a different
        // account — the one case where the cached login is most certainly
        // stale.
        rememberLogin(null);
        if (retryToken && tokenStore.clearAfterRejection) {
          await tokenStore.clearAfterRejection(retryToken);
        } else if (retryToken && (await tokenStore.get()) === retryToken) {
          await tokenStore.clear();
        }
      }
      throw wrapApiError(retryErr, "GitHub API call failed");
    }
  }
}

// ── Parse owner/repo from origin URL ─────────────────────

/** Derive { owner, repo } from a GitHub origin URL. Used by every PR
 *  call. We don't infer this from `repoSlug` because the slug
 *  lowercases everything and joins with hyphens, which mangles
 *  case-sensitive owners (e.g. "AcmeCorp"). */
export function parseGitHubRemote(originUrl: string): {
  owner: string;
  repo: string;
} {
  const input = originUrl.trim();
  let host = "";
  let rawPath = "";

  // scp-like SSH: git@github.com:owner/repo.git or the valid userless form
  // github.com:owner/repo.git.
  const scpMatch = input.includes("://")
    ? null
    : input.match(/^(?:[^@/:\s]+@)?([^:/\s]+):(.+)$/);
  if (scpMatch) {
    host = scpMatch[1];
    rawPath = scpMatch[2];
  } else {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "The configured remote is not a valid GitHub URL.",
      });
    }
    if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "The configured remote uses an unsupported Git protocol.",
      });
    }
    // A password in the URL is a real bypass of the selected method. A bare
    // username is not — `https://alice@github.com/o/r.git` is a widespread
    // legacy remote that carries no secret, and refusing it made every GitHub
    // API operation (including Create PR) fail on those repositories.
    if (url.password) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message:
          "The configured GitHub remote contains an embedded credential.",
        remediation: "Remove the password from the remote URL, then try again.",
      });
    }
    host = url.hostname;
    rawPath = url.pathname;
  }

  const normalizedHost = host.toLowerCase().replace(/\.$/, "");
  if (
    normalizedHost !== "github.com" &&
    normalizedHost !== "www.github.com" &&
    normalizedHost !== "ssh.github.com"
  ) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "The configured remote does not point to github.com.",
    });
  }

  const parts = rawPath
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  if (parts.length !== 2) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "Could not parse an owner and repository from the GitHub remote.",
    });
  }

  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(parts[0]);
    repo = decodeURIComponent(parts[1]).replace(/\.git$/i, "");
  } catch {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "Could not parse an owner and repository from the GitHub remote.",
    });
  }
  if (!owner || !repo || /[/\\]/.test(owner) || /[/\\]/.test(repo)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "Could not parse an owner and repository from the GitHub remote.",
    });
  }
  return { owner, repo };
}

export interface GithubRepositoryOwnerAvatar {
  login: string;
  type: "user" | "org" | null;
  avatarUrl: string;
}

/** Load the canonical owner avatar from GitHub's account payload. GitHub's
 *  `/users/{username}` resource represents both individual and organization
 *  accounts, so this does not need repository visibility or a guessed avatar
 *  URL. This is a best-effort UI read: callers decide whether an API/network
 *  failure should be surfaced or degraded to a repository initial. */
export async function getRepositoryOwnerAvatar(
  originUrl: string,
): Promise<GithubRepositoryOwnerAvatar | null> {
  const { owner } = parseGitHubRemote(originUrl);
  const oct = await getOptionalAuthOctokit();
  try {
    const response = await oct.users.getByUsername({ username: owner });
    const avatarUrl = response.data.avatar_url?.trim();
    if (!avatarUrl) return null;

    let parsed: URL;
    try {
      parsed = new URL(avatarUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return null;
    }

    const rawType = response.data.type?.toLowerCase();
    return {
      login: response.data.login || owner,
      type:
        rawType === "organization" ? "org" : rawType === "user" ? "user" : null,
      avatarUrl: parsed.href,
    };
  } catch (err) {
    throw wrapApiError(err, "Could not load the repository owner avatar");
  }
}

// ── PR operations ────────────────────────────────────────

function octoPrToPr(p: {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean | null;
  title: string;
  body: string | null;
  user: { login: string } | null;
  base: { ref: string };
  head: { ref: string; sha: string };
  mergeable?: boolean | null;
  mergeable_state?: string;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
}): PR {
  let state: PrState;
  if (p.merged_at) state = "merged";
  else if (p.state === "closed") state = "closed";
  else if (p.draft) state = "draft";
  else state = "ready";
  return {
    number: p.number,
    url: p.html_url,
    state,
    title: p.title,
    body: p.body ?? "",
    authorLogin: p.user?.login ?? "",
    baseBranch: p.base.ref,
    headBranch: p.head.ref,
    headSha: p.head.sha,
    mergeableState: p.mergeable_state ?? "unknown",
    isMergeable: p.mergeable ?? null,
    createdAt: new Date(p.created_at).getTime(),
    updatedAt: new Date(p.updated_at).getTime(),
    mergedAt: p.merged_at ? new Date(p.merged_at).getTime() : null,
    mergeCommitSha: p.merge_commit_sha ?? null,
  };
}

/** Look up the workspace's GitHub remote → { owner, repo }. Shells out
 *  to git so we don't have to plumb the remote URL through the workspace
 *  record. */
async function workspaceRemote(workspaceId: string): Promise<{
  owner: string;
  repo: string;
}> {
  const ws = getWorkspace(workspaceId);
  // The repo's configured `git.remote` (the "Remote origin" setting, default
  // "origin") — every PR op targets the same remote as push/pull/create.
  // Settings-sourced, so guard it before it reaches git as a positional.
  const { remote } = resolveRepoGit(ws.repoRoot);
  assertSafeGitRef(remote, "workspaceRemote.remote");
  let stdout: string;
  try {
    ({ stdout } = await runFile(
      "git",
      ["-C", ws.repoRoot, "remote", "get-url", remote],
      { maxBufferBytes: 1024 * 1024 },
    ));
  } catch (err) {
    // No such remote (or git failed) — `git remote get-url` exits 128 with a
    // raw child-process error. Without this it escapes BEFORE withAuthRetry's
    // classification and surfaces as an unstructured WORKSPACE_OP_FAILED.
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `This repository has no '${remote}' remote on GitHub.`,
      remediation:
        remote === "origin"
          ? "Publish the repository to GitHub (or add an 'origin' remote) before opening a pull request."
          : `Add a '${remote}' remote, or pick a different remote in the repo's Git settings, before opening a pull request.`,
      cause: err,
    });
  }
  return parseGitHubRemote(stdout.trim());
}

// ── Repository access preflight ──────────────────────────

/** Can the selected connection open a pull request on this workspace's remote? */
export interface GithubRepoAccess {
  /** `blocked` is a DEFINITE refusal — the same request with the same
   *  connection cannot succeed. `unknown` means the probe itself failed
   *  (offline, rate limited, 5xx) and is deliberately not a refusal: callers
   *  must fall through to the real operation rather than ground it for a
   *  reason the user cannot act on. */
  state: "ok" | "blocked" | "unknown";
  /** Whether any GitHub credential is selected and readable. Absent when the
   *  probe never got as far as the credential store. */
  connected?: boolean;
  code?: GitErrorCode;
  message?: string;
  remediation?: string;
}

/** Refusals that survive a retry. Everything else — a rate limit, a dropped
 *  connection, a GitHub 5xx — is a failure of the PROBE, not evidence about
 *  access, and must never be reported as one. */
const BLOCKING_ACCESS_CODES = new Set<GitErrorCode>([
  "NOT_AUTHENTICATED",
  "GITHUB_REPO_NOT_INSTALLED",
  "GITHUB_FORBIDDEN_SCOPE",
  "GITHUB_SSO_REQUIRED",
  "GITHUB_INSTALLATION_SUSPENDED",
]);

/** One `GET /repos/{owner}/{repo}` against the workspace's CONFIGURED remote —
 *  cheap next to the push + `pulls.create` it guards, and the only way to tell
 *  "not signed in" apart from "signed in, but this repository is outside the
 *  connection's reach".
 *
 *  Those two states are otherwise indistinguishable to every caller: GitHub
 *  answers both with a 404, and `git push` answers the second with "remote:
 *  Repository not found", which classifyGitTransportError has to read as
 *  NOT_AUTHENTICATED so the credential-rotation retry still fires. Without this
 *  probe, a user with a connected GitHub App that simply doesn't include this
 *  repository was told to connect GitHub.
 *
 *  Never throws — the caller uses the result to CHOOSE a message, and a probe
 *  that failed for its own reasons must not become that message. */
export async function getWorkspaceRepoAccess(
  workspaceId: string,
): Promise<GithubRepoAccess> {
  let connected: boolean;
  try {
    connected = Boolean(await tokenStore.get());
  } catch {
    return { state: "unknown" };
  }
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = await workspaceRemote(workspaceId));
  } catch (err) {
    // No configured remote, a non-github.com host, an embedded credential —
    // definite and fixable, and none of them needs a GitHub round trip.
    if (!isGitError(err)) return { state: "unknown", connected };
    return {
      state: "blocked",
      connected,
      code: err.code,
      message: err.message,
      ...(err.remediation ? { remediation: err.remediation } : {}),
    };
  }
  if (!connected) {
    return {
      state: "blocked",
      connected: false,
      code: "NOT_AUTHENTICATED",
      message: "Not signed in to GitHub",
      remediation: "Connect GitHub in Settings → Integrations.",
    };
  }
  try {
    const response = await withAuthRetry((oct) =>
      oct.repos.get({ owner, repo }),
    );
    // `permissions.push === false` is the authenticated account's own write
    // bit: definite, so it blocks. `true` is NOT a guarantee (an App
    // installation can hold narrower `contents` permission than the user who
    // authorized it), so it never blocks — this probe may only ever remove a
    // wrong message, never a pull request that would have worked.
    if (response.data.permissions?.push === false) {
      return {
        state: "blocked",
        connected: true,
        code: "GITHUB_FORBIDDEN_SCOPE",
        message: "This GitHub connection cannot push to this repository.",
        remediation:
          "A pull request has to push its branch first. Ask for write access on GitHub, or connect an account that has it.",
      };
    }
    return { state: "ok", connected: true };
  } catch (err) {
    const wrapped = wrapApiError(
      err,
      "Could not check GitHub repository access",
    );
    if (!BLOCKING_ACCESS_CODES.has(wrapped.code)) {
      return { state: "unknown", connected: true };
    }
    return {
      state: "blocked",
      connected: true,
      code: wrapped.code,
      message: wrapped.message,
      ...(wrapped.remediation ? { remediation: wrapped.remediation } : {}),
    };
  }
}

export interface CreatePrOptions {
  workspaceId: string;
  title: string;
  body: string;
  draft?: boolean;
}

/** Does this error indicate the repo/plan rejects DRAFT pull requests? GitHub
 *  returns a 422 ("Draft pull requests are not supported …"). Matches both the
 *  raw Octokit error and our fixed-copy wrapped GitError. Used to retry once
 *  as a normal PR rather than fail outright. */
function isDraftUnsupported(err: unknown): boolean {
  const e = err as {
    status?: number;
    code?: string;
    message?: string;
    context?: { reason?: unknown };
  };
  if (e?.context?.reason === "draft-unsupported") return true;
  const msg = (e?.message ?? "").toLowerCase();
  const looksLikeApi = e?.status === 422 || e?.code === "GITHUB_API_ERROR";
  return (
    looksLikeApi &&
    /draft/.test(msg) &&
    /(not|cannot|unsupported|isn't)/.test(msg)
  );
}

/** Test seam: createPr pushes the head branch before opening the PR. Tests stub
 *  this so they don't make a real network push (mirrors the octokit/tokenStore
 *  injection seams). Defaults to the real `push` op. */
let pushImpl: typeof push = push;
export function setPushForTesting(fn: typeof push | null): void {
  pushImpl = fn ?? push;
}

export async function createPr(opts: CreatePrOptions): Promise<PR> {
  const ws = getWorkspace(opts.workspaceId);
  // Validate the GitHub remote up front (clear error if there's no origin).
  const { owner, repo } = await workspaceRemote(opts.workspaceId);
  // Worktree branches are created locally-only (`git worktree add -b`) and there
  // is no manual Push control anymore — so the head branch is usually absent on
  // origin. Push it FIRST, otherwise `pulls.create` 422s with "head sha can't be
  // found" / "No commits between base and head". Idempotent: a no-op when the
  // branch is already pushed and up to date.
  await pushImpl({ workspaceId: opts.workspaceId, setUpstream: true });

  const wantDraft = opts.draft ?? true;
  const createWith = (draft: boolean) =>
    withAuthRetry((oct) =>
      oct.pulls.create({
        owner,
        repo,
        title: opts.title,
        body: opts.body,
        head: ws.branch,
        base: ws.baseBranch,
        draft,
      }),
    );

  let pr;
  try {
    pr = await createWith(wantDraft);
  } catch (err) {
    // Repo/plan doesn't allow draft PRs → retry once as a normal PR so the user
    // still gets a PR instead of an opaque 422.
    if (wantDraft && isDraftUnsupported(err)) {
      pr = await createWith(false);
    } else {
      throw err;
    }
  }

  const parsed = octoPrToPr(pr.data);
  updateWorkspace(opts.workspaceId, {
    prNumber: parsed.number,
    prState: parsed.state,
    prUrl: parsed.url,
  });
  // Opening a PR moves the workspace to "in-review" (unless it was manually
  // cancelled / is archived — advanceLifecycle guards that).
  advanceLifecycle(opts.workspaceId, "in-review");
  return parsed;
}

/** Detect the pull request for a workspace's branch on GitHub and reconcile the
 *  workspace row (prNumber/prState/prUrl + lifecycle status).
 *
 *  This is the reconciliation path for PRs whose lifecycle happens OUTSIDE our
 *  create/merge buttons — e.g. the agent runs `gh pr create` in its own shell
 *  (the Zeros "Create PR" flow hands the agent a brief), or the user opens/merges
 *  a PR from the terminal / github.com. Those never touch the engine, so the row
 *  would otherwise never learn its prNumber (→ the island stays hidden) or that
 *  the PR merged (→ the workspace would sit in "in-review" forever).
 *
 *  Queries `state: "all"` so it catches both a live PR (→ "in-review") and a
 *  merged PR (→ "done", the external-merge path). Lifecycle moves go through
 *  advanceLifecycle, so a manually-cancelled / archived row is never disturbed.
 *
 *  Idempotent + best-effort: returns the PR when one is found (stamping the row
 *  only if something changed, to avoid needless DB_CHANGED churn), else null.
 *  Never throws for the ordinary "no origin / not authenticated / no PR yet"
 *  cases — the caller reads null as "no PR". */
export async function syncWorkspacePr(workspaceId: string): Promise<PR | null> {
  const ws = getWorkspace(workspaceId);
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = await workspaceRemote(workspaceId));
  } catch {
    return null; // no GitHub origin → nothing to sync
  }
  let rows;
  try {
    rows = await withAuthRetry((oct) =>
      oct.pulls.list({
        owner,
        repo,
        state: "all", // include merged/closed so an external merge → "done"
        head: `${owner}:${ws.branch}`,
        per_page: 10,
      }),
    );
  } catch {
    return null; // not authenticated / network / API error → stay quiet
  }
  // Server-side `head` filter should already scope to this branch, but it can be
  // silently ignored/misapplied — so require an exact `head.ref` match and bail
  // otherwise. (A fallback to rows.data[0] here would stamp an UNRELATED PR onto
  // this workspace whenever the filter misfires — the exact case this re-check
  // guards against.) Prefer a still-open PR; otherwise take the newest match
  // (pulls.list is created-desc), which is the relevant merged/closed one.
  const matches = rows.data.filter((p) => p.head?.ref === ws.branch);
  if (matches.length === 0) return null; // no PR for THIS branch
  const chosen = matches.find((p) => p.state === "open") ?? matches[0];

  // List rows may omit merged_at, so for a CLOSED row fetch PR detail to tell a
  // merge from a plain close (one extra call, only when a closed PR is found).
  let parsed: PR;
  if (chosen.state === "open") {
    parsed = octoPrToPr({
      ...chosen,
      merged_at: null,
      mergeable: null,
      mergeable_state: undefined,
    });
  } else {
    try {
      const detail = await withAuthRetry((oct) =>
        oct.pulls.get({ owner, repo, pull_number: chosen.number }),
      );
      parsed = octoPrToPr(detail.data);
    } catch {
      parsed = octoPrToPr({
        ...chosen,
        merged_at: null,
        mergeable: null,
        mergeable_state: undefined,
      });
    }
  }

  // A closed-unmerged PR is historical, not an active review. When the workspace
  // has no recorded PR yet, do not backfill it: doing so hides the Create PR
  // affordance and leaves only "Archive" for a branch that may need a new PR.
  if (parsed.state === "closed" && ws.prNumber == null) {
    return null;
  }

  if (
    ws.prNumber !== parsed.number ||
    ws.prState !== parsed.state ||
    ws.prUrl !== parsed.url
  ) {
    updateWorkspace(workspaceId, {
      prNumber: parsed.number,
      prState: parsed.state,
      prUrl: parsed.url,
    });
  }
  // A merged PR → "done"; a live PR (draft/ready) → "in-review". A closed-unmerged
  // PR leaves status untouched (the user decides whether to cancel it).
  if (parsed.state === "merged") {
    advanceLifecycle(workspaceId, "done");
  } else if (parsed.state !== "closed") {
    advanceLifecycle(workspaceId, "in-review");
  }
  return parsed;
}

// ── Publish a local repo to GitHub (create private repo + push) ──────────
//
// The "Publish to GitHub" offer: turn a local-only project into a GitHub repo.
// Keyed on a bare repoRoot (NOT a workspaceId) — a freshly added local project
// has no workspace row. Handles both screenshot states: a non-git folder
// (git-init + commit first) and a git-but-remoteless folder (create + push).
// The push relies on the user's git credential helper (gh), same as the
// existing workspace push.

export interface GithubOwner {
  login: string;
  type: "user" | "org";
  avatarUrl: string | null;
}

/** Publish targets: the authed user + every org they belong to (the dialog's
 *  Owner dropdown). Org listing needs `read:org`; if absent we return user-only. */
export async function listGithubOwners(): Promise<GithubOwner[]> {
  return withAuthRetry(async (oct) => {
    const me = await oct.users.getAuthenticated();
    const owners: GithubOwner[] = [
      {
        login: me.data.login,
        type: "user",
        avatarUrl: me.data.avatar_url ?? null,
      },
    ];
    try {
      const orgs = await oct.orgs.listForAuthenticatedUser({ per_page: 100 });
      for (const o of orgs.data) {
        owners.push({
          login: o.login,
          type: "org",
          avatarUrl: o.avatar_url ?? null,
        });
      }
    } catch {
      /* no org scope — user-only is fine */
    }
    return owners;
  });
}

/** Whether `<owner>/<name>` is free to create (the dialog's "name is available"
 *  check). 404 → available; 200 → taken. */
export async function checkRepoNameAvailable(opts: {
  owner: string;
  name: string;
}): Promise<{ available: boolean }> {
  const oct = await getOctokit();
  try {
    await oct.repos.get({ owner: opts.owner, repo: opts.name });
    return { available: false };
  } catch (err) {
    if ((err as { status?: number }).status === 404) return { available: true };
    throw wrapApiError(err, "Could not check repository name availability");
  }
}

export interface PublishRepoOptions {
  /** Absolute path to the folder to publish (git-init'd in place if needed). */
  repoRoot: string;
  /** New repository name on GitHub. */
  name: string;
  /** Owner login — the authed user (default) or an org the user belongs to. */
  owner?: string;
  /** Create a private repo (default true). */
  private?: boolean;
}

export interface PublishRepoResult {
  /** https clone URL added as `origin`. */
  originUrl: string;
  /** Browser URL of the new repo. */
  htmlUrl: string;
  owner: string;
  repo: string;
}

/** Result of {@link initRepoInPlace}. */
export interface InitRepoInPlaceResult {
  /** Branch HEAD ended up on (e.g. "main"). */
  branch: string;
  /** True when this call ran `git init` (the folder wasn't a repo before). */
  initialized: boolean;
}

/** Turn an EXISTING folder into a local git repo: `git init` (if it isn't one
 *  already) + an initial commit of the current tree (if there's no HEAD yet).
 *  No remote, no GitHub — the local-only half of {@link publishRepoToGithub},
 *  which delegates here so the two paths share one implementation. Idempotent:
 *  a folder that's already a repo with a commit is returned unchanged. */
export async function initRepoInPlace(
  repoRoot: string,
): Promise<InitRepoInPlaceResult> {
  if (!repoRoot || typeof repoRoot !== "string") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "initRepoInPlace: repoRoot is required",
    });
  }
  const initialized = !(await isRepo(repoRoot));
  if (initialized) {
    await runGit(repoRoot, ["init", "-q", "-b", "main"]);
  }
  await ensureGitIdentity(repoRoot);
  if (!(await refExists(repoRoot, "HEAD"))) {
    await runGit(repoRoot, ["add", "-A"]);
    // --allow-empty: plain `git commit` exits 1 with "nothing to commit" when
    // the index is empty, which failed Initialize Git on exactly the folders
    // that need it most — an empty folder, or one where every file is
    // gitignored. An empty root commit is a perfectly good worktree base, so
    // the repo ends up workspace-ready either way. Files present still commit
    // normally; the flag only widens what's accepted.
    await runGit(repoRoot, [
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "Initial commit",
    ]);
  }
  const branch =
    (
      await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    ).stdout.trim() || "main";
  return { branch, initialized };
}

/** git-init (if needed) + commit the current tree (if no HEAD) + create the
 *  GitHub repo + add it as `origin` + push the current branch. The dialog must
 *  check name availability first — a name collision surfaces as a GITHUB_API_ERROR. */
export async function publishRepoToGithub(
  opts: PublishRepoOptions,
): Promise<PublishRepoResult> {
  const { repoRoot, name } = opts;
  if (!repoRoot || typeof repoRoot !== "string") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "publishRepoToGithub: repoRoot is required",
    });
  }
  if (!name || typeof name !== "string") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "publishRepoToGithub: name is required",
    });
  }

  // 1. Ensure the folder is a git repo with at least one commit on a branch
  //    (shared with the local-only "Initialize Git" path).
  const { branch } = await initRepoInPlace(repoRoot);

  // 2. Create the repo on GitHub (under the user or an org).
  const me = await withAuthRetry((oct) => oct.users.getAuthenticated());
  const authedLogin = me.data.login;
  const isOrg = !!opts.owner && opts.owner !== authedLogin;
  const isPrivate = opts.private ?? true;
  const created = await withAuthRetry((oct) =>
    isOrg
      ? oct.repos.createInOrg({
          org: opts.owner!,
          name,
          private: isPrivate,
        })
      : oct.repos.createForAuthenticatedUser({ name, private: isPrivate }),
  );
  const data = created.data as {
    clone_url?: string;
    html_url?: string;
    owner?: { login?: string };
    name?: string;
  };
  const originUrl = data.clone_url ?? "";
  const createdOwner = data.owner?.login ?? opts.owner ?? authedLogin;
  const createdRepo = data.name ?? name;

  // 3. Wire the repository's configured remote + push the current branch (set
  //    upstream). Capture the old URL so this multi-system mutation can roll
  //    back both sides if transport fails: leaving a newly-created but empty
  //    GitHub repository (and a local remote pointing at it) makes retrying
  //    impossible without manual cleanup.
  const { remote } = resolveRepoGit(repoRoot);
  assertSafeGitRef(remote, "publish.remote");
  let previousRemoteUrl: string | null = null;
  try {
    previousRemoteUrl = (
      await runGit(repoRoot, ["remote", "get-url", remote])
    ).stdout.trim();
  } catch {
    /* no configured remote yet */
  }
  let remoteMutated = false;
  try {
    if (!originUrl) {
      throw new GitError({
        code: "GITHUB_API_ERROR",
        message: "GitHub did not return a clone URL for the new repository",
      });
    }
    if (previousRemoteUrl !== null) {
      await runGit(repoRoot, ["remote", "set-url", remote, originUrl]);
    } else {
      await runGit(repoRoot, ["remote", "add", remote, originUrl]);
    }
    remoteMutated = true;
    await runGit(repoRoot, ["push", "-u", remote, branch], {
      timeoutMs: 60_000,
      mapErrorCode: (stderr) =>
        classifyGitTransportError(stderr) ?? "GIT_COMMAND_FAILED",
    });
  } catch (error) {
    // Best-effort compensation, ordered so a partial rollback cannot strand the
    // user. Deleting the repository needs `delete_repo` / `Administration:
    // write`, which none of the selectable methods requests (`gh auth login`
    // grants repo, read:org, gist, workflow), so this DELETE commonly 403s.
    // Unwiring the local remote anyway would leave an orphan repo on GitHub AND
    // no remote locally — worse than doing nothing, because the name is now
    // taken and there is no remote left to retry the push against. Roll the
    // remote back only once the repository is confirmed gone.
    const deleted = await withAuthRetry((oct) =>
      oct.repos.delete({ owner: createdOwner, repo: createdRepo }),
    ).then(
      () => true,
      () => false,
    );
    if (deleted && remoteMutated) {
      await (
        previousRemoteUrl === null
          ? runGit(repoRoot, ["remote", "remove", remote])
          : runGit(repoRoot, ["remote", "set-url", remote, previousRemoteUrl])
      ).catch(() => {
        // Preserve the primary push/configuration error below.
      });
    }
    throw error;
  }

  return {
    originUrl,
    htmlUrl: data.html_url ?? "",
    owner: createdOwner,
    repo: createdRepo,
  };
}

/** Ensure a local committer identity so `git commit` works on fresh installs
 *  without global git config. Only sets values that are MISSING — never
 *  clobbers an existing user.name/user.email. */
async function ensureGitIdentity(repoRoot: string): Promise<void> {
  const pairs: ReadonlyArray<[string, string]> = [
    ["user.email", "noreply@zeros.design"],
    ["user.name", "Zeros"],
  ];
  for (const [key, val] of pairs) {
    try {
      const { stdout } = await runGit(repoRoot, ["config", "--get", key]);
      if (stdout.trim()) continue; // already set — leave it
    } catch {
      /* unset → set below */
    }
    try {
      await runGit(repoRoot, ["config", key, val]);
    } catch {
      /* best effort */
    }
  }
}

export interface UpdatePrOptions {
  workspaceId: string;
  prNumber: number;
  title?: string;
  body?: string;
}

export async function updatePr(opts: UpdatePrOptions): Promise<PR> {
  const { owner, repo } = await workspaceRemote(opts.workspaceId);
  const pr = await withAuthRetry((oct) =>
    oct.pulls.update({
      owner,
      repo,
      pull_number: opts.prNumber,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    }),
  );
  const parsed = octoPrToPr(pr.data);
  updateWorkspace(opts.workspaceId, { prState: parsed.state });
  return parsed;
}

export interface MarkReadyOptions {
  workspaceId: string;
  prNumber: number;
}

/** GitHub's REST API can't toggle a PR from draft to ready — that
 *  capability is GraphQL-only via `markPullRequestReadyForReview`. We
 *  resolve the PR's node_id first, then run the mutation. */
export async function markPrReady(opts: MarkReadyOptions): Promise<PR> {
  const { owner, repo } = await workspaceRemote(opts.workspaceId);
  const pr = await withAuthRetry((oct) =>
    oct.pulls.get({ owner, repo, pull_number: opts.prNumber }),
  );
  const nodeId = (pr.data as { node_id: string }).node_id;
  await withAuthRetry((oct) =>
    oct.graphql(
      `mutation($id: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $id }) {
          pullRequest { id }
        }
      }`,
      { id: nodeId },
    ),
  );
  // Re-fetch so the returned PR reflects the new state.
  const after = await withAuthRetry((oct) =>
    oct.pulls.get({ owner, repo, pull_number: opts.prNumber }),
  );
  const parsed = octoPrToPr(after.data);
  updateWorkspace(opts.workspaceId, { prState: parsed.state });
  return parsed;
}

export interface GetPrOptions {
  workspaceId: string;
  prNumber: number;
}

/** behind-by counts per `owner/repo#pr`, keyed to the PR's head SHA (a push
 *  invalidates immediately) with a TTL bound on base-branch movement. Bounded:
 *  entries exist only for PRs currently in the "behind" state. */
const behindByCache = new Map<
  string,
  { baseRef: string; headSha: string; at: number; value: number | null }
>();
const BEHIND_BY_TTL_MS = 5 * 60_000;
const MAX_BEHIND_BY_ENTRIES = 128;

async function getBehindBy(
  owner: string,
  repo: string,
  prNumber: number,
  baseRef: string,
  headLabel: string,
  headSha: string,
): Promise<number | null> {
  const key = `${owner}/${repo}#${prNumber}`;
  const cached = behindByCache.get(key);
  if (
    cached &&
    cached.baseRef === baseRef &&
    cached.headSha === headSha &&
    Date.now() - cached.at < BEHIND_BY_TTL_MS
  ) {
    return cached.value;
  }
  let value: number | null = null;
  try {
    const cmp = await withAuthRetry((oct) =>
      oct.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${baseRef}...${headLabel}`,
        per_page: 1,
      }),
    );
    value = cmp.data.behind_by ?? null;
  } catch {
    value = null;
  }
  behindByCache.delete(key);
  behindByCache.set(key, { baseRef, headSha, at: Date.now(), value });
  while (behindByCache.size > MAX_BEHIND_BY_ENTRIES) {
    const oldest = behindByCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    behindByCache.delete(oldest);
  }
  return value;
}

export function resetBehindByCacheForTesting(): void {
  behindByCache.clear();
}

export async function getPr(opts: GetPrOptions): Promise<PR> {
  const { owner, repo } = await workspaceRemote(opts.workspaceId);
  const pr = await withAuthRetry((oct) =>
    oct.pulls.get({ owner, repo, pull_number: opts.prNumber }),
  );
  const parsed = octoPrToPr(pr.data);
  // "behind" = the repo requires branches to be current before merging and the
  // base has moved on. Fetch the real commit count from GitHub's compare (the
  // local remote-tracking ref can be fetch-stale) — only in this state, so the
  // common path stays a single API call. `head.label` (owner:branch) keeps
  // fork PRs correct. Best-effort: the label renders count-less on failure.
  // The count is TTL-cached per PR head SHA — the island polls getPr every
  // minute and a behind-state PR is exactly the one left open longest, so
  // without the cache every poll would double its API traffic.
  if (parsed.mergeableState === "behind") {
    parsed.behindBy = await getBehindBy(
      owner,
      repo,
      opts.prNumber,
      pr.data.base.ref,
      (pr.data.head as { label: string; sha: string }).label,
      (pr.data.head as { label: string; sha: string }).sha,
    );
  }
  // Reconcile an EXTERNAL merge (merged on github.com / the CLI, not via our
  // Merge button) into the persisted lifecycle. getPr is the island's live
  // refresh read, so this flips a known-PR workspace to "done" with no extra API
  // call. Guarded + idempotent: write prState only if it changed, and
  // advanceLifecycle no-ops once done / when cancelled / when archived.
  if (parsed.state === "merged") {
    const ws = getWorkspace(opts.workspaceId);
    if (ws && ws.prState !== "merged") {
      updateWorkspace(opts.workspaceId, { prState: "merged" });
    }
    advanceLifecycle(opts.workspaceId, "done");
  }
  return parsed;
}

export interface ListPrsOptions {
  /** Owner/repo from the originUrl. Different IPC shape from PR write
   *  ops because the listing isn't tied to a single workspace. */
  owner: string;
  repo: string;
  state?: "open" | "closed" | "all";
}

export async function listPrs(opts: ListPrsOptions): Promise<PR[]> {
  const prs = await withAuthRetry((oct) =>
    oct.pulls.list({
      owner: opts.owner,
      repo: opts.repo,
      state: opts.state ?? "open",
      per_page: 50,
    }),
  );
  return prs.data.map((p) =>
    octoPrToPr({
      ...p,
      // pulls.list rows don't carry merged_at; the field exists only on
      // pulls.get responses. Treat closed-with-no-merged as "closed",
      // closed-with-merge handled at PR-detail time.
      merged_at: null,
      mergeable: null,
      mergeable_state: undefined,
    }),
  );
}

// ── PR review data (checks / commits / reviews / comments) ───

export interface PrCheck {
  name: string;
  /** queued | in_progress | completed (check runs) or state (statuses). */
  status: string;
  /** success | failure | neutral | cancelled | … (null while running). */
  conclusion: string | null;
  detailsUrl: string | null;
  /** Epoch ms — check-run timing for the Checks tab's duration column.
   *  Commit statuses don't report timing, so both stay null there. */
  startedAt: number | null;
  completedAt: number | null;
}

export interface PrDeployment {
  /** Context label, e.g. "cloudflare-workers-and-pages". */
  environment: string;
  state: string;
  description: string | null;
  url: string | null;
}

export interface PrChecksResult {
  checks: PrCheck[];
  deployments: PrDeployment[];
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

/** CI checks + deploy/preview statuses for a PR's head commit. Combines
 *  the Checks API (GitHub Actions etc.) with commit statuses (where
 *  Cloudflare Pages / Vercel preview deploys report, carrying target_url). */
export async function getPrChecks(opts: {
  workspaceId: string;
  prNumber: number;
}): Promise<PrChecksResult> {
  const { owner, repo } = await workspaceRemote(opts.workspaceId);
  const pr = await withAuthRetry((oct) =>
    oct.pulls.get({ owner, repo, pull_number: opts.prNumber }),
  );
  const sha = (pr.data as { head: { sha: string } }).head.sha;
  const [runs, statuses] = await Promise.all([
    withAuthRetry((oct) =>
      oct.checks.listForRef({ owner, repo, ref: sha, per_page: 100 }),
    ),
    withAuthRetry((oct) =>
      oct.repos.listCommitStatusesForRef({
        owner,
        repo,
        ref: sha,
        per_page: 100,
      }),
    ),
  ]);
  const checks: PrCheck[] = runs.data.check_runs.map((c) => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
    detailsUrl: c.details_url ?? c.html_url ?? null,
    startedAt: c.started_at ? new Date(c.started_at).getTime() : null,
    completedAt: c.completed_at ? new Date(c.completed_at).getTime() : null,
  }));
  // Commit statuses: keep only the latest per context (the API returns
  // newest-first). Surface deploy-like contexts as deployment cards.
  const seen = new Set<string>();
  const deployments: PrDeployment[] = [];
  for (const s of statuses.data) {
    if (seen.has(s.context)) continue;
    seen.add(s.context);
    if (/deploy|pages|vercel|netlify|cloudflare|preview/i.test(s.context)) {
      deployments.push({
        environment: s.context,
        state: s.state,
        description: s.description ?? null,
        url: s.target_url ?? null,
      });
    } else {
      checks.push({
        name: s.context,
        status: s.state === "pending" ? "in_progress" : "completed",
        conclusion: s.state === "pending" ? null : s.state,
        detailsUrl: s.target_url ?? null,
        startedAt: null,
        completedAt: null,
      });
    }
  }
  const isPass = (c: PrCheck) =>
    c.conclusion === "success" ||
    c.conclusion === "neutral" ||
    c.conclusion === "skipped";
  const isFail = (c: PrCheck) =>
    c.conclusion === "failure" ||
    c.conclusion === "cancelled" ||
    c.conclusion === "timed_out" ||
    c.conclusion === "error";
  return {
    checks,
    deployments,
    total: checks.length,
    passed: checks.filter(isPass).length,
    failed: checks.filter(isFail).length,
    pending: checks.filter((c) => c.conclusion === null).length,
  };
}

export interface PrCommitAuthor {
  name: string;
  avatarUrl: string | null;
}

export interface PrCommitSummary {
  sha: string;
  abbreviatedSha: string;
  message: string;
  authorName: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  date: number;
  /** Additional authors (Co-authored-by) beyond the primary one. */
  coAuthors: PrCommitAuthor[];
  /** Diff stats. Null when the stats lookup fails — the UI hides them. */
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

/** Shape of the per-commit stats GraphQL query below. */
interface PrCommitStatsQuery {
  repository: {
    pullRequest: {
      commits: {
        nodes: Array<{
          commit: {
            oid: string;
            additions: number;
            deletions: number;
            changedFilesIfAvailable: number | null;
            authors: {
              nodes: Array<{
                name: string | null;
                user: { login: string; avatarUrl: string } | null;
              }>;
            };
          };
        }>;
      } | null;
    } | null;
  } | null;
}

export async function getPrCommits(opts: {
  workspaceId: string;
  prNumber: number;
}): Promise<PrCommitSummary[]> {
  const { owner, repo } = await workspaceRemote(opts.workspaceId);
  // The REST list (rows) + one GraphQL query (per-commit ±stats, file counts,
  // co-authors — REST would need an API call per commit). Stats are cosmetic,
  // so a GraphQL failure degrades to null stats instead of failing the list.
  const [r, stats] = await Promise.all([
    withAuthRetry((oct) =>
      oct.pulls.listCommits({
        owner,
        repo,
        pull_number: opts.prNumber,
        per_page: 100,
      }),
    ),
    withAuthRetry(async (oct) => {
      const q = await oct.graphql<PrCommitStatsQuery>(
        `query ($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              commits(first: 100) {
                nodes {
                  commit {
                    oid
                    additions
                    deletions
                    changedFilesIfAvailable
                    authors(first: 6) {
                      nodes { name user { login avatarUrl } }
                    }
                  }
                }
              }
            }
          }
        }`,
        { owner, repo, number: opts.prNumber },
      );
      return q.repository?.pullRequest?.commits?.nodes ?? [];
    }).catch(() => []),
  ]);
  const bySha = new Map(stats.map((n) => [n.commit.oid, n.commit]));
  return r.data.map((c) => {
    const s = bySha.get(c.sha);
    const authorName = c.commit.author?.name ?? c.author?.login ?? "";
    const authorLogin = c.author?.login ?? null;
    // Everyone GraphQL lists beyond the primary author is a co-author.
    const coAuthors: PrCommitAuthor[] = (s?.authors.nodes ?? [])
      .map((a) => ({
        name: a.name ?? a.user?.login ?? "",
        avatarUrl: a.user?.avatarUrl ?? null,
        login: a.user?.login ?? null,
      }))
      .filter(
        (a) =>
          a.name && a.name !== authorName && a.login !== (authorLogin ?? " "),
      )
      .map(({ name, avatarUrl }) => ({ name, avatarUrl }));
    return {
      sha: c.sha,
      abbreviatedSha: c.sha.slice(0, 7),
      message: c.commit.message,
      authorName,
      authorLogin,
      authorAvatarUrl: c.author?.avatar_url ?? null,
      date: new Date(c.commit.author?.date ?? 0).getTime(),
      coAuthors,
      additions: s?.additions ?? null,
      deletions: s?.deletions ?? null,
      changedFiles: s?.changedFilesIfAvailable ?? null,
    };
  });
}

export interface PrTimelineItem {
  kind: "review" | "comment";
  id: number;
  author: string;
  authorAvatarUrl: string | null;
  /** Review state (APPROVED / CHANGES_REQUESTED / COMMENTED) or "". */
  state: string;
  body: string;
  url: string | null;
  createdAt: number;
}

/** Merged review + comment timeline for a PR, oldest-first. Covers the
 *  reviews (verdicts + bodies — e.g. an automated-review card) and the
 *  PR conversation comments. (Per-line inline-comment threads + resolve
 *  are GraphQL and deferred.) */
export async function getPrReviews(opts: {
  workspaceId: string;
  prNumber: number;
}): Promise<PrTimelineItem[]> {
  const { owner, repo } = await workspaceRemote(opts.workspaceId);
  const [reviews, comments] = await Promise.all([
    withAuthRetry((oct) =>
      oct.pulls.listReviews({
        owner,
        repo,
        pull_number: opts.prNumber,
        per_page: 100,
      }),
    ),
    withAuthRetry((oct) =>
      oct.issues.listComments({
        owner,
        repo,
        issue_number: opts.prNumber,
        per_page: 100,
      }),
    ),
  ]);
  const items: PrTimelineItem[] = [];
  for (const r of reviews.data) {
    if (r.state === "PENDING") continue;
    items.push({
      kind: "review",
      id: r.id,
      author: r.user?.login ?? "",
      authorAvatarUrl: r.user?.avatar_url ?? null,
      state: r.state ?? "",
      body: r.body ?? "",
      url: r.html_url ?? null,
      createdAt: new Date(r.submitted_at ?? 0).getTime(),
    });
  }
  for (const c of comments.data) {
    items.push({
      kind: "comment",
      id: c.id,
      author: c.user?.login ?? "",
      authorAvatarUrl: c.user?.avatar_url ?? null,
      state: "",
      body: c.body ?? "",
      url: c.html_url ?? null,
      createdAt: new Date(c.created_at).getTime(),
    });
  }
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

/** Post a top-level comment on the PR conversation. */
export async function addPrComment(opts: {
  workspaceId: string;
  prNumber: number;
  body: string;
}): Promise<{ id: number; url: string }> {
  if (!opts.body || !opts.body.trim()) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "Comment body is empty",
    });
  }
  const { owner, repo } = await workspaceRemote(opts.workspaceId);
  const r = await withAuthRetry((oct) =>
    oct.issues.createComment({
      owner,
      repo,
      issue_number: opts.prNumber,
      body: opts.body,
    }),
  );
  return { id: r.data.id, url: r.data.html_url };
}

export interface MergePrOptions {
  workspaceId: string;
  prNumber: number;
  method: "squash" | "merge" | "rebase";
  commitTitle?: string;
  commitMessage?: string;
}

export async function mergePr(opts: MergePrOptions): Promise<{ sha: string }> {
  const { owner, repo } = await workspaceRemote(opts.workspaceId);
  const result = await withAuthRetry((oct) =>
    oct.pulls.merge({
      owner,
      repo,
      pull_number: opts.prNumber,
      merge_method: opts.method,
      ...(opts.commitTitle !== undefined
        ? { commit_title: opts.commitTitle }
        : {}),
      ...(opts.commitMessage !== undefined
        ? { commit_message: opts.commitMessage }
        : {}),
    }),
  );
  updateWorkspace(opts.workspaceId, { prState: "merged" });
  advanceLifecycle(opts.workspaceId, "done");
  return { sha: result.data.sha };
}
