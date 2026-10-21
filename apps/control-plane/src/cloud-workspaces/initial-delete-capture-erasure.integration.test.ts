import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx } from "../db.js";
import { JobRunner } from "../job-runner.js";
import { manageCloudInitialDeleteCapture as manage } from "../manage-cloud-initial-delete-capture.js";
import { seedInitialDeleteCapture } from "./initial-delete-capture-test-fixtures.js";
import { sealFinalSaveFixture, commitFinalSaveFixture } from "./final-save-test-fixtures.js";
import { deliverWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { DatabaseCloudProviderOperationStore } from "./provider-operation-store.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";
import { CloudWorkspaceComputeLeaseCoordinator } from "./compute-leases.js";
import { readLifecycleDueInMs } from "./lifecycle-jobs.js";
import type { CloudWorkspaceProvider, CloudProviderResource } from "./provider.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("initial Delete capture through ordinary provider completion and erasure", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));

  it("saves the first live source, wakes the real lifecycle runner and purges the same Delete's objects and records", async () => {
    const f = await seedInitialDeleteCapture(pool), options = { databaseUrl: process.env.TEST_DATABASE_URL! };
    const originalIntent = (await pool.query("SELECT id,idempotency_key,request_sha256 FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.deleteId])).rows[0];
    const jobId = (await pool.query("SELECT id FROM workspace_deletion_jobs WHERE workspace_id=$1", [f.workspaceId])).rows[0].id;
    const plan = await manage(pool, f.request, options);
    const accepted = await manage(pool, f.request, { ...options, execute: true, approval: plan.approval });
    const receipt = (await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_initial_delete_captures r WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0].value;
    const directive = await withSystemTx(pool, tx => deliverWorkspaceCheckpointRequest(tx, { ...f.scope, finalSaveVersion: 1 }));
    expect(directive).toMatchObject({ id: accepted.captureRequestId, reason: "before_delete", finalSave: {
      source: { engineInstanceId: f.engineInstanceId, bootId: f.bootId, writerEpoch: f.writerEpoch }, attemptOrdinal: 0,
    } });
    expect(await readLifecycleDueInMs(pool, "lifecycle", f.workspaceId, { provider: "boat", driftIntervalMs: 60_000 })).toBeNull();
    expect((await pool.query("SELECT state,sealed_sequence FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [f.writerEpoch])).rows[0])
      .toEqual({ state: "active", sealed_sequence: null });
    const batchId = randomUUID();
    await pool.query("INSERT INTO workspace_record_heads(workspace_id,org_id,current_revision,last_durable_at) VALUES($1,$2,1,now())", [f.workspaceId, f.organizationId]);
    await pool.query(`INSERT INTO workspace_record_batches(id,workspace_id,org_id,generation,engine_instance_id,authority_epoch,
      idempotency_key,request_sha256,first_revision,last_revision,event_count)
      VALUES($1,$2,$3,1,$4,1,'initial-delete-record',decode(repeat('a',64),'hex'),1,1,1)`, [batchId, f.workspaceId, f.organizationId, f.engineInstanceId]);
    await pool.query(`INSERT INTO workspace_record_events(workspace_id,org_id,revision,batch_id,entity_kind,entity_id,operation,document,occurred_at)
      VALUES($1,$2,1,$3,'metadata','initial-delete','upsert','{"retained":true}',now())`, [f.workspaceId, f.organizationId, batchId]);
    await pool.query(`INSERT INTO workspace_record_entities(workspace_id,org_id,entity_kind,entity_id,revision,schema_version,document)
      VALUES($1,$2,'metadata','initial-delete',1,1,'{"retained":true}')`, [f.workspaceId, f.organizationId]);
    const sealed = await sealFinalSaveFixture(pool, f.scope);
    expect(sealed.ack).toBeTruthy();
    const saved = await commitFinalSaveFixture(pool, f.scope, { intentId: f.deleteId, userId: f.userId, reason: "before_delete" });
    expect(saved.request.id).toBe(accepted.captureRequestId);
    expect(saved.objects.size).toBeGreaterThan(0);
    expect((await withSystemTx(pool, tx => tx.query("SELECT cloud_final_save_proven($1) AS proven,cloud_final_save_dispatchable($1) AS allowed", [f.deleteId]))).rows)
      .toEqual([{ proven: true, allowed: true }]);
    expect((await pool.query("SELECT state,checkpoint_id,proven_request_id FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0])
      .toEqual({ state: "proven", checkpoint_id: saved.receipt.checkpointId, proven_request_id: accepted.captureRequestId });
    const due = (await pool.query("SELECT state,run_at<=clock_timestamp() AS due FROM control_plane_jobs WHERE kind='cloud_lifecycle_intent' AND workspace_id=$1 AND state IN ('queued','running')", [f.workspaceId])).rows;
    expect(due).toEqual([{ state: "queued", due: true }]);
    const account = "initial-delete-fixture-account", journal = new DatabaseCloudProviderOperationStore(pool, "boat", account);
    await pool.query(`INSERT INTO cloud_workspace_provider_operations(provider,account_scope,workspace_id,generation,org_id,idempotency_key,
      request_sha256,create_attempts_tracked,resource_id) VALUES('boat',$1,$2,1,$3,$4,$5,true,$6)`,
    [account, f.workspaceId, f.organizationId, f.createId, "a".repeat(64), f.resourceId]);
    let resource: CloudProviderResource | null = { resourceId: f.resourceId, workspaceId: f.workspaceId, generation: 1,
      state: "running", target: "test-region", metadata: {} };
    const provider = { name: "boat", find: vi.fn(async () => resource ? [resource] : []), inspect: vi.fn(async () => resource),
      delete: vi.fn(async () => {
        await journal.beginDelete(f.resourceId);
        const deletion = randomUUID();
        await journal.bindDeletion(f.resourceId, deletion); await journal.completeDeletion(f.resourceId, deletion); resource = null;
      }), verifyAbsence: vi.fn(async () => true), verifyManagedResourceOwnership: vi.fn(async () => true),
      create: vi.fn(), start: vi.fn(), archive: vi.fn(),
      stop: vi.fn(async () => { if (!resource) throw new Error("Missing fixture resource"); resource = { ...resource, state: "stopped" }; return resource; }),
      computeWeight: vi.fn(), createWithComputeLease: vi.fn(), startWithComputeLease: vi.fn(),
      readComputeUsage: vi.fn(), renewComputeLease: vi.fn() };
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const reconciler = new CloudWorkspaceReconciler({ pool, provider: provider as unknown as CloudWorkspaceProvider, workerId: "initial-delete-proof", logger });
    const runner = new JobRunner({ pool, concurrency: 1, ownerId: "initial-delete-runner", pollIntervalMs: 60_000, logger,
      handlers: [{ kind: "cloud_lifecycle_intent", timeoutMs: 10_000, handle: (job, { signal }) => reconciler.runJob(job, signal) }] });
    const stop = runner.start();
    try {
      await vi.waitFor(async () => {
        expect(provider.stop).toHaveBeenCalledOnce();
        expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [f.leaseId])).rows[0].state).toBe("draining");
        expect(runner.inFlight).toBe(0);
      }, { timeout: 5_000, interval: 20 });
      expect(provider.delete).not.toHaveBeenCalled();
      // This unmetered fixture has no reservations. Advance only the stopped
      // observation clock, then let the real coordinator settle its lease.
      await pool.query("UPDATE managed_compute_allocation_leases SET stopped_observed_at=clock_timestamp()-interval '1 minute',next_check_at=clock_timestamp() WHERE id=$1", [f.leaseId]);
      await new CloudWorkspaceComputeLeaseCoordinator({ pool, provider: provider as unknown as CloudWorkspaceProvider,
        workosEnabled: false, usageMeterWindowMs: 0, logger }).runOnce(f.workspaceId);
      expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [f.leaseId])).rows[0].state).toBe("settled");
      await vi.waitFor(async () => {
        expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.deleteId])).rows[0].state).toBe("succeeded");
        expect(runner.inFlight).toBe(0);
      }, { timeout: 5_000, interval: 20 });
    } finally { await stop(); }
    expect(provider.delete).toHaveBeenCalledOnce();
    expect(provider.create).not.toHaveBeenCalled(); expect(provider.start).not.toHaveBeenCalled();
    expect(logger.error.mock.calls).toEqual([]); expect(logger.warn.mock.calls).toEqual([]);
    expect((await pool.query("SELECT deletion_verified_at IS NOT NULL AS verified FROM cloud_workspace_provider_bindings WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([{ verified: true }]);
    expect((await pool.query("SELECT settled_at IS NOT NULL AS settled FROM cloud_workspace_final_save_dispatches WHERE lifecycle_intent_id=$1", [f.deleteId])).rows).toEqual([{ settled: true }]);
    const erasure = new CloudWorkspaceOperationsWorker(pool, saved.blobs, { workerId: "initial-delete-erasure", logger });
    for (let pass = 0; pass < 6; pass++) await erasure.processDeletionOnce();
    expect(logger.error.mock.calls).toEqual([]);
    expect(saved.objects.size).toBe(0);
    expect((await pool.query("SELECT id,state FROM workspace_deletion_jobs WHERE id=$1", [jobId])).rows).toEqual([{ id: jobId, state: "succeeded" }]);
    expect((await pool.query("SELECT data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows).toEqual([{ erased: true }]);
    for (const table of ["workspace_file_entries", "workspace_record_events", "workspace_record_entities", "workspace_checkpoints",
      "workspace_checkpoint_requests", "workspace_blob_references", "cloud_workspace_local_command_writers", "cloud_workspace_final_save_recoveries"]) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`, [f.workspaceId])).rows[0].n, table).toBe(0);
    }
    expect((await pool.query("SELECT id,idempotency_key,request_sha256 FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.deleteId])).rows[0]).toEqual(originalIntent);
    expect((await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_initial_delete_captures r WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0].value).toEqual(receipt);
    expect(await manage(pool, f.request, { ...options, execute: true, approval: plan.approval })).toEqual({ ...accepted, state: "unchanged" });
  }, 20_000);
});
