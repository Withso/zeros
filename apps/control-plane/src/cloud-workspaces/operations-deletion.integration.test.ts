import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { confirmWorkspaceDeletion, seedWorkspaceDeletionGraph } from "./deletion-test-fixtures.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";
import { seedCanonicalCloudWorkspaceAuthority, seedCanonicalWorkspaceSettingsVersion,
  seedSupportedCloudWorkspaceGeneration, withCloudFixtureOwnerTx } from "./test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
// Explicit erasure roots, independent of the worker's statement order. The
// catalog walk below adds every cascading child and detects new restrictive
// references whose owner has not been included in the synthetic fixture.
const purgeRoots = [
  "cloud_workspace_event_streams", "cloud_workspace_conversation_controls", "cloud_workspace_action_receipts",
  "cloud_workspace_local_command_writers", "cloud_workspace_local_command_history_heads",
  "cloud_workspace_runtime_transitions", "cloud_workspace_setup_attestations",
  "workspace_export_grants", "workspace_replica_grants", "workspace_replicas", "workspace_setup_recovery_grants",
  "workspace_checkpoint_requests", "workspace_record_heads", "workspace_content_heads", "workspace_fork_import_entries",
  "workspace_fork_import_records", "workspace_ports", "port_forward_sessions", "workspace_executions",
  "cloud_workspace_setup_runs", "cloud_workspace_endpoint_grants", "cloud_workspace_client_access_grants",
  "cloud_workspace_setup_secrets", "cloud_workspace_setup_specs", "workspace_settings_versions",
];
const referencingOwners = [
  "cloud_workspaces", "cloud_workspace_action_receipts", "cloud_workspace_commands", "cloud_workspace_event_streams",
  "cloud_workspace_local_command_writers", "cloud_workspace_runtime_attestations", "cloud_workspace_runtime_enrollments",
  "cloud_workspace_runtime_transitions", "cloud_workspace_setup_attestations", "workspace_content_revisions",
  "workspace_record_batches", "cloud_workspace_local_command_history_heads", "cloud_workspace_allocation_transfers",
  "cloud_workspace_generations", "workspace_checkpoint_requests", "workspace_content_heads", "workspace_exports",
  "cloud_workspace_setup_specs",
];

suite("workspace deletion dependency graph", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });

  async function graph() {
    return (await pool.query<{ child: string; parent: string; action: string }>(`WITH RECURSIVE purged(oid) AS (
      SELECT unnest($1::regclass[])::oid
      UNION SELECT fk.conrelid FROM pg_constraint fk JOIN purged ON purged.oid=fk.confrelid
        WHERE fk.contype='f' AND fk.confdeltype='c'
    ) SELECT fk.conrelid::regclass::text AS child,fk.confrelid::regclass::text AS parent,fk.confdeltype AS action
      FROM pg_constraint fk JOIN purged ON purged.oid=fk.confrelid
      WHERE fk.contype='f' ORDER BY parent,child`, [purgeRoots])).rows;
  }

  async function count(table: string, workspaceId: string, organizationId: string) {
    if (table === "cloud_workspace_runtime_attestations") return (await pool.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM cloud_workspace_runtime_attestations attestation JOIN cloud_workspace_runtime_enrollments enrollment
        ON enrollment.id=attestation.enrollment_id WHERE enrollment.workspace_id=$1 AND enrollment.org_id=$2`,
    [workspaceId, organizationId])).rows[0]!.count;
    if (!/^[a-z_]+$/.test(table)) throw new Error("Invalid fixture table");
    const key = table === "cloud_workspaces" ? "id" : "workspace_id";
    return (await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}
      WHERE ${key}=$1 AND org_id=$2`, [workspaceId, organizationId])).rows[0]!.count;
  }

  it("seeds every RESTRICT/NO ACTION owner through the complete purge cascade", async () => {
    const fixture = await seedWorkspaceDeletionGraph(pool);
    const references = (await graph()).filter(edge => ["r", "a"].includes(edge.action));
    expect(references.length).toBeGreaterThanOrEqual(17);
    for (const reference of references) expect(referencingOwners, `${reference.parent} <- ${reference.child}`).toContain(reference.child);
    for (const table of referencingOwners)
      expect(await count(table, fixture.workspaceId, fixture.organizationId), table).toBeGreaterThan(0);
  });

  it.each([0, 1, 2])("purges a complete workspace graph with %s runtime transfers and preserves audit/billing evidence", async runtimeTransfer => {
    const fixture = await seedWorkspaceDeletionGraph(pool, runtimeTransfer);
    const other = await seedWorkspaceDeletionGraph(pool);
    const siblingId = randomUUID();
    await withCloudFixtureOwnerTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspaces(id,org_id,team_id,created_by,owner_user_id,assignee_user_id,
        display_name,repository_id,repository_forge,repository_owner,repository_name,repository_revision)
        SELECT $2,org_id,team_id,created_by,owner_user_id,assignee_user_id,'Sibling fixture',repository_id,
          repository_forge,repository_owner,repository_name,repository_revision FROM cloud_workspaces WHERE id=$1`,
      [fixture.workspaceId, siblingId]);
      const input = { workspaceId: siblingId, organizationId: fixture.organizationId, ownerUserId: fixture.userId };
      await seedCanonicalCloudWorkspaceAuthority(tx, input);
      await seedSupportedCloudWorkspaceGeneration(tx, input);
      await seedCanonicalWorkspaceSettingsVersion(tx, { ...input, generation: 1, createdBy: fixture.userId,
        effectiveDocument: { schemaVersion: 1, values: {} } });
    });
    const retained = ["workspace_billing_epochs", "cloud_workspace_generations", "cloud_workspace_generation_transitions",
      "cloud_workspace_allocation_owners", "cloud_workspace_allocation_transfers"];
    const receipts = async () => Object.fromEntries(await Promise.all(retained.map(async table => [table,
      (await pool.query(`SELECT to_jsonb(receipt)-'recovery_checkpoint_id' AS receipt
        FROM ${table} receipt WHERE workspace_id=$1 AND org_id=$2 ORDER BY to_jsonb(receipt)::text`,
      [fixture.workspaceId, fixture.organizationId])).rows.map(row => row.receipt)])));
    const before = await receipts();
    const audits = (await pool.query(`SELECT id,subject FROM audit_log WHERE org_id=$1 ORDER BY id`, [fixture.organizationId])).rows;
    await confirmWorkspaceDeletion(pool, fixture);
    const logger = { error: vi.fn() };
    const worker = new CloudWorkspaceOperationsWorker(pool, fixture.objects,
      { workerId: "deletion-graph-fixture", maxAttempts: 1, logger });
    await worker.runOnce();
    expect((await pool.query(`SELECT job.state,job.error_code,workspace.data_deleted_at IS NOT NULL AS erased,
      workspace.agent_boot_id,workspace.agent_command_mode
      FROM workspace_deletion_jobs job JOIN cloud_workspaces workspace ON workspace.id=job.workspace_id
        AND workspace.org_id=job.org_id WHERE workspace.id=$1`, [fixture.workspaceId])).rows[0]).toEqual({
      state: "succeeded", error_code: null, erased: true, agent_boot_id: null, agent_command_mode: "boot-owner-v1",
    });
    expect(logger.error).not.toHaveBeenCalled();
    for (const table of ["cloud_workspace_local_command_writers", "cloud_workspace_local_command_history_heads",
      "cloud_workspace_local_command_history_blobs", "cloud_agent_boot_bindings", "cloud_workspace_setup_attestations",
      "cloud_workspace_setup_runs", "cloud_workspace_engine_instances", "cloud_workspace_runtime_attestations",
      "cloud_workspace_runtime_enrollments", "cloud_workspace_runtime_transitions", "workspace_content_revisions",
      "workspace_checkpoints", "workspace_record_batches", "workspace_record_events", "workspace_record_entities",
      "cloud_workspace_commands", "cloud_workspace_action_receipts", "cloud_workspace_event_streams"]) {
      expect(await count(table, fixture.workspaceId, fixture.organizationId), table).toBe(0);
      expect(await count(table, other.workspaceId, other.organizationId), `other ${table}`).toBeGreaterThan(0);
    }
    expect(await count("workspace_settings_versions", siblingId, fixture.organizationId)).toBe(1);
    expect((await pool.query("SELECT 1 FROM cloud_agent_boot_credentials WHERE binding_id=$1", [fixture.bindingId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM cloud_agent_boot_source_deliveries WHERE binding_id=$1", [fixture.bindingId])).rowCount).toBe(0);
    expect(await receipts()).toEqual(before);
    expect((await pool.query("SELECT id,subject FROM audit_log WHERE org_id=$1 ORDER BY id", [fixture.organizationId])).rows).toEqual(audits);
    const completed = (await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0];
    await worker.runOnce();
    expect((await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0]).toEqual(completed);
    expect((await pool.query(`SELECT count(*)::int AS count FROM cloud_workspace_outbox
      WHERE workspace_id=$1 AND event_type='workspace.data_deleted'`, [fixture.workspaceId])).rows[0].count).toBe(1);
    if (runtimeTransfer) await expect(withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_allocation_transfers
      (workspace_id,org_id,provider_resource_id,revision,transition_id,source_generation,target_generation,engine_instance_id)
      SELECT workspace_id,org_id,provider_resource_id,revision+100,transition_id,source_generation,target_generation,engine_instance_id
      FROM cloud_workspace_allocation_transfers WHERE workspace_id=$1 ORDER BY revision LIMIT 1`, [fixture.workspaceId])))
      .rejects.toMatchObject({ code: "23503" });
    await withSystemTx(pool, async tx => {
      expect((await tx.query(`SELECT nullif(current_setting('app.workspace_deletion_job_id',true),'') IS NULL
        AND nullif(current_setting('app.workspace_deletion_lease_owner',true),'') IS NULL AS cleared`)).rows[0].cleared).toBe(true);
    });
  });

  it("retains the boot pointer and all records when another worker owns the deletion lease", async () => {
    const fixture = await seedWorkspaceDeletionGraph(pool, false);
    await confirmWorkspaceDeletion(pool, fixture);
    await pool.query(`INSERT INTO workspace_deletion_jobs(workspace_id,org_id,requested_by,idempotency_key,state,
      lease_owner,lease_expires_at) VALUES($1,$2,$3,'deletion-owned-elsewhere','deleting_records','other-worker',now()+interval '1 minute')`,
    [fixture.workspaceId, fixture.organizationId, fixture.userId]);
    const worker = new CloudWorkspaceOperationsWorker(pool, fixture.objects, { workerId: "deletion-lease-fixture" });
    expect(await worker.processDeletionOnce()).toBe(false);
    expect((await pool.query("SELECT agent_boot_id,data_deleted_at FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ agent_boot_id: fixture.bindingId, data_deleted_at: null });
    expect(await count("cloud_workspace_local_command_writers", fixture.workspaceId, fixture.organizationId)).toBe(1);
  });

  it("does not grant ordinary system transactions permission to erase runtime transfer evidence", async () => {
    const fixture = await seedWorkspaceDeletionGraph(pool);
    await withSystemTx(pool, async tx => {
      const before = await tx.query("SELECT transition_id FROM cloud_workspace_runtime_transitions WHERE workspace_id=$1", [fixture.workspaceId]);
      await tx.query("SAVEPOINT refused_purge");
      try { await tx.query("DELETE FROM cloud_workspace_runtime_transitions WHERE workspace_id=$1", [fixture.workspaceId]); }
      catch { await tx.query("ROLLBACK TO SAVEPOINT refused_purge"); }
      expect((await tx.query("SELECT transition_id FROM cloud_workspace_runtime_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rows).toEqual(before.rows);
    });
    const auditRows = (await pool.query("SELECT * FROM cloud_workspace_allocation_transfers WHERE workspace_id=$1", [fixture.workspaceId])).rows;
    expect((await withSystemTx(pool, tx => tx.query("DELETE FROM cloud_workspace_allocation_transfers WHERE workspace_id=$1", [fixture.workspaceId]))).rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM cloud_workspace_allocation_transfers WHERE workspace_id=$1", [fixture.workspaceId])).rows).toEqual(auditRows);
  });

  async function preparePurge() {
    const fixture = await seedWorkspaceDeletionGraph(pool, false);
    await confirmWorkspaceDeletion(pool, fixture);
    const worker = new CloudWorkspaceOperationsWorker(pool, fixture.objects, { workerId: "purge-guard-fixture" });
    const jobId = randomUUID();
    await pool.query(`INSERT INTO workspace_deletion_jobs(id,workspace_id,org_id,requested_by,idempotency_key)
      VALUES($1,$2,$3,$4,'purge-guard-fixture')`, [jobId, fixture.workspaceId, fixture.organizationId, fixture.userId]);
    for (let step = 0; step < 3; step++) expect(await worker.processDeletionOnce()).toBe(true);
    expect((await pool.query("SELECT state FROM workspace_deletion_jobs WHERE id=$1", [jobId])).rows[0].state).toBe("deleting_records");
    await pool.query(`UPDATE workspace_deletion_jobs SET lease_owner='purge-guard-fixture',lease_expires_at=clock_timestamp()+interval '1 minute'
      WHERE id=$1`, [jobId]);
    return { fixture, worker, job: { id: jobId, workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
      state: "deleting_records" as const, leaseOwner: "purge-guard-fixture", attemptCount: 0 } };
  }

  it.each(["expired", "wrong-owner", "wrong-org", "wrong-workspace"])("rejects a %s purge lease without changing content", async kind => {
    const { fixture, worker, job } = await preparePurge();
    if (kind === "expired") await pool.query("UPDATE workspace_deletion_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    if (kind === "wrong-owner") job.leaseOwner = "other-worker";
    if (kind === "wrong-org") job.organizationId = randomUUID();
    if (kind === "wrong-workspace") job.workspaceId = randomUUID();
    await worker["purgeDeletionRecords"](job);
    expect((await pool.query("SELECT agent_boot_id,data_deleted_at FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ agent_boot_id: fixture.bindingId, data_deleted_at: null });
    expect(await count("cloud_workspace_local_command_writers", fixture.workspaceId, fixture.organizationId)).toBe(1);
  });

  it("rolls back every erased row if the lease expires before completion", async () => {
    const { fixture, worker, job } = await preparePurge();
    await pool.query(`CREATE FUNCTION expire_purge_fixture_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE workspace_deletion_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=NEW.id;
      RETURN NEW; END $$;
      CREATE TRIGGER expire_purge_fixture_lease AFTER UPDATE OF data_deleted_at ON cloud_workspaces
      FOR EACH ROW WHEN (NEW.data_deleted_at IS NOT NULL) EXECUTE FUNCTION expire_purge_fixture_lease();`);
    await expect(worker["purgeDeletionRecords"](job)).rejects.toThrow("workspace_deletion_lease_lost");
    expect((await pool.query("SELECT agent_boot_id,data_deleted_at FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ agent_boot_id: fixture.bindingId, data_deleted_at: null });
    expect(await count("workspace_content_revisions", fixture.workspaceId, fixture.organizationId)).toBe(1);
    expect(await count("cloud_workspace_setup_attestations", fixture.workspaceId, fixture.organizationId)).toBe(1);
  });

  it("uses the operator's workspace-before-job lock order during a concurrent replay", async () => {
    const { fixture, job } = await preparePurge();
    const operator = await pool.connect();
    const workerPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, application_name: "deletion-lock-fixture" });
    let completed: Promise<unknown> | undefined;
    try {
      await operator.query("BEGIN; SET LOCAL lock_timeout='300ms'");
      await operator.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [fixture.workspaceId]);
      const worker = new CloudWorkspaceOperationsWorker(workerPool, fixture.objects, { workerId: job.leaseOwner });
      completed = worker["purgeDeletionRecords"](job).then(() => null, error => error);
      let blocked = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        blocked = (await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND application_name='deletion-lock-fixture' AND wait_event_type='Lock'`)).rowCount === 1;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await expect(operator.query("SELECT id FROM workspace_deletion_jobs WHERE id=$1 FOR UPDATE", [job.id]))
        .resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await operator.query("ROLLBACK");
      operator.release();
      const result = await completed;
      await workerPool.end();
      expect(result).toBeNull();
    }
  });

  it.each([
    ["missing context", null],
    ["wrong context", null],
    ["unverified provider", "UPDATE cloud_workspace_provider_bindings SET deletion_verified_at=NULL WHERE workspace_id=$1"],
    ["pending blob", "UPDATE workspace_deletion_blob_targets SET completed_at=NULL WHERE job_id=(SELECT id FROM workspace_deletion_jobs WHERE workspace_id=$1)"],
    ["target blob hold", "UPDATE workspace_blobs SET legal_hold=true WHERE id IN (SELECT blob_id FROM workspace_deletion_blob_targets WHERE job_id=(SELECT id FROM workspace_deletion_jobs WHERE workspace_id=$1))"],
    ["workspace hold", "INSERT INTO workspace_retention_policies(workspace_id,org_id,legal_hold) SELECT id,org_id,true FROM cloud_workspaces WHERE id=$1 ON CONFLICT(workspace_id) DO UPDATE SET legal_hold=true"],
    ["checkpoint hold", "UPDATE workspace_checkpoints SET legal_hold=true WHERE workspace_id=$1"],
    ["live workspace", "UPDATE cloud_workspaces SET status='ready',desired_state='running',deleted_at=NULL WHERE id=$1"],
  ])("does not relax the boot guard for %s", async (kind, sql) => {
    const { fixture, job } = await preparePurge();
    if (sql) await pool.query(sql, [fixture.workspaceId]);
    await expect(withSystemTx(pool, async tx => {
      if (kind !== "missing context") await tx.query(`SELECT set_config('app.workspace_deletion_job_id',$1,true),
        set_config('app.workspace_deletion_lease_owner',$2,true)`, [job.id, kind === "wrong context" ? "wrong-worker" : job.leaseOwner]);
      await tx.query("UPDATE cloud_workspaces SET agent_boot_id=NULL WHERE id=$1", [fixture.workspaceId]);
    })).rejects.toMatchObject({ code: "23514" });
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspaces SET agent_command_mode='legacy',agent_boot_id=NULL WHERE id=$1", [fixture.workspaceId])))
      .rejects.toMatchObject({ code: "23514" });
  });
});
