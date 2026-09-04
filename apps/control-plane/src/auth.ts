// ──────────────────────────────────────────────────────────
// Auth — verify provider-issued JWTs locally (JWKS) and JIT-mirror the user.
//
// Sign-in provisions the user row plus the account's permanent Personal
// organization and its default team. Collaborative organizations remain
// explicit: a user creates one or joins one by invitation.
//
// The JWT proves WHO (sub, email); the database decides WHAT (authz.ts).
// jose's createRemoteJWKSet caches keys in memory and re-fetches only
// when an unknown `kid` appears (key rotation).
//
// users.id is an internally-generated uuid, decoupled from every provider's
// `sub`. user_identities maps (provider, provider_sub) -> users.id, so product
// ownership never depends on an authentication-vendor identifier.
// ──────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyOptions,
} from "jose";
import type { MiddlewareHandler } from "hono";
import type pg from "pg";
import type { Config } from "./config.js";
import { withSystemTx, type Tx } from "./db.js";
import { HttpError, type StaffRole } from "./authz.js";
import {
  AuthTokenContractError,
  authTokenVerifyOptions,
  validateAuthTokenClaims,
  type AuthClientKind,
  type AuthTokenContractConfig,
} from "./auth-token-contract.js";
import { materializeProjectedMemberships } from "./workos-sync-events.js";
import { isDeletionRecoveryRequest } from "./deletion-lifecycle.js";
import { enqueueWorkOSUserDeletionCommand } from "./workos-command-outbox.js";
import {
  assertAccountWorkOSProviderErasureSubjectLimit,
  workOSProviderErasureFenceStatus,
  workOSProviderSubjectHash,
  workOSProviderSubjectLockKey,
  workOSUserProviderLockKey,
} from "./workos-provider-locks.js";

export type IdentityProvider = "auth0" | "workos";

export type AuthenticatedSessionInput = {
  id: string;
  clientKind: AuthClientKind;
  authTime: number | null;
  /** JWT exp in seconds since the Unix epoch. */
  tokenExpiresAt: number;
};

export type AuthenticatedIdentityInput = {
  provider: IdentityProvider;
  providerSubject: string;
  email: string;
  displayName: string | null;
  avatarUrl?: string | null;
  session?: AuthenticatedSessionInput;
};

export type AuthedUser = {
  /** Canonical Zeros account UUID. Product and integration ownership keys use
   *  this value, never the provider subject below. */
  id: string;
  /** Server-only authentication binding needed for provider lifecycle work. */
  identity: {
    provider: IdentityProvider;
    subject: string;
  };
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  accountRevision: number;
  /** Server-only lifecycle state. Public account responses expose only
   * deliberately bounded deletion details from the lifecycle routes. */
  accountStatus:
    | "active"
    | "identity_disabled"
    | "suspended"
    | "deletion_pending"
    | "deleted";
  /** Server-only verified session context. Never serialize this object as part
   * of a public account response. */
  authentication: {
    sessionId: string | null;
    clientKind: AuthClientKind | "legacy";
    authTime: number | null;
    tokenExpiresAt: number | null;
  };
  /** Product-wide staff role, or null for the ordinary case. Re-read from
   *  Postgres on every request by ensureUser below — never taken from a claim,
   *  so revoking it needs no token expiry. Gates Settings → Internal in the
   *  Mac app; see apps/control-plane/migrations/0007_staff_role.sql. */
  staffRole: StaffRole | null;
};

// Auth0 access tokens carry NO profile claims by default. A Post-Login Action
// stamps email/email_verified/name onto the token, but Auth0 requires custom
// claims to be NAMESPACED (it silently drops plain `email`), so they arrive
// under this prefix. We read the namespaced claim first and fall back to a
// top-level one so a differently-shaped token (e.g. an id-token, or a future
// non-namespaced setup) still resolves. Keep this NS in sync with the Action.
const CLAIM_NS = "https://zeros.build/";

function claimString(payload: JWTPayload, key: string): string | null {
  const ns = payload[CLAIM_NS + key];
  if (typeof ns === "string") return ns;
  const top = payload[key];
  return typeof top === "string" ? top : null;
}

function claimBool(payload: JWTPayload, key: string): boolean | undefined {
  const ns = payload[CLAIM_NS + key];
  if (typeof ns === "boolean") return ns;
  const top = payload[key];
  return typeof top === "boolean" ? top : undefined;
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthedUser;
  }
}

export function createAuthMiddleware(
  config: Config,
  pool: pg.Pool,
): MiddlewareHandler {
  const jwks = createRemoteJWKSet(new URL(config.auth.jwksUrl));
  const workosContract: AuthTokenContractConfig | null =
    config.auth.provider === "workos"
      ? {
          issuer: config.auth.issuer,
          audience: config.auth.audience,
          webClientId: config.auth.webClientId,
          desktopClientId: config.auth.desktopClientId,
        }
      : null;
  const verifyOptions: JWTVerifyOptions =
    config.auth.provider === "workos"
      ? authTokenVerifyOptions(workosContract!)
      : {
          issuer: config.auth.issuers,
          audience: config.auth.audience,
          // Preserve the released Auth0 contract until its clients move.
          algorithms: ["RS256"],
          requiredClaims: ["exp", "sub"],
        };

  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return c.json(
        { error: { code: "unauthorized", message: "Missing bearer token" } },
        401,
      );
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, verifyOptions));
    } catch (err) {
      // Surface jose's error code (JWKS_NO_MATCHING_KEY = old-key token,
      // JWT_CLAIM_VALIDATION_FAILED = issuer/audience mismatch, JWT_EXPIRED).
      // Codes only — never claims or key material; this is safe to show and
      // turns "it doesn't work" into a one-look diagnosis.
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : "VERIFY_FAILED";
      const claim =
        err && typeof err === "object" && "claim" in err
          ? ` (claim: ${String((err as { claim: unknown }).claim)})`
          : "";
      // Railway HTTP logs only show the status line; without this line the
      // whole fleet can 401 for days with no visible cause.
      console.warn(`[auth] 401 token verification failed [${code}${claim}]`);
      return c.json(
        {
          error: {
            code: "unauthorized",
            message: `Invalid or expired token [${code}${claim}]`,
          },
        },
        401,
      );
    }

    let identity: {
      provider: IdentityProvider;
      providerSubject: string;
      email: string;
      displayName: string | null;
      avatarUrl: string | null;
      session?: AuthenticatedSessionInput;
    };
    if (workosContract) {
      try {
        const claims = validateAuthTokenClaims(payload, workosContract);
        identity = {
          provider: "workos",
          providerSubject: claims.providerSubject,
          email: claims.email,
          displayName: claims.displayName,
          avatarUrl: claims.avatarUrl,
          session: {
            id: claims.sessionId,
            clientKind: claims.clientKind,
            authTime: claims.authTime,
            tokenExpiresAt: claims.expiresAt,
          },
        };
      } catch (error) {
        const code =
          error instanceof AuthTokenContractError
            ? error.code
            : "AUTH_CONTRACT_INVALID";
        console.warn(`[auth] 401 WorkOS token contract rejected [${code}]`);
        if (
          error instanceof AuthTokenContractError &&
          error.code === "AUTH_EMAIL_UNVERIFIED"
        ) {
          return c.json(
            {
              error: {
                code: "email_unverified",
                message: "Verify your email to continue",
              },
            },
            401,
          );
        }
        return c.json(
          {
            error: {
              code: "unauthorized",
              message: `Invalid access token contract [${code}]`,
            },
          },
          401,
        );
      }
    } else {
      const sub = typeof payload.sub === "string" ? payload.sub : null;
      const email = claimString(payload, "email");
      if (!sub || !email) {
        console.warn("[auth] 401 Auth0 token missing required profile claims");
        return c.json(
          {
            error: {
              code: "unauthorized",
              message: "Token missing sub/email",
            },
          },
          401,
        );
      }
      // Invitation acceptance binds on verified email, so a missing or false
      // assertion must fail closed for the legacy provider too.
      if (claimBool(payload, "email_verified") !== true) {
        console.warn("[auth] 401 Auth0 token email is unverified");
        return c.json(
          {
            error: {
              code: "email_unverified",
              message: "Verify your email to continue",
            },
          },
          401,
        );
      }
      const displayName =
        claimString(payload, "name") ||
        claimString(payload, "nickname") ||
        null;
      const picture = claimString(payload, "picture");
      let avatarUrl: string | null = null;
      if (picture && picture.length <= 2_048) {
        try {
          const parsed = new URL(picture);
          if (
            parsed.protocol === "https:" &&
            !parsed.username &&
            !parsed.password
          ) {
            avatarUrl = parsed.toString();
          }
        } catch {
          // Invalid provider claim: omit it; identity still authenticates.
        }
      }
      identity = {
        provider: "auth0",
        providerSubject: sub,
        email,
        displayName,
        avatarUrl,
      };
    }

    const user = await resolveAuthenticatedUser(
      pool,
      { ...identity },
      {
        allowDeletionPending: isDeletionRecoveryRequest(
          c.req.method,
          c.req.path,
        ),
      },
    );
    c.set("user", user);
    await next();
  };
}

// Backstop against just-in-time signup flooding. ensureUser mints a
// user + identity row for any never-seen (provider, sub), so an
// attacker holding many provider identities could mass-create rows and bloat the
// DB. This caps NEW signups globally per window; RETURNING users are
// never touched (the guard only fires on the create branch). In-memory and
// per-instance like ratelimit.ts — abuse control, not a hard security boundary;
// the provider's own attack protection is the first line. Tune the cap if
// a real launch spike ever trips it (it logs when it does).
const SIGNUP_WINDOW_MS = 60 * 60 * 1000; // 1h
const SIGNUP_MAX_PER_WINDOW = 200;
let signupWindow = { count: 0, resetAt: 0 };

const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Human-readable support locator. The random value is not authentication;
 * recovery still requires a fresh WorkOS ceremony plus a fresh staff ceremony.
 * Excluding ambiguous glyphs keeps verbal handoff reliable. */
function recoveryPublicCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(
    bytes,
    (byte) => RECOVERY_CODE_ALPHABET[byte % RECOVERY_CODE_ALPHABET.length],
  ).join("");
  return `ZR-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function chargeSignupBudget(now: number): void {
  if (now >= signupWindow.resetAt)
    signupWindow = { count: 0, resetAt: now + SIGNUP_WINDOW_MS };
  signupWindow.count += 1;
  if (signupWindow.count > SIGNUP_MAX_PER_WINDOW) {
    console.warn(
      `[auth] signup budget exceeded (${signupWindow.count} new users in the window) — throttling new provisioning`,
    );
    throw new HttpError(
      429,
      "signup_throttled",
      "Sign-ups are temporarily rate limited — please try again shortly.",
    );
  }
}

type AccountAuthStatus =
  | "active"
  | "identity_disabled"
  | "suspended"
  | "deletion_pending"
  | "deleted";

type IdentityLifecycleStatus =
  | "active"
  | "provider_deleted"
  | "superseded"
  | "revoked";

type PrincipalRow = {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  staff_role: StaffRole | null;
  auth_status: AccountAuthStatus;
  auth_revision: string | number;
  deleted_at: Date | null;
  identity_status: IdentityLifecycleStatus;
};

function authenticationContext(
  input: AuthenticatedIdentityInput,
): AuthedUser["authentication"] {
  return input.session
    ? {
        sessionId: input.session.id,
        clientKind: input.session.clientKind,
        authTime: input.session.authTime,
        tokenExpiresAt: input.session.tokenExpiresAt,
      }
    : {
        sessionId: null,
        clientKind: "legacy",
        authTime: null,
        tokenExpiresAt: null,
      };
}

function activePrincipal(
  row: PrincipalRow,
  input: AuthenticatedIdentityInput,
  options: { allowDeletionPending: boolean },
): AuthedUser {
  if (row.identity_status !== "active") {
    throw new HttpError(
      401,
      row.identity_status === "superseded"
        ? "identity_superseded"
        : "account_deleted",
      "This sign-in identity is no longer active.",
    );
  }
  const deletionRecovery =
    options.allowDeletionPending && row.auth_status === "deletion_pending";
  if (!deletionRecovery && (row.deleted_at || row.auth_status !== "active")) {
    throw new HttpError(
      401,
      row.auth_status === "suspended" ? "account_suspended" : "account_deleted",
      row.auth_status === "suspended"
        ? "This account is suspended."
        : "This account is no longer active.",
    );
  }
  return {
    id: row.id,
    identity: {
      provider: input.provider,
      subject: input.providerSubject,
    },
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    staffRole: row.staff_role,
    accountRevision: Number(row.auth_revision),
    accountStatus: row.auth_status,
    authentication: authenticationContext(input),
  };
}

async function requireUnfencedWorkOSIdentity(
  tx: Tx,
  input: AuthenticatedIdentityInput,
): Promise<void> {
  if (input.provider !== "workos") return;
  const status = await workOSProviderErasureFenceStatus(tx, [
    { kind: "user", id: input.providerSubject },
  ]);
  if (status === "not_ready") {
    throw new HttpError(
      503,
      "authentication_temporarily_unavailable",
      "Authentication is temporarily unavailable. Try again.",
    );
  }
  if (status === "fenced") {
    throw new HttpError(
      401,
      "account_deleted",
      "This account is no longer active.",
    );
  }
}

const WORKOS_AUTH_LOCK_TIMEOUT_MS = 10_000;

type WorkOSAuthenticationTarget = {
  user_id: string;
  exact_identity: boolean;
  subject_binding: boolean;
  email_match: boolean;
};

async function workOSAuthenticationTargets(
  database: pg.Pool | Tx,
  input: AuthenticatedIdentityInput,
): Promise<WorkOSAuthenticationTarget[]> {
  const sessionId = input.session?.id ?? null;
  const targets = await database.query<WorkOSAuthenticationTarget>(
    `SELECT associated.user_id,
            bool_or(associated.source = 'exact_identity') AS exact_identity,
            bool_or(associated.source IN (
              'recovery', 'auth_session', 'browser_session'
            )) AS subject_binding,
            bool_or(associated.source = 'email') AS email_match
     FROM (
       SELECT identity.user_id, 'exact_identity'::text AS source
       FROM user_identities identity
       WHERE identity.provider = 'workos' AND identity.provider_sub = $1
       UNION ALL
       SELECT account.id AS user_id, 'email'::text AS source
       FROM users account WHERE account.email = $2::citext
       UNION ALL
       SELECT recovery.target_user_id AS user_id, 'recovery'::text AS source
       FROM account_recovery_requests recovery
       WHERE recovery.candidate_provider_sub = $1
         AND recovery.state = 'pending'
       UNION ALL
       SELECT session.user_id, 'auth_session'::text AS source
       FROM auth_sessions session
       WHERE session.provider = 'workos' AND session.user_id IS NOT NULL
         AND (session.provider_sub = $1
              OR ($3::text IS NOT NULL
                  AND session.provider_session_id = $3))
       UNION ALL
       SELECT browser.account_user_id AS user_id,
              'browser_session'::text AS source
       FROM workos_browser_sessions browser
       WHERE browser.kind = 'session'
         AND browser.account_user_id IS NOT NULL
         AND (browser.provider_sub = $1
              OR ($3::text IS NOT NULL
                  AND browser.provider_session_id = $3))
     ) associated
     GROUP BY associated.user_id
     ORDER BY associated.user_id`,
    [input.providerSubject, input.email, sessionId],
  );
  return targets.rows;
}

function resolveCurrentWorkOSAuthenticationTarget(
  targets: readonly WorkOSAuthenticationTarget[],
):
  | { kind: "exact" }
  | { kind: "candidate"; userId: string }
  | { kind: "ambiguous" }
  | { kind: "unassociated" } {
  const exact = targets.filter((target) => target.exact_identity);
  if (exact.length === 1) return { kind: "exact" };
  if (exact.length > 1) return { kind: "ambiguous" };

  const subjectTargets = targets.filter((target) => target.subject_binding);
  const uniqueTargets = new Set(targets.map((target) => target.user_id));
  if (subjectTargets.length > 1 || uniqueTargets.size > 1) {
    return { kind: "ambiguous" };
  }
  const userId = targets[0]?.user_id;
  return userId ? { kind: "candidate", userId } : { kind: "unassociated" };
}

async function fenceAndQueueLatePurgingWorkOSCandidate(
  tx: Tx,
  input: AuthenticatedIdentityInput,
  targetUserId: string,
): Promise<boolean> {
  const deletion = await tx.query<{
    deletion_request_id: string;
    target_user_id: string;
  }>(
    `SELECT request.id AS deletion_request_id,
            account.id AS target_user_id
     FROM users account
     JOIN deletion_requests request
       ON request.id = account.deletion_request_id
      AND request.target_kind = 'account'
      AND request.target_id = account.id
      AND request.target_user_id = account.id
      AND request.state IN ('purging', 'provider_deleting', 'failed')
     WHERE account.id = $1
       AND account.auth_status = 'deletion_pending'
       AND account.deletion_request_id = request.id`,
    [targetUserId],
  );
  const target = deletion.rows[0];
  if (!target) return false;
  await requireUnfencedWorkOSIdentity(tx, input);
  try {
    await assertAccountWorkOSProviderErasureSubjectLimit(
      tx,
      target.deletion_request_id,
      [input.providerSubject],
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "workos_user_erasure_subject_limit_exceeded"
    ) {
      throw new HttpError(
        503,
        "workos_user_erasure_subject_limit_exceeded",
        "Authentication is temporarily unavailable. Try again.",
      );
    }
    throw error;
  }
  const subjectHash = workOSProviderSubjectHash({
    kind: "user",
    id: input.providerSubject,
  });
  const existingFence = await tx.query(
    `SELECT 1 FROM workos_provider_erasure_fences
     WHERE deletion_request_id = $1 AND provider = 'workos'
       AND subject_kind = 'user' AND hash_version = 1
       AND subject_hash = $2`,
    [target.deletion_request_id, subjectHash],
  );
  if (!existingFence.rows[0]) {
    await tx.query(
      `INSERT INTO deletion_request_events (
         deletion_request_id, actor_user_id, action, metadata
       ) VALUES ($1, NULL, 'purge.provider_erasure_fenced', $2::jsonb)`,
      [
        target.deletion_request_id,
        JSON.stringify({
          provider: "workos",
          workosSubjectHashes: [subjectHash],
        }),
      ],
    );
  }
  await enqueueWorkOSUserDeletionCommand(tx, {
    deletionRequestId: target.deletion_request_id,
    userId: target.target_user_id,
    workosUserId: input.providerSubject,
  });
  return true;
}

async function withWorkOSAuthenticationTx<T>(
  pool: pg.Pool,
  input: AuthenticatedIdentityInput,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (input.provider !== "workos") return withSystemTx(pool, work);
  const subjectKey = workOSProviderSubjectLockKey({
    kind: "user",
    id: input.providerSubject,
  });
  const knownTargets = new Map(
    (await workOSAuthenticationTargets(pool, input)).map((target) => [
      target.user_id,
      target,
    ]),
  );
  const deadline = Date.now() + WORKOS_AUTH_LOCK_TIMEOUT_MS;
  let retryDelayMs = 5;
  for (;;) {
    const keys = Array.from(
      new Set([
        subjectKey,
        ...Array.from(knownTargets.keys(), workOSUserProviderLockKey),
      ]),
    ).sort();
    const result = await withSystemTx<
      | { kind: "acquired"; value: T }
      | { kind: "account_deleted" }
      | { kind: "ambiguous" }
      | { kind: "contended" }
      | { kind: "expanded"; targets: WorkOSAuthenticationTarget[] }
    >(pool, async (tx) => {
      for (const key of keys) {
        const lock = await tx.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_xact_lock(
             hashtextextended($1::text, 0)
           ) AS acquired`,
          [key],
        );
        if (!lock.rows[0]?.acquired) return { kind: "contended" };
      }
      const currentTargets = await workOSAuthenticationTargets(tx, input);
      if (
        currentTargets.some(
          (target) => !keys.includes(workOSUserProviderLockKey(target.user_id)),
        )
      ) {
        return { kind: "expanded", targets: currentTargets };
      }
      const resolution =
        resolveCurrentWorkOSAuthenticationTarget(currentTargets);
      if (resolution.kind === "ambiguous") return { kind: "ambiguous" };
      if (
        resolution.kind === "candidate" &&
        (await fenceAndQueueLatePurgingWorkOSCandidate(
          tx,
          input,
          resolution.userId,
        ))
      ) {
        return { kind: "account_deleted" };
      }
      return { kind: "acquired", value: await work(tx) };
    });
    if (result.kind === "acquired") return result.value;
    if (result.kind === "account_deleted") {
      throw new HttpError(
        401,
        "account_deleted",
        "This account is no longer active.",
      );
    }
    if (result.kind === "ambiguous") {
      throw new HttpError(
        503,
        "authentication_temporarily_unavailable",
        "Authentication is temporarily unavailable. Try again.",
      );
    }
    if (result.kind === "expanded") {
      for (const target of result.targets) {
        knownTargets.set(target.user_id, target);
      }
      continue;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new HttpError(
        503,
        "authentication_temporarily_unavailable",
        "Authentication is temporarily unavailable. Try again.",
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(retryDelayMs, remainingMs)),
    );
    retryDelayMs = Math.min(retryDelayMs * 2, 100);
  }
}

async function registerAuthenticatedSession(
  tx: Tx,
  user: AuthedUser,
  input: AuthenticatedIdentityInput,
): Promise<void> {
  const session = input.provider === "workos" ? input.session : undefined;
  if (!session) return;

  let current = await tx.query<{
    provider_sub: string;
    user_id: string | null;
    client_kind: AuthClientKind | "unknown";
    status: "active" | "revoked" | "expired";
  }>(
    `SELECT provider_sub, user_id, client_kind, status
     FROM auth_sessions
     WHERE provider = 'workos' AND provider_session_id = $1
     FOR UPDATE`,
    [session.id],
  );
  if (!current.rows[0]) {
    await tx.query(
      `INSERT INTO auth_sessions (
         provider, provider_session_id, provider_sub, user_id, client_kind,
         last_token_expires_at
       ) VALUES ('workos', $1, $2, $3, $4, to_timestamp($5))
       ON CONFLICT (provider, provider_session_id) DO NOTHING`,
      [
        session.id,
        input.providerSubject,
        user.id,
        session.clientKind,
        session.tokenExpiresAt,
      ],
    );
    current = await tx.query(
      `SELECT provider_sub, user_id, client_kind, status
       FROM auth_sessions
       WHERE provider = 'workos' AND provider_session_id = $1
       FOR UPDATE`,
      [session.id],
    );
  }
  const observed = current.rows[0];
  if (!observed || observed.status !== "active") {
    throw new HttpError(401, "session_revoked", "This session was revoked.");
  }
  if (
    observed.provider_sub !== input.providerSubject ||
    (observed.user_id !== null && observed.user_id !== user.id) ||
    (observed.client_kind !== "unknown" &&
      observed.client_kind !== session.clientKind)
  ) {
    throw new HttpError(
      401,
      "session_identity_mismatch",
      "This session does not belong to the authenticated account.",
    );
  }
  await tx.query(
    `UPDATE auth_sessions
     SET user_id = COALESCE(user_id, $2),
         client_kind = CASE
           WHEN client_kind = 'unknown' THEN $4::auth_client_kind
           ELSE client_kind
         END,
         last_token_expires_at = GREATEST(
           COALESCE(last_token_expires_at, '-infinity'::timestamptz),
           to_timestamp($3)
         ),
         last_seen_at = CASE
           WHEN last_seen_at < now() - interval '15 minutes' THEN now()
           ELSE last_seen_at
         END
     WHERE provider = 'workos' AND provider_session_id = $1
       AND status = 'active'`,
    [session.id, user.id, session.tokenExpiresAt, session.clientKind],
  );
  // Browser credentials are independently opaque. Binding the provider sid to
  // the stable account lets a global account event remove every browser shell
  // without ever storing its bearer token.
  await tx.query(
    `UPDATE workos_browser_sessions
     SET account_user_id = $2, account_revision = $3
     WHERE kind = 'session' AND provider_session_id = $1
       AND (account_user_id IS NULL OR account_user_id = $2)`,
    [session.id, user.id, user.accountRevision],
  );
}

/** Ordinary authentication is a read of the already-bound account. Only a
 * never-seen identity enters the explicit bootstrap path. */
export async function resolveAuthenticatedUser(
  pool: pg.Pool,
  input: AuthenticatedIdentityInput,
  options: { allowDeletionPending?: boolean } = {},
): Promise<AuthedUser> {
  const existing = await withWorkOSAuthenticationTx(pool, input, async (tx) => {
    const result = await tx.query<PrincipalRow>(
      `SELECT u.id, u.email, u.display_name, u.avatar_url, u.staff_role,
              u.auth_status, u.auth_revision, u.deleted_at,
              ui.status AS identity_status
       FROM user_identities ui
       JOIN users u ON u.id = ui.user_id
       WHERE ui.provider = $1 AND ui.provider_sub = $2`,
      [input.provider, input.providerSubject],
    );
    if (!result.rows[0]) return null;
    if (options.allowDeletionPending === true) {
      await requireUnfencedWorkOSIdentity(tx, input);
    }
    const user = activePrincipal(result.rows[0], input, {
      allowDeletionPending: options.allowDeletionPending === true,
    });
    await registerAuthenticatedSession(tx, user, input);
    return user;
  });
  if (existing) return existing;

  const created = await ensureUserWithoutProviderLock(pool, input);
  await withWorkOSAuthenticationTx(pool, input, async (tx) => {
    await requireUnfencedWorkOSIdentity(tx, input);
    await registerAuthenticatedSession(tx, created, input);
  });
  return created;
}

/**
 * JIT provisioning, idempotent under concurrency: identity link → user row →
 * permanent Personal organization → default team. Collaborative organizations
 * are still explicitly created/joined.
 * Parallel first requests are serialized by the unique indexes
 * (provider+sub, email) and settle via ON CONFLICT / row re-reads.
 */
export async function ensureUser(
  pool: pg.Pool,
  input: AuthenticatedIdentityInput,
): Promise<AuthedUser> {
  return ensureUserWithoutProviderLock(pool, input);
}

async function ensureUserWithoutProviderLock(
  pool: pg.Pool,
  input: AuthenticatedIdentityInput,
): Promise<AuthedUser> {
  const result = await withWorkOSAuthenticationTx<
    | { kind: "active"; user: AuthedUser }
    | { kind: "recovery_required"; publicCode: string | null }
  >(pool, input, async (tx) => {
    let linked = await tx.query<{
      user_id: string;
      status: IdentityLifecycleStatus;
    }>(
      `SELECT user_id, status FROM user_identities
       WHERE provider = $1 AND provider_sub = $2`,
      [input.provider, input.providerSubject],
    );
    if (!linked.rows[0]) {
      await requireUnfencedWorkOSIdentity(tx, input);
      // Serialize only the first-request path for one provider identity, then
      // re-read after acquiring the lock. Unique constraints reject duplicates,
      // but without this lock the losing transaction surfaces an opaque 500
      // instead of reusing the row the winner just provisioned. Hash collisions
      // cause harmless extra serialization.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `identity:${input.provider.length}:${input.provider}:${input.providerSubject}`,
      ]);
      linked = await tx.query<{
        user_id: string;
        status: IdentityLifecycleStatus;
      }>(
        `SELECT user_id, status FROM user_identities
         WHERE provider = $1 AND provider_sub = $2`,
        [input.provider, input.providerSubject],
      );
    }

    let row: {
      id: string;
      email: string;
      display_name: string | null;
      avatar_url: string | null;
      staff_role: StaffRole | null;
      auth_status: AccountAuthStatus;
      auth_revision: string | number;
    };
    if (linked.rows[0]) {
      if (linked.rows[0].status !== "active") {
        throw new HttpError(
          401,
          linked.rows[0].status === "superseded"
            ? "identity_superseded"
            : "account_deleted",
          "This sign-in identity is no longer active.",
        );
      }
      // Mirror the IdP's email — UNLESS another user already owns it, in which
      // case the UPDATE would trip the users.email unique constraint and abort
      // the tx as a 500 on every request (locking this user out entirely). An
      // email change colliding with an existing account needs a deliberate
      // resolution, not an outage: keep the stored email and let the user keep
      // working. The WHERE NOT EXISTS makes the guard atomic with the write.
      const updated = await tx.query<typeof row>(
        `UPDATE users SET
           email = CASE
             WHEN NOT EXISTS (SELECT 1 FROM users WHERE email = $2 AND id <> $1) THEN $2
             ELSE email
           END,
           display_name = COALESCE(display_name, $3),
           avatar_url = COALESCE($4, avatar_url)
         WHERE id = $1 AND deleted_at IS NULL AND auth_status = 'active'
         RETURNING id, email, display_name, avatar_url, staff_role,
                   auth_status, auth_revision`,
        [
          linked.rows[0].user_id,
          input.email,
          input.displayName,
          input.avatarUrl ?? null,
        ],
      );
      if (!updated.rows[0]) {
        const state = await tx.query<{ auth_status: AccountAuthStatus }>(
          `SELECT auth_status FROM users WHERE id = $1`,
          [linked.rows[0].user_id],
        );
        throw new HttpError(
          401,
          state.rows[0]?.auth_status === "suspended"
            ? "account_suspended"
            : "account_deleted",
          state.rows[0]?.auth_status === "suspended"
            ? "This account is suspended."
            : "This account is no longer active.",
        );
      }
      row = updated.rows[0];
      if (row.email !== input.email) {
        console.warn(
          `[auth] token email for user ${row.id} conflicts with another account — keeping stored email`,
        );
      }
    } else {
      // A brand-new identity → a real signup. Charge the global signup budget
      // BEFORE creating anything, so a flood of fresh provider subs can't mass-
      // provision rows. Throws 429 past the window cap.
      chargeSignupBudget(Date.now());
      // Different provider identities can race with the same case-insensitive
      // email. Serialize that narrower signup branch so the loser observes the
      // committed owner below and receives the deliberate account_exists 409.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 1))`, [
        `email:${input.email.toLowerCase()}`,
      ]);
      // No identity link yet for this (provider, sub). If a DIFFERENT identity
      // already owns this email, this is a SECOND sign-in method for the same
      // person (e.g. GitHub after Google). We deliberately do NOT auto-link on
      // email — that would be an account-takeover vector if two IdPs report the
      // same address — but we also must not blindly INSERT and hit the
      // users.email UNIQUE constraint, which aborts the whole tx as an opaque
      // 500 on EVERY future request with that provider (a permanent lockout).
      // Fail with a deliberate, actionable 409 instead.
      const emailOwner = await tx.query<{
        id: string;
        auth_status: AccountAuthStatus;
        recovery_identity_id: string | null;
        recovery_identity_provider: IdentityProvider | null;
      }>(
        `SELECT u.id, u.auth_status,
                recovery_identity.id AS recovery_identity_id,
                recovery_identity.provider AS recovery_identity_provider
         FROM users u
         LEFT JOIN LATERAL (
           SELECT ui.id, ui.provider
           FROM user_identities ui
           WHERE ui.user_id = u.id AND (
             (
               u.auth_status IN ('identity_disabled', 'deletion_pending')
               AND ui.provider = 'workos'
               AND ui.status = 'provider_deleted'
             ) OR (
               u.auth_status = 'active'
               AND ui.provider = 'auth0'
               AND ui.status = 'active'
             )
           )
             AND NOT EXISTS (
               SELECT 1
               FROM user_identities active_workos
               WHERE active_workos.user_id = u.id
                 AND active_workos.provider = 'workos'
                 AND active_workos.status = 'active'
             )
           ORDER BY ui.disabled_at DESC NULLS LAST, ui.created_at DESC
           LIMIT 1
         ) recovery_identity ON true
         WHERE u.email = $1`,
        [input.email],
      );
      if (emailOwner.rows[0]) {
        const owner = emailOwner.rows[0];
        const providerRecovery =
          owner.recovery_identity_provider === "workos" &&
          (owner.auth_status === "identity_disabled" ||
            owner.auth_status === "deletion_pending");
        const legacyMigration =
          owner.recovery_identity_provider === "auth0" &&
          owner.auth_status === "active";
        if (
          input.provider === "workos" &&
          owner.recovery_identity_id &&
          (providerRecovery || legacyMigration)
        ) {
          if (!input.session) {
            return { kind: "recovery_required", publicCode: null };
          }
          const nowSeconds = Date.now() / 1_000;
          if (
            input.session.authTime === null ||
            input.session.authTime > nowSeconds + 60 ||
            nowSeconds - input.session.authTime > 10 * 60
          ) {
            throw new HttpError(
              401,
              "reauthentication_required",
              "Sign in again to start account recovery.",
            );
          }
          const publicCode = recoveryPublicCode();
          const recovery = await tx.query<{ public_code: string }>(
            `INSERT INTO account_recovery_requests (
               public_code, candidate_provider_sub, candidate_session_id,
               candidate_email, candidate_auth_time, target_user_id,
               target_identity_id
             ) VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7)
             ON CONFLICT (candidate_provider_sub) WHERE state = 'pending'
             DO UPDATE SET
               candidate_session_id = EXCLUDED.candidate_session_id,
               candidate_email = EXCLUDED.candidate_email,
               candidate_auth_time = EXCLUDED.candidate_auth_time,
               target_user_id = EXCLUDED.target_user_id,
               target_identity_id = EXCLUDED.target_identity_id,
               attempt_count = account_recovery_requests.attempt_count + 1,
               requested_at = now(),
               expires_at = now() + interval '24 hours'
             RETURNING public_code`,
            [
              publicCode,
              input.providerSubject,
              input.session.id,
              input.email,
              input.session.authTime,
              owner.id,
              owner.recovery_identity_id,
            ],
          );
          return {
            kind: "recovery_required",
            publicCode: recovery.rows[0]!.public_code,
          };
        }
        throw new HttpError(
          409,
          "account_exists",
          "An account with this email already exists from a different sign-in method. Sign in using the method you first used.",
        );
      }
      const inserted = await tx.query<typeof row>(
        `INSERT INTO users (email, display_name, avatar_url)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name, avatar_url, staff_role,
                   auth_status, auth_revision`,
        [input.email, input.displayName, input.avatarUrl ?? null],
      );
      row = inserted.rows[0]!;
      await tx.query(
        `INSERT INTO user_identities (
           user_id, provider, provider_sub, email_at_link,
           email_verified_at, linked_via
         ) VALUES ($1, $2, $3, $4, now(), 'jit')
         ON CONFLICT (provider, provider_sub) DO NOTHING`,
        [row.id, input.provider, input.providerSubject, input.email],
      );
      if (input.provider === "workos") {
        await materializeProjectedMemberships(
          tx,
          row.id,
          input.providerSubject,
        );
      }
    }

    await ensurePersonalOrganization(tx, row);

    return {
      kind: "active",
      user: {
        id: row.id,
        identity: {
          provider: input.provider,
          subject: input.providerSubject,
        },
        email: row.email,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        staffRole: row.staff_role,
        accountRevision: Number(row.auth_revision),
        accountStatus: row.auth_status,
        authentication: authenticationContext(input),
      },
    };
  });
  if (result.kind === "recovery_required") {
    throw new HttpError(
      409,
      "account_recovery_required",
      "This verified identity needs reviewed account recovery before it can access Zeros.",
      result.publicCode
        ? { recoveryCode: result.publicCode, expiresInSeconds: 24 * 60 * 60 }
        : undefined,
    );
  }
  return result.user;
}

/**
 * Make Personal a database invariant, not a first-page side effect. Running on
 * every authenticated request repairs an interrupted/manual import and updates
 * the fallback "Personal" label if an identity provider later supplies a name.
 */
export async function ensurePersonalOrganization(
  tx: Tx,
  user: {
    id: string;
    display_name: string | null;
  },
): Promise<void> {
  const displayName = user.display_name?.trim() || "Personal";
  const preferredSlug = `personal-${user.id.replaceAll("-", "")}`;
  const existing = await tx.query<{
    id: string;
    name: string;
    has_organization_membership: boolean;
    default_team_id: string | null;
    has_team_membership: boolean;
  }>(
    `SELECT o.id, o.name,
            EXISTS (
              SELECT 1 FROM organization_members om
              WHERE om.org_id = o.id AND om.user_id = $1 AND om.role = 'owner'
            ) AS has_organization_membership,
            dt.id AS default_team_id,
            EXISTS (
              SELECT 1 FROM team_members tm
              WHERE tm.team_id = dt.id AND tm.user_id = $1
                AND tm.role = 'maintainer'
            ) AS has_team_membership
     FROM organizations o
     LEFT JOIN LATERAL (
       SELECT t.id FROM teams t
       WHERE t.org_id = o.id AND t.is_default AND t.deleted_at IS NULL
       ORDER BY t.id LIMIT 1
     ) dt ON true
     WHERE o.created_by = $1 AND o.is_personal AND o.deleted_at IS NULL`,
    [user.id],
  );
  const current = existing.rows[0];
  const invariantComplete = Boolean(
    current?.has_organization_membership &&
    current.default_team_id &&
    current.has_team_membership,
  );
  if (current && invariantComplete) {
    // A provider name may arrive after the first token. Promote only the
    // literal fallback so a future user-editable name is never overwritten.
    if (displayName !== "Personal" && current.name === "Personal") {
      await tx.query(
        `UPDATE organizations SET name = $2
         WHERE id = $1 AND is_personal AND name = 'Personal'`,
        [current.id, displayName],
      );
    }
    return;
  }

  let orgId = current?.id ?? null;
  let createdPersonal = false;
  if (!orgId) {
    let slug = preferredSlug;
    for (let attempt = 0; attempt < 5 && !orgId; attempt++) {
      // Targetless DO NOTHING covers both the per-owner invariant and a slug
      // squatter that commits between attempts. The follow-up owner read
      // distinguishes a concurrent same-user winner from a slug collision.
      const created = await tx.query<{ id: string }>(
        `INSERT INTO organizations (
           slug, name, created_by, is_personal, cloud_workspaces_allowed
         )
         VALUES ($1, $2, $3, true, false)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [slug, displayName, user.id],
      );
      if (created.rows[0]) {
        orgId = created.rows[0].id;
        createdPersonal = true;
        break;
      }
      const selected = await tx.query<{ id: string }>(
        `SELECT id FROM organizations
         WHERE created_by = $1 AND is_personal AND deleted_at IS NULL`,
        [user.id],
      );
      orgId = selected.rows[0]?.id ?? null;
      slug = `${preferredSlug}-${randomBytes(16).toString("hex")}`;
    }
  }
  if (!orgId) throw new Error("Couldn't provision Personal organization");

  // A provider name may arrive after the first token. Promote only the literal
  // fallback so a future user-editable profile name is never overwritten.
  if (displayName !== "Personal") {
    await tx.query(
      `UPDATE organizations SET name = $2
       WHERE id = $1 AND is_personal AND name = 'Personal'`,
      [orgId, displayName],
    );
  }

  await tx.query(
    `INSERT INTO organization_members (org_id, user_id, role)
     VALUES ($1, $2, 'owner')
     ON CONFLICT (org_id, user_id) DO NOTHING`,
    [orgId, user.id],
  );
  await tx.query(
    `INSERT INTO teams (org_id, slug, name, is_default, created_by)
     SELECT $1, 'default', 'Default', true, $2
     WHERE NOT EXISTS (
       SELECT 1 FROM teams
       WHERE org_id = $1 AND is_default AND deleted_at IS NULL
     )
     ON CONFLICT DO NOTHING`,
    [orgId, user.id],
  );
  await tx.query(
    `INSERT INTO team_members (team_id, org_id, user_id, role)
     SELECT t.id, t.org_id, $2, 'maintainer'
     FROM teams t
     WHERE t.org_id = $1 AND t.is_default AND t.deleted_at IS NULL
     ON CONFLICT (team_id, user_id) DO NOTHING`,
    [orgId, user.id],
  );
  if (createdPersonal) {
    await tx.query(
      `INSERT INTO audit_log (org_id, actor_id, action, subject)
       VALUES ($1, $2, 'organization.personal_created', '{}'::jsonb)`,
      [orgId, user.id],
    );
  }
}

/** Short random slug suffix (base36) — collision-avoidance, not security. */
export function randomSuffix(): string {
  return randomBytes(4).toString("hex");
}

/** slugify; ids are identity, slugs are cosmetic + url-safe. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "organization";
}
