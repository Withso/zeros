// ──────────────────────────────────────────────────────────
// Organization API.
//
// The product hierarchy is Organization → Team → Member. For the first
// release every organization has exactly one persisted default team, while
// membership, billing, invitations, policy, and workspace ownership remain
// organization-scoped. `/v1/teams` is intentionally retained as a legacy
// alias for released desktop clients from the flat-Team era; its resource id
// is an ORGANIZATION id, never the new child-team id.
// ──────────────────────────────────────────────────────────

import { Hono } from "hono";
import { z } from "zod";
import type pg from "pg";
import { withUserTx, withSystemTx, type Tx } from "./db.js";
import {
  HttpError,
  requireOrganizationMembership,
  requireOrganizationRole,
  type OrganizationRole,
} from "./authz.js";
import { audit } from "./audit.js";
import { generateInviteToken, hashInviteToken } from "./invites.js";
import { randomSuffix, slugify } from "./auth.js";
import { inviteEmailHtml, sendEmail, type EmailConfig } from "./email.js";
import { rateLimit } from "./ratelimit.js";
import type { CloudWorkspaceBackendConfig } from "./config.js";
import { createCloudWorkspaceRoutes } from "./cloud-workspaces/routes.js";

const INVITE_LINK_BASE =
  process.env.INVITE_LINK_BASE?.trim().replace(/\/+$/, "") ||
  "https://app.zeros.build/invite";

export function inviteLink(rawToken: string): string {
  return `${INVITE_LINK_BASE}?token=${encodeURIComponent(rawToken)}`;
}

const OrganizationRoleSchema = z.enum(["owner", "admin", "member"]);
const NameSchema = z.string().trim().min(1).max(80);
const EmailSchema = z.string().trim().toLowerCase().email().max(254);
const UuidSchema = z.string().uuid();
const LogoSchema = z
  .string()
  .regex(
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/,
    "Logo must be a png, jpeg, or webp data URL",
  )
  .max(200_000, "Logo image is too large — use an image under 150 KB");
const ScopeSchema = z
  .string()
  .trim()
  .regex(/^(\*|[\w.-]+(\/[\w.-]+)?)$/, "Scope must be * or a repo slug")
  .default("*");
const SettingsDocSchema = z.record(z.string(), z.unknown());

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

function uuidParam(value: string | undefined): string {
  const result = UuidSchema.safeParse(value);
  if (!result.success) throw new HttpError(404, "not_found", "Not found");
  return result.data;
}

type OrganizationRow = {
  id: string;
  slug: string;
  name: string;
  logo: string | null;
  role: OrganizationRole;
  is_personal: boolean;
  cloud_workspaces_allowed: boolean;
  default_team_id: string | null;
};

export type OrganizationSummary = {
  id: string;
  slug: string;
  name: string;
  logo: string | null;
  role: OrganizationRole;
  isPersonal: boolean;
  defaultTeamId: string | null;
  workspaceCapabilities: { local: true; cloud: boolean };
  teamCapabilities: { multiple: false; canCreate: false };
};

function organizationSummary(row: OrganizationRow): OrganizationSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    logo: row.logo,
    role: row.role,
    isPersonal: row.is_personal,
    defaultTeamId: row.default_team_id,
    workspaceCapabilities: {
      local: true,
      cloud: !row.is_personal && row.cloud_workspaces_allowed,
    },
    teamCapabilities: { multiple: false, canCreate: false },
  };
}

function requiredOrganizationSummary(
  row: OrganizationRow | undefined,
): OrganizationSummary {
  if (!row) {
    throw new HttpError(404, "not_found", "Organization not found");
  }
  return organizationSummary(row);
}

const ORGANIZATION_SUMMARY_SQL = `
  SELECT o.id, o.slug, o.name, o.logo, om.role, o.is_personal,
         o.cloud_workspaces_allowed, dt.id AS default_team_id
  FROM organizations o
  JOIN organization_members om ON om.org_id = o.id
  LEFT JOIN LATERAL (
    SELECT t.id FROM teams t
    WHERE t.org_id = o.id AND t.is_default AND t.deleted_at IS NULL
    ORDER BY t.id LIMIT 1
  ) dt ON true`;

export function createRoutes(
  pool: pg.Pool,
  email?: EmailConfig,
  cloudWorkspaces: CloudWorkspaceBackendConfig | null = null,
): Hono {
  const app = new Hono();

  app.get("/v1/me", async (c) => {
    const user = c.get("user");
    const result = await withUserTx(pool, user.id, (tx) =>
      tx.query<OrganizationRow>(
        `${ORGANIZATION_SUMMARY_SQL}
         WHERE om.user_id = $1 AND o.deleted_at IS NULL
         ORDER BY o.is_personal DESC, o.created_at, o.id`,
        [user.id],
      ),
    );
    const organizations = result.rows.map(organizationSummary);
    // Compatibility: old clients treat these tenant roots as flat Teams. The
    // provider binding is server-only and never enters the account wire shape.
    const publicUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      staffRole: user.staffRole,
    };
    return c.json({ user: publicUser, organizations, teams: organizations });
  });

  app.route(
    "/v1/organizations",
    createOrganizationRouter(pool, email, false),
  );
  app.route("/v1/teams", createOrganizationRouter(pool, email, true));
  app.route("/", createCloudWorkspaceRoutes(pool, cloudWorkspaces));

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
      const invitationResult = await tx.query<{
        id: string;
        org_id: string;
        email: string;
        role: OrganizationRole;
      }>(
        `SELECT i.id, i.org_id, i.email, i.role
         FROM invitations i
         JOIN organizations o
           ON o.id = i.org_id AND o.deleted_at IS NULL AND NOT o.is_personal
         WHERE i.token_hash = $1
           AND i.accepted_at IS NULL AND i.revoked_at IS NULL
           AND i.expires_at > now()
         FOR UPDATE OF i, o`,
        [hash],
      );
      const invitation = invitationResult.rows[0];
      if (!invitation) {
        throw new HttpError(
          404,
          "invalid_invite",
          "This invite link is no longer valid",
        );
      }
      if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
        throw new HttpError(
          403,
          "wrong_account",
          `This invite was sent to ${maskEmail(invitation.email)}`,
        );
      }

      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [invitation.org_id, user.id, invitation.role],
      );
      const effectiveRole = await tx.query<{ role: OrganizationRole }>(
        `SELECT role FROM organization_members
         WHERE org_id = $1 AND user_id = $2`,
        [invitation.org_id, user.id],
      );
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         SELECT t.id, t.org_id, $2,
                CASE WHEN $3 IN ('owner', 'admin')
                     THEN 'maintainer'::team_role ELSE 'member'::team_role END
         FROM teams t
         WHERE t.org_id = $1 AND t.is_default AND t.deleted_at IS NULL
         ON CONFLICT (team_id, user_id) DO NOTHING`,
        [invitation.org_id, user.id, effectiveRole.rows[0]!.role],
      );
      await tx.query(
        `UPDATE invitations SET accepted_at = now() WHERE id = $1`,
        [invitation.id],
      );
      await audit(tx, invitation.org_id, user.id, "member.joined", {
        invitation: invitation.id,
      });
      const result = await tx.query<OrganizationRow>(
        `${ORGANIZATION_SUMMARY_SQL}
         WHERE o.id = $1 AND om.user_id = $2`,
        [invitation.org_id, user.id],
      );
      return requiredOrganizationSummary(result.rows[0]);
    });
    return c.json({ organization: joined, team: joined });
  });

  return app;
}

function createOrganizationRouter(
  pool: pg.Pool,
  email: EmailConfig | undefined,
  legacy: boolean,
): Hono {
  const app = new Hono();
  const param = (c: { req: { param(name: string): string } }): string =>
    uuidParam(c.req.param("organization"));

  app.post("/", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const name = parse(NameSchema, body.name);
    const logo = body.logo == null ? null : parse(LogoSchema, body.logo);
    const organization = await withSystemTx(pool, async (tx) => {
      let created: { rows: OrganizationRow[] } | null = null;
      let slug = slugify(name);
      for (let attempt = 0; attempt < 5 && !created?.rows[0]; attempt++) {
        const result = await tx.query<OrganizationRow>(
          `INSERT INTO organizations (
             slug, name, logo, created_by, is_personal,
             cloud_workspaces_allowed
           )
           VALUES ($1, $2, $3, $4, false, true)
           ON CONFLICT (slug) DO NOTHING
           RETURNING id, slug, name, logo, is_personal,
                     cloud_workspaces_allowed`,
          [slug, name, logo, user.id],
        );
        if (result.rows[0]) created = result;
        else slug = `${slugify(name)}-${randomSuffix()}`;
      }
      const root = created?.rows[0];
      if (!root) {
        throw new HttpError(
          409,
          "slug_conflict",
          "Couldn't allocate a unique organization URL — try again",
        );
      }
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [root.id, user.id],
      );
      const team = await tx.query<{ id: string }>(
        `INSERT INTO teams (org_id, slug, name, is_default, created_by)
         VALUES ($1, 'default', 'Default', true, $2)
         RETURNING id`,
        [root.id, user.id],
      );
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [team.rows[0]!.id, root.id, user.id],
      );
      await audit(tx, root.id, user.id, "organization.created", {});
      return organizationSummary({
        ...root,
        role: "owner",
        default_team_id: team.rows[0]!.id,
      });
    });
    return legacy
      ? c.json({ team: organization }, 201)
      : c.json({ organization }, 201);
  });

  app.get("/:organization", async (c) => {
    const user = c.get("user");
    const orgId = param(c);
    const organization = await withUserTx(pool, user.id, async (tx) => {
      await requireOrganizationMembership(tx, orgId, user.id);
      const result = await tx.query<OrganizationRow>(
        `${ORGANIZATION_SUMMARY_SQL}
         WHERE o.id = $1 AND om.user_id = $2 AND o.deleted_at IS NULL`,
        [orgId, user.id],
      );
      return requiredOrganizationSummary(result.rows[0]);
    });
    return legacy
      ? c.json({ team: organization })
      : c.json({ organization });
  });

  app.patch("/:organization", async (c) => {
    const user = c.get("user");
    const orgId = param(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
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
    const organization = await withUserTx(pool, user.id, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "admin");
      await assertCollaborativeOrganization(tx, orgId);
      await tx.query(
        `UPDATE organizations
         SET name = COALESCE($2, name),
             logo = CASE WHEN $3 THEN logo ELSE $4 END
         WHERE id = $1 AND deleted_at IS NULL`,
        [orgId, name ?? null, logo === undefined, logo ?? null],
      );
      if (name !== undefined) {
        await audit(tx, orgId, user.id, "organization.renamed", { name });
      }
      if (logo !== undefined) {
        await audit(tx, orgId, user.id, "organization.logo_updated", {
          cleared: logo === null,
        });
      }
      const result = await tx.query<OrganizationRow>(
        `${ORGANIZATION_SUMMARY_SQL}
         WHERE o.id = $1 AND om.user_id = $2`,
        [orgId, user.id],
      );
      return requiredOrganizationSummary(result.rows[0]);
    });
    return legacy
      ? c.json({ team: organization })
      : c.json({ organization });
  });

  app.delete("/:organization", async (c) => {
    const user = c.get("user");
    const orgId = param(c);
    // Soft deletion intentionally removes this org from app_user_org_ids(). Use
    // the system transaction only after explicit owner authorization so the
    // revocation, audit, and final tombstone remain one atomic operation.
    await withSystemTx(pool, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "owner");
      await assertCollaborativeOrganization(tx, orgId);
      await tx.query(
        `UPDATE invitations SET revoked_at = now()
         WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [orgId],
      );
      await audit(tx, orgId, user.id, "organization.deleted", {});
      const result = await tx.query(
        `UPDATE organizations SET deleted_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [orgId],
      );
      if (!result.rowCount) {
        throw new HttpError(404, "not_found", "Organization not found");
      }
    });
    return c.json({ ok: true });
  });

  app.get("/:organization/members", async (c) => {
    const user = c.get("user");
    const orgId = param(c);
    const members = await withUserTx(pool, user.id, async (tx) => {
      await requireOrganizationMembership(tx, orgId, user.id);
      const result = await tx.query(
        `SELECT u.id, u.email, u.display_name, u.avatar_url, om.role,
                om.created_at
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
         WHERE om.org_id = $1
         ORDER BY om.created_at, u.id`,
        [orgId],
      );
      return result.rows;
    });
    return c.json({ members });
  });

  app.patch("/:organization/members/:user", async (c) => {
    const actor = c.get("user");
    const orgId = param(c);
    const targetId = uuidParam(c.req.param("user"));
    const body = await c.req.json().catch(() => ({}));
    const role = parse(
      OrganizationRoleSchema,
      (body as { role?: unknown }).role,
    );
    await withUserTx(pool, actor.id, async (tx) => {
      const actorRole = await requireOrganizationRole(
        tx,
        orgId,
        actor.id,
        "admin",
      );
      await assertCollaborativeOrganization(tx, orgId);
      const target = await tx.query<{ role: OrganizationRole }>(
        `SELECT role FROM organization_members
         WHERE org_id = $1 AND user_id = $2 FOR UPDATE`,
        [orgId, targetId],
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
      if (current === "owner" && role !== "owner") {
        await assertNotLastOwner(tx, orgId);
      }
      await tx.query(
        `UPDATE organization_members SET role = $3
         WHERE org_id = $1 AND user_id = $2`,
        [orgId, targetId, role],
      );
      await tx.query(
        `UPDATE team_members
         SET role = CASE WHEN $3 IN ('owner', 'admin')
                         THEN 'maintainer'::team_role
                         ELSE 'member'::team_role END
         WHERE org_id = $1 AND user_id = $2`,
        [orgId, targetId, role],
      );
      await audit(tx, orgId, actor.id, "member.role_changed", {
        user: targetId,
        role,
      });
    });
    return c.json({ ok: true });
  });

  app.delete("/:organization/members/:user", async (c) => {
    const actor = c.get("user");
    const orgId = param(c);
    const targetId = uuidParam(c.req.param("user"));
    await withUserTx(pool, actor.id, async (tx) => {
      const selfLeave = actor.id === targetId;
      const actorRole = selfLeave
        ? await requireOrganizationMembership(tx, orgId, actor.id)
        : await requireOrganizationRole(tx, orgId, actor.id, "admin");
      await assertCollaborativeOrganization(tx, orgId);
      const target = await tx.query<{ role: OrganizationRole }>(
        `SELECT role FROM organization_members
         WHERE org_id = $1 AND user_id = $2 FOR UPDATE`,
        [orgId, targetId],
      );
      const current = target.rows[0]?.role;
      if (!current) throw new HttpError(404, "not_found", "Member not found");
      if (current === "owner" && !selfLeave && actorRole !== "owner") {
        throw new HttpError(
          403,
          "forbidden",
          "Only owners can remove an owner",
        );
      }
      if (current === "owner") await assertNotLastOwner(tx, orgId);
      // Audit before a self-leave: after removing the membership RLS no longer
      // permits this actor to insert an organization-scoped audit row.
      await audit(
        tx,
        orgId,
        actor.id,
        selfLeave ? "member.left" : "member.removed",
        { user: targetId },
      );
      await tx.query(
        `DELETE FROM organization_members
         WHERE org_id = $1 AND user_id = $2`,
        [orgId, targetId],
      );
    });
    return c.json({ ok: true });
  });

  app.post(
    "/:organization/invitations",
    rateLimit("invite-create", 20, 10 * 60_000),
  );
  app.post("/:organization/invitations", async (c) => {
    const user = c.get("user");
    const orgId = param(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const emailAddress = parse(EmailSchema, body.email);
    const role = parse(
      OrganizationRoleSchema.exclude(["owner"]).default("member"),
      body.role ?? "member",
    );
    const result = await withUserTx(pool, user.id, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "admin");
      await assertCollaborativeOrganization(tx, orgId);
      await tx.query(
        `UPDATE invitations SET revoked_at = now()
         WHERE org_id = $1 AND email = $2
           AND accepted_at IS NULL AND revoked_at IS NULL`,
        [orgId, emailAddress],
      );
      const { raw, hash } = generateInviteToken();
      const created = await tx.query<{ id: string; expires_at: string }>(
        `INSERT INTO invitations (org_id, email, role, token_hash, invited_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, expires_at`,
        [orgId, emailAddress, role, hash, user.id],
      );
      const organization = await tx.query<{ name: string }>(
        `SELECT name FROM organizations WHERE id = $1`,
        [orgId],
      );
      await audit(tx, orgId, user.id, "member.invited", {
        email: emailAddress,
        role,
      });
      return {
        id: created.rows[0]!.id,
        expiresAt: created.rows[0]!.expires_at,
        token: raw,
        organizationName:
          organization.rows[0]?.name ?? "your organization",
      };
    });
    if (email) {
      const message = inviteEmailHtml({
        organizationName: result.organizationName,
        inviterName: user.displayName ?? user.email,
        acceptUrl: inviteLink(result.token),
        expiresDays: 7,
      });
      void sendEmail(
        email,
        emailAddress,
        message.subject,
        message.html,
      ).catch(() => {});
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

  app.get("/:organization/invitations", async (c) => {
    const user = c.get("user");
    const orgId = param(c);
    const invitations = await withUserTx(pool, user.id, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "admin");
      await assertCollaborativeOrganization(tx, orgId);
      const result = await tx.query(
        `SELECT id, email, role, expires_at, created_at
         FROM invitations
         WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
           AND expires_at > now()
         ORDER BY created_at DESC`,
        [orgId],
      );
      return result.rows;
    });
    return c.json({ invitations });
  });

  app.delete("/:organization/invitations/:id", async (c) => {
    const user = c.get("user");
    const orgId = param(c);
    const inviteId = uuidParam(c.req.param("id"));
    await withUserTx(pool, user.id, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "admin");
      await assertCollaborativeOrganization(tx, orgId);
      const result = await tx.query(
        `UPDATE invitations SET revoked_at = now()
         WHERE id = $1 AND org_id = $2
           AND accepted_at IS NULL AND revoked_at IS NULL`,
        [inviteId, orgId],
      );
      if (!result.rowCount) {
        throw new HttpError(404, "not_found", "Invitation not found");
      }
      await audit(tx, orgId, user.id, "invitation.revoked", {
        invitation: inviteId,
      });
    });
    return c.json({ ok: true });
  });

  app.get("/:organization/teams", async (c) => {
    const user = c.get("user");
    const orgId = param(c);
    const teams = await withUserTx(pool, user.id, async (tx) => {
      await requireOrganizationMembership(tx, orgId, user.id);
      const result = await tx.query(
        `SELECT t.id, t.org_id, t.slug, t.name, t.is_default,
                tm.role, t.created_at
         FROM teams t
         JOIN team_members tm
           ON tm.team_id = t.id AND tm.user_id = $2
         WHERE t.org_id = $1 AND t.deleted_at IS NULL
         ORDER BY t.is_default DESC, t.created_at, t.id`,
        [orgId, user.id],
      );
      return result.rows;
    });
    return c.json({ teams, capabilities: { multiple: false, canCreate: false } });
  });

  app.post("/:organization/teams", async (c) => {
    const user = c.get("user");
    const orgId = param(c);
    await withUserTx(pool, user.id, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "admin");
      await assertCollaborativeOrganization(tx, orgId);
    });
    throw new HttpError(
      409,
      "multiple_teams_not_available",
      "Every organization uses its default team for now",
    );
  });

  app.get("/:organization/billing", async (c) => {
    const user = c.get("user");
    const orgId = param(c);
    const billing = await withUserTx(pool, user.id, async (tx) => {
      await requireOrganizationMembership(tx, orgId, user.id);
      const org = await tx.query<{ is_personal: boolean }>(
        `SELECT is_personal FROM organizations
         WHERE id = $1 AND deleted_at IS NULL`,
        [orgId],
      );
      if (org.rows[0]!.is_personal) {
        return { applicable: false as const, managementAvailable: false as const };
      }
      const subscription = await tx.query(
        `SELECT status, plan, seats, current_period_end, updated_at
         FROM billing_subscriptions
         WHERE org_id = $1
         ORDER BY updated_at DESC LIMIT 1`,
        [orgId],
      );
      const members = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM organization_members WHERE org_id = $1`,
        [orgId],
      );
      return {
        applicable: true as const,
        managementAvailable: false as const,
        subscription: subscription.rows[0] ?? null,
        memberCount: Number(members.rows[0]?.count ?? 0),
      };
    });
    return c.json({ billing });
  });

  app.get("/:organization/settings", async (c) => {
    const user = c.get("user");
    const orgId = param(c);
    const scope = parse(ScopeSchema, c.req.query("scope") ?? "*");
    const document = await withUserTx(pool, user.id, async (tx) => {
      await requireOrganizationMembership(tx, orgId, user.id);
      const org = await tx.query<{ is_personal: boolean }>(
        `SELECT is_personal FROM organizations WHERE id = $1`,
        [orgId],
      );
      // Personal configuration is device-local. Returning an empty document
      // keeps released clients safe without ever persisting it in the cloud.
      if (org.rows[0]!.is_personal) {
        return { doc: {}, updated_at: null, localOnly: true };
      }
      const result = await tx.query<{ doc: unknown; updated_at: string }>(
        `SELECT doc, updated_at FROM organization_settings
         WHERE org_id = $1 AND scope = $2`,
        [orgId, scope],
      );
      return result.rows[0] ?? { doc: {}, updated_at: null };
    });
    return c.json({ scope, ...document });
  });

  app.put("/:organization/settings", async (c) => {
    const user = c.get("user");
    const orgId = param(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const scope = parse(ScopeSchema, body.scope ?? "*");
    const doc = parse(SettingsDocSchema, body.doc ?? {});
    await withUserTx(pool, user.id, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "admin");
      await assertCollaborativeOrganization(tx, orgId);
      await tx.query(
        `INSERT INTO organization_settings (org_id, scope, doc, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, scope)
         DO UPDATE SET doc = EXCLUDED.doc, updated_by = EXCLUDED.updated_by,
                       updated_at = now()`,
        [orgId, scope, JSON.stringify(doc), user.id],
      );
      await audit(tx, orgId, user.id, "settings.updated", { scope });
    });
    return c.json({ ok: true });
  });

  return app;
}

async function assertCollaborativeOrganization(
  tx: Tx,
  orgId: string,
): Promise<void> {
  const result = await tx.query<{ is_personal: boolean }>(
    `SELECT is_personal FROM organizations
     WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [orgId],
  );
  if (!result.rows[0]) {
    throw new HttpError(404, "not_found", "Organization not found");
  }
  if (result.rows[0].is_personal) {
    throw new HttpError(
      409,
      "personal_organization",
      "Personal is permanent and device-local",
    );
  }
}

async function assertNotLastOwner(tx: Tx, orgId: string): Promise<void> {
  await tx.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [
    orgId,
  ]);
  const result = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM organization_members
     WHERE org_id = $1 AND role = 'owner'`,
    [orgId],
  );
  if (Number(result.rows[0]?.n ?? 0) <= 1) {
    throw new HttpError(
      409,
      "last_owner",
      "An organization must keep at least one owner",
    );
  }
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}
