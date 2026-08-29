// GitHub App OAuth/install flow.
//
// The control plane is the confidential-client boundary: the GitHub client secret
// never ships in Electron. OAuth state + PKCE verifier are single-use (10 min);
// the resulting token pair crosses a second, Zeros-account-bound handoff row for
// at most 90 seconds before Electron persists it in safeStorage.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type pg from "pg";

import type { GithubBackendConfig } from "./config.js";
import { withSystemTx, withUserTx, type Tx } from "./db.js";
import { HttpError } from "./authz.js";
import { rateLimit } from "./ratelimit.js";

const API_VERSION = "2026-03-10";
const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** The hosted page exposes its Open Zeros link for one minute. Keep only 30
 * seconds beyond that for the deep link to reach Electron and finish the
 * authenticated exchange; an abandoned tab must not create a five-minute
 * redemption window. */
export const GITHUB_HANDOFF_TTL_MS = 90_000;
const MAX_INSTALLATION_PAGES = 10;
const MAX_REPOSITORY_COUNT_PROBES = 50;
const REPOSITORY_COUNT_CONCURRENCY = 4;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
/** Ceiling for one route's whole GitHub conversation. The per-request timeout
 *  bounds a single call; without an aggregate deadline 10 installation pages
 *  plus 50 count probes could hold a handler for ~6 minutes — long after the
 *  browser gave up, and long enough for 20 rate-limit-permitted requests from
 *  one account to pin the process. Past the deadline the inventory is reported
 *  incomplete rather than pursued. */
const GITHUB_FLOW_DEADLINE_MS = 30_000;

const NonceSchema = z
  .string()
  .trim()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const VariantSchema = z.literal("github.com");
const SchemeSchema = z.enum([
  "zeros",
  "zeros-alpha",
  "zeros-beta",
  "zeros-dev",
]);
const TokenSchema = z.string().trim().min(1).max(4096);
const RefreshBindingSchema = z
  .string()
  .trim()
  .min(32)
  .max(4096)
  .regex(/^zghrb_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const CloudInstallationTokenBodySchema = z
  .object({
    repositories: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9._-]+$/),
      )
      .min(1)
      .max(500)
      .refine((items) => new Set(items).size === items.length, {
        message: "Repository names must be unique",
      })
      .optional(),
  })
  .strict();

type FetchLike = typeof fetch;

export interface GithubRouteDependencies {
  fetch?: FetchLike;
  now?: () => number;
  random?: (bytes: number) => Buffer;
}

/** Physically purge short-lived OAuth secrets after their logical expiry.
 * Route-level deletes remain defense in depth; this sweep prevents an
 * abandoned browser flow from leaving a still-valid refresh token in a dead
 * handoff row until the next user happens to connect. */
export async function cleanupExpiredGithubOauth(pool: pg.Pool): Promise<void> {
  await withSystemTx(pool, async (tx) => {
    await tx.query(
      `DELETE FROM github_oauth_handoffs WHERE expires_at <= now()`,
    );
    await tx.query(`DELETE FROM github_oauth_states WHERE expires_at <= now()`);
  });
}

export function startGithubOauthCleanup(
  pool: pg.Pool,
  intervalMs = 60_000,
): () => void {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await cleanupExpiredGithubOauth(pool);
    } catch (error) {
      console.warn(
        `[github] OAuth cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export interface GithubInstallation {
  installationId: number;
  appVariantKey: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  targetType: string;
  repositoryCount: number | null;
  allRepositories: boolean;
  suspendedAt: string | null;
  createdAt: string | null;
  lastVerifiedAt: string;
  configureUrl: string | null;
}

interface GithubTokenBundle {
  accessToken: string;
  expiresAtMs: number;
  refreshToken: string;
  refreshTokenExpiresAtMs: number;
}

interface GithubInstallationSnapshot {
  installations: GithubInstallation[];
  /** False when the bounded paginator stopped at its safety ceiling. */
  complete: boolean;
}

interface PendingOauthState {
  owner_user_id: string;
  client_nonce: string;
  scheme: string;
  app_variant: string;
  flow_kind: "oauth" | "install";
  pkce_verifier: string | null;
}

export type GithubOauthFlowKind = "oauth" | "install";

/** A desktop only knows whether this Mac has a credential. The control plane
 * owns the account-level view needed to distinguish a genuine first install
 * from a second Mac reconnecting to an installation that already exists.
 *
 * Authorization alone deliberately counts as prior setup for the automatic
 * choice: a bounded or failed installation inventory read still persists the
 * usable authorization but may have no installation rows. The desktop keeps
 * that unknown inventory distinct from a completed empty inventory. Once it
 * has confirmed zero installations, its explicit recovery action must bypass
 * prior account state so GitHub can create an installation again. */
export function resolveGithubOauthFlowKind(input: {
  installRequested: boolean;
  forceInstallRequested: boolean;
  hasAuthorization: boolean;
  hasInstallation: boolean;
}): GithubOauthFlowKind {
  if (input.forceInstallRequested) return "install";
  return input.installRequested &&
    !(input.hasAuthorization || input.hasInstallation)
    ? "install"
    : "oauth";
}

function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(
      422,
      "invalid_input",
      result.error.issues[0]?.message ?? "Invalid input",
    );
  }
  return result.data;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

/** GitHub requires RS256, an iat backdated for clock drift, and an exp no more
 * than ten minutes ahead. The public client id is the recommended issuer. */
export function createGithubAppJwt(
  config: GithubBackendConfig,
  nowMs: number = Date.now(),
): string {
  if (
    !config.privateKey ||
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0
  ) {
    throw new HttpError(
      503,
      "github_cloud_not_configured",
      "Cloud GitHub access is not configured on this Zeros control plane.",
    );
  }
  let key;
  try {
    key = createPrivateKey(config.privateKey);
  } catch {
    throw new HttpError(
      503,
      "github_cloud_not_configured",
      "Cloud GitHub access is not configured on this Zeros control plane.",
    );
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new HttpError(
      503,
      "github_cloud_not_configured",
      "Cloud GitHub access is not configured on this Zeros control plane.",
    );
  }
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const nowSeconds = Math.floor(nowMs / 1_000);
  const payload = Buffer.from(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: config.clientId,
    }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), key).toString(
    "base64url",
  );
  return `${unsigned}.${signature}`;
}

function pkceChallenge(verifier: string): string {
  // PKCE S256 deliberately uses one SHA-256 digest over a high-entropy random
  // code verifier (RFC 7636); this value is not a user-chosen password.
  return base64url(createHash("sha256").update(verifier, "utf8").digest());
}

// ── Handoff token sealing ────────────────────────────────────────────────
// The browser→desktop handoff must park a GitHub access/refresh pair somewhere
// the desktop can collect it, and the desktop's proof of ownership is the client
// nonce. Deriving the key from that nonce — of which Postgres keeps only a
// SHA-256 — means the row is useless without the nonce: a WAL segment, a PITR
// restore, or the nightly off-platform dump yields ciphertext, not credentials.
// The short-lived row TTL never bounds that risk by itself, because a refresh
// token stays live for ~6 months after the row is gone.

const HANDOFF_SEAL_INFO = "zeros-github-handoff.v1";
const HANDOFF_SEAL_IV_BYTES = 12;
const HANDOFF_SEAL_TAG_BYTES = 16;

function handoffSealKey(nonce: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(nonce, "utf8"),
      sha256(HANDOFF_SEAL_INFO),
      HANDOFF_SEAL_INFO,
      32,
    ),
  );
}

function sealHandoffToken(nonce: string, token: string): Buffer {
  const iv = randomBytes(HANDOFF_SEAL_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", handoffSealKey(nonce), iv);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function openHandoffToken(nonce: string, sealed: Buffer): string {
  if (sealed.length <= HANDOFF_SEAL_IV_BYTES + HANDOFF_SEAL_TAG_BYTES) {
    throw new Error("sealed handoff token is truncated");
  }
  const iv = sealed.subarray(0, HANDOFF_SEAL_IV_BYTES);
  const tag = sealed.subarray(
    HANDOFF_SEAL_IV_BYTES,
    HANDOFF_SEAL_IV_BYTES + HANDOFF_SEAL_TAG_BYTES,
  );
  const decipher = createDecipheriv("aes-256-gcm", handoffSealKey(nonce), iv);
  decipher.setAuthTag(tag);
  return `${decipher.update(
    sealed.subarray(HANDOFF_SEAL_IV_BYTES + HANDOFF_SEAL_TAG_BYTES),
    undefined,
    "utf8",
  )}${decipher.final("utf8")}`;
}

interface RefreshBindingPayload {
  v: 1;
  ownerUserId: string;
  appVariant: string;
  refreshTokenHash: string;
  expiresAtMs: number;
}

function refreshBindingSignature(
  config: GithubBackendConfig,
  encodedPayload: string,
): Buffer {
  // Deliberately NOT the OAuth client secret unless the operator left them the
  // same: rotating the client secret is routine, and a binding key that rotates
  // with it invalidates every outstanding binding at once.
  return createHmac("sha256", config.refreshBindingSecret)
    .update("zeros-github-refresh-binding.v1\0", "utf8")
    .update(encodedPayload, "utf8")
    .digest();
}

function createRefreshBinding(
  config: GithubBackendConfig,
  input: {
    ownerUserId: string;
    appVariant: string;
    refreshToken: string;
    expiresAtMs: number;
  },
): string {
  const payload: RefreshBindingPayload = {
    v: 1,
    ownerUserId: input.ownerUserId,
    appVariant: input.appVariant,
    refreshTokenHash: base64url(sha256(input.refreshToken)),
    expiresAtMs: input.expiresAtMs,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `zghrb_v1.${encodedPayload}.${base64url(
    refreshBindingSignature(config, encodedPayload),
  )}`;
}

function assertRefreshBinding(
  config: GithubBackendConfig,
  binding: string,
  input: {
    ownerUserId: string;
    appVariant: string;
    refreshToken: string;
    nowMs: number;
  },
): void {
  const parts = binding.split(".");
  const [prefix, encodedPayload, encodedSignature] = parts;
  if (
    parts.length !== 3 ||
    prefix !== "zghrb_v1" ||
    !encodedPayload ||
    !encodedSignature
  ) {
    throw new HttpError(
      401,
      "github_binding_invalid",
      "The GitHub refresh authorization is invalid. Reconnect the GitHub App.",
    );
  }
  let signature: Buffer;
  let payload: RefreshBindingPayload;
  try {
    signature = Buffer.from(encodedSignature, "base64url");
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as RefreshBindingPayload;
  } catch {
    throw new HttpError(
      401,
      "github_binding_invalid",
      "The GitHub refresh authorization is invalid. Reconnect the GitHub App.",
    );
  }
  const expectedSignature = refreshBindingSignature(config, encodedPayload);
  const validSignature =
    signature.length === expectedSignature.length &&
    timingSafeEqual(signature, expectedSignature);
  const validPayload =
    payload?.v === 1 &&
    payload.ownerUserId === input.ownerUserId &&
    payload.appVariant === input.appVariant &&
    payload.refreshTokenHash === base64url(sha256(input.refreshToken)) &&
    Number.isSafeInteger(payload.expiresAtMs) &&
    payload.expiresAtMs > input.nowMs;
  if (!validSignature || !validPayload) {
    throw new HttpError(
      401,
      "github_binding_invalid",
      "The GitHub refresh authorization is invalid. Reconnect the GitHub App.",
    );
  }
}

function githubHeaders(token?: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": API_VERSION,
    "user-agent": "zeros-control-plane",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  deadlineAtMs?: number,
): Promise<Response> {
  // Never let one call outlive the route's aggregate deadline.
  const budget =
    deadlineAtMs === undefined
      ? GITHUB_REQUEST_TIMEOUT_MS
      : Math.min(GITHUB_REQUEST_TIMEOUT_MS, deadlineAtMs - Date.now());
  if (budget <= 0) {
    throw new HttpError(
      503,
      "github_timeout",
      "GitHub did not answer in time.",
    );
  }
  try {
    return await fetchImpl(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(budget),
    });
  } catch {
    throw new HttpError(
      503,
      "github_unavailable",
      "GitHub is temporarily unavailable.",
    );
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function stringField(value: unknown, maxLength = 500): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

async function exchangeGithubToken(
  fetchImpl: FetchLike,
  config: GithubBackendConfig,
  params: URLSearchParams,
  nowMs: number,
): Promise<GithubTokenBundle> {
  const response = await fetchWithTimeout(
    fetchImpl,
    `${config.webBaseUrl}/login/oauth/access_token`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "zeros-control-plane",
      },
      body: params.toString(),
    },
  );
  const raw = await responseJson(response);
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  if (!response.ok || typeof body.error === "string") {
    // Only GitHub's explicit refresh-token refusal belongs to the user grant.
    // A bad client secret is our deployment problem and must never make the
    // desktop delete an otherwise valid rotating credential.
    const terminal = body.error === "bad_refresh_token";
    throw new HttpError(
      terminal ? 401 : 503,
      terminal ? "github_authorization_expired" : "github_oauth_failed",
      terminal
        ? "The GitHub authorization expired. Connect the GitHub App again."
        : "GitHub could not finish authorization.",
    );
  }

  const accessToken = stringField(body.access_token, 4096);
  if (!accessToken) {
    throw new HttpError(
      503,
      "github_bad_response",
      "GitHub returned an incomplete authorization response.",
    );
  }
  const expiresIn = positiveInteger(body.expires_in);
  const refreshToken = stringField(body.refresh_token, 4096);
  const refreshExpiresIn = positiveInteger(body.refresh_token_expires_in);
  if (
    !expiresIn ||
    !refreshToken ||
    !refreshExpiresIn ||
    refreshExpiresIn <= expiresIn
  ) {
    throw new HttpError(
      503,
      "github_bad_response",
      "GitHub returned a credential that cannot be rotated safely.",
    );
  }
  return {
    accessToken,
    expiresAtMs: nowMs + expiresIn * 1000,
    refreshToken,
    refreshTokenExpiresAtMs: nowMs + refreshExpiresIn * 1000,
  };
}

async function githubUser(
  fetchImpl: FetchLike,
  config: GithubBackendConfig,
  token: string,
): Promise<{ login: string }> {
  const response = await fetchWithTimeout(
    fetchImpl,
    `${config.apiBaseUrl}/user`,
    { headers: githubHeaders(token) },
  );
  if (!response.ok) {
    throw new HttpError(
      response.status === 401 ? 401 : 503,
      response.status === 401
        ? "github_authorization_expired"
        : "github_unavailable",
      response.status === 401
        ? "GitHub rejected this authorization."
        : "GitHub is temporarily unavailable.",
    );
  }
  const raw = await responseJson(response);
  const login =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? stringField((raw as Record<string, unknown>).login, 100)
      : undefined;
  if (!login) {
    throw new HttpError(
      503,
      "github_bad_response",
      "GitHub returned an incomplete user profile.",
    );
  }
  return { login };
}

async function installationRepositoryCount(
  fetchImpl: FetchLike,
  config: GithubBackendConfig,
  token: string,
  installationId: number,
  deadlineAtMs?: number,
): Promise<number | null> {
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${config.apiBaseUrl}/user/installations/${installationId}/repositories?per_page=1`,
      { headers: githubHeaders(token) },
      deadlineAtMs,
    );
    if (!response.ok) return null;
    const raw = await responseJson(response);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const total = (raw as Record<string, unknown>).total_count;
    return typeof total === "number" &&
      Number.isSafeInteger(total) &&
      total >= 0
      ? total
      : null;
  } catch {
    // Repository cardinality enriches the Settings copy; it is not allowed to
    // turn a valid authorization into a failed connection.
    return null;
  }
}

function installationFromGithub(
  value: unknown,
  config: GithubBackendConfig,
  nowIso: string,
): Omit<GithubInstallation, "repositoryCount"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const installationId = positiveInteger(input.id);
  const appId = positiveInteger(input.app_id);
  const account =
    input.account && typeof input.account === "object"
      ? (input.account as Record<string, unknown>)
      : null;
  const accountLogin = account ? stringField(account.login, 100) : undefined;
  const accountType = account?.type;
  if (
    !installationId ||
    appId !== config.appId ||
    !accountLogin ||
    (accountType !== "User" && accountType !== "Organization")
  ) {
    return null;
  }
  const targetType = stringField(input.target_type, 100) ?? accountType;
  const selection = input.repository_selection;
  const suspendedAt = stringField(input.suspended_at) ?? null;
  const createdAt = stringField(input.created_at) ?? null;
  const htmlUrl = stringField(input.html_url, 2000) ?? null;
  return {
    installationId,
    appVariantKey: config.variantKey,
    accountLogin,
    accountType,
    targetType,
    allRepositories: selection === "all",
    suspendedAt,
    createdAt,
    lastVerifiedAt: nowIso,
    configureUrl:
      htmlUrl?.startsWith("https://") || htmlUrl?.startsWith("http://")
        ? htmlUrl
        : null,
  };
}

async function listGithubInstallations(
  fetchImpl: FetchLike,
  config: GithubBackendConfig,
  token: string,
  nowMs: number,
  deadlineAtMs = nowMs + GITHUB_FLOW_DEADLINE_MS,
): Promise<GithubInstallationSnapshot> {
  const rawInstallations: unknown[] = [];
  let complete = false;
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
    if (page > 1 && Date.now() >= deadlineAtMs) break;
    const response = await fetchWithTimeout(
      fetchImpl,
      `${config.apiBaseUrl}/user/installations?per_page=100&page=${page}`,
      { headers: githubHeaders(token) },
      deadlineAtMs,
    );
    if (!response.ok) {
      throw new HttpError(
        response.status === 401 ? 401 : 503,
        response.status === 401
          ? "github_authorization_expired"
          : "github_unavailable",
        response.status === 401
          ? "GitHub rejected this authorization."
          : "GitHub installations could not be checked.",
      );
    }
    const raw = await responseJson(response);
    const pageRows =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).installations
        : null;
    if (!Array.isArray(pageRows)) {
      throw new HttpError(
        503,
        "github_bad_response",
        "GitHub returned an incomplete installation list.",
      );
    }
    rawInstallations.push(...pageRows);
    if (pageRows.length < 100) {
      complete = true;
      break;
    }
  }

  const nowIso = new Date(nowMs).toISOString();
  const installations = rawInstallations
    .map((value) => installationFromGithub(value, config, nowIso))
    .filter(
      (value): value is Omit<GithubInstallation, "repositoryCount"> =>
        value !== null,
    );
  // `installationFromGithub` drops any installation belonging to a different
  // app_id (github.ts, `appId !== config.appId`). That filter is correct, and
  // silent — so a wrong GITHUB_APP_ID looks EXACTLY like success: the token
  // exchange works, /user works, the list fetches, every row is discarded, and
  // the user is told to install an App they just installed. Zod cannot catch it
  // (any positive integer is well-formed), so the log is the only place this
  // can ever surface.
  if (rawInstallations.length > 0 && installations.length === 0) {
    console.warn(
      `[github] GitHub returned ${rawInstallations.length} installation(s) ` +
        `but none match GITHUB_APP_ID=${config.appId} — the configured App id ` +
        "is almost certainly wrong for this registration.",
    );
  }
  const result: GithubInstallation[] = installations.map((installation) => ({
    ...installation,
    repositoryCount: null,
  }));
  // Repository counts enrich Settings only. Bound both cardinality and
  // concurrency so an account with hundreds of organizations cannot turn one
  // Refresh click into a 15-minute request train or a GitHub API burst.
  const probeCount = Math.min(result.length, MAX_REPOSITORY_COUNT_PROBES);
  for (
    let offset = 0;
    offset < probeCount;
    offset += REPOSITORY_COUNT_CONCURRENCY
  ) {
    // Counts are enrichment: past the deadline the remaining ones stay null
    // rather than extending the handler.
    if (Date.now() >= deadlineAtMs) break;
    const chunk = result.slice(
      offset,
      Math.min(offset + REPOSITORY_COUNT_CONCURRENCY, probeCount),
    );
    const counts = await Promise.all(
      chunk.map((installation) =>
        installationRepositoryCount(
          fetchImpl,
          config,
          token,
          installation.installationId,
          deadlineAtMs,
        ),
      ),
    );
    for (let index = 0; index < counts.length; index += 1) {
      result[offset + index] = {
        ...result[offset + index]!,
        repositoryCount: counts[index] ?? null,
      };
    }
  }
  return { installations: result, complete };
}

async function persistInstallations(
  tx: Tx,
  input: {
    ownerUserId: string;
    appVariant: string;
    installations: GithubInstallation[];
    complete: boolean;
  },
): Promise<void> {
  const installationIds = input.installations.map(
    (installation) => installation.installationId,
  );
  if (input.complete) {
    await tx.query(
      `DELETE FROM github_installations
       WHERE owner_user_id = $1
         AND app_variant = $2
         AND NOT (github_installation_id = ANY($3::bigint[]))`,
      [input.ownerUserId, input.appVariant, installationIds],
    );
  }
  for (const installation of input.installations) {
    await tx.query(
      `INSERT INTO github_installations (
         github_installation_id, app_variant, owner_user_id,
         account_login, account_type, target_type, repository_count,
         all_repositories, suspended_at, github_created_at, last_verified_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (
         app_variant, github_installation_id, owner_user_id
       ) WHERE owner_user_id IS NOT NULL
       DO UPDATE SET
         account_login = EXCLUDED.account_login,
         account_type = EXCLUDED.account_type,
         target_type = EXCLUDED.target_type,
         repository_count = EXCLUDED.repository_count,
         all_repositories = EXCLUDED.all_repositories,
         suspended_at = EXCLUDED.suspended_at,
         github_created_at = EXCLUDED.github_created_at,
         last_verified_at = now(),
         updated_at = now()`,
      [
        installation.installationId,
        input.appVariant,
        input.ownerUserId,
        installation.accountLogin,
        installation.accountType,
        installation.targetType,
        installation.repositoryCount,
        installation.allRepositories,
        installation.suspendedAt,
        installation.createdAt,
      ],
    );
  }
}

async function persistAuthorization(
  tx: Tx,
  input: {
    pending: PendingOauthState;
    nonceHash: Buffer;
    bundle: GithubTokenBundle;
    login: string;
    installations: GithubInstallation[];
    installationsComplete: boolean;
    nowMs: number;
  },
): Promise<void> {
  await persistInstallations(tx, {
    ownerUserId: input.pending.owner_user_id,
    appVariant: input.pending.app_variant,
    installations: input.installations,
    complete: input.installationsComplete,
  });
  await tx.query(
    `INSERT INTO github_authorizations (
       owner_user_id, app_variant, github_login, last_verified_at
     ) VALUES ($1, $2, $3, now())
     ON CONFLICT (owner_user_id, app_variant)
     DO UPDATE SET
       github_login = EXCLUDED.github_login,
       last_verified_at = now(),
       updated_at = now()`,
    [input.pending.owner_user_id, input.pending.app_variant, input.login],
  );
  await tx.query(
    `INSERT INTO github_oauth_handoffs (
       nonce_hash, owner_user_id, app_variant, access_token_sealed,
       access_token_expires_at, refresh_token_sealed, refresh_token_expires_at,
       login, installations, installations_complete, expires_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11
     )`,
    [
      input.nonceHash,
      input.pending.owner_user_id,
      input.pending.app_variant,
      sealHandoffToken(input.pending.client_nonce, input.bundle.accessToken),
      new Date(input.bundle.expiresAtMs),
      sealHandoffToken(input.pending.client_nonce, input.bundle.refreshToken),
      new Date(input.bundle.refreshTokenExpiresAtMs),
      input.login,
      JSON.stringify(input.installations),
      input.installationsComplete,
      new Date(input.nowMs + GITHUB_HANDOFF_TTL_MS),
    ],
  );
  await tx.query(
    `INSERT INTO github_audit_log (
       owner_user_id, actor_id, action, subject
     ) VALUES ($1, $1, 'github.authorization.completed', $2::jsonb)`,
    [
      input.pending.owner_user_id,
      JSON.stringify({
        appVariant: input.pending.app_variant,
        installationCount: input.installations.length,
      }),
    ],
  );
}

/** The signed binding proves who minted the refresh token, but it is stateless
 * and therefore cannot know the grant was disconnected. Without this check a
 * leaked or backed-up (refreshToken, refreshBinding) pair keeps minting fresh
 * access tokens for the refresh token's whole lifetime AFTER the user clicks
 * Disconnect — GitHub's own /applications/{id}/token revocation only kills the
 * one access token, leaving the authorization grant usable. */
async function assertLiveAuthorization(
  tx: Tx,
  input: { ownerUserId: string; appVariant: string },
): Promise<void> {
  const live = await tx.query(
    `SELECT 1
     FROM github_authorizations
     WHERE owner_user_id = $1 AND app_variant = $2`,
    [input.ownerUserId, input.appVariant],
  );
  if (live.rowCount === 0) {
    throw new HttpError(
      401,
      "github_authorization_expired",
      "The GitHub authorization was disconnected. Connect the GitHub App again.",
    );
  }
}

async function assertAuthorizedGithubLogin(
  tx: Tx,
  input: {
    ownerUserId: string;
    appVariant: string;
    login: string;
  },
): Promise<void> {
  const expected = await tx.query<{ github_login: string }>(
    `SELECT github_login
     FROM github_authorizations
     WHERE owner_user_id = $1 AND app_variant = $2`,
    [input.ownerUserId, input.appVariant],
  );
  const expectedLogin = expected.rows[0]?.github_login;
  // "No authorization at all" and "a token for a different account" are
  // different states and need different codes. Reporting a disconnected grant
  // as a mismatch left the other device's Settings row stuck on `unavailable`
  // forever, because a mismatch is not something the desktop can recover from,
  // whereas `github_authorization_expired` drives its reconnect path.
  if (!expectedLogin) {
    throw new HttpError(
      401,
      "github_authorization_expired",
      "The GitHub authorization was disconnected. Connect the GitHub App again.",
    );
  }
  if (expectedLogin.toLowerCase() !== input.login.toLowerCase()) {
    throw new HttpError(
      403,
      "github_account_mismatch",
      "This GitHub credential does not belong to the connected account.",
    );
  }
  await tx.query(
    `UPDATE github_authorizations
     SET last_verified_at = now(), updated_at = now()
     WHERE owner_user_id = $1 AND app_variant = $2`,
    [input.ownerUserId, input.appVariant],
  );
}

/** Ask GitHub to drop one user access token. Per GitHub this kills only that
 *  token — the grant, the refresh token, and the installation survive, which is
 *  why `github_authorizations` carries the server-side liveness row that
 *  `assertLiveAuthorization` enforces. Returns false when GitHub refused. */
async function revokeGithubAccessToken(
  fetchImpl: FetchLike,
  config: GithubBackendConfig,
  accessToken: string,
): Promise<boolean> {
  const response = await fetchWithTimeout(
    fetchImpl,
    `${config.apiBaseUrl}/applications/${encodeURIComponent(
      config.clientId,
    )}/token`,
    {
      method: "DELETE",
      headers: {
        ...githubHeaders(),
        authorization: `Basic ${Buffer.from(
          `${config.clientId}:${config.clientSecret}`,
          "utf8",
        ).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken }),
    },
  );
  // 404 means GitHub has no such token — already gone is success.
  return response.ok || response.status === 404;
}

interface CloudInstallationRow {
  suspended_at: Date | null;
}

async function assertCloudInstallationAccess(
  tx: Tx,
  input: {
    ownerUserId: string;
    appVariant: string;
    installationId: number;
  },
): Promise<void> {
  // Look up the caller-owned row first. RLS plus the explicit owner predicate
  // make a foreign id indistinguishable from a nonexistent id (404), even
  // when the caller has never connected GitHub. Only a known owner should get
  // authorization-expired or suspension detail.
  const result = await tx.query<CloudInstallationRow>(
    `SELECT suspended_at
     FROM github_installations
     WHERE owner_user_id = $1
       AND app_variant = $2
       AND github_installation_id = $3`,
    [input.ownerUserId, input.appVariant, input.installationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(
      404,
      "github_installation_not_found",
      "This GitHub App installation is not connected to your account.",
    );
  }
  await assertLiveAuthorization(tx, {
    ownerUserId: input.ownerUserId,
    appVariant: input.appVariant,
  });
  if (row.suspended_at) {
    throw new HttpError(
      409,
      "github_installation_suspended",
      "This GitHub App installation is suspended.",
    );
  }
}

async function revokeGithubInstallationToken(
  fetchImpl: FetchLike,
  config: GithubBackendConfig,
  token: string,
): Promise<void> {
  await fetchWithTimeout(
    fetchImpl,
    `${config.apiBaseUrl}/installation/token`,
    {
      method: "DELETE",
      headers: githubHeaders(token),
    },
  ).catch(() => undefined);
}

async function mintGithubInstallationToken(
  fetchImpl: FetchLike,
  config: GithubBackendConfig,
  input: {
    installationId: number;
    repositories?: readonly string[];
    nowMs: number;
  },
): Promise<{ token: string; expiresAtMs: number }> {
  const response = await fetchWithTimeout(
    fetchImpl,
    `${config.apiBaseUrl}/app/installations/${input.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${createGithubAppJwt(config, input.nowMs)}`,
        "content-type": "application/json",
        "user-agent": "zeros-control-plane",
        "x-github-api-version": API_VERSION,
      },
      body: JSON.stringify(
        input.repositories ? { repositories: input.repositories } : {},
      ),
    },
  );
  const raw = await responseJson(response);
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const token = stringField(body.token, 4_096);
  const expiresAtMs = Date.parse(String(body.expires_at ?? ""));
  if (
    !response.ok ||
    response.status !== 201 ||
    !token ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs - input.nowMs < 5 * 60_000 ||
    expiresAtMs - input.nowMs > 70 * 60_000
  ) {
    throw new HttpError(
      response.status === 404 ? 404 : 503,
      response.status === 404
        ? "github_installation_not_found"
        : "github_unavailable",
      response.status === 404
        ? "GitHub no longer recognizes this App installation."
        : "GitHub could not issue a cloud workspace credential.",
    );
  }
  return { token, expiresAtMs };
}

/** Send browser-only handoff material in the fragment so the hosted completion
 * page can offer an exact-channel Open Zeros link without exposing the nonce
 * to Cloudflare request logs, referrers, or query-string analytics. */
export function githubCompletionUrl(
  completionPageUrl: string,
  pending: Pick<PendingOauthState, "scheme" | "client_nonce">,
  error?: string,
): string {
  const url = new URL(completionPageUrl);
  url.hash = new URLSearchParams({
    scheme: pending.scheme,
    nonce: pending.client_nonce,
    ...(error ? { error } : {}),
  }).toString();
  return url.toString();
}

function installUrl(config: GithubBackendConfig, state?: string): string {
  const url = new URL(
    `/apps/${encodeURIComponent(config.appSlug)}/installations/new`,
    `${config.webBaseUrl}/`,
  );
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/** Stand-in for every GitHub route when no App is registered for this
 * environment. A precise code matters: without it the desktop got the router's
 * generic 404 ("Not found") and had no way to tell "GitHub sign-in is off here"
 * from "your request was malformed". Mount this instead of both real routers so
 * a missing registration costs one feature, not the whole control plane. */
export function createGithubUnconfiguredRoutes(): Hono {
  const app = new Hono();
  app.all("/v1/github/*", (c) =>
    c.json(
      {
        error: {
          code: "github_not_configured",
          message:
            "GitHub sign-in is not configured on this Zeros control plane.",
        },
      },
      503,
    ),
  );
  return app;
}

/** Public callback. Mount this before the `/v1/*` authentication middleware. */
export function createGithubPublicRoutes(
  pool: pg.Pool,
  config: GithubBackendConfig,
  dependencies: GithubRouteDependencies = {},
): Hono {
  const app = new Hono();
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;

  app.get("/v1/github/oauth/callback", async (c) => {
    // Take the PARSED value, not the raw query string: NonceSchema begins with
    // `.trim()`, so a padded `state` validates while `sha256(raw)` hashes
    // something else entirely — the code would then check one value and look up
    // another. It fails closed today (no lookup hit), and our own states never
    // carry whitespace, but validating a different string than you use is the
    // shape of a real bypass, not a style nit.
    const parsedState = NonceSchema.safeParse(c.req.query("state") ?? "");
    if (!parsedState.success) {
      throw new HttpError(422, "invalid_oauth_state", "Invalid OAuth state.");
    }
    const state = parsedState.data;
    // No table-wide expiry sweep here: this route is unauthenticated, so any
    // caller with a well-formed `state` could otherwise drive one write
    // transaction plus a full-table DELETE per request against the same pool
    // /healthz uses. `startGithubOauthCleanup` already sweeps every 60 s, and
    // the `expires_at > now()` predicate below is what makes state single-use.
    const pending = await withSystemTx(pool, async (tx) => {
      const result = await tx.query<PendingOauthState>(
        `DELETE FROM github_oauth_states
         WHERE state_hash = $1 AND expires_at > now()
         RETURNING owner_user_id, client_nonce, scheme, app_variant,
                   flow_kind, pkce_verifier`,
        [sha256(state)],
      );
      return result.rows[0] ?? null;
    });
    if (!pending) {
      throw new HttpError(
        422,
        "oauth_state_expired",
        "This GitHub authorization expired. Start again from Zeros.",
      );
    }

    const oauthError = c.req.query("error");
    const code = c.req.query("code");
    if (oauthError || !code) {
      return c.redirect(
        githubCompletionUrl(
          config.completionPageUrl,
          pending,
          oauthError === "access_denied" ? "access_denied" : "oauth_failed",
        ),
        302,
      );
    }

    try {
      const params = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.oauthCallbackUrl,
      });
      if (pending.flow_kind === "oauth" && pending.pkce_verifier) {
        params.set("code_verifier", pending.pkce_verifier);
      }
      const nowMs = now();
      const deadlineAtMs = nowMs + GITHUB_FLOW_DEADLINE_MS;
      const bundle = await exchangeGithubToken(
        fetchImpl,
        config,
        params,
        nowMs,
      );
      // The `code` is now spent and a ~6-month refresh token exists at GitHub.
      // Identity is required to record it; the installation inventory is not.
      // Failing the whole callback on a cosmetic listing error used to abandon
      // that credential with no row, no audit entry, and nothing able to revoke
      // it. `installations_complete: false` is the honest way to say
      // "authorized, inventory unknown" — Settings Refresh fills it in.
      const { login } = await githubUser(fetchImpl, config, bundle.accessToken);
      let installationSnapshot: GithubInstallationSnapshot = {
        installations: [],
        complete: false,
      };
      try {
        installationSnapshot = await listGithubInstallations(
          fetchImpl,
          config,
          bundle.accessToken,
          nowMs,
          deadlineAtMs,
        );
      } catch (error) {
        // A 401 means the token we just minted is already unusable — that is
        // not a partial inventory, so it still fails the flow.
        if (error instanceof HttpError && error.status === 401) throw error;
        console.warn(
          `[github] installation inventory unavailable during connect: ${
            error instanceof HttpError
              ? error.code
              : error instanceof Error
                ? error.name
                : "unknown"
          }`,
        );
      }
      await withSystemTx(pool, async (tx) => {
        await persistAuthorization(tx, {
          pending,
          nonceHash: sha256(pending.client_nonce),
          bundle,
          login,
          installations: installationSnapshot.installations,
          installationsComplete: installationSnapshot.complete,
          // Re-read the clock: the handoff TTL is the window the DESKTOP gets
          // after this redirect, so it must not be shortened by the GitHub
          // round trips above (token exchange + user + installation pages +
          // repository-count probes, each allowed REQUEST_TIMEOUT_MS).
          nowMs: now(),
        });
      });
      return c.redirect(
        githubCompletionUrl(config.completionPageUrl, pending),
        302,
      );
    } catch (error) {
      const kind =
        error instanceof HttpError &&
        error.code === "github_authorization_expired"
          ? "authorization_expired"
          : "github_unavailable";
      // This is the only GitHub route whose failures are invisible: the browser
      // gets a 302 and Railway logs just the status line, so a wrong client
      // secret or a Postgres fault would read to operators as "GitHub is down".
      // Log the classification (never the URL, code, or tokens).
      console.error(
        `[github] oauth callback failed (reported as ${kind}): ${
          error instanceof HttpError
            ? `${error.status} ${error.code}`
            : error instanceof Error
              ? `${error.name}: ${error.message}`
              : "unknown error"
        }`,
      );
      return c.redirect(
        githubCompletionUrl(config.completionPageUrl, pending, kind),
        302,
      );
    }
  });

  return app;
}

/** Authenticated routes. Mount after the standard authentication middleware. */
export function createGithubRoutes(
  pool: pg.Pool,
  config: GithubBackendConfig,
  dependencies: GithubRouteDependencies = {},
): Hono {
  const app = new Hono();
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? randomBytes;

  app.post(
    "/v1/github/oauth/start",
    rateLimit("github-oauth-start", 20, 10 * 60_000),
    async (c) => {
      const user = c.get("user");
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const nonce = parse(NonceSchema, body.nonce);
      const variant = parse(
        VariantSchema,
        body.variantKey ?? config.variantKey,
      );
      const scheme = parse(SchemeSchema, body.scheme);
      if (!config.desktopSchemes.includes(scheme)) {
        throw new HttpError(
          422,
          "invalid_scheme",
          "Unsupported desktop callback scheme.",
        );
      }
      const forceInstallRequested = body.forceInstall === true;
      const installRequested =
        forceInstallRequested || body.installFlow !== false;
      const state = base64url(random(32));
      const randomPkceVerifier = base64url(random(48));
      const expiresAt = new Date(now() + OAUTH_STATE_TTL_MS);

      const flowKind = await withUserTx(pool, user.id, async (tx) => {
        let hasAuthorization = false;
        let hasInstallation = false;
        if (installRequested) {
          const known = await tx.query<{
            has_authorization: boolean;
            has_installation: boolean;
          }>(
            `SELECT
               EXISTS (
                 SELECT 1 FROM github_authorizations
                 WHERE owner_user_id = $1 AND app_variant = $2
               ) AS has_authorization,
               EXISTS (
                 SELECT 1 FROM github_installations
                 WHERE owner_user_id = $1 AND app_variant = $2
               ) AS has_installation`,
            [user.id, variant],
          );
          hasAuthorization = known.rows[0]?.has_authorization === true;
          hasInstallation = known.rows[0]?.has_installation === true;
        }
        const resolvedFlowKind = resolveGithubOauthFlowKind({
          installRequested,
          forceInstallRequested,
          hasAuthorization,
          hasInstallation,
        });
        const verifier =
          resolvedFlowKind === "oauth" ? randomPkceVerifier : null;
        await tx.query(
          `DELETE FROM github_oauth_states
           WHERE owner_user_id = $1
             AND (expires_at <= now() OR client_nonce = $2)`,
          [user.id, nonce],
        );
        await tx.query(
          `INSERT INTO github_oauth_states (
             state_hash, owner_user_id, client_nonce, scheme, app_variant,
             flow_kind, pkce_verifier, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            sha256(state),
            user.id,
            nonce,
            scheme,
            variant,
            resolvedFlowKind,
            verifier,
            expiresAt,
          ],
        );
        return resolvedFlowKind;
      });

      if (flowKind === "install") {
        return c.json({
          authorizeUrl: installUrl(config, state),
          state,
          expiresAt: expiresAt.toISOString(),
          flowKind,
        });
      }
      const url = new URL("/login/oauth/authorize", `${config.webBaseUrl}/`);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.oauthCallbackUrl);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", pkceChallenge(randomPkceVerifier));
      url.searchParams.set("code_challenge_method", "S256");
      return c.json({
        authorizeUrl: url.toString(),
        state,
        expiresAt: expiresAt.toISOString(),
        flowKind,
      });
    },
  );

  app.post(
    "/v1/github/oauth/exchange",
    rateLimit("github-oauth-exchange", 30, 10 * 60_000),
    async (c) => {
      const user = c.get("user");
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const nonce = parse(NonceSchema, body.nonce);
      const row = await withUserTx(pool, user.id, async (tx) => {
        await tx.query(
          `DELETE FROM github_oauth_handoffs
           WHERE owner_user_id = $1 AND expires_at <= now()`,
          [user.id],
        );
        const result = await tx.query<{
          app_variant: string;
          access_token_sealed: Buffer;
          access_token_expires_at: Date;
          refresh_token_sealed: Buffer;
          refresh_token_expires_at: Date;
          login: string;
          installations: GithubInstallation[];
          installations_complete: boolean;
        }>(
          `DELETE FROM github_oauth_handoffs
           WHERE nonce_hash = $1
             AND owner_user_id = $2
             AND expires_at > now()
           RETURNING app_variant, access_token_sealed,
                     access_token_expires_at, refresh_token_sealed,
                     refresh_token_expires_at, login,
                     installations, installations_complete`,
          [sha256(nonce), user.id],
        );
        return result.rows[0] ?? null;
      });
      if (!row) {
        throw new HttpError(
          404,
          "handoff_not_found",
          "This GitHub handoff expired or was already used.",
        );
      }
      let accessToken: string;
      let refreshToken: string;
      try {
        accessToken = openHandoffToken(nonce, row.access_token_sealed);
        refreshToken = openHandoffToken(nonce, row.refresh_token_sealed);
      } catch (error) {
        // Only this control plane writes these bytes, so a failure here is a bug or
        // corruption, not a client error. The row is already consumed.
        console.error(
          `[github] handoff token could not be opened: ${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
        throw new HttpError(
          503,
          "github_bad_response",
          "This GitHub handoff could not be read. Start the connection again.",
        );
      }
      const refreshTokenExpiresAtMs = new Date(
        row.refresh_token_expires_at,
      ).getTime();
      return c.json({
        accessToken,
        expiresAtMs: new Date(row.access_token_expires_at).getTime(),
        refreshToken,
        refreshTokenExpiresAtMs,
        refreshBinding: createRefreshBinding(config, {
          ownerUserId: user.id,
          appVariant: row.app_variant,
          refreshToken,
          expiresAtMs: refreshTokenExpiresAtMs,
        }),
        login: row.login,
        variantKey: row.app_variant,
        installations: row.installations,
        installationsComplete: row.installations_complete,
      });
    },
  );

  app.post(
    "/v1/github/oauth/refresh",
    rateLimit("github-oauth-refresh", 30, 60_000),
    async (c) => {
      const user = c.get("user");
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const refreshToken = parse(TokenSchema, body.refreshToken);
      const refreshBinding = parse(RefreshBindingSchema, body.refreshBinding);
      const nowMs = now();
      assertRefreshBinding(config, refreshBinding, {
        ownerUserId: user.id,
        appVariant: config.variantKey,
        refreshToken,
        nowMs,
      });
      // Revoke deletes this row, so it is what makes Disconnect terminal. The
      // sibling /installations/refresh route already requires it.
      await withUserTx(pool, user.id, (tx) =>
        assertLiveAuthorization(tx, {
          ownerUserId: user.id,
          appVariant: config.variantKey,
        }),
      );
      const bundle = await exchangeGithubToken(
        fetchImpl,
        config,
        new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        nowMs,
      );
      // The liveness check above committed before this round trip, so a
      // Disconnect landing in between would otherwise be answered with a
      // credential minted after the user asked to stop. Re-check, and give the
      // token GitHub just issued back before failing.
      try {
        await withUserTx(pool, user.id, (tx) =>
          assertLiveAuthorization(tx, {
            ownerUserId: user.id,
            appVariant: config.variantKey,
          }),
        );
      } catch (error) {
        await revokeGithubAccessToken(
          fetchImpl,
          config,
          bundle.accessToken,
        ).catch(() => undefined);
        throw error;
      }
      // The signed binding above is the security decision and is verified
      // before the single-use token rotates. Audit is deliberately
      // best-effort after rotation: a transient DB write failure must not
      // suppress the new pair and strand the desktop with the consumed old
      // refresh token.
      try {
        await withUserTx(pool, user.id, async (tx) => {
          await tx.query(
            `INSERT INTO github_audit_log (
               owner_user_id, actor_id, action, subject
             ) VALUES ($1, $1, 'github.credential.refreshed', $2::jsonb)`,
            [user.id, JSON.stringify({ appVariant: config.variantKey })],
          );
        });
      } catch (error) {
        console.warn(
          `[github] refresh audit failed after token rotation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return c.json({
        ...bundle,
        refreshBinding: createRefreshBinding(config, {
          ownerUserId: user.id,
          appVariant: config.variantKey,
          refreshToken: bundle.refreshToken,
          expiresAtMs: bundle.refreshTokenExpiresAtMs,
        }),
      });
    },
  );

  app.post(
    "/v1/github/oauth/revoke",
    rateLimit("github-oauth-revoke", 10, 10 * 60_000),
    async (c) => {
      const user = c.get("user");
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const accessToken = parse(TokenSchema, body.accessToken);
      const refreshToken = parse(TokenSchema, body.refreshToken);
      const refreshBinding = parse(RefreshBindingSchema, body.refreshBinding);
      assertRefreshBinding(config, refreshBinding, {
        ownerUserId: user.id,
        appVariant: config.variantKey,
        refreshToken,
        nowMs: now(),
      });

      // Already disconnected — stay idempotent. Without this, a retry (or a
      // second device) sent GitHub another authenticated revoke and appended a
      // duplicate audit row for a grant this control plane no longer knows about.
      const stillConnected = await withUserTx(pool, user.id, async (tx) => {
        const live = await tx.query(
          `SELECT 1 FROM github_authorizations
           WHERE owner_user_id = $1 AND app_variant = $2`,
          [user.id, config.variantKey],
        );
        return (live.rowCount ?? 0) > 0;
      });
      if (!stillConnected) {
        return c.json({ revoked: true, remotelyRevoked: false });
      }

      let remotelyRevoked = false;
      let remoteFailure: string | null = null;
      try {
        remotelyRevoked = await revokeGithubAccessToken(
          fetchImpl,
          config,
          accessToken,
        );
        if (!remotelyRevoked) remoteFailure = "github_refused";
      } catch (error) {
        remoteFailure =
          error instanceof HttpError ? error.code : "github_unreachable";
      }

      // Local metadata describes the Zeros-side connection, so remove it even
      // when GitHub is offline. The desktop also deletes its encrypted pair;
      // remote revocation remains best-effort and the access token is bounded.
      await withUserTx(pool, user.id, async (tx) => {
        await tx.query(
          `DELETE FROM github_authorizations
           WHERE owner_user_id = $1 AND app_variant = $2`,
          [user.id, config.variantKey],
        );
        await tx.query(
          `DELETE FROM github_installations
           WHERE owner_user_id = $1 AND app_variant = $2`,
          [user.id, config.variantKey],
        );
        await tx.query(
          `INSERT INTO github_audit_log (
             owner_user_id, actor_id, action, subject
           ) VALUES ($1, $1, 'github.authorization.revoked', $2::jsonb)`,
          [
            user.id,
            JSON.stringify({
              appVariant: config.variantKey,
              remotelyRevoked,
            }),
          ],
        );
      });
      // Deliberately NOT an error: the deletion above has already committed, so
      // a 503 here would tell the desktop the disconnect failed while the only
      // record that could ever retry the GitHub-side revoke is gone. Deleting
      // the liveness row is what makes the refresh token unusable through this
      // control plane, so the disconnect really did take effect.
      if (remoteFailure) {
        console.warn(
          `[github] local disconnect completed but GitHub token revocation ` +
            `did not (${remoteFailure}); the access token expires on its own.`,
        );
      }
      return c.json({ revoked: true, remotelyRevoked });
    },
  );

  // No `GET /v1/github/install-url`. It had no caller, and it echoed a
  // caller-supplied `state` into an install URL WITHOUT inserting the matching
  // `github_oauth_states` row — so any install driven through it was guaranteed
  // to 422 at the callback. `/oauth/start` is the one supported entry point.

  app.post(
    "/v1/github/installations/refresh",
    rateLimit("github-installations-refresh", 20, 60_000),
    async (c) => {
      const user = c.get("user");
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const accessToken = parse(TokenSchema, body.accessToken);
      const nowMs = now();
      // Resolve the identity, then confirm it owns this connection BEFORE
      // enumerating. Running both concurrently let any authenticated Zeros user
      // spend up to 60 outbound GitHub calls — against our IP reputation and
      // the token's own rate budget — on a token that is not theirs.
      const { login } = await githubUser(fetchImpl, config, accessToken);
      await withUserTx(pool, user.id, (tx) =>
        assertAuthorizedGithubLogin(tx, {
          ownerUserId: user.id,
          appVariant: config.variantKey,
          login,
        }),
      );
      const snapshot = await listGithubInstallations(
        fetchImpl,
        config,
        accessToken,
        nowMs,
        nowMs + GITHUB_FLOW_DEADLINE_MS,
      );
      await withUserTx(pool, user.id, async (tx) => {
        await persistInstallations(tx, {
          ownerUserId: user.id,
          appVariant: config.variantKey,
          installations: snapshot.installations,
          complete: snapshot.complete,
        });
        await tx.query(
          `INSERT INTO github_audit_log (
             owner_user_id, actor_id, action, subject
           ) VALUES (
             $1, $1, 'github.installations.refreshed', $2::jsonb
           )`,
          [
            user.id,
            JSON.stringify({
              appVariant: config.variantKey,
              installationCount: snapshot.installations.length,
              complete: snapshot.complete,
            }),
          ],
        );
      });
      return c.json({
        login,
        installations: snapshot.installations,
        complete: snapshot.complete,
      });
    },
  );

  app.get("/v1/github/installations", async (c) => {
    const user = c.get("user");
    const rows = await withUserTx(pool, user.id, (tx) =>
      tx.query<{
        github_installation_id: string;
        app_variant: string;
        account_login: string;
        account_type: "User" | "Organization";
        target_type: string;
        repository_count: number | null;
        all_repositories: boolean;
        suspended_at: Date | null;
        github_created_at: Date | null;
        last_verified_at: Date;
      }>(
        `SELECT github_installation_id, app_variant, account_login,
                account_type, target_type, repository_count,
                all_repositories, suspended_at, github_created_at,
                last_verified_at
         FROM github_installations
         WHERE owner_user_id = $1 AND app_variant = $2
         ORDER BY account_login, github_installation_id`,
        [user.id, config.variantKey],
      ),
    );
    return c.json({
      installations: rows.rows.map((row) => ({
        installationId: Number(row.github_installation_id),
        appVariantKey: row.app_variant,
        accountLogin: row.account_login,
        accountType: row.account_type,
        targetType: row.target_type,
        repositoryCount: row.repository_count,
        allRepositories: row.all_repositories,
        suspendedAt: row.suspended_at?.toISOString() ?? null,
        createdAt: row.github_created_at?.toISOString() ?? null,
        lastVerifiedAt: row.last_verified_at.toISOString(),
        configureUrl:
          row.account_type === "Organization"
            ? `${config.webBaseUrl}/organizations/${encodeURIComponent(
                row.account_login,
              )}/settings/installations/${row.github_installation_id}`
            : `${config.webBaseUrl}/settings/installations/${row.github_installation_id}`,
      })),
    });
  });

  app.post(
    "/v1/github/installations/:id/token",
    rateLimit("github-cloud-installation-token", 10, 60_000),
    async (c) => {
      const user = c.get("user");
      const installationId = Number(c.req.param("id"));
      if (
        !Number.isSafeInteger(installationId) ||
        installationId < 1
      ) {
        throw new HttpError(
          422,
          "invalid_input",
          "GitHub installation id is invalid.",
        );
      }
      const body = parse(
        CloudInstallationTokenBodySchema,
        await c.req.json().catch(() => ({})),
      );
      const access = {
        ownerUserId: user.id,
        appVariant: config.variantKey,
        installationId,
      };
      // Authorize before touching GitHub. A caller cannot use this endpoint to
      // probe whether another user's installation id exists.
      await withUserTx(pool, user.id, (tx) =>
        assertCloudInstallationAccess(tx, access),
      );
      const nowMs = now();
      const minted = await mintGithubInstallationToken(fetchImpl, config, {
        installationId,
        ...(body.repositories ? { repositories: body.repositories } : {}),
        nowMs,
      });
      // Disconnect/suspension can race the network round trip. Re-check before
      // releasing the bearer, and revoke the just-created token on a lost race.
      try {
        await withUserTx(pool, user.id, (tx) =>
          assertCloudInstallationAccess(tx, access),
        );
      } catch (error) {
        await revokeGithubInstallationToken(
          fetchImpl,
          config,
          minted.token,
        );
        throw error;
      }
      try {
        await withUserTx(pool, user.id, (tx) =>
          tx.query(
            `INSERT INTO github_audit_log (
               owner_user_id, actor_id, action, subject
             ) VALUES ($1, $1, 'github.cloud_credential.minted', $2::jsonb)`,
            [
              user.id,
              JSON.stringify({
                appVariant: config.variantKey,
                installationId,
                repositoryCount: body.repositories?.length ?? null,
                expiresAt: new Date(minted.expiresAtMs).toISOString(),
              }),
            ],
          ),
        );
      } catch (error) {
        console.warn(
          `[github] cloud credential audit failed after mint: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return c.json({
        method: "github-app",
        accessToken: minted.token,
        expiresAtMs: minted.expiresAtMs,
        gitHost: "github.com",
        gitHttpUsername: "x-access-token",
        variantKey: config.variantKey,
        ownerSubjectSha256: createHash("sha256")
          // Compatibility field consumed by the deferred cloud-workspace
          // credential protocol. Its v1 wire meaning remains provider subject
          // until that protocol receives an explicit account-ID migration.
          .update(user.identity.subject, "utf8")
          .digest("hex"),
      });
    },
  );

  return app;
}
