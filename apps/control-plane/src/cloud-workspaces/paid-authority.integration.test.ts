import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureUser } from "../auth.js";
import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { applyWorkOSIdentityEvent } from "../workos-events.js";
import { DatabaseCloudWorkspacePaidAuthorityReconciler } from "./paid-authority.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("cloud workspace paid-authority reconciliation", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  it("rolls a valid entitlement revision into a new immutable billing epoch", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE organization_entitlements
         SET revision = revision + 1, updated_at = now()
         WHERE org_id = $1`,
        [fixture.organizationId],
      ),
    );

    const reconciler = new DatabaseCloudWorkspacePaidAuthorityReconciler(pool, {
      workosEnabled: false,
      recheckIntervalMs: 300_000,
    });
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      workspaceId: fixture.workspaceId,
      action: "billing_rebound",
    });

    const state = (
      await pool.query<{
        desired_state: string;
        status: string;
        current_billing_epoch: string;
        paid: boolean;
        engine_state: string;
      }>(
        `SELECT workspace.desired_state, workspace.status,
                workspace.current_billing_epoch::text,
                cloud_workspace_paid_authority_live(
                  workspace.id, workspace.owner_user_id, false
                ) AS paid,
                engine.state AS engine_state
         FROM cloud_workspaces workspace
         JOIN cloud_workspace_engine_instances engine
           ON engine.workspace_id = workspace.id
          AND engine.generation = workspace.current_generation
         WHERE workspace.id = $1`,
        [fixture.workspaceId],
      )
    ).rows[0];
    expect(state).toEqual({
      desired_state: "running",
      status: "ready",
      current_billing_epoch: "2",
      paid: true,
      engine_state: "ready",
    });

    const epochs = await pool.query<{
      billing_epoch: string;
      entitlement_revision: string;
      ended_at: Date | null;
    }>(
      `SELECT billing_epoch::text, entitlement_revision::text, ended_at
       FROM workspace_billing_epochs
       WHERE workspace_id = $1 ORDER BY billing_epoch`,
      [fixture.workspaceId],
    );
    expect(epochs.rows).toMatchObject([
      { billing_epoch: "1", entitlement_revision: "1" },
      { billing_epoch: "2", entitlement_revision: "2", ended_at: null },
    ]);
    expect(epochs.rows[0]!.ended_at).not.toBeNull();
  });

  it("denies runtime authority before an organization entitlement activates", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE organization_entitlements
         SET valid_from = now() + interval '1 hour', updated_at = now()
         WHERE org_id = $1`,
        [fixture.organizationId],
      ),
    );

    const authority = await pool.query<{ paid: boolean; runtime: boolean }>(
      `SELECT cloud_workspace_paid_authority_live($1, $2, false) AS paid,
              cloud_workspace_runtime_authority_live($1, 1, $2, false)
                AS runtime`,
      [fixture.workspaceId, fixture.userId],
    );
    expect(authority.rows[0]).toEqual({ paid: false, runtime: false });
  });

  it("denies Pro runtime authority for a future-dated collaborator entitlement", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE organization_entitlements
         SET plan = 'pro', seat_limit = NULL, revision = revision + 1,
             updated_at = now()
         WHERE org_id = $1`,
        [fixture.organizationId],
      ),
    );
    const reconciler = new DatabaseCloudWorkspacePaidAuthorityReconciler(pool, {
      workosEnabled: false,
      recheckIntervalMs: 300_000,
    });
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      workspaceId: fixture.workspaceId,
      action: "billing_rebound",
    });

    const collaborator = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${randomUUID().replaceAll("-", "")}`,
      email: `future-collaborator-${randomUUID()}@example.test`,
      displayName: "Future Pro Collaborator",
    });
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [fixture.organizationId, collaborator.id],
      );
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'member')`,
        [fixture.teamId, fixture.organizationId, collaborator.id],
      );
      await tx.query(
        `INSERT INTO account_entitlements (
           user_id, plan, status, cloud_workspaces_allowed, source, valid_from
         ) VALUES (
           $1, 'pro', 'active', true, 'operator',
           now() + interval '1 hour'
         )`,
        [collaborator.id],
      );
    });

    const authority = await pool.query<{ paid: boolean; runtime: boolean }>(
      `SELECT cloud_workspace_paid_authority_live($1, $2, false) AS paid,
              cloud_workspace_runtime_authority_live($1, 1, $2, false)
                AS runtime`,
      [fixture.workspaceId, fixture.userId],
    );
    expect(authority.rows[0]).toEqual({ paid: false, runtime: false });
  });

  it("fails closed and queues cleanup for every generation when the owner seat is released", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         )
         SELECT workspace_id, 2, org_id, provider, image_ref, architecture,
                cpu_millicores, memory_mib, storage_mib, source_commit,
                created_by, provider_connection_id
         FROM cloud_workspace_generations
         WHERE workspace_id = $1 AND generation = 1`,
        [fixture.workspaceId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider
         ) VALUES ($1, 2, $2, 'daytona')`,
        [fixture.workspaceId, fixture.organizationId],
      );
      await tx.query(
        `UPDATE organization_seat_assignments
         SET state = 'released', released_at = now(), revision = revision + 1
         WHERE org_id = $1 AND user_id = $2`,
        [fixture.organizationId, fixture.userId],
      );
    });

    const reconciler = new DatabaseCloudWorkspacePaidAuthorityReconciler(pool, {
      workosEnabled: false,
    });
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      workspaceId: fixture.workspaceId,
      action: "stopped",
      reason: "paid_authority_revoked",
    });

    const workspace = (
      await pool.query<{
        desired_state: string;
        status: string;
        last_error_code: string;
        authority_epoch: string;
      }>(
        `SELECT desired_state, status, last_error_code, authority_epoch::text
         FROM cloud_workspaces WHERE id = $1`,
        [fixture.workspaceId],
      )
    ).rows[0];
    expect(workspace).toEqual({
      desired_state: "stopped",
      status: "stopping",
      last_error_code: "paid_authority_revoked",
      authority_epoch: "2",
    });

    const intents = await pool.query<{
      generation: number;
      affects_workspace: boolean;
      operation: string;
    }>(
      `SELECT generation, affects_workspace, operation::text
       FROM cloud_workspace_lifecycle_intents
       WHERE workspace_id = $1 AND state IN ('queued', 'dispatching', 'observing')
       ORDER BY generation, operation`,
      [fixture.workspaceId],
    );
    expect(intents.rows).toEqual([
      { generation: 1, affects_workspace: true, operation: "stop" },
      { generation: 2, affects_workspace: false, operation: "stop" },
    ]);

    const engine = (
      await pool.query<{ state: string; revoked_at: Date | null }>(
        `SELECT state, revoked_at FROM cloud_workspace_engine_instances
         WHERE id = $1`,
        [fixture.engineInstanceId],
      )
    ).rows[0];
    expect(engine.state).toBe("revoked");
    expect(engine.revoked_at).not.toBeNull();
    expect(
      await pool.query(
        `SELECT 1 FROM workspace_checkpoint_requests
         WHERE workspace_id = $1`,
        [fixture.workspaceId],
      ),
    ).toHaveProperty("rowCount", 0);
  });

  it("stops before an immutable delegated provider credential expires", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const connectionId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO provider_connections (
           id, org_id, owner_kind, provider, display_name,
           credential_source, current_version, state, capabilities, region
         ) VALUES (
           $1, $2, 'organization', 'daytona', 'Expiring Daytona',
           'delegated', 1, 'active', $3::jsonb, 'eu'
         )`,
        [
          connectionId,
          fixture.organizationId,
          JSON.stringify({ qualified: true, lifecycle: true }),
        ],
      );
      await tx.query(
        `INSERT INTO provider_connection_versions (
           connection_id, org_id, version, credential_source, endpoint,
           key_version, nonce, ciphertext, auth_tag, credential_sha256,
           capabilities, credential_expires_at, created_by
         ) VALUES (
           $1, $2, 1, 'delegated', 'https://api.daytona.test',
           1, $3, $4, $5, $6, $7::jsonb, now() + interval '4 minutes', $8
         )`,
        [
          connectionId,
          fixture.organizationId,
          randomBytes(12),
          randomBytes(32),
          randomBytes(16),
          randomBytes(32),
          JSON.stringify({
            qualified: true,
            lifecycle: true,
            ssh: true,
            preview: true,
            commandExecution: true,
            daytonaTarget: "eu",
          }),
          fixture.userId,
        ],
      );
      await tx.query(
        `UPDATE cloud_workspace_generations
         SET provider_connection_id = $3
         WHERE workspace_id = $1 AND org_id = $2 AND generation = 1`,
        [fixture.workspaceId, fixture.organizationId, connectionId],
      );
    });

    const reconciler = new DatabaseCloudWorkspacePaidAuthorityReconciler(pool, {
      workosEnabled: false,
    });
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      workspaceId: fixture.workspaceId,
      action: "stopped",
      reason: "provider_authority_revoked",
    });
    await expect(
      pool.query(
        `SELECT desired_state, status, last_error_code
         FROM cloud_workspaces WHERE id = $1`,
        [fixture.workspaceId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          desired_state: "stopped",
          status: "stopping",
          last_error_code: "provider_authority_revoked",
        },
      ],
    });
  });

  it("treats a WorkOS organization-link loss as runtime authority loss", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO workos_organization_links (
           organization_id, workos_organization_id, external_id, state
         ) VALUES ($1::uuid, $2::text, $1::uuid::text, 'active')`,
        [fixture.organizationId, `org_${randomUUID().replaceAll("-", "")}`],
      );
      await tx.query(
        `UPDATE workos_organization_links
         SET state = 'conflict', last_error_code = 'identity_conflict'
         WHERE organization_id = $1`,
        [fixture.organizationId],
      );
    });

    const reconciler = new DatabaseCloudWorkspacePaidAuthorityReconciler(pool, {
      workosEnabled: true,
    });
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      workspaceId: fixture.workspaceId,
      action: "stopped",
    });
  });

  it("fails closed immediately and schedules provider cleanup when WorkOS deletes the owner", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const providerSubject = `user_${randomUUID().replaceAll("-", "")}`;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `UPDATE user_identities SET provider_sub = $2
         WHERE user_id = $1 AND provider = 'workos'`,
        [fixture.userId, providerSubject],
      );
      await tx.query(
        `INSERT INTO workos_organization_links (
           organization_id, workos_organization_id, external_id, state
         ) VALUES ($1::uuid, $2::text, $1::uuid::text, 'active')`,
        [fixture.organizationId, `org_${randomUUID().replaceAll("-", "")}`],
      );
    });

    await expect(
      applyWorkOSIdentityEvent(pool, {
        eventId: `event_${randomUUID().replaceAll("-", "")}`,
        eventType: "user.deleted",
        createdAt: new Date().toISOString(),
        user: {
          id: providerSubject,
          email: `durable-${fixture.userId}@example.test`,
          emailVerified: true,
          name: "Durable Workspace Owner",
          profilePictureUrl: null,
        },
      }),
    ).resolves.toEqual({ status: "applied" });

    const authority = await pool.query<{
      paid: boolean;
      runtime: boolean;
      queued: boolean;
    }>(
      `SELECT
         cloud_workspace_paid_authority_live($1, $2, true) AS paid,
         cloud_workspace_runtime_authority_live($1, 1, $2, true) AS runtime,
         EXISTS (
           SELECT 1 FROM cloud_workspace_paid_authority_checks
           WHERE workspace_id = $1
         ) AS queued`,
      [fixture.workspaceId, fixture.userId],
    );
    expect(authority.rows[0]).toEqual({ paid: false, runtime: false, queued: true });

    const reconciler = new DatabaseCloudWorkspacePaidAuthorityReconciler(pool, {
      workosEnabled: true,
    });
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      workspaceId: fixture.workspaceId,
      action: "stopped",
      reason: "paid_authority_revoked",
    });
  });

  it("stops Pro organization work when any collaborator loses Pro", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const collaborator = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${randomUUID().replaceAll("-", "")}`,
      email: `collaborator-${randomUUID()}@example.test`,
      displayName: "Collaborator",
    });
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [fixture.organizationId, collaborator.id],
      );
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'member')`,
        [fixture.teamId, fixture.organizationId, collaborator.id],
      );
      await tx.query(
        `INSERT INTO account_entitlements (
           user_id, plan, status, cloud_workspaces_allowed, source
         ) VALUES ($1, 'pro', 'active', true, 'operator')`,
        [collaborator.id],
      );
      await tx.query(
        `UPDATE organization_entitlements
         SET plan = 'pro', seat_limit = NULL, revision = revision + 1,
             updated_at = now()
         WHERE org_id = $1`,
        [fixture.organizationId],
      );
    });
    const reconciler = new DatabaseCloudWorkspacePaidAuthorityReconciler(pool, {
      workosEnabled: false,
    });
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      action: "billing_rebound",
    });

    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE account_entitlements
         SET status = 'cancelled', revision = revision + 1, updated_at = now()
         WHERE user_id = $1`,
        [collaborator.id],
      ),
    );
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      workspaceId: fixture.workspaceId,
      action: "stopped",
    });
  });
});
