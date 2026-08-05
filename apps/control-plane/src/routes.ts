// ──────────────────────────────────────────────────────────
// API surface. Every team-scoped route follows this sequence:
// withUserTx (binds app.user_id for RLS) → requireRole → mutation +
// audit in the SAME transaction. Invariants live in SQL transactions,
// not UI: last-owner protection, enumeration-safe invitations. Teams are
// OPTIONAL (2026-07-22): none is auto-created at sign-in, and any team is
// deletable by an owner.
// ──────────────────────────────────────────────────────────

import { Hono } from "hono";
import { z } from "zod";
import type pg from "pg";
import { withUserTx, withSystemTx, type Tx } from "./db.js";
import { HttpError, requireMembership, requireRole } from "./authz.js";
import { audit } from "./audit.js";
import { generateInviteToken, hashInviteToken } from "./invites.js";
import { randomSuffix, slugify } from "./auth.js";
import { inviteEmailHtml, sendEmail, type EmailConfig } from "./email.js";
import { rateLimit } from "./ratelimit.js";

/** Where the email's Accept button points; the raw token rides as ?token=.
 *  Overridable via INVITE_LINK_BASE (e.g. an app.zeros.build/invite page
 *  that hands off to the zeros:// deep link). */
const INVITE_LINK_BASE =
  process.env.INVITE_LINK_BASE?.trim().replace(/\/+$/, "") ||
  "https://app.zeros.build/invite";

export function inviteLink(rawToken: string): string {
  return `${INVITE_LINK_BASE}?token=${encodeURIComponent(rawToken)}`;
}

const TeamRoleSchema = z.enum(["owner", "admin", "member"]);
const NameSchema = z.string().trim().min(1).max(80);
const EmailSchema = z.string().trim().toLowerCase().email().max(254);
const UuidSchema = z.string().uuid();
// Team logo: a small raster image as a data: URL. Mime is pinned to
// png/jpeg/webp — NEVER svg (it can carry script) — and the base64 body is
// charset-checked so nothing but image bytes can ride in. ~200k chars ≈
// 150 KB decoded; the client downscales to 256×256 before upload, so real
// logos land far below this. Null clears the logo.
const LogoSchema = z
  .string()
  .regex(
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/,
    "Logo must be a png, jpeg, or webp data URL",
  )
  .max(200_000, "Logo image is too large — use an image under 150 KB");
// '*' = team-wide; anything else is a repo slug (e.g. "owner/name").
const ScopeSchema = z
  .string()
  .trim()
  .regex(/^(\*|[\w.-]+(\/[\w.-]+)?)$/, "Scope must be * or a repo slug")
  .default("*");
const SettingsDocSchema = z.record(z.string(), z.unknown());

// Input type is deliberately loose: schemas with .default() have a
// narrower output than input, and callers only care about the output.
function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpError(
      422,
      "invalid_input",
      r.error.issues[0]?.message ?? "Invalid input",
    );
  }
  return r.data;
}

/** Path params are attacker-controlled; a malformed uuid must 404, not 500. */
function uuidParam(value: string | undefined): string {
  const r = UuidSchema.safeParse(value);
  if (!r.success) throw new HttpError(404, "not_found", "Not found");
  return r.data;
}

export function createRoutes(pool: pg.Pool, email?: EmailConfig): Hono {
  const app = new Hono();

  // ── Me ─────────────────────────────────────────────────
  app.get("/v1/me", async (c) => {
    const user = c.get("user");
    const teams = await withUserTx(pool, user.id, (tx) =>
      tx.query(
        `SELECT t.id, t.slug, t.name, t.logo, tm.role
         FROM teams t
         JOIN team_members tm ON tm.team_id = t.id
         WHERE tm.user_id = $1 AND t.deleted_at IS NULL
         ORDER BY t.created_at`,
        [user.id],
      ),
    );
    return c.json({ user, teams: teams.rows });
  });

  // ── Teams ──────────────────────────────────────────────
  // Creation runs in SYSTEM context, like the JIT signup transaction used
  // to: under user-context RLS a brand-new team can never pass the USING
  // check that ON CONFLICT/RETURNING apply to the inserted row, and the
  // owner-membership bootstrap can't see a team it isn't a member of yet
  // under those policies. No team-scoped authz applies anyway — any
  // authenticated user may create a team; the input is Zod-validated and
  // created_by/audit are stamped server-side.
  app.post("/v1/teams", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const name = parse(NameSchema, body.name);
    const logo = body.logo == null ? null : parse(LogoSchema, body.logo);
    const team = await withSystemTx(pool, async (tx) => {
      // ON CONFLICT (slug) DO NOTHING doesn't abort the tx, so we can retry
      // with a fresh suffix on collision instead of 500-ing (the check-then-
      // insert race). Bounded; realistically resolves on the first attempt.
      let created: { rows: Array<{ id: string }> } | null = null;
      let slug = slugify(name);
      for (let i = 0; i < 5 && !created?.rows[0]; i++) {
        const r = await tx.query(
          `INSERT INTO teams (slug, name, logo, created_by)
           VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING
           RETURNING id, slug, name, logo`,
          [slug, name, logo, user.id],
        );
        if (r.rows[0]) created = r;
        else slug = `${slugify(name)}-${randomSuffix()}`;
      }
      if (!created?.rows[0]) {
        throw new HttpError(
          409,
          "slug_conflict",
          "Couldn't allocate a unique team URL — try again",
        );
      }
      const row = created.rows[0] as { id: string };
      await tx.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [row.id, user.id],
      );
      await audit(tx, row.id, user.id, "team.created", {});
      return created.rows[0];
    });
    return c.json({ team }, 201);
  });

  app.patch("/v1/teams/:team", async (c) => {
    const user = c.get("user");
    const teamId = uuidParam(c.req.param("team"));
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    // Partial update: name and/or logo (logo: null clears it). Validating
    // only the provided keys keeps a logo-only change from requiring the
    // name to ride along.
    const name =
      body.name === undefined ? undefined : parse(NameSchema, body.name);
    const logo =
      body.logo === undefined
        ? undefined
        : body.logo === null
          ? null
          : parse(LogoSchema, body.logo);
    if (name === undefined && logo === undefined) {
      throw new HttpError(422, "invalid_input", "Nothing to update");
    }
    const team = await withUserTx(pool, user.id, async (tx) => {
      await requireRole(tx, teamId, user.id, "admin");
      const updated = await tx.query(
        `UPDATE teams
         SET name = COALESCE($2, name),
             logo = CASE WHEN $3 THEN logo ELSE $4 END
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, slug, name, logo`,
        [teamId, name ?? null, logo === undefined, logo ?? null],
      );
      if (!updated.rows[0])
        throw new HttpError(404, "not_found", "Team not found");
      if (name !== undefined)
        await audit(tx, teamId, user.id, "team.renamed", { name });
      if (logo !== undefined) {
        await audit(tx, teamId, user.id, "team.logo_updated", {
          cleared: logo === null,
        });
      }
      return updated.rows[0];
    });
    return c.json({ team });
  });

  app.delete("/v1/teams/:team", async (c) => {
    const user = c.get("user");
    const teamId = uuidParam(c.req.param("team"));
    await withUserTx(pool, user.id, async (tx) => {
      await requireRole(tx, teamId, user.id, "owner");
      const gone = await tx.query(
        `UPDATE teams SET deleted_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [teamId],
      );
      if (!gone.rowCount)
        throw new HttpError(404, "not_found", "Team not found");
      // A deleted team must not keep live join links: revoke every pending
      // invitation in the same transaction (the accept path also re-checks
      // deleted_at, so this is belt and suspenders).
      await tx.query(
        `UPDATE invitations SET revoked_at = now()
         WHERE team_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [teamId],
      );
      await audit(tx, teamId, user.id, "team.deleted", {});
    });
    return c.json({ ok: true });
  });

  // ── Members ────────────────────────────────────────────
  app.get("/v1/teams/:team/members", async (c) => {
    const user = c.get("user");
    const teamId = uuidParam(c.req.param("team"));
    const rows = await withUserTx(pool, user.id, async (tx) => {
      await requireMembership(tx, teamId, user.id);
      const r = await tx.query(
        `SELECT u.id, u.email, u.display_name, tm.role, tm.created_at
         FROM team_members tm JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1 ORDER BY tm.created_at`,
        [teamId],
      );
      return r.rows;
    });
    return c.json({ members: rows });
  });

  app.patch("/v1/teams/:team/members/:user", async (c) => {
    const actor = c.get("user");
    const teamId = uuidParam(c.req.param("team"));
    const targetId = uuidParam(c.req.param("user"));
    const body = await c.req.json().catch(() => ({}));
    const role = parse(TeamRoleSchema, (body as { role?: unknown }).role);
    await withUserTx(pool, actor.id, async (tx) => {
      const actorRole = await requireRole(tx, teamId, actor.id, "admin");
      // Only owners mint or demote owners.
      const target = await tx.query<{ role: string }>(
        `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
        [teamId, targetId],
      );
      const current = target.rows[0]?.role;
      if (!current) throw new HttpError(404, "not_found", "Member not found");
      if ((current === "owner" || role === "owner") && actorRole !== "owner") {
        throw new HttpError(
          403,
          "forbidden",
          "Only owners can change owner roles",
        );
      }
      if (current === "owner" && role !== "owner")
        await assertNotLastOwner(tx, teamId);
      await tx.query(
        `UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2`,
        [teamId, targetId, role],
      );
      await audit(tx, teamId, actor.id, "member.role_changed", {
        user: targetId,
        role,
      });
    });
    return c.json({ ok: true });
  });

  app.delete("/v1/teams/:team/members/:user", async (c) => {
    const actor = c.get("user");
    const teamId = uuidParam(c.req.param("team"));
    const targetId = uuidParam(c.req.param("user"));
    await withUserTx(pool, actor.id, async (tx) => {
      const selfLeave = actor.id === targetId;
      const actorRole = selfLeave
        ? await requireMembership(tx, teamId, actor.id)
        : await requireRole(tx, teamId, actor.id, "admin");
      const target = await tx.query<{ role: string }>(
        `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
        [teamId, targetId],
      );
      const current = target.rows[0]?.role;
      if (!current) throw new HttpError(404, "not_found", "Member not found");
      // Removing an owner is owner-only territory — mirrors the role-change
      // guard, which otherwise lets an admin evict an owner via delete.
      // (Self-leave is always allowed for one's own row.)
      if (current === "owner" && !selfLeave && actorRole !== "owner") {
        throw new HttpError(
          403,
          "forbidden",
          "Only owners can remove an owner",
        );
      }
      if (current === "owner") await assertNotLastOwner(tx, teamId);
      // ORDER MATTERS under RLS for self-leave: once the actor's own
      // membership row is gone, app_user_team_ids() stops containing this
      // team, so the audit INSERT would fail its policy and roll the whole
      // leave back. Audit first, membership last — the transaction is atomic
      // either way.
      await audit(
        tx,
        teamId,
        actor.id,
        selfLeave ? "member.left" : "member.removed",
        {
          user: targetId,
        },
      );
      await tx.query(
        `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [teamId, targetId],
      );
    });
    return c.json({ ok: true });
  });

  // ── Invitations ────────────────────────────────────────
  // Abuse control on the mail-sending path (Part F): 20 invites / 10 min / admin.
  app.post(
    "/v1/teams/:team/invitations",
    rateLimit("invite-create", 20, 10 * 60_000),
  );
  app.post("/v1/teams/:team/invitations", async (c) => {
    const user = c.get("user");
    const teamId = uuidParam(c.req.param("team"));
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const emailAddr = parse(EmailSchema, body.email);
    const role = parse(
      TeamRoleSchema.exclude(["owner"]).default("member"),
      body.role ?? "member",
    );

    const result = await withUserTx(pool, user.id, async (tx) => {
      await requireRole(tx, teamId, user.id, "admin");
      // Enumeration-safe: identical success shape whether or not the email
      // already has an account or a pending invite (re-invite = rotate token).
      await tx.query(
        `UPDATE invitations SET revoked_at = now()
         WHERE team_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [teamId, emailAddr],
      );
      const { raw, hash } = generateInviteToken();
      const created = await tx.query<{ id: string; expires_at: string }>(
        `INSERT INTO invitations (team_id, email, role, token_hash, invited_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, expires_at`,
        [teamId, emailAddr, role, hash, user.id],
      );
      const teamRow = await tx.query<{ name: string }>(
        `SELECT name FROM teams WHERE id = $1`,
        [teamId],
      );
      await audit(tx, teamId, user.id, "member.invited", {
        email: emailAddr,
        role,
      });
      return {
        id: created.rows[0]!.id,
        expiresAt: created.rows[0]!.expires_at,
        token: raw,
        teamName: teamRow.rows[0]?.name ?? "your team",
      };
    });
    // Email AFTER commit — the invite row + copyable link exist regardless;
    // a mail-provider outage must never roll back the invitation.
    if (email) {
      const { subject, html } = inviteEmailHtml({
        teamName: result.teamName,
        inviterName: user.displayName ?? user.email,
        acceptUrl: inviteLink(result.token),
        expiresDays: 7,
      });
      void sendEmail(email, emailAddr, subject, html).catch(() => {});
    }
    return c.json(
      {
        invitation: {
          id: result.id,
          expiresAt: result.expiresAt,
          token: result.token,
          acceptUrl: inviteLink(result.token),
        },
      },
      201,
    );
  });

  app.get("/v1/teams/:team/invitations", async (c) => {
    const user = c.get("user");
    const teamId = uuidParam(c.req.param("team"));
    const rows = await withUserTx(pool, user.id, async (tx) => {
      await requireRole(tx, teamId, user.id, "admin");
      const r = await tx.query(
        `SELECT id, email, role, expires_at, created_at
         FROM invitations
         WHERE team_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
           AND expires_at > now()
         ORDER BY created_at DESC`,
        [teamId],
      );
      return r.rows;
    });
    return c.json({ invitations: rows });
  });

  app.delete("/v1/teams/:team/invitations/:id", async (c) => {
    const user = c.get("user");
    const teamId = uuidParam(c.req.param("team"));
    const inviteId = uuidParam(c.req.param("id"));
    await withUserTx(pool, user.id, async (tx) => {
      await requireRole(tx, teamId, user.id, "admin");
      const r = await tx.query(
        `UPDATE invitations SET revoked_at = now()
         WHERE id = $1 AND team_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [inviteId, teamId],
      );
      if (!r.rowCount)
        throw new HttpError(404, "not_found", "Invitation not found");
      await audit(tx, teamId, user.id, "invitation.revoked", {
        invitation: inviteId,
      });
    });
    return c.json({ ok: true });
  });

  /** Accept: system-context lookup (the acceptor isn't a member yet), but the
   *  ACTING account must be authenticated, and its email must match the invite —
   *  wrong-account acceptance is the documented takeover path (Part F). */
  // Throttle guessing at the accept endpoint (30 tries / 10 min / user).
  app.post(
    "/v1/invitations/accept",
    rateLimit("invite-accept", 30, 10 * 60_000),
  );
  app.post("/v1/invitations/accept", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const raw = typeof body.token === "string" ? body.token : "";
    if (!raw || raw.length > 200) {
      throw new HttpError(422, "invalid_input", "Missing invitation token");
    }
    const hash = hashInviteToken(raw);

    const joined = await withSystemTx(pool, async (tx) => {
      // Joined against live teams: an invite whose team was deleted after the
      // invite went out must read as invalid, not add membership to a
      // soft-deleted team. Locking BOTH rows (FOR UPDATE OF i, t) closes the
      // race with a concurrent team-delete: the EPQ re-check on lock
      // acquisition re-evaluates t.deleted_at, so an accept that loses the
      // race sees the row vanish instead of joining a deleted team.
      const inv = await tx.query<{
        id: string;
        team_id: string;
        email: string;
        role: "owner" | "admin" | "member";
      }>(
        `SELECT i.id, i.team_id, i.email, i.role
         FROM invitations i
         JOIN teams t ON t.id = i.team_id AND t.deleted_at IS NULL
         WHERE i.token_hash = $1
           AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
         FOR UPDATE OF i, t`,
        [hash],
      );
      const invite = inv.rows[0];
      // One generic failure for unknown/expired/revoked — no oracle.
      if (!invite)
        throw new HttpError(
          404,
          "invalid_invite",
          "This invite link is no longer valid",
        );
      if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
        throw new HttpError(
          403,
          "wrong_account",
          `This invite was sent to ${maskEmail(invite.email)}`,
        );
      }
      await tx.query(
        `INSERT INTO team_members (team_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (team_id, user_id) DO NOTHING`,
        [invite.team_id, user.id, invite.role],
      );
      await tx.query(
        `UPDATE invitations SET accepted_at = now() WHERE id = $1`,
        [invite.id],
      );
      await audit(tx, invite.team_id, user.id, "member.joined", {
        invitation: invite.id,
      });
      const team = await tx.query(
        `SELECT id, slug, name FROM teams WHERE id = $1`,
        [invite.team_id],
      );
      return team.rows[0];
    });
    return c.json({ team: joined });
  });

  // ── Team settings document — the engine's team layer ───
  app.get("/v1/teams/:team/settings", async (c) => {
    const user = c.get("user");
    const teamId = uuidParam(c.req.param("team"));
    const scope = parse(ScopeSchema, c.req.query("scope") ?? "*");
    const doc = await withUserTx(pool, user.id, async (tx) => {
      await requireMembership(tx, teamId, user.id);
      const r = await tx.query<{ doc: unknown; updated_at: string }>(
        `SELECT doc, updated_at FROM team_settings WHERE team_id = $1 AND scope = $2`,
        [teamId, scope],
      );
      return r.rows[0] ?? { doc: {}, updated_at: null };
    });
    return c.json({ scope, ...doc });
  });

  app.put("/v1/teams/:team/settings", async (c) => {
    const user = c.get("user");
    const teamId = uuidParam(c.req.param("team"));
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const scope = parse(ScopeSchema, body.scope ?? "*");
    const doc = parse(SettingsDocSchema, body.doc ?? {});
    await withUserTx(pool, user.id, async (tx) => {
      await requireRole(tx, teamId, user.id, "admin");
      await tx.query(
        `INSERT INTO team_settings (team_id, scope, doc, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, scope)
         DO UPDATE SET doc = EXCLUDED.doc, updated_by = EXCLUDED.updated_by,
                       updated_at = now()`,
        [teamId, scope, JSON.stringify(doc), user.id],
      );
      await audit(tx, teamId, user.id, "settings.updated", { scope });
    });
    return c.json({ ok: true });
  });

  return app;
}

/** Refuse to leave a team with zero owners. Serializes on the TEAM row so two
 *  owners leaving/demoting concurrently can't both observe count=2 and both
 *  commit to zero owners: every owner-affecting mutation must first take this
 *  same row lock (the per-member FOR UPDATE the callers hold locks different
 *  rows and does NOT serialize distinct owners). */
async function assertNotLastOwner(tx: Tx, teamId: string): Promise<void> {
  await tx.query(`SELECT 1 FROM teams WHERE id = $1 FOR UPDATE`, [teamId]);
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM team_members WHERE team_id = $1 AND role = 'owner'`,
    [teamId],
  );
  if (Number(rows[0]?.n ?? 0) <= 1) {
    throw new HttpError(
      409,
      "last_owner",
      "A team must keep at least one owner",
    );
  }
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}
