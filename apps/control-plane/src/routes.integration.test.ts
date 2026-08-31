import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { ensureUser, type AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import { withSystemTx } from "./db.js";
import { runMigrations } from "./migrate.js";
import { createRoutes } from "./routes.js";
import type { WorkOSInvitationRecord } from "./workos-provider.js";
import {
  seedCanonicalCloudWorkspaceAuthority,
  seedCanonicalCloudWorkspacePrerequisites,
} from "./cloud-workspaces/test-fixtures.js";

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
    app.route(
      "/",
      createRoutes(pool, undefined, null, {
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
    const nativeOwner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_native_owner_${suffix}`,
      email: `native-owner-${suffix}@example.com`,
      displayName: "Native Owner",
    });
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
      createRoutes(pool, undefined, null, {
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
    const workosOwner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_owner_${suffix}`,
      email: `workos-owner-${suffix}@example.com`,
      displayName: "WorkOS Owner",
    });
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
      createRoutes(pool, undefined, null, {
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

  it("revokes a pending local rejoin token when removing a member during Auth0 rollback", async () => {
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

  it("refuses organization deletion until every cloud workspace is deleted", async () => {
    const created = await request("/v1/organizations", {
      method: "POST",
      body: { name: "Cloud Retention" },
    });
    const body = (await created.json()) as {
      organization: { id: string; defaultTeamId: string };
    };
    const workspaceId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      const prerequisite = await seedCanonicalCloudWorkspacePrerequisites(tx, {
        organizationId: body.organization.id,
        ownerUserId: owner.id,
      });
      await tx.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, repository_id, owner_user_id, assignee_user_id
         ) VALUES ($1, $2, $3, $4, 'Retained workspace',
                   'github.com', 'withso', 'zeros', 'main', $5, $4, $4)`,
        [
          workspaceId,
          body.organization.id,
          body.organization.defaultTeamId,
          owner.id,
          prerequisite.repositoryId,
        ],
      );
      await seedCanonicalCloudWorkspaceAuthority(tx, {
        workspaceId,
        organizationId: body.organization.id,
        ownerUserId: owner.id,
      });
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib, created_by,
           provider_connection_id
         ) VALUES ($1, 1, $2, 'daytona', 'zeros:test', 'linux/amd64',
                   1000, 2048, 10240, $3, $4)`,
        [
          workspaceId,
          body.organization.id,
          owner.id,
          prerequisite.providerConnectionId,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider
         ) VALUES ($1, 1, $2, 'daytona')`,
        [workspaceId, body.organization.id],
      );
    });

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
