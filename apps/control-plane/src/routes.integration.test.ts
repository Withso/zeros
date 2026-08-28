import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { ensureUser, type AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import { runMigrations } from "./migrate.js";
import { createRoutes } from "./routes.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("organization routes", () => {
  let pool: pg.Pool;
  let actor: AuthedUser;
  let owner: AuthedUser;
  let member: AuthedUser;
  let app: Hono;

  const signup = (name: string) => {
    const sub = randomUUID();
    return ensureUser(pool, {
      provider: "auth0",
      providerSubject: sub,
      email: `${name.toLowerCase()}-${sub}@example.com`,
      displayName: name,
    });
  };

  const request = (
    path: string,
    init?: { method?: string; body?: Record<string, unknown> },
  ) =>
    app.request(path, {
      method: init?.method ?? "GET",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    owner = await signup("Ada");
    member = await signup("Grace");
    actor = owner;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", actor);
      await next();
    });
    app.route("/", createRoutes(pool));
    app.onError((error, c) => {
      if (error instanceof HttpError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }
      throw error;
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns Personal first with local-only capabilities", async () => {
    const response = await request("/v1/me");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: Record<string, unknown>;
      organizations: Array<{
        name: string;
        isPersonal: boolean;
        defaultTeamId: string;
        workspaceCapabilities: { local: boolean; cloud: boolean };
      }>;
      teams: unknown[];
    };
    expect(body.organizations).toHaveLength(1);
    expect(body.user).not.toHaveProperty("providerSub");
    expect(body.user).not.toHaveProperty("identity");
    expect(body.teams).toEqual(body.organizations);
    expect(body.organizations[0]).toMatchObject({
      name: "Ada",
      isPersonal: true,
      workspaceCapabilities: { local: true, cloud: false },
    });
    expect(body.organizations[0]!.defaultTeamId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("creates an organization and its one default team atomically", async () => {
    const response = await request("/v1/organizations", {
      method: "POST",
      body: { name: "Analytical Engines" },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      organization: {
        id: string;
        isPersonal: boolean;
        defaultTeamId: string;
        workspaceCapabilities: { cloud: boolean };
      };
    };
    expect(body.organization).toMatchObject({
      isPersonal: false,
      workspaceCapabilities: { cloud: true },
    });

    const teams = await request(
      `/v1/organizations/${body.organization.id}/teams`,
    );
    expect(teams.status).toBe(200);
    const teamBody = (await teams.json()) as {
      teams: Array<{ id: string; is_default: boolean }>;
      capabilities: { multiple: boolean; canCreate: boolean };
    };
    expect(teamBody.teams).toEqual([
      expect.objectContaining({
        id: body.organization.defaultTeamId,
        is_default: true,
      }),
    ]);
    expect(teamBody.capabilities).toEqual({
      multiple: false,
      canCreate: false,
    });
  });

  it("never permits Personal deletion, mutation, collaboration, or cloud settings", async () => {
    const me = (await (await request("/v1/me")).json()) as {
      organizations: Array<{ id: string; isPersonal: boolean }>;
    };
    const personal = me.organizations.find((org) => org.isPersonal)!;
    for (const [path, method, body] of [
      [`/v1/organizations/${personal.id}`, "DELETE", undefined],
      [`/v1/organizations/${personal.id}`, "PATCH", { name: "Nope" }],
      [
        `/v1/organizations/${personal.id}/invitations`,
        "POST",
        { email: "friend@example.com" },
      ],
      [
        `/v1/organizations/${personal.id}/settings`,
        "PUT",
        { doc: { cloud: true } },
      ],
      [
        `/v1/organizations/${personal.id}/teams`,
        "POST",
        { name: "Not a team" },
      ],
    ] as const) {
      const response = await request(path, { method, body });
      expect(response.status, `${method} ${path}`).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "personal_organization" },
      });
    }

    const settings = await request(
      `/v1/organizations/${personal.id}/settings`,
    );
    await expect(settings.json()).resolves.toMatchObject({
      doc: {},
      localOnly: true,
    });
  });

  it("blocks additional teams now but exposes the future-safe child-team API", async () => {
    const me = (await (await request("/v1/me")).json()) as {
      organizations: Array<{ id: string; isPersonal: boolean }>;
    };
    const org = me.organizations.find((item) => !item.isPersonal)!;
    const response = await request(`/v1/organizations/${org.id}/teams`, {
      method: "POST",
      body: { name: "Research" },
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "multiple_teams_not_available" },
    });
  });

  it("invites at organization scope, verifies the account email, and joins the default team", async () => {
    const me = (await (await request("/v1/me")).json()) as {
      organizations: Array<{ id: string; isPersonal: boolean }>;
    };
    const org = me.organizations.find((item) => !item.isPersonal)!;
    const invite = await request(`/v1/organizations/${org.id}/invitations`, {
      method: "POST",
      body: { email: member.email, role: "member" },
    });
    expect(invite.status).toBe(201);
    const invitation = (await invite.json()) as {
      invitation: { token: string };
    };

    actor = member;
    const accepted = await request("/v1/invitations/accept", {
      method: "POST",
      body: { token: invitation.invitation.token },
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      organization: { id: org.id, role: "member" },
      team: { id: org.id },
    });
    const membership = await pool.query(
      `SELECT tm.role
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       WHERE t.org_id = $1 AND tm.user_id = $2`,
      [org.id, member.id],
    );
    expect(membership.rows).toEqual([{ role: "member" }]);
    actor = owner;
  });

  it("refuses local role and removal changes for directory-managed members", async () => {
    const created = await request("/v1/organizations", {
      method: "POST",
      body: { name: "Directory Managed" },
    });
    const body = (await created.json()) as { organization: { id: string } };
    const orgId = body.organization.id;
    await pool.query(
      `INSERT INTO organization_members (
         org_id, user_id, role, membership_source, workos_membership_id
       ) VALUES ($1, $2, 'member', 'scim', $3)`,
      [orgId, member.id, `om_${randomUUID().replaceAll("-", "")}`],
    );

    for (const [method, body] of [
      ["PATCH", { role: "admin" }],
      ["DELETE", undefined],
    ] as const) {
      const response = await request(
        `/v1/organizations/${orgId}/members/${member.id}`,
        { method, body },
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "directory_managed_membership" },
      });
    }

    const membership = await pool.query(
      `SELECT role, membership_source FROM organization_members
       WHERE org_id = $1 AND user_id = $2`,
      [orgId, member.id],
    );
    expect(membership.rows).toEqual([
      { role: "member", membership_source: "scim" },
    ]);
    const listed = await request(`/v1/organizations/${orgId}/members`);
    const listedBody = (await listed.json()) as {
      members: Array<{ id: string; directory_managed: boolean }>;
    };
    expect(listedBody.members.find((item) => item.id === member.id)).toMatchObject({
      directory_managed: true,
    });
  });

  it("keeps a damaged organization visible when its default team is missing", async () => {
    const created = await request("/v1/organizations", {
      method: "POST",
      body: { name: "Needs Repair" },
    });
    const organization = (await created.json()) as {
      organization: { id: string };
    };
    const orgId = organization.organization.id;
    const invite = await request(`/v1/organizations/${orgId}/invitations`, {
      method: "POST",
      body: { email: member.email, role: "member" },
    });
    const invitation = (await invite.json()) as {
      invitation: { token: string };
    };
    await pool.query(`DELETE FROM teams WHERE org_id = $1`, [orgId]);

    const me = (await (await request("/v1/me")).json()) as {
      organizations: Array<{ id: string; defaultTeamId: string | null }>;
    };
    expect(me.organizations).toContainEqual(
      expect.objectContaining({ id: orgId, defaultTeamId: null }),
    );

    const detail = await request(`/v1/organizations/${orgId}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      organization: { id: orgId, defaultTeamId: null },
    });

    const updated = await request(`/v1/organizations/${orgId}`, {
      method: "PATCH",
      body: { name: "Still Visible" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      organization: { id: orgId, name: "Still Visible", defaultTeamId: null },
    });

    actor = member;
    try {
      const accepted = await request("/v1/invitations/accept", {
        method: "POST",
        body: { token: invitation.invitation.token },
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toMatchObject({
        organization: { id: orgId, defaultTeamId: null },
      });
    } finally {
      actor = owner;
    }
  });

  it("keeps /v1/teams as an organization-id compatibility alias", async () => {
    const me = (await (await request("/v1/me")).json()) as {
      organizations: Array<{ id: string; isPersonal: boolean }>;
    };
    const org = me.organizations.find((item) => !item.isPersonal)!;
    const response = await request(`/v1/teams/${org.id}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      team: { id: org.id },
    });
  });

  it("refuses organization deletion until every cloud workspace is deleted", async () => {
    const created = await request("/v1/organizations", {
      method: "POST",
      body: { name: "Cloud Retention" },
    });
    const body = (await created.json()) as {
      organization: { id: string; defaultTeamId: string };
    };
    const workspaceId = randomUUID();
    await pool.query(
      `WITH workspace AS (
         INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision
         ) VALUES ($1, $2, $3, $4, 'Retained workspace',
                   'github', 'withso', 'zeros', 'main')
         RETURNING id, org_id
       )
       INSERT INTO cloud_workspace_generations (
         workspace_id, generation, org_id, provider, image_ref,
         architecture, cpu_millicores, memory_mib, storage_mib, created_by
       )
       SELECT id, 1, org_id, 'daytona', 'zeros:test', 'linux/amd64',
              1000, 2048, 10240, $4
       FROM workspace`,
      [
        workspaceId,
        body.organization.id,
        body.organization.defaultTeamId,
        owner.id,
      ],
    );

    const deleted = await request(
      `/v1/organizations/${body.organization.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(409);
    await expect(deleted.json()).resolves.toMatchObject({
      error: { code: "organization_has_cloud_workspaces" },
    });
    const organization = await pool.query(
      `SELECT deleted_at FROM organizations WHERE id = $1`,
      [body.organization.id],
    );
    expect(organization.rows[0]?.deleted_at).toBeNull();
  });

  it("soft-deletes a collaborative organization atomically without exposing it through RLS", async () => {
    const created = await request("/v1/organizations", {
      method: "POST",
      body: { name: "Temporary" },
    });
    const body = (await created.json()) as { organization: { id: string } };
    const deleted = await request(`/v1/organizations/${body.organization.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    const me = (await (await request("/v1/me")).json()) as {
      organizations: Array<{ id: string }>;
    };
    expect(me.organizations.some((item) => item.id === body.organization.id)).toBe(
      false,
    );
    const audit = await pool.query(
      `SELECT 1 FROM audit_log
       WHERE org_id = $1 AND action = 'organization.deleted'`,
      [body.organization.id],
    );
    expect(audit.rowCount).toBe(1);
  });
});
