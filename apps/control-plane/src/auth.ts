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
  type AuthTokenContractConfig,
} from "./auth-token-contract.js";

export type IdentityProvider = "auth0" | "workos";

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
      return c.json({ error: { code: "unauthorized", message: "Missing bearer token" } }, 401);
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

    const user = await ensureUser(pool, {
      ...identity,
    });
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

function chargeSignupBudget(now: number): void {
  if (now >= signupWindow.resetAt) signupWindow = { count: 0, resetAt: now + SIGNUP_WINDOW_MS };
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

/**
 * JIT provisioning, idempotent under concurrency: identity link → user row →
 * permanent Personal organization → default team. Collaborative organizations
 * are still explicitly created/joined.
 * Parallel first requests are serialized by the unique indexes
 * (provider+sub, email) and settle via ON CONFLICT / row re-reads.
 */
export async function ensureUser(
  pool: pg.Pool,
  input: {
    provider: IdentityProvider;
    providerSubject: string;
    email: string;
    displayName: string | null;
    avatarUrl?: string | null;
  },
): Promise<AuthedUser> {
  return withSystemTx(pool, async (tx) => {
    let linked = await tx.query<{ user_id: string }>(
      `SELECT user_id FROM user_identities WHERE provider = $1 AND provider_sub = $2`,
      [input.provider, input.providerSubject],
    );
    if (!linked.rows[0]) {
      // Serialize only the first-request path for one provider identity, then
      // re-read after acquiring the lock. Unique constraints reject duplicates,
      // but without this lock the losing transaction surfaces an opaque 500
      // instead of reusing the row the winner just provisioned. Hash collisions
      // cause harmless extra serialization.
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [
          `identity:${input.provider.length}:${input.provider}:${input.providerSubject}`,
        ],
      );
      linked = await tx.query<{ user_id: string }>(
        `SELECT user_id FROM user_identities
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
    };
    if (linked.rows[0]) {
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
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, email, display_name, avatar_url, staff_role`,
        [
          linked.rows[0].user_id,
          input.email,
          input.displayName,
          input.avatarUrl ?? null,
        ],
      );
      if (!updated.rows[0]) {
        throw new HttpError(
          401,
          "account_deleted",
          "This account is no longer active.",
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
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 1))`,
        [`email:${input.email.toLowerCase()}`],
      );
      // No identity link yet for this (provider, sub). If a DIFFERENT identity
      // already owns this email, this is a SECOND sign-in method for the same
      // person (e.g. GitHub after Google). We deliberately do NOT auto-link on
      // email — that would be an account-takeover vector if two IdPs report the
      // same address — but we also must not blindly INSERT and hit the
      // users.email UNIQUE constraint, which aborts the whole tx as an opaque
      // 500 on EVERY future request with that provider (a permanent lockout).
      // Fail with a deliberate, actionable 409 instead.
      const emailOwner = await tx.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1`,
        [input.email],
      );
      if (emailOwner.rows[0]) {
        throw new HttpError(
          409,
          "account_exists",
          "An account with this email already exists from a different sign-in method. Sign in using the method you first used.",
        );
      }
      const inserted = await tx.query<typeof row>(
        `INSERT INTO users (email, display_name, avatar_url)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name, avatar_url, staff_role`,
        [input.email, input.displayName, input.avatarUrl ?? null],
      );
      row = inserted.rows[0]!;
      await tx.query(
        `INSERT INTO user_identities (user_id, provider, provider_sub)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_sub) DO NOTHING`,
        [row.id, input.provider, input.providerSubject],
      );
    }

    await ensurePersonalOrganization(tx, row);

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
    };
  });
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
