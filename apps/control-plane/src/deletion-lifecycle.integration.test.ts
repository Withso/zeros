import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureUser, type AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import {
  createDeletionLifecycleRoutes,
  DeletionLifecycleProcessor,
} from "./deletion-lifecycle.js";
import { runMigrations } from "./migrate.js";
import { createOpsRoutes } from "./ops.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

type DeletionResponse = {
  deletion: {
    id: string;
    recoveryCode: string;
    state: string;
    targetKind: "account" | "organization";
    targetId: string;
  };
};

d("account, organization, and operator deletion lifecycle", () => {
  let pool: pg.Pool;
  let actor: AuthedUser;
  let app: Hono;

  const signup = (name: string) => {
    const suffix = randomUUID().replaceAll("-", "");
    const now = Math.floor(Date.now() / 1_000);
    return ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${suffix}`,
      email: `${name.toLowerCase()}-${suffix}@example.test`,
      displayName: name,
      session: {
        id: `session_${suffix}`,
        clientKind: "web",
        authTime: now,
        tokenExpiresAt: now + 3_600,
      },
    });
  };

  const asActor = (user: AuthedUser) => {
    actor = user;
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

  const createOrganization = async (
    owner: AuthedUser,
    name: string,
  ): Promise<string> => {
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`;
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (
         slug, name, created_by, is_personal, cloud_workspaces_allowed
       ) VALUES ($1, $2, $3, false, true)
       RETURNING id`,
      [slug, name, owner.id],
    );
    const organizationId = organization.rows[0]!.id;
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [organizationId, owner.id],
    );
    const team = await pool.query<{ id: string }>(
      `INSERT INTO teams (org_id, slug, name, is_default, created_by)
       VALUES ($1, 'default', 'Default', true, $2)
       RETURNING id`,
      [organizationId, owner.id],
    );
    await pool.query(
      `INSERT INTO team_members (team_id, org_id, user_id, role)
       VALUES ($1, $2, $3, 'maintainer')`,
      [team.rows[0]!.id, organizationId, owner.id],
    );
    return organizationId;
  };

  const addOrganizationMember = async (
    organizationId: string,
    user: AuthedUser,
    role: "owner" | "admin" | "member",
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [organizationId, user.id, role],
    );
    await pool.query(
      `INSERT INTO team_members (team_id, org_id, user_id, role)
       SELECT id, org_id, $2,
              CASE WHEN $3::organization_role IN ('owner', 'admin')
                   THEN 'maintainer'::team_role ELSE 'member'::team_role END
       FROM teams WHERE org_id = $1 AND is_default AND deleted_at IS NULL`,
      [organizationId, user.id, role],
    );
  };

  const scheduleAccount = async (user: AuthedUser) => {
    asActor(user);
    const response = await request("/v1/account/deletion", {
      method: "POST",
      body: { confirmation: "DELETE MY ACCOUNT" },
    });
    const body = (await response.json()) as DeletionResponse;
    return { response, body };
  };

  const makeDue = (requestId: string) =>
    pool.query(
      `UPDATE deletion_requests
       SET requested_at = requested_at - interval '31 days',
           purge_after = purge_after - interval '31 days',
           next_attempt_at = now()
       WHERE id = $1`,
      [requestId],
    );

  const succeedPurgeCommand = async (requestId: string) => {
    const request = await pool.query<{ purge_command_id: string | null }>(
      `SELECT purge_command_id FROM deletion_requests WHERE id = $1`,
      [requestId],
    );
    const commandId = request.rows[0]!.purge_command_id;
    expect(commandId).not.toBeNull();
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now(),
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1`,
      [commandId],
    );
    await pool.query(
      `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
      [requestId],
    );
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    actor = await signup("Bootstrap");

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", actor);
      await next();
    });
    app.route("/", createDeletionLifecycleRoutes(pool));
    app.route("/", createOpsRoutes(pool, "alpha"));
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

  it("cascades a sole-member Pro organization and restores the exact account snapshot", async () => {
    const customer = await signup("ProOwner");
    const organizationId = await createOrganization(customer, "Solo Pro");
    const { response, body } = await scheduleAccount(customer);

    expect(response.status).toBe(202);
    expect(body.deletion).toMatchObject({
      state: "scheduled",
      targetKind: "account",
      targetId: customer.id,
    });
    const account = await pool.query<{
      auth_status: string;
      deletion_request_id: string;
    }>(`SELECT auth_status, deletion_request_id FROM users WHERE id = $1`, [
      customer.id,
    ]);
    expect(account.rows[0]).toEqual({
      auth_status: "deletion_pending",
      deletion_request_id: body.deletion.id,
    });
    const organization = await pool.query<{
      lifecycle_status: string;
      parent_request_id: string;
    }>(
      `SELECT o.lifecycle_status, r.parent_request_id
       FROM organizations o
       JOIN deletion_requests r ON r.id = o.deletion_request_id
       WHERE o.id = $1`,
      [organizationId],
    );
    expect(organization.rows[0]).toEqual({
      lifecycle_status: "scheduled",
      parent_request_id: body.deletion.id,
    });
    await expect(
      pool.query(
        `SELECT status FROM auth_sessions
         WHERE user_id = $1 AND status = 'active'`,
        [customer.id],
      ),
    ).resolves.toMatchObject({ rows: [] });

    asActor({ ...customer, accountStatus: "deletion_pending" });
    const restored = await request("/v1/account/deletion/restore", {
      method: "POST",
      body: { requestId: body.deletion.id },
    });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      deletion: { id: body.deletion.id, state: "restored" },
    });
    await expect(
      pool.query(
        `SELECT auth_status, deletion_request_id FROM users WHERE id = $1`,
        [customer.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ auth_status: "active", deletion_request_id: null }],
    });
    await expect(
      pool.query(
        `SELECT lifecycle_status, deletion_request_id
         FROM organizations WHERE id = $1`,
        [organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ lifecycle_status: "active", deletion_request_id: null }],
    });
  });

  it("requires ownership transfer but leaves a shared Business organization active", async () => {
    const departingOwner = await signup("BusinessOwner");
    const secondOwner = await signup("BusinessSuccessor");
    const organizationId = await createOrganization(
      departingOwner,
      "Shared Business",
    );
    await addOrganizationMember(organizationId, secondOwner, "member");

    const blocked = await scheduleAccount(departingOwner);
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({
      error: { code: "ownership_transfer_required" },
    });

    await pool.query(
      `UPDATE organization_members SET role = 'owner'
       WHERE org_id = $1 AND user_id = $2`,
      [organizationId, secondOwner.id],
    );
    const scheduled = await scheduleAccount(departingOwner);
    expect(scheduled.response.status).toBe(202);
    await expect(
      pool.query(
        `SELECT lifecycle_status, deletion_request_id
         FROM organizations WHERE id = $1`,
        [organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ lifecycle_status: "active", deletion_request_id: null }],
    });
    await expect(
      pool.query(
        `SELECT role FROM organization_members
         WHERE org_id = $1 AND user_id = $2`,
        [organizationId, secondOwner.id],
      ),
    ).resolves.toMatchObject({ rows: [{ role: "owner" }] });

    asActor({ ...departingOwner, accountStatus: "deletion_pending" });
    const restored = await request("/v1/account/deletion/restore", {
      method: "POST",
      body: { requestId: scheduled.body.deletion.id },
    });
    expect(restored.status).toBe(200);
  });

  it("waits for WorkOS user deletion before final account erasure and completion notification", async () => {
    const customer = await signup("AccountPurge");
    const originalEmail = customer.email;
    const scheduled = await scheduleAccount(customer);
    expect(scheduled.response.status).toBe(202);
    const requestId = scheduled.body.deletion.id;
    await makeDue(requestId);

    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "test-account-purge",
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT state FROM deletion_requests WHERE id = $1`, [
        requestId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "provider_deleting" }] });
    await expect(
      pool.query(
        `SELECT operation, provider_object_id, state
         FROM workos_command_outbox
         WHERE id = (SELECT purge_command_id FROM deletion_requests WHERE id = $1)`,
        [requestId],
      ),
    ).resolves.toMatchObject({
      rows: [
        expect.objectContaining({ operation: "user.delete", state: "queued" }),
      ],
    });

    await succeedPurgeCommand(requestId);
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT state FROM deletion_requests WHERE id = $1`, [
        requestId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "purged" }] });
    await expect(
      pool.query(
        `SELECT auth_status, email::text, display_name
         FROM users WHERE id = $1`,
        [customer.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          auth_status: "deleted",
          email: expect.stringMatching(/^deleted\+[a-f0-9]+@deleted\.invalid$/),
          display_name: null,
        },
      ],
    });
    await expect(
      pool.query(`SELECT 1 FROM user_identities WHERE user_id = $1`, [
        customer.id,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query(
        `SELECT destination_email::text, user_id
         FROM security_notification_outbox
         WHERE template = 'account_deletion_completed'
           AND destination_email = $1`,
        [originalEmail],
      ),
    ).resolves.toMatchObject({
      rows: [{ destination_email: originalEmail, user_id: null }],
    });
  });

  it("rejects cloud workspace ownership by permanent local-only Personal organizations at the database boundary", async () => {
    const customer = await signup("PersonalInvariant");
    const personal = await pool.query<{ org_id: string; team_id: string }>(
      `SELECT o.id AS org_id, t.id AS team_id
       FROM organizations o
       JOIN teams t ON t.org_id = o.id AND t.is_default
       WHERE o.created_by = $1 AND o.is_personal`,
      [customer.id],
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(
        client.query(
          `INSERT INTO cloud_workspaces (
             id, org_id, team_id, created_by, display_name,
             repository_forge, repository_owner, repository_name,
             repository_revision, status, desired_state
           ) VALUES ($1, $2, $3, $4, 'Impossible Personal Cloud',
                     'github.com', 'withso', 'zeros', 'main',
                     'requested', 'running')`,
          [
            randomUUID(),
            personal.rows[0]!.org_id,
            personal.rows[0]!.team_id,
            customer.id,
          ],
        ),
      ).rejects.toThrow(/Personal organizations are local-only/i);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("keeps organization Personal classification immutable", async () => {
    const customer = await signup("PersonalClassification");
    const personal = await pool.query<{ id: string }>(
      `SELECT id FROM organizations
       WHERE created_by = $1 AND is_personal`,
      [customer.id],
    );
    const collaborativeId = await createOrganization(
      customer,
      "Classification Company",
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(
        client.query(
          `UPDATE organizations SET is_personal = false WHERE id = $1`,
          [personal.rows[0]!.id],
        ),
      ).rejects.toThrow(/Personal classification is immutable/i);
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await expect(
        client.query(
          `UPDATE organizations SET is_personal = true WHERE id = $1`,
          [collaborativeId],
        ),
      ).rejects.toThrow(/Personal classification is immutable/i);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("fails closed before WorkOS erasure when a legacy Personal cloud-workspace invariant is violated", async () => {
    const customer = await signup("LegacyPersonalInvariant");
    const personal = await pool.query<{ org_id: string; team_id: string }>(
      `SELECT o.id AS org_id, t.id AS team_id
       FROM organizations o
       JOIN teams t ON t.org_id = o.id AND t.is_default
       WHERE o.created_by = $1 AND o.is_personal`,
      [customer.id],
    );
    const workspaceId = randomUUID();
    // Model data that predates the database invariant. The bypass is local to
    // this transaction/session, so concurrent integration workers can never
    // observe a table-wide disabled trigger.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, status, desired_state
         ) VALUES ($1, $2, $3, $4, 'Legacy Personal Cloud',
                   'github.com', 'withso', 'zeros', 'main',
                   'requested', 'running')`,
        [
          workspaceId,
          personal.rows[0]!.org_id,
          personal.rows[0]!.team_id,
          customer.id,
        ],
      );
      await client.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by
         ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3, $4)`,
        [workspaceId, personal.rows[0]!.org_id, "a".repeat(40), customer.id],
      );
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    const scheduled = await scheduleAccount(customer);
    expect(scheduled.response.status).toBe(202);
    await makeDue(scheduled.body.deletion.id);
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "test-personal-cloud-invariant",
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(
        `SELECT state, last_error_code
         FROM deletion_requests WHERE id = $1`,
        [scheduled.body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "failed",
          last_error_code: "personal_cloud_workspace_invariant_violation",
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM workos_command_outbox
         WHERE operation = 'user.delete' AND user_id = $1`,
        [customer.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("waits for WorkOS organization deletion before erasing tenant data", async () => {
    const owner = await signup("OrgPurge");
    const member = await signup("OrgMember");
    const organizationId = await createOrganization(owner, "Purge Company");
    await addOrganizationMember(organizationId, member, "member");
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, workos_organization_id, external_id, state
       ) VALUES ($1::uuid, $2, $1::uuid::text, 'active')`,
      [organizationId, `org_${randomUUID().replaceAll("-", "")}`],
    );

    asActor(owner);
    const scheduled = await request(`/v1/organizations/${organizationId}`, {
      method: "DELETE",
      body: { confirmation: "Purge Company" },
    });
    expect(scheduled.status).toBe(202);
    const body = (await scheduled.json()) as DeletionResponse;
    await makeDue(body.deletion.id);
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "test-organization-purge",
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(
        `SELECT operation, state
         FROM workos_command_outbox
         WHERE id = (SELECT purge_command_id FROM deletion_requests WHERE id = $1)`,
        [body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ operation: "organization.delete", state: "queued" }],
    });
    await succeedPurgeCommand(body.deletion.id);
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT 1 FROM organizations WHERE id = $1`, [organizationId]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM security_notification_outbox
         WHERE template = 'organization_deletion_completed'
           AND destination_email IN ($1, $2)`,
        [owner.email, member.email],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });

  it("requires exact-case owner grants and two people for Business recovery and forced purge", async () => {
    const customer = await signup("OpsCustomer");
    const coworker = await signup("OpsCoworker");
    const owner = await signup("PlatformOwner");
    const developer = await signup("Developer");
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [owner.id],
    );
    await pool.query(
      `UPDATE users SET staff_role = 'developer' WHERE id = $1`,
      [developer.id],
    );
    const organizationId = await createOrganization(customer, "Ops Business");
    await addOrganizationMember(organizationId, coworker, "member");

    asActor(customer);
    const scheduled = await request(`/v1/organizations/${organizationId}`, {
      method: "DELETE",
      body: { confirmation: "Ops Business" },
    });
    const body = (await scheduled.json()) as DeletionResponse;
    const code = body.deletion.recoveryCode;
    const supportCaseReference = "CASE-OPS-1001";
    const verified = {
      supportCaseReference,
      ownershipVerification: "confirmed_out_of_band",
    };

    asActor({ ...owner, staffRole: "platform_owner" });
    const lookup = await request(`/v1/ops/deletions/${code}/lookup`, {
      method: "POST",
      body: verified,
    });
    expect(lookup.status).toBe(200);
    await expect(lookup.json()).resolves.toMatchObject({
      target: { businessOrganization: true, name: "Ops Business" },
    });
    const ownerRestore = await request(`/v1/ops/deletions/${code}/restore`, {
      method: "POST",
      body: verified,
    });
    expect(ownerRestore.status).toBe(409);
    await expect(ownerRestore.json()).resolves.toMatchObject({
      error: { code: "two_person_approval_required" },
    });
    const grantResponse = await request(`/v1/ops/deletions/${code}/grants`, {
      method: "POST",
      body: {
        ...verified,
        granteeUserId: developer.id,
        capability: "deletion.restore",
        expiresInMinutes: 15,
      },
    });
    expect(grantResponse.status).toBe(201);
    const grant = (await grantResponse.json()) as { grant: { id: string } };

    asActor({ ...developer, staffRole: "developer" });
    const wrongCaseLookup = await request(`/v1/ops/deletions/${code}/lookup`, {
      method: "POST",
      body: { ...verified, supportCaseReference: "CASE-WRONG-1001" },
    });
    expect(wrongCaseLookup.status).toBe(404);
    const restored = await request(`/v1/ops/deletions/${code}/restore`, {
      method: "POST",
      body: { ...verified, grantId: grant.grant.id },
    });
    expect(restored.status).toBe(200);
    await expect(
      pool.query(`SELECT used_at FROM staff_operation_grants WHERE id = $1`, [
        grant.grant.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ used_at: expect.any(Date) }] });

    // A grant is a one-shot approval, including when the downstream state
    // transition fails after authorization. Burning it first prevents a
    // partial-success/retry path from replaying destructive authority.
    const failureOrganizationId = await createOrganization(
      customer,
      "Grant Failure",
    );
    asActor(customer);
    const failureScheduled = await request(
      `/v1/organizations/${failureOrganizationId}`,
      {
        method: "DELETE",
        body: { confirmation: "Grant Failure" },
      },
    );
    const failureBody = (await failureScheduled.json()) as DeletionResponse;
    const failureVerified = {
      supportCaseReference: "CASE-OPS-1003",
      ownershipVerification: "confirmed_out_of_band",
    };
    asActor({ ...owner, staffRole: "platform_owner" });
    const failureGrantResponse = await request(
      `/v1/ops/deletions/${failureBody.deletion.recoveryCode}/grants`,
      {
        method: "POST",
        body: {
          ...failureVerified,
          granteeUserId: developer.id,
          capability: "deletion.restore",
          expiresInMinutes: 15,
        },
      },
    );
    const failureGrant = (await failureGrantResponse.json()) as {
      grant: { id: string };
    };
    await pool.query(
      `UPDATE deletion_requests
       SET state = 'failed', purge_started_at = now()
       WHERE id = $1`,
      [failureBody.deletion.id],
    );
    asActor({ ...developer, staffRole: "developer" });
    const failedRestore = await request(
      `/v1/ops/deletions/${failureBody.deletion.recoveryCode}/restore`,
      {
        method: "POST",
        body: { ...failureVerified, grantId: failureGrant.grant.id },
      },
    );
    expect(failedRestore.status).toBe(409);
    await expect(failedRestore.json()).resolves.toMatchObject({
      error: { code: "deletion_not_recoverable" },
    });
    await expect(
      pool.query(`SELECT used_at FROM staff_operation_grants WHERE id = $1`, [
        failureGrant.grant.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ used_at: expect.any(Date) }] });

    asActor(customer);
    const forceScheduled = await request(
      `/v1/organizations/${organizationId}`,
      {
        method: "DELETE",
        body: { confirmation: "Ops Business" },
      },
    );
    const forceBody = (await forceScheduled.json()) as DeletionResponse;
    const forceCode = forceBody.deletion.recoveryCode;
    const forceCase = "CASE-OPS-1002";
    const forceVerified = {
      supportCaseReference: forceCase,
      ownershipVerification: "confirmed_out_of_band",
    };
    asActor({ ...owner, staffRole: "platform_owner" });
    const ownerForce = await request(
      `/v1/ops/deletions/${forceCode}/force-purge`,
      {
        method: "POST",
        body: {
          ...forceVerified,
          confirmation: `FORCE PURGE ${forceCode}`,
        },
      },
    );
    expect(ownerForce.status).toBe(409);
    const forceGrantResponse = await request(
      `/v1/ops/deletions/${forceCode}/grants`,
      {
        method: "POST",
        body: {
          ...forceVerified,
          granteeUserId: developer.id,
          capability: "deletion.force_purge",
          expiresInMinutes: 15,
        },
      },
    );
    const forceGrant = (await forceGrantResponse.json()) as {
      grant: { id: string };
    };
    asActor({ ...developer, staffRole: "developer" });
    const purging = await request(
      `/v1/ops/deletions/${forceCode}/force-purge`,
      {
        method: "POST",
        body: {
          ...forceVerified,
          grantId: forceGrant.grant.id,
          confirmation: `FORCE PURGE ${forceCode}`,
        },
      },
    );
    expect(purging.status).toBe(202);
    await expect(purging.json()).resolves.toMatchObject({
      deletion: { state: "purging" },
    });
  });
});
