// ──────────────────────────────────────────────────────────
// Auth — verify Auth0-issued JWTs locally (JWKS) and JIT-mirror the
// user (docs/teams.md Part C).
//
// Sign-in provisions ONLY the user row — teams are optional
// (2026-07-22 decision, see migrations/0005): a user creates one
// explicitly via POST /v1/teams or joins one via an invite. Zero teams
// is a fully supported state.
//
// The JWT proves WHO (sub, email); the database decides WHAT (authz.ts).
// jose's createRemoteJWKSet caches keys in memory and re-fetches only
// when an unknown `kid` appears (key rotation).
//
// users.id is an internally-generated uuid, decoupled from Auth0's `sub`
// (which isn't a uuid — it is `<connection>|<id>`, e.g. "oauth2|000000000").
// user_identities maps (provider, provider_sub) -> users.id, so a future
// provider swap only needs a new row shape here, not a schema change.
// ──────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { MiddlewareHandler } from "hono";
import type pg from "pg";
import type { Config } from "./config.js";
import { withSystemTx } from "./db.js";
import { HttpError, type StaffRole } from "./authz.js";

export type AuthedUser = {
  id: string;
  email: string;
  displayName: string | null;
  /** Product-wide staff role, or null for the ordinary case. Re-read from
   *  Postgres on every request by ensureUser below — never taken from a claim,
   *  so revoking it needs no token expiry. Gates Settings → Internal in the
   *  Mac app; see backend/migrations/0007_staff_role.sql. */
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
  const jwks = createRemoteJWKSet(new URL(config.authJwksUrl));

  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return c.json({ error: { code: "unauthorized", message: "Missing bearer token" } }, 401);
    }

    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: config.authIssuers,
        audience: config.authAudience,
        // Belt-and-braces pinning: the remote JWKS already only yields RS256
        // keys, but an explicit allowlist removes any reliance on JWKS content
        // (alg-confusion), and requiring `exp` means a signed-but-expiry-less
        // token can never become immortal. Auth0 always sets both.
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub"],
      }));
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

    const sub = typeof payload.sub === "string" ? payload.sub : null;
    const email = claimString(payload, "email");
    if (!sub || !email) {
      console.warn(
        `[auth] 401 token missing ${sub ? "email" : "sub"} (sub=${sub ?? "?"}) — ` +
          `is the Auth0 Post-Login Action deployed and stamping ${CLAIM_NS}email onto the ACCESS token?`,
      );
      return c.json({ error: { code: "unauthorized", message: "Token missing sub/email" } }, 401);
    }
    // The invitation accept flow binds on `email` as the sole anti-takeover
    // control (Part F), so an UNVERIFIED email must never authenticate. Fail
    // CLOSED: require an explicit `email_verified: true`. A MISSING claim is
    // rejected too — the Auth0 Action that stamps `email` onto this access token
    // MUST also stamp `email_verified` (both Google and GitHub provide it); an
    // absent claim means a misconfigured connection, not a trustworthy one, and
    // silently trusting it would reopen the takeover vector. Mirrors the web
    // layer (website/web-app/lib/session.ts).
    if (claimBool(payload, "email_verified") !== true) {
      console.warn(`[auth] 401 email_unverified (sub=${sub})`);
      return c.json(
        { error: { code: "email_unverified", message: "Verify your email to continue" } },
        401,
      );
    }
    const displayName = claimString(payload, "name") || claimString(payload, "nickname") || null;

    const user = await ensureUser(pool, {
      provider: "auth0",
      providerSub: sub,
      email,
      displayName,
    });
    c.set("user", user);
    await next();
  };
}

// Backstop against just-in-time signup flooding. ensureUser mints a
// user + identity row for any never-seen (provider, sub), so an
// attacker holding many Auth0 identities could mass-create rows and bloat the
// DB. This caps NEW signups globally per window; RETURNING users are
// never touched (the guard only fires on the create branch). In-memory and
// per-instance like ratelimit.ts — abuse control, not a hard security boundary;
// Auth0's own attack-protection is the first line. Tune SIGNUP_MAX_PER_WINDOW if
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
 * JIT provisioning, idempotent under concurrency: identity link → user row.
 * No team is created — teams are optional and explicitly created/joined.
 * Parallel first requests are serialized by the unique indexes
 * (provider+sub, email) and settle via ON CONFLICT / row re-reads.
 */
export async function ensureUser(
  pool: pg.Pool,
  input: { provider: string; providerSub: string; email: string; displayName: string | null },
): Promise<AuthedUser> {
  return withSystemTx(pool, async (tx) => {
    const linked = await tx.query<{ user_id: string }>(
      `SELECT user_id FROM user_identities WHERE provider = $1 AND provider_sub = $2`,
      [input.provider, input.providerSub],
    );

    let row: {
      id: string;
      email: string;
      display_name: string | null;
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
           display_name = COALESCE(display_name, $3)
         WHERE id = $1
         RETURNING id, email, display_name, staff_role`,
        [linked.rows[0].user_id, input.email, input.displayName],
      );
      row = updated.rows[0]!;
      if (row.email !== input.email) {
        console.warn(
          `[auth] token email for user ${row.id} conflicts with another account — keeping stored email`,
        );
      }
    } else {
      // A brand-new identity → a real signup. Charge the global signup budget
      // BEFORE creating anything, so a flood of fresh Auth0 subs can't mass-
      // provision rows. Throws 429 past the window cap.
      chargeSignupBudget(Date.now());
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
        `INSERT INTO users (email, display_name)
         VALUES ($1, $2)
         RETURNING id, email, display_name, staff_role`,
        [input.email, input.displayName],
      );
      row = inserted.rows[0]!;
      await tx.query(
        `INSERT INTO user_identities (user_id, provider, provider_sub)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_sub) DO NOTHING`,
        [row.id, input.provider, input.providerSub],
      );
    }

    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      staffRole: row.staff_role,
    };
  });
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
  return s || "team";
}

