import {withCloudFixtureOwnerTx} from "./test-fixtures.js";
import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureUser } from "../auth.js";
import { withSystemTx, type Tx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { applyWorkOSIdentityEvent } from "../workos-events.js";
import { functionColumnReads, functionInputTables, stripSqlLiterals } from "./function-input-tables-test-utils.js";
import { DatabaseCloudWorkspacePaidAuthorityReconciler } from "./paid-authority.js";
import { seedReadyCloudWorkspace, seedReadyProCloudWorkspace } from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

/** The functions the reconciler evaluates, and the workspace columns it
 * passes them (paid-authority.ts). */
const AUTHORITY_FUNCTIONS = [
  "cloud_workspace_paid_authority_live",
  "cloud_workspace_generation_provider_authority_live",
];
const AUTHORITY_ARGUMENTS = ["cloud_workspaces.owner_user_id", "cloud_workspaces.current_generation"];

/** Authority inputs that queue no check, each with the reason. Every running
 * workspace is still re-checked each recheckIntervalMs, so an exemption gives
 * up only the immediate check. */
const RECHECK_EXEMPT_INPUTS: Record<string, string> = {
  teams:
    "A soft delete drains the team's workspaces (team_cloud_workspace_retirement), and their (team_id, org_id) foreign key blocks deleting the team or moving it to another organization.",
  workspace_billing_epochs:
    "Written only by workspace creation and refreshCloudWorkspaceBillingEpoch, after the same transaction authorizes the owner.",
  staff_pro_benefits:
    "Maintained only from users.staff_role (staff_pro_benefit_sync), whose change queues the check itself.",
};

const SET_ON_INSERT = "Set on insert; no code path updates it.";

/** Columns the authority functions read that no check trigger watches, as
 * table.column, each with the reason. Primary-key columns need no entry. */
const RECHECK_EXEMPT_COLUMNS: Record<string, string> = {
  "cloud_workspaces.current_billing_epoch":
    "Moved only by refreshCloudWorkspaceBillingEpoch, to an epoch its transaction has just authorized.",
  "cloud_workspaces.deleted_at":
    "Set only with status 'deleted' when a delete completes; leaving desired_state 'running' already parked the check.",
  "organizations.is_personal": "Immutable (organizations_personal_classification_immutable).",
  "cloud_workspace_generations.org_id": SET_ON_INSERT,
  "cloud_workspace_generations.provider": SET_ON_INSERT,
  "provider_connections.credential_source": SET_ON_INSERT,
  "provider_connections.org_id": SET_ON_INSERT,
  "provider_connections.provider": SET_ON_INSERT,
  "provider_connection_versions.credential_source": SET_ON_INSERT,
  "provider_connection_versions.org_id": SET_ON_INSERT,
};

/** The workspace's own rows. A row they reference through a NO ACTION or
 * RESTRICT foreign key cannot be deleted while the workspace depends on it,
 * so its table needs no delete trigger. */
const WORKSPACE_TABLES = ["cloud_workspaces", "cloud_workspace_generations", "workspace_billing_epochs"];

/** Authority inputs whose deletes queue no check, each with the reason. */
const RECHECK_EXEMPT_DELETES: Record<string, string> = {
  cloud_workspaces:
    "Deleted only by an organization purge, which first verifies that every workspace is deleted (organization_cloud_deletion_not_verified); the check row cascades with it.",
};

/** A delegated Boat connection whose only credential version expires in four
 * minutes, inside the reconciler's five-minute provider cleanup margin. */
async function insertExpiringDelegatedConnection(
  tx: Tx,
  fixture: { organizationId: string; userId: string },
): Promise<string> {
  const connectionId = randomUUID();
  await tx.query(
    `INSERT INTO provider_connections (
       id, org_id, owner_kind, provider, display_name,
       credential_source, current_version, state, capabilities, region
     ) VALUES (
       $1, $2, 'organization', 'boat', 'Expiring Boat',
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
       $1, $2, 1, 'delegated', 'https://api.fixture.test',
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
        providerTarget: "eu",
      }),
      fixture.userId,
    ],
  );
  return connectionId;
}

d("cloud workspace paid-authority reconciliation", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=false WHERE provider='boat'");
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

  it("keeps sponsor authority when an unrelated collaborator's Pro has not activated", async () => {
    const fixture = await seedReadyProCloudWorkspace(pool);
    const reconciler = new DatabaseCloudWorkspacePaidAuthorityReconciler(pool, {
      workosEnabled: false,
      recheckIntervalMs: 300_000,
    });
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      workspaceId: fixture.workspaceId,
      action: "unchanged",
    });

    const collaborator = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${randomUUID().replaceAll("-", "")}`,
      email: `future-collaborator-${randomUUID()}@example.test`,
      displayName: "Future Pro Collaborator",
    });
    await withCloudFixtureOwnerTx(pool, async (tx) => {
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

    const authority = await withSystemTx(pool, tx => tx.query<{ paid: boolean; runtime: boolean; collaborator_live: boolean }>(
      `SELECT cloud_workspace_paid_authority_live($1, $2, false) AS paid,
              cloud_workspace_runtime_authority_live($1, 1, $2, false)
                AS runtime,
              cloud_workspace_pro_user_live($3) AS collaborator_live`,
      [fixture.workspaceId, fixture.userId, collaborator.id],
    ));
    expect(authority.rows[0]).toEqual({ paid: true, runtime: true, collaborator_live: false });
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
         ) VALUES ($1, 2, $2, 'boat')`,
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
    await withSystemTx(pool, async (tx) => {
      const connectionId = await insertExpiringDelegatedConnection(tx, fixture);
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

  it("keeps owner-funded work running when another collaborator loses Pro", async () => {
    const fixture = await seedReadyProCloudWorkspace(pool);
    const collaborator = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${randomUUID().replaceAll("-", "")}`,
      email: `collaborator-${randomUUID()}@example.test`,
      displayName: "Collaborator",
    });
    await withCloudFixtureOwnerTx(pool, async (tx) => {
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
    });
    const reconciler = new DatabaseCloudWorkspacePaidAuthorityReconciler(pool, {
      workosEnabled: false,
    });
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      action: "unchanged",
    });
    expect((await withSystemTx(pool, tx => tx.query("SELECT cloud_workspace_pro_user_live($1) AS live", [collaborator.id]))).rows[0].live).toBe(true);

    await withCloudFixtureOwnerTx(pool, (tx) =>
      tx.query(
        `UPDATE account_entitlements
         SET status = 'cancelled', revision = revision + 1, updated_at = now()
         WHERE user_id = $1`,
        [collaborator.id],
      ),
    );
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      workspaceId: fixture.workspaceId,
      action: "unchanged",
    });
    const authority = await withSystemTx(pool, tx => tx.query(
      `SELECT cloud_workspace_runtime_authority_live($1,1,$2,false) AS sponsor_live,
              cloud_workspace_pro_user_live($3) AS collaborator_live`,
      [fixture.workspaceId,fixture.userId,collaborator.id],
    ));
    expect(authority.rows[0]).toEqual({sponsor_live:true,collaborator_live:false});
  });

  it("revokes live engine authority and schedules cleanup when a pilot sponsor loses staff access", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await pool.query("UPDATE users SET staff_role = NULL WHERE id = $1", [fixture.userId]);
    const authority = await pool.query(`SELECT cloud_workspace_runtime_authority_live($1,1,$2,false) AS live`, [fixture.workspaceId, fixture.userId]);
    expect(authority.rows[0].live).toBe(false);
    const reconciler = new DatabaseCloudWorkspacePaidAuthorityReconciler(pool, {workosEnabled:false});
    await expect(reconciler.runOnce()).resolves.toMatchObject({ workspaceId: fixture.workspaceId, action:"stopped", reason:"paid_authority_revoked" });
  });

  it("re-checks provider authority as soon as the current generation changes", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const reconciler = new DatabaseCloudWorkspacePaidAuthorityReconciler(pool, {
      workosEnabled: false,
    });
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      workspaceId: fixture.workspaceId,
      action: "unchanged",
    });
    await expect(reconciler.runOnce()).resolves.toBeNull();

    // A rebuild, rollback or runtime transfer moves current_generation to a
    // generation whose credential the scheduled check never looked at.
    await withSystemTx(pool, async (tx) => {
      const connectionId = await insertExpiringDelegatedConnection(tx, fixture);
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         )
         SELECT workspace_id, 2, org_id, provider, image_ref, architecture,
                cpu_millicores, memory_mib, storage_mib, source_commit,
                created_by, $2
         FROM cloud_workspace_generations
         WHERE workspace_id = $1 AND generation = 1`,
        [fixture.workspaceId, connectionId],
      );
      await tx.query(
        `UPDATE cloud_workspaces SET current_generation = 2 WHERE id = $1`,
        [fixture.workspaceId],
      );
    });
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      workspaceId: fixture.workspaceId,
      action: "stopped",
      reason: "provider_authority_revoked",
    });
  });

  it("queues a check when any table or column the authority functions read changes", async () => {
    // Derived from the live function bodies: once an authority function reads
    // a new table or column, this fails until a trigger that queues a check
    // watches its updates and deletes, or it gains a reasoned exemption above.
    const { tables, functions, bodies } = await functionInputTables(pool, AUTHORITY_FUNCTIONS);
    for (const callee of ["cloud_workspace_pro_user_live", "cloud_workspace_pilot_user_live",
      "cloud_workspace_pro_entitlement"]) expect(functions).toContain(callee);
    const reads = await functionColumnReads(pool, [...bodies.values()].flat(), tables);
    for (const key of AUTHORITY_ARGUMENTS) {
      const [table, column] = key.split(".") as [string, string];
      reads.get(table)?.add(column);
    }
    for (const [table, column] of [
      ["cloud_workspaces", "current_billing_epoch"], ["cloud_workspaces", "current_generation"],
      ["organizations", "is_personal"], ["organization_entitlements", "valid_until"],
      ["provider_connection_versions", "credential_expires_at"], ["staff_pro_benefits", "revoked_at"],
    ] as const) expect(reads.get(table), table).toContain(column);

    const triggers = (await pool.query<{
      table: string;
      function: string;
      update: boolean;
      delete: boolean;
      columns: string[] | null;
    }>(
      `SELECT relation.relname AS table, function.proname AS function,
              (trigger.tgtype & 16) <> 0 AS update, (trigger.tgtype & 8) <> 0 AS delete,
              (SELECT array_agg(attribute.attname::text) FROM pg_attribute attribute
               WHERE attribute.attrelid = trigger.tgrelid
                 AND attribute.attnum = ANY(trigger.tgattr)) AS columns
       FROM pg_trigger trigger
       JOIN pg_class relation ON relation.oid = trigger.tgrelid
       JOIN pg_proc function ON function.oid = trigger.tgfoid
       WHERE NOT trigger.tgisinternal AND trigger.tgenabled IN ('O', 'A')
         AND relation.relnamespace = 'public'::regnamespace
         AND relation.relname = ANY($1::text[])`,
      [[...tables]],
    )).rows;
    // A trigger counts when its function, or one it calls, inserts a check.
    const queuesCheck = new Map<string, boolean>();
    for (const { function: name } of triggers) {
      if (queuesCheck.has(name)) continue;
      const called = await functionInputTables(pool, [name]);
      queuesCheck.set(name, [...called.bodies.values()].flat().some((body) =>
        /\binsert\s+into\s+(?:public\.)?cloud_workspace_paid_authority_checks\b/i.test(stripSqlLiterals(body))));
    }
    const primaryKey = new Set((await pool.query<{ key: string }>(
      `SELECT relation.relname || '.' || attribute.attname AS key
       FROM pg_index pk
       JOIN pg_class relation ON relation.oid = pk.indrelid
       JOIN pg_attribute attribute
         ON attribute.attrelid = pk.indrelid AND attribute.attnum = ANY(pk.indkey)
       WHERE pk.indisprimary AND relation.relnamespace = 'public'::regnamespace
         AND relation.relname = ANY($1::text[])`,
      [[...tables]],
    )).rows.map((row) => row.key));
    const deleteBlocked = new Set((await pool.query<{ table: string }>(
      `SELECT DISTINCT confrelid::regclass::text AS table FROM pg_constraint
       WHERE contype = 'f' AND confdeltype IN ('a', 'r')
         AND conrelid::regclass::text = ANY($1::text[])`,
      [WORKSPACE_TABLES],
    )).rows.map((row) => row.table));

    const uncovered: string[] = [];
    const needless: string[] = [];
    for (const table of tables) {
      const own = triggers.filter((trigger) => trigger.table === table && queuesCheck.get(trigger.function));
      const exemptTable = Object.hasOwn(RECHECK_EXEMPT_INPUTS, table);
      if (!own.length) {
        if (!exemptTable) uncovered.push(table);
        continue;
      }
      if (exemptTable) needless.push(table);
      const deleteCovered = deleteBlocked.has(table) || own.some((trigger) => trigger.delete);
      const exemptDelete = Object.hasOwn(RECHECK_EXEMPT_DELETES, table);
      if (deleteCovered && exemptDelete) needless.push(`${table} (delete)`);
      if (!deleteCovered && !exemptDelete) uncovered.push(`${table} (delete)`);
      const updates = own.filter((trigger) => trigger.update);
      for (const column of reads.get(table) ?? []) {
        const key = `${table}.${column}`;
        const covered = primaryKey.has(key) ||
          updates.some((trigger) => !trigger.columns || trigger.columns.includes(column));
        const exemptColumn = Object.hasOwn(RECHECK_EXEMPT_COLUMNS, key);
        if (covered && exemptColumn) needless.push(key);
        if (!covered && !exemptColumn) uncovered.push(key);
      }
    }
    expect(uncovered.sort()).toEqual([]);
    expect(needless.sort()).toEqual([]);
    expect([
      ...[...Object.keys(RECHECK_EXEMPT_INPUTS), ...Object.keys(RECHECK_EXEMPT_DELETES)]
        .filter((table) => !tables.has(table)),
      ...Object.keys(RECHECK_EXEMPT_COLUMNS).filter((key) => {
        const [table, column] = key.split(".") as [string, string];
        return !reads.get(table)?.has(column);
      }),
    ]).toEqual([]);

    // The database facts the exemptions rest on.
    const premises = await pool.query<{ name: string }>(
      `SELECT tgname AS name FROM pg_trigger
       WHERE NOT tgisinternal AND tgenabled IN ('O', 'A') AND tgname IN (
         'team_cloud_workspace_retirement', 'staff_pro_benefit_sync',
         'organizations_personal_classification_immutable')
       UNION ALL
       SELECT conname FROM pg_constraint
       WHERE conname = 'cloud_workspaces_team_id_org_id_fkey'
         AND confdeltype = 'r' AND confupdtype IN ('a', 'r')`,
    );
    expect(premises.rows.map((row) => row.name).sort()).toEqual([
      "cloud_workspaces_team_id_org_id_fkey",
      "organizations_personal_classification_immutable",
      "staff_pro_benefit_sync",
      "team_cloud_workspace_retirement",
    ]);
  });
});
