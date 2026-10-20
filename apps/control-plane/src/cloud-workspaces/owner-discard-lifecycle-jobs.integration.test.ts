import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JobRunner } from "../job-runner.js";
import { manageCloudOwnerDiscardDelete } from "../manage-cloud-owner-discard-delete.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { existingDeleteWorkers, seedExistingDelete } from "./owner-existing-delete-test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type Fixture = Awaited<ReturnType<typeof seedExistingDelete>>;
type Workers = ReturnType<typeof existingDeleteWorkers>;

suite("discarded final-save lifecycle scheduling", () => {
  let pool: pg.Pool;
  const runners = new Set<JobRunner>();
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });
  afterEach(async () => {
    await Promise.all([...runners].map(runner => runner.stop()));
    runners.clear();
  });
  afterAll(async () => { await pool.end(); });

  const manage = manageCloudOwnerDiscardDelete as (pool: pg.Pool, request: unknown,
    options: { databaseUrl: string; execute?: boolean; approval?: string }) => ReturnType<typeof manageCloudOwnerDiscardDelete>;
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });
  const jobs = (workspaceId: string) => pool.query(
    `SELECT kind, state, run_at <= clock_timestamp() AS due FROM control_plane_jobs
     WHERE workspace_id=$1 AND kind='cloud_lifecycle_intent' ORDER BY id`, [workspaceId]);

  // Use the same queue claim, handler and completion boundaries as the live
  // worker. A direct reconciler.runOnce call would hide a missing enqueue.
  async function consumeLifecycleJobs(f: Fixture, workers: Workers): Promise<void> {
    let completed = 0;
    const runner = new JobRunner({
      pool, ownerId: "discarded-lifecycle-test", concurrency: 1, pollIntervalMs: 1_000,
      logger: workers.logger,
      handlers: [{ kind: "cloud_lifecycle_intent", leaseMs: 60_000, timeoutMs: 10_000,
        handle: (job, { signal }) => workers.reconciler.runJob(job, signal) }],
      observe: event => { if (event.operation === "complete") completed += event.rows; },
    });
    runners.add(runner);
    runner.start();
    await vi.waitFor(async () => {
      expect(completed).toBeGreaterThan(0);
      expect(runner.inFlight).toBe(0);
      expect((await jobs(f.workspaceId)).rows).toEqual([]);
    }, { timeout: 5_000, interval: 10 });
    await runner.stop();
    runners.delete(runner);
  }

  async function drainedBlockedDelete() {
    const f = await seedExistingDelete(pool), workers = existingDeleteWorkers(pool, f);
    expect((await jobs(f.workspaceId)).rows).toHaveLength(1);
    await consumeLifecycleJobs(f, workers);
    expect(workers.provider.delete).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state, attempt_count, dispatched_at FROM cloud_workspace_lifecycle_intents WHERE id=$1",
      [f.deleteId])).rows[0]).toEqual({ state: "queued", attempt_count: 0, dispatched_at: null });
    return { f, workers };
  }

  async function accept(f: Fixture) {
    const plan = await manage(pool, f.request, options());
    return manage(pool, f.request, { ...options(), execute: true, approval: plan.approval });
  }

  it("wakes the real queue after an owner discard when the blocked lifecycle job has drained", async () => {
    const { f, workers } = await drainedBlockedDelete();
    const intent = (await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=$1",
      [f.deleteId])).rows[0].value;
    const accepted = await accept(f);
    expect(accepted).toMatchObject({ state: "deleting", deleteIntentId: f.deleteId });
    expect((await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=$1",
      [f.deleteId])).rows[0].value).toEqual(intent);
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven, cloud_final_save_dispatchable($1) AS dispatchable",
      [f.deleteId])).rows[0]).toEqual({ proven: false, dispatchable: true });

    expect((await jobs(f.workspaceId)).rows).toEqual([
      { kind: "cloud_lifecycle_intent", state: "queued", due: true },
    ]);
    await consumeLifecycleJobs(f, workers);
    expect(workers.provider.delete).toHaveBeenCalledExactlyOnceWith(f.resourceId);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.deleteId])).rows[0].state)
      .toBe("succeeded");
    expect(workers.logger.error.mock.calls).toEqual([]);
  }, 30_000);

  it("control: planning an unprovable Delete leaves the drained queue and retained data untouched", async () => {
    const { f, workers } = await drainedBlockedDelete();
    const objectKey = (await pool.query("SELECT object_key FROM workspace_blobs WHERE id=$1", [f.blobId])).rows[0].object_key as string;
    expect((await manage(pool, f.request, options())).state).toBe("planned");
    expect((await jobs(f.workspaceId)).rows).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_owner_existing_delete_receipts")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT cloud_final_save_dispatchable($1) AS dispatchable", [f.deleteId])).rows[0].dispatchable).toBe(false);
    expect(await workers.erasure.processDeletionOnce()).toBe(false);
    expect(workers.provider.delete).not.toHaveBeenCalled();
    expect(await f.store.get(objectKey)).not.toBeNull();
  }, 30_000);

  it("control: the fallback audit feeds the real runner without replacing the Delete or inventing save proof", async () => {
    const { f, workers } = await drainedBlockedDelete();
    const objectKey = (await pool.query("SELECT object_key FROM workspace_blobs WHERE id=$1", [f.blobId])).rows[0].object_key as string;
    const accepted = await accept(f);
    const source = (await pool.query("SELECT source FROM cloud_workspace_owner_existing_delete_receipts WHERE id=$1",
      [accepted.receiptId])).rows[0].source;
    await workers.reconciler.auditJobs();
    expect((await jobs(f.workspaceId)).rows).toEqual([
      { kind: "cloud_lifecycle_intent", state: "queued", due: true },
    ]);
    await consumeLifecycleJobs(f, workers);
    expect(workers.provider.delete).toHaveBeenCalledExactlyOnceWith(f.resourceId);
    expect((await workers.journal.get(f.resourceId))?.deletedAt).toBeInstanceOf(Date);
    expect((await pool.query("SELECT retired_at, sealed_sequence, seal_ack FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1",
      [f.writerEpoch])).rows[0]).toEqual({ retired_at: expect.any(Date), sealed_sequence: null, seal_ack: null });
    for (let pass = 0; pass < 6; pass++) await workers.erasure.processDeletionOnce();
    expect(await f.store.get(objectKey)).toBeNull();
    expect((await pool.query("SELECT status, data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1",
      [f.workspaceId])).rows[0]).toEqual({ status: "deleted", erased: true });
    for (const table of ["workspace_blob_references", "workspace_record_events", "workspace_record_entities"]) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id=$1`,
        [f.workspaceId])).rows[0].count, table).toBe(0);
    }
    expect((await pool.query("SELECT source FROM cloud_workspace_owner_existing_delete_receipts WHERE id=$1",
      [accepted.receiptId])).rows[0].source).toEqual(source);
    expect(await manage(pool, f.request, { ...options(), execute: true, approval: accepted.approval }))
      .toMatchObject({ state: "unchanged", deleteIntentId: f.deleteId, providerDeletion: "verified", dataErasure: "complete" });
    expect(workers.provider.create).not.toHaveBeenCalled();
    expect(workers.provider.start).not.toHaveBeenCalled();
    expect(workers.logger.error.mock.calls).toEqual([]);
  }, 30_000);
});
