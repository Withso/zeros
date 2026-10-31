import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { ensureUser, type AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import { withSystemTx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { grantTestPro } from "./test-pro.js";
import { createRoutes } from "./routes.js";
import { createDeletionLifecycleRoutes } from "./deletion-lifecycle.js";
import type { WorkOSInvitationRecord } from "./workos-provider.js";

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
      provider: "workos",
      providerSubject: sub,
      email: `${name.toLowerCase()}-${sub}@example.com`,
      displayName: name,
      session: {
        id: `session_${sub}`,
        clientKind: "web",
        authTime: Math.floor(Date.now() / 1_000),
        tokenExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      },
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
    await resetMigratedTestDatabase(pool);
    owner = { ...(await signup("Ada")), staffRole: "platform_owner" };
    await grantTestPro(pool, owner.id);
    member = await signup("Grace");
    actor = owner;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", actor);
      await next();
    });
    app.route("/", createDeletionLifecycleRoutes(pool));
    app.route(
      "/",
      createRoutes(pool, undefined, {
        inviteLinkBase: "https://app-alpha.zeros.build/invite",
      }),
    );
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
      capabilities: { createOrganization: boolean; pro: boolean };
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
    expect(body.capabilities).toEqual({ createOrganization: true, pro: true });
    expect(body.organizations[0]).toMatchObject({
      name: "Ada",
      isPersonal: true,
      workspaceCapabilities: { local: true, cloud: false },
    });
    expect(body.organizations[0]!.defaultTeamId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("requires Pro on both organization-create routes, where support staff get none", async () => {
    await pool.query("UPDATE users SET staff_role = 'support_admin' WHERE id = $1", [member.id]);
    actor = { ...member, staffRole: "support_admin" };
    try {
      const me = await request("/v1/me");
      await expect(me.json()).resolves.toMatchObject({
        capabilities: { createOrganization: false, pro: false },
      });
      for (const path of ["/v1/organizations", "/v1/teams"]) {
        const response = await request(path, {
          method: "POST",
          body: { name: "Must not exist" },
        });
        expect(response.status, path).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "pro_required" },
        });
      }
    } finally {
      await pool.query("UPDATE users SET staff_role = NULL WHERE id = $1", [member.id]);
      actor = owner;
    }
  });

  it("gives platform owners and developers Pro with their role, and takes it away with it", async () => {
    const staff = await signup("Staff");
    actor = staff;
    try {
      for (const role of ["developer", "platform_owner"]) {
        await pool.query("UPDATE users SET staff_role = $2 WHERE id = $1", [staff.id, role]);
        const me = await request("/v1/me");
        await expect(me.json(), role).resolves.toMatchObject({
          capabilities: { createOrganization: true, pro: true },
        });
      }
      const created = await request("/v1/organizations", { method: "POST", body: { name: "Staff Org" } });
      expect(created.status).toBe(201);
      await pool.query("UPDATE users SET staff_role = NULL WHERE id = $1", [staff.id]);
      await expect((await request("/v1/me")).json()).resolves.toMatchObject({
        capabilities: { createOrganization: false, pro: false },
      });
    } finally {
      actor = owner;
    }
  });

  it("returns every membership in stable order, including organizations without cloud", async () => {
    const previous = actor;
    const fixtureUser = await signup("Memberships");
    const multiOrganizationFixture = Array.from({ length: 20 }, (_, index) => {
      const number = index + 1;
      const prefix = String(number).padStart(8, "0");
      return {
        id: `${prefix}-1111-4111-8111-111111111111`,
        slug: `membership-${number}`,
        name: `Membership ${String(number).padStart(2, "0")}`,
        logo: null,
        role: "member",
        isPersonal: false,
        defaultTeamId: `${prefix}-2222-4222-8222-222222222222`,
        workspaceCapabilities: { local: false, cloud: index !== 2 },
        seat: "free",
        teamCapabilities: { multiple: false, canCreate: false },
      };
    });
    try {
      await withSystemTx(pool, async tx => {
        for (const [index, org] of multiOrganizationFixture.entries()) {
          await tx.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed, created_at)
            VALUES ($1, $2, $3, $4, false, $5, $6)`,
          [org.id, org.slug, org.name, fixtureUser.id, org.workspaceCapabilities.cloud, new Date(Date.UTC(2026, 0, 1, 0, index))]);
          await tx.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)`, [org.id, fixtureUser.id, org.role]);
          await tx.query(`INSERT INTO teams (id, org_id, slug, name, is_default, created_by) VALUES ($1, $2, 'default', 'Default', true, $3)`,
            [org.defaultTeamId, org.id, fixtureUser.id]);
        }
      });
      actor = fixtureUser;
      const response = await request("/v1/me");
      expect(response.status).toBe(200);
      const body = await response.json() as { organizations: Array<{ isPersonal: boolean }>; teams: unknown[] };
      expect(body.organizations.filter(org => !org.isPersonal)).toEqual(multiOrganizationFixture);
      expect(body.teams).toEqual(body.organizations);
    } finally { actor = previous; }
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
      workspaceCapabilities: { local: false, cloud: true },
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
    const revisionBefore = await pool.query<{
      authorization_revision: string | number;
      data_revision: string | number;
    }>(
      `SELECT authorization_revision, data_revision
       FROM organizations WHERE id = $1`,
      [org.id],
    );
    const invite = await request(`/v1/organizations/${org.id}/invitations`, {
      method: "POST",
      body: { email: member.email, role: "member" },
    });
    expect(invite.status).toBe(201);
    const invitation = (await invite.json()) as {
      invitation: { token: string; acceptUrl: string };
    };
    expect(invitation.invitation.acceptUrl).toBe(
      `https://app-alpha.zeros.build/invite?token=${encodeURIComponent(invitation.invitation.token)}`,
    );
    const revisionAfterInvite = await pool.query<{
      data_revision: string | number;
    }>(`SELECT data_revision FROM organizations WHERE id = $1`, [org.id]);
    expect(Number(revisionAfterInvite.rows[0]?.data_revision)).toBe(
      Number(revisionBefore.rows[0]?.data_revision) + 1,
    );
    const inviteEvent = await pool.query<{
      data_revision: string | number | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT data_revision, payload FROM security_events
       WHERE org_id = $1 AND kind = 'organization.data_changed'
       ORDER BY sequence DESC LIMIT 1`,
      [org.id],
    );
    expect(inviteEvent.rows[0]).toMatchObject({
      data_revision: revisionAfterInvite.rows[0]!.data_revision,
      payload: { reason: "zeros_invitation_created" },
    });

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
    const revisionAfter = await pool.query<{
      authorization_revision: string | number;
    }>(
      `SELECT authorization_revision FROM organizations WHERE id = $1`,
      [org.id],
    );
    expect(Number(revisionAfter.rows[0]?.authorization_revision)).toBe(
      Number(revisionBefore.rows[0]?.authorization_revision) + 1,
    );
    const event = await pool.query<{
      kind: string;
      user_id: string | null;
      authorization_revision: string | number | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT kind, user_id, authorization_revision, payload
       FROM security_events
       WHERE org_id = $1 AND kind = 'organization.authorization_changed'
       ORDER BY sequence DESC LIMIT 1`,
      [org.id],
    );
    expect(event.rows[0]).toMatchObject({
      kind: "organization.authorization_changed",
      user_id: member.id,
      authorization_revision:
        revisionAfter.rows[0]!.authorization_revision,
      payload: { reason: "zeros_member_joined" },
    });
    actor = owner;
  });

  it("accepts only an exact locally-correlated WorkOS native invitation", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const nativeOwner = {
      ...(await ensureUser(pool, {
        provider: "workos",
        providerSubject: `user_native_owner_${suffix}`,
        email: `native-owner-${suffix}@example.com`,
        displayName: "Native Owner",
      })),
      staffRole: "developer" as const,
    };
    await grantTestPro(pool, nativeOwner.id);
    const nativeMember = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_native_member_${suffix}`,
      email: `native-member-${suffix}@example.com`,
      displayName: "Native Member",
    });
    const raceMember = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_native_race_${suffix}`,
      email: `native-race-${suffix}@example.com`,
      displayName: "Native Race Member",
    });
    const workosOrganizationId = `org_native_${suffix}`;
    const providerToken = `native_${"A".repeat(36)}`;
    const manualToken = `manual_${"B".repeat(36)}`;
    const unavailableToken = `outage_${"C".repeat(36)}`;
    const raceToken = `race_${"D".repeat(38)}`;
    const records = new Map<string, WorkOSInvitationRecord>();
    let getInvitationUnavailable = false;
    const invitationNotFound = () => {
      const missing = new Error("Invitation not found") as Error & {
        status: number;
      };
      missing.status = 404;
      return missing;
    };
    const provider = {
      getInvitation: vi.fn(async (invitationId: string) => {
        if (getInvitationUnavailable) {
          const unavailable = new Error("WorkOS unavailable") as Error & {
            status: number;
          };
          unavailable.status = 503;
          throw unavailable;
        }
        const record = [...records.values()].find(
          (candidate) => candidate.id === invitationId,
        );
        if (record) return record;
        throw invitationNotFound();
      }),
      findInvitationByToken: vi.fn(async (token: string) => {
        if (token === unavailableToken) {
          const unavailable = new Error("WorkOS unavailable") as Error & {
            status: number;
          };
          unavailable.status = 503;
          throw unavailable;
        }
        const record = records.get(token);
        if (record) return record;
        throw invitationNotFound();
      }),
    };
    let nativeActor = nativeOwner;
    const nativeApp = new Hono();
    nativeApp.use("*", async (c, next) => {
      c.set("user", nativeActor);
      await next();
    });
    nativeApp.route(
      "/",
      createRoutes(pool, undefined, {
        workosEnabled: true,
        workosProvider: provider,
        inviteLinkBase: "https://app-alpha.zeros.build/invite",
      }),
    );
    nativeApp.onError((error, c) => {
      if (error instanceof HttpError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }
      throw error;
    });
    const nativeRequest = (
      path: string,
      init?: { method?: string; body?: Record<string, unknown> },
    ) =>
      nativeApp.request(path, {
        method: init?.method ?? "GET",
        headers: init?.body
          ? { "content-type": "application/json" }
          : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });

    const created = await nativeRequest("/v1/organizations", {
      method: "POST",
      body: { name: `Native invitations ${suffix}` },
    });
    expect(created.status).toBe(201);
    const organizationId = (
      (await created.json()) as { organization: { id: string } }
    ).organization.id;
    await pool.query(
      `UPDATE workos_organization_links
       SET workos_organization_id = $2, state = 'active'
       WHERE organization_id = $1`,
      [organizationId, workosOrganizationId],
    );

    const invited = await nativeRequest(
      `/v1/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        body: { email: nativeMember.email, role: "member" },
      },
    );
    expect(invited.status).toBe(201);
    const localInvitation = (
      (await invited.json()) as {
        invitation: { id: string; acceptUrl: string };
      }
    ).invitation;
    const localInvitationId = localInvitation.id;
    const localToken = new URL(localInvitation.acceptUrl).searchParams.get(
      "token",
    )!;
    const providerInvitationId = `inv_native_${suffix}`;
    await pool.query(
      `UPDATE invitations
       SET workos_invitation_id = $2, invitation_source = 'workos'
       WHERE id = $1`,
      [localInvitationId, providerInvitationId],
    );
    records.set(providerToken, {
      id: providerInvitationId,
      organizationId: workosOrganizationId,
      email: nativeMember.email,
      state: "pending",
      roleSlug: "member",
      updatedAt: new Date().toISOString(),
    });

    const wrongAccount = await nativeRequest("/v1/invitations/accept", {
      method: "POST",
      body: { token: providerToken },
    });
    expect(wrongAccount.status).toBe(403);
    await expect(wrongAccount.json()).resolves.toMatchObject({
      error: { code: "wrong_account" },
    });

    nativeActor = nativeMember;
    getInvitationUnavailable = true;
    const copiedLinkProviderUnavailable = await nativeRequest(
      "/v1/invitations/accept",
      {
        method: "POST",
        body: { token: localToken },
      },
    );
    expect(copiedLinkProviderUnavailable.status).toBe(503);
    await expect(copiedLinkProviderUnavailable.json()).resolves.toMatchObject({
      error: { code: "auth_unavailable" },
    });
    getInvitationUnavailable = false;
    records.set(providerToken, {
      ...records.get(providerToken)!,
      state: "revoked",
    });
    const copiedLinkProviderRevoked = await nativeRequest(
      "/v1/invitations/accept",
      {
        method: "POST",
        body: { token: localToken },
      },
    );
    expect(copiedLinkProviderRevoked.status).toBe(404);
    expect(provider.getInvitation).toHaveBeenCalledWith(providerInvitationId);
    const providerRevoked = await nativeRequest("/v1/invitations/accept", {
      method: "POST",
      body: { token: providerToken },
    });
    expect(providerRevoked.status).toBe(404);
    records.set(providerToken, {
      ...records.get(providerToken)!,
      state: "pending",
      email: nativeOwner.email,
    });
    const providerRecipientMismatch = await nativeRequest(
      "/v1/invitations/accept",
      {
        method: "POST",
        body: { token: providerToken },
      },
    );
    expect(providerRecipientMismatch.status).toBe(404);
    records.set(providerToken, {
      ...records.get(providerToken)!,
      email: nativeMember.email,
    });
    const accepted = await nativeRequest("/v1/invitations/accept", {
      method: "POST",
      body: { token: providerToken },
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      organization: { id: organizationId },
    });

    nativeActor = nativeOwner;
    const racingInvite = await nativeRequest(
      `/v1/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        body: { email: raceMember.email, role: "member" },
      },
    );
    expect(racingInvite.status).toBe(201);
    const racingInvitation = (
      (await racingInvite.json()) as {
        invitation: { id: string; acceptUrl: string };
      }
    ).invitation;
    const racingInvitationId = racingInvitation.id;
    const racingLocalToken = new URL(
      racingInvitation.acceptUrl,
    ).searchParams.get("token")!;
    nativeActor = raceMember;
    const copiedLinkPreparing = await nativeRequest(
      "/v1/invitations/accept",
      {
        method: "POST",
        body: { token: racingLocalToken },
      },
    );
    expect(copiedLinkPreparing.status).toBe(503);
    await expect(copiedLinkPreparing.json()).resolves.toMatchObject({
      error: { code: "invite_preparing" },
    });
    records.set(raceToken, {
      id: `inv_race_${suffix}`,
      organizationId: workosOrganizationId,
      email: raceMember.email,
      state: "pending",
      roleSlug: "member",
      updatedAt: new Date().toISOString(),
    });
    const preparing = await nativeRequest("/v1/invitations/accept", {
      method: "POST",
      body: { token: raceToken },
    });
    expect(preparing.status).toBe(503);
    await expect(preparing.json()).resolves.toMatchObject({
      error: { code: "invite_preparing" },
    });
    const stillPending = await pool.query<{ accepted_at: Date | null }>(
      `SELECT accepted_at FROM invitations WHERE id = $1`,
      [racingInvitationId],
    );
    expect(stillPending.rows[0]?.accepted_at).toBeNull();

    records.set(manualToken, {
      id: `inv_manual_${suffix}`,
      organizationId: workosOrganizationId,
      email: nativeMember.email,
      state: "pending",
      roleSlug: "member",
      updatedAt: new Date().toISOString(),
    });
    const manual = await nativeRequest("/v1/invitations/accept", {
      method: "POST",
      body: { token: manualToken },
    });
    expect(manual.status).toBe(404);
    await expect(manual.json()).resolves.toMatchObject({
      error: { code: "invalid_invite" },
    });

    const unavailable = await nativeRequest("/v1/invitations/accept", {
      method: "POST",
      body: { token: unavailableToken },
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: "auth_unavailable" },
    });
    expect(provider.findInvitationByToken).toHaveBeenCalledWith(providerToken);
  });

  it("serializes provider invitation cleanup before membership creation and removal", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const workosOwner = {
      ...(await ensureUser(pool, {
        provider: "workos",
        providerSubject: `user_owner_${suffix}`,
        email: `workos-owner-${suffix}@example.com`,
        displayName: "WorkOS Owner",
      })),
      staffRole: "developer" as const,
    };
    await grantTestPro(pool, workosOwner.id);
    const workosMember = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_member_${suffix}`,
      email: `workos-member-${suffix}@example.com`,
      displayName: "WorkOS Member",
    });
    let workosActor = workosOwner;
    const workosApp = new Hono();
    workosApp.use("*", async (c, next) => {
      c.set("user", workosActor);
      await next();
    });
    workosApp.route(
      "/",
      createRoutes(pool, undefined, {
        workosEnabled: true,
        inviteLinkBase: "https://app-alpha.zeros.build/invite",
      }),
    );
    workosApp.onError((error, c) => {
      if (error instanceof HttpError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }
      throw error;
    });
    const workosRequest = (
      path: string,
      init?: { method?: string; body?: Record<string, unknown> },
    ) =>
      workosApp.request(path, {
        method: init?.method ?? "GET",
        headers: init?.body
          ? { "content-type": "application/json" }
          : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });

    const created = await workosRequest("/v1/organizations", {
      method: "POST",
      body: { name: `Provider ordering ${suffix}` },
    });
    expect(created.status).toBe(201);
    const organization = (await created.json()) as {
      organization: { id: string };
    };
    const orgId = organization.organization.id;
    const invited = await workosRequest(
      `/v1/organizations/${orgId}/invitations`,
      {
        method: "POST",
        body: { email: workosMember.email, role: "member" },
      },
    );
    expect(invited.status).toBe(201);
    const invitation = (await invited.json()) as {
      invitation: { id: string; token: string };
    };

    workosActor = workosMember;
    const accepted = await workosRequest("/v1/invitations/accept", {
      method: "POST",
      body: { token: invitation.invitation.token },
    });
    expect(accepted.status).toBe(200);
    const acceptedCommands = await pool.query<{
      operation: string;
      aggregate_revision: string | number;
      ordering_key: string;
    }>(
      `SELECT operation, aggregate_revision, ordering_key
       FROM workos_command_outbox
       WHERE aggregate_key IN ($1, $2)
       ORDER BY sequence`,
      [
        `invitation:${invitation.invitation.id}`,
        `membership:${orgId}:${workosMember.id}`,
      ],
    );
    expect(acceptedCommands.rows.map((row) => row.operation)).toEqual([
      "invitation.create",
      "invitation.revoke",
      "membership.create",
    ]);
    expect(
      new Set(acceptedCommands.rows.map((row) => row.ordering_key)).size,
    ).toBe(1);
    const localAccepted = await pool.query<{
      accepted_at: Date | null;
      workos_sync_revision: string | number;
    }>(
      `SELECT accepted_at, workos_sync_revision
       FROM invitations WHERE id = $1`,
      [invitation.invitation.id],
    );
    expect(localAccepted.rows[0]?.accepted_at).not.toBeNull();
    expect(Number(localAccepted.rows[0]?.workos_sync_revision)).toBe(2);

    workosActor = workosOwner;
    const removed = await workosRequest(
      `/v1/organizations/${orgId}/members/${workosMember.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    const allCommands = await pool.query<{
      operation: string;
      aggregate_revision: string | number;
      ordering_key: string;
    }>(
      `SELECT operation, aggregate_revision, ordering_key
       FROM workos_command_outbox
       WHERE aggregate_key IN ($1, $2)
       ORDER BY sequence`,
      [
        `invitation:${invitation.invitation.id}`,
        `membership:${orgId}:${workosMember.id}`,
      ],
    );
    expect(allCommands.rows.map((row) => row.operation)).toEqual([
      "invitation.create",
      "invitation.revoke",
      "membership.create",
      "invitation.revoke",
      "membership.delete",
    ]);
    expect(new Set(allCommands.rows.map((row) => row.ordering_key)).size).toBe(
      1,
    );
    const localRemoved = await pool.query<{
      accepted_at: Date | null;
      revoked_at: Date | null;
      workos_sync_revision: string | number;
    }>(
      `SELECT accepted_at, revoked_at, workos_sync_revision
       FROM invitations WHERE id = $1`,
      [invitation.invitation.id],
    );
    expect(localRemoved.rows[0]?.accepted_at).not.toBeNull();
    expect(localRemoved.rows[0]?.revoked_at).toBeNull();
    expect(Number(localRemoved.rows[0]?.workos_sync_revision)).toBe(3);

    const reinvited = await workosRequest(
      `/v1/organizations/${orgId}/invitations`,
      {
        method: "POST",
        body: { email: workosMember.email, role: "member" },
      },
    );
    expect(reinvited.status).toBe(201);
    const rejoinInvitation = (await reinvited.json()) as {
      invitation: { id: string; token: string };
    };
    workosActor = workosMember;
    const rejoined = await workosRequest("/v1/invitations/accept", {
      method: "POST",
      body: { token: rejoinInvitation.invitation.token },
    });
    expect(rejoined.status).toBe(200);

    const membershipGenerations = await pool.query<{
      operation: string;
      aggregate_revision: string | number;
    }>(
      `SELECT operation, aggregate_revision
       FROM workos_command_outbox
       WHERE aggregate_key = $1
       ORDER BY sequence`,
      [`membership:${orgId}:${workosMember.id}`],
    );
    expect(membershipGenerations.rows).toEqual([
      { operation: "membership.create", aggregate_revision: "1" },
      { operation: "membership.delete", aggregate_revision: "2" },
      { operation: "membership.create", aggregate_revision: "3" },
    ]);
  });

  it("waits for the organization lock before locking an invitation", async () => {
    actor = owner;
    const created = await request("/v1/organizations", {
      method: "POST",
      body: { name: `Invitation lock order ${randomUUID()}` },
    });
    expect(created.status).toBe(201);
    const organization = (await created.json()) as {
      organization: { id: string };
    };
    const orgId = organization.organization.id;
    const invited = await request(`/v1/organizations/${orgId}/invitations`, {
      method: "POST",
      body: { email: member.email, role: "member" },
    });
    expect(invited.status).toBe(201);
    const invitation = (await invited.json()) as {
      invitation: { id: string; token: string };
    };

    const blocker = await pool.connect();
    let accepting: Promise<Response> | null = null;
    let invitationLockError: unknown = null;
    let acceptWasWaiting = false;
    try {
      await blocker.query("BEGIN");
      const blockerPid = (
        await blocker.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;
      await blocker.query(
        `SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`,
        [orgId],
      );
      actor = member;
      accepting = request("/v1/invitations/accept", {
        method: "POST",
        body: { token: invitation.invitation.token },
      });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const activity = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database()
               AND pid <> pg_backend_pid()
               AND state = 'active'
               AND wait_event_type = 'Lock'
               AND $1 = ANY(pg_blocking_pids(pid))
           ) AS waiting`,
          [blockerPid],
        );
        if (activity.rows[0]?.waiting) {
          acceptWasWaiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await blocker.query(`SET LOCAL lock_timeout = '500ms'`);
      try {
        await blocker.query(
          `SELECT 1 FROM invitations WHERE id = $1 FOR UPDATE`,
          [invitation.invitation.id],
        );
      } catch (error) {
        invitationLockError = error;
      }
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
    const accepted = await accepting;
    actor = owner;

    expect(acceptWasWaiting).toBe(true);
    expect(invitationLockError).toBeNull();
    expect(accepted?.status).toBe(200);
  });

  it("does not accept an invitation for a historical profile email", async () => {
    actor = owner;
    const created = await request("/v1/organizations", { method: "POST", body: { name: `Identity check ${randomUUID()}` } });
    const org = (await created.json()).organization.id;
    const invited = await request(`/v1/organizations/${org}/invitations`, { method: "POST", body: { email: member.email } });
    const token = (await invited.json()).invitation.token;
    try {
      for (const verifiedEmail of [undefined, `changed-${randomUUID()}@example.test`]) {
        actor = { ...member, identity: { ...member.identity, verifiedEmail } };
        const result = await request("/v1/invitations/accept", { method: "POST", body: { token } });
        expect(result.status).toBe(403);
      }
      actor = { ...member, identity: { ...member.identity, verifiedEmail: member.email.toUpperCase() } };
      expect((await request("/v1/invitations/accept", { method: "POST", body: { token } })).status).toBe(200);
    } finally { actor = owner; }
  });

  it("rechecks an administrator after waiting behind their demotion", async () => {
    actor = owner;
    const created = await request("/v1/organizations", { method: "POST", body: { name: `Role race ${randomUUID()}` } });
    const org = (await created.json()).organization.id;
    const admin = await signup("Demoted"), target = await signup("Target");
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member')", [org, admin.id, target.id]);
    const blocker = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [org]);
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      actor = admin;
      pending = request(`/v1/organizations/${org}/members/${target.id}`, { method: "PATCH", body: { role: "admin" } });
      await vi.waitFor(async () => {
        const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid]);
        expect(result.rowCount).toBeGreaterThan(0);
      });
      await blocker.query("UPDATE organization_members SET role='member',authorization_revision=authorization_revision+1 WHERE org_id=$1 AND user_id=$2", [org, admin.id]);
      await blocker.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect((await pool.query("SELECT role FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, target.id])).rows[0].role).toBe("member");
    } finally {
      await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); await pending; actor = owner;
    }
  });

  it("revokes a pending local rejoin token when removing a member without WorkOS management", async () => {
    actor = owner;
    const created = await request("/v1/organizations", {
      method: "POST",
      body: { name: `Rollback removal ${randomUUID()}` },
    });
    expect(created.status).toBe(201);
    const organization = (await created.json()) as {
      organization: { id: string };
    };
    const orgId = organization.organization.id;
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [orgId, member.id],
    );

    const invited = await request(`/v1/organizations/${orgId}/invitations`, {
      method: "POST",
      body: { email: member.email, role: "member" },
    });
    expect(invited.status).toBe(201);
    const invitation = (await invited.json()) as {
      invitation: { id: string };
    };

    const removed = await request(
      `/v1/organizations/${orgId}/members/${member.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    const local = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM invitations WHERE id = $1`,
      [invitation.invitation.id],
    );
    expect(local.rows[0]?.revoked_at).not.toBeNull();
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



  it("schedules and restores a collaborative organization without deleting it in WorkOS", async () => {
    const created = await request("/v1/organizations", {
      method: "POST",
      body: { name: "Temporary" },
    });
    const body = (await created.json()) as { organization: { id: string } };
    const deleted = await request(`/v1/organizations/${body.organization.id}`, {
      method: "DELETE",
      body: { confirmation: "Temporary" },
    });
    expect(deleted.status).toBe(202);
    const scheduled = (await deleted.json()) as {
      deletion: { id: string; state: string; purgeAfter: string };
    };
    expect(scheduled.deletion.state).toBe("scheduled");

    const me = (await (await request("/v1/me")).json()) as {
      organizations: Array<{ id: string }>;
    };
    expect(me.organizations.some((item) => item.id === body.organization.id)).toBe(
      false,
    );
    const audit = await pool.query(
      `SELECT 1 FROM audit_log
       WHERE org_id = $1 AND action = 'organization.deletion_scheduled'`,
      [body.organization.id],
    );
    expect(audit.rowCount).toBe(1);

    const providerDelete = await pool.query(
      `SELECT 1 FROM workos_command_outbox
       WHERE organization_id = $1 AND operation = 'organization.delete'`,
      [body.organization.id],
    );
    expect(providerDelete.rowCount).toBe(0);

    const restored = await request(
      `/v1/organizations/${body.organization.id}/restore`,
      {
        method: "POST",
        body: { requestId: scheduled.deletion.id },
      },
    );
    expect(restored.status).toBe(200);
    const meAfterRestore = (await (await request("/v1/me")).json()) as {
      organizations: Array<{ id: string }>;
    };
    expect(
      meAfterRestore.organizations.some(
        (item) => item.id === body.organization.id,
      ),
    ).toBe(true);
  });
});
