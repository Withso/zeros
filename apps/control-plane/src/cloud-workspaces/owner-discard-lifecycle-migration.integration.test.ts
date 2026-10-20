import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { claimJobs, completeJob } from "../job-queue.js";
import { JobRunner } from "../job-runner.js";
import { manageCloudOwnerDiscardDelete } from "../manage-cloud-owner-discard-delete.js";
import { runDueLifecycleJobs } from "./lifecycle-job-test-utils.js";
import { existingDeleteWorkers, seedExistingDelete } from "./owner-existing-delete-test-fixtures.js";
import { CloudProviderError } from "./provider.js";
import { requestCloudWorkspaceDeletion } from "./routes.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const directory = new URL("../../migrations/", import.meta.url);
const migration = "0179_cloud_discarded_lifecycle_jobs.sql", kind = "cloud_lifecycle_intent";
type Fixture = Awaited<ReturnType<typeof seedExistingDelete>>;

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

suite("discarded lifecycle migration from committed existing-Delete receipts", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  beforeEach(async () => {
    await pool.end();
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 });
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const name of (await readdir(directory)).filter(name => /^\d{4}_.*\.sql$/.test(name) && name < migration).sort()) {
      await apply(name);
    }
  }, 30_000);
  afterAll(async () => { await pool.end(); });

  async function apply(name = migration, rollback = false) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(new URL(name, directory), "utf8"));
      await client.query(rollback ? "ROLLBACK" : "COMMIT");
    } finally { await client.query("ROLLBACK"); client.release(); }
  }
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });
  async function accept(f: Fixture) {
    const plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    return manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: plan.approval });
  }
  const jobs = () => pool.query(`SELECT id,workspace_id,org_id,state,run_at,rerun_at,
    run_at<=clock_timestamp() AS due,rerun_at<=clock_timestamp() AS rerun_due
    FROM control_plane_jobs WHERE kind=$1 ORDER BY workspace_id`, [kind]);
  async function retained(f: { workspaceId: string }) {
    const snapshot: Record<string, unknown> = {};
    for (const table of ["cloud_workspace_lifecycle_intents", "cloud_workspace_final_save_recoveries",
      "workspace_checkpoint_requests", "cloud_workspace_owner_existing_delete_receipts", "workspace_deletion_jobs",
      "cloud_workspace_local_command_writers", "managed_compute_allocation_leases", "cloud_workspace_provider_bindings",
      "cloud_workspace_provider_operations"]) {
      snapshot[table] = (await pool.query(`SELECT to_jsonb(row) AS value FROM ${table} row
        WHERE workspace_id=$1 ORDER BY to_jsonb(row)::text`, [f.workspaceId])).rows;
    }
    snapshot.workspace = (await pool.query("SELECT to_jsonb(w) AS value FROM cloud_workspaces w WHERE id=$1", [f.workspaceId])).rows;
    return snapshot;
  }
  async function committedWithoutWake() {
    const f = await seedExistingDelete(pool), workers = existingDeleteWorkers(pool, f);
    await runDueLifecycleJobs(pool, workers.reconciler, ["lifecycle"]);
    expect((await jobs()).rows).toEqual([]);
    const accepted = await accept(f);
    expect((await jobs()).rows).toEqual([]);
    expect((await pool.query("SELECT cloud_owner_existing_delete_current($1) AS current", [f.deleteId])).rows[0].current).toBe(true);
    return { f, workers, accepted };
  }

  it("backfills only the exact receipt, then the real runner completes provider deletion and physical erasure", async () => {
    const { f, workers, accepted } = await committedWithoutWake();
    const other = await seedReadyCloudWorkspace(pool);
    await withSystemTx(pool, tx => requestCloudWorkspaceDeletion(tx, {
      ...other, actorUserId: other.userId, idempotencyKey: `migration-unreceipted:${randomUUID()}`,
    }));
    await runDueLifecycleJobs(pool, workers.reconciler, ["lifecycle"]);
    expect((await jobs()).rows).toEqual([]);
    const before = await retained(f), unrelated = await retained(other);
    const objectKey = (await pool.query("SELECT object_key FROM workspace_blobs WHERE id=$1", [f.blobId])).rows[0].object_key;
    await apply();
    const queued = (await jobs()).rows;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ workspace_id: f.workspaceId, org_id: f.organizationId, state: "queued", due: true });
    expect(await retained(f)).toEqual(before);
    expect(await retained(other)).toEqual(unrelated);
    await apply();
    expect((await jobs()).rows).toEqual(queued);

    let completed = 0;
    const runner = new JobRunner({ pool, ownerId: "discard-backfill-runner", concurrency: 1, pollIntervalMs: 1_000,
      logger: workers.logger,
      handlers: [{ kind, leaseMs: 60_000, timeoutMs: 10_000,
        handle: (job, { signal }) => workers.reconciler.runJob(job, signal) }],
      observe: event => { if (event.operation === "complete") completed += event.rows; },
    });
    runner.start();
    try {
      await vi.waitFor(async () => {
        expect(completed).toBeGreaterThan(0);
        expect(runner.inFlight).toBe(0);
        expect((await jobs()).rows).toEqual([]);
      }, { timeout: 5_000, interval: 10 });
    } finally { await runner.stop(); }
    expect(workers.provider.delete).toHaveBeenCalledExactlyOnceWith(f.resourceId);
    expect((await workers.journal.get(f.resourceId))?.deletedAt).toBeInstanceOf(Date);
    expect((await pool.query("SELECT retired_at,sealed_sequence,seal_ack FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1",
      [f.writerEpoch])).rows[0]).toEqual({ retired_at: expect.any(Date), sealed_sequence: null, seal_ack: null });
    for (let pass = 0; pass < 6; pass++) await workers.erasure.processDeletionOnce();
    expect(await f.store.get(objectKey)).toBeNull();
    expect((await pool.query("SELECT data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].erased)
      .toBe(true);
    for (const table of ["workspace_record_events", "workspace_record_entities", "workspace_blob_references"]) {
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`, [f.workspaceId])).rowCount, table).toBe(0);
    }
    expect(await retained(other)).toEqual(unrelated);
    expect(await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: accepted.approval }))
      .toMatchObject({ state: "unchanged", receiptId: accepted.receiptId, deleteIntentId: f.deleteId,
        providerDeletion: "verified", dataErasure: "complete" });
    await apply();
    expect((await jobs()).rows).toEqual([]);
    expect(workers.provider.create).not.toHaveBeenCalled();
    expect(workers.provider.start).not.toHaveBeenCalled();
    expect(workers.logger.error.mock.calls).toEqual([]);
  }, 30_000);

  it("rolls back both the new scheduling function and backfill if the migration does not commit", async () => {
    const { f } = await committedWithoutWake(), before = await retained(f);
    const definition = () => pool.query("SELECT pg_get_functiondef('cloud_final_save_jobs()'::regprocedure) AS body");
    const parent = (await definition()).rows;
    await apply(migration, true);
    expect((await jobs()).rows).toEqual([]);
    expect((await definition()).rows).toEqual(parent);
    expect(await retained(f)).toEqual(before);
    await apply();
    expect((await jobs()).rows).toHaveLength(1);
  }, 30_000);

  it("includes an old-trigger discard that is still uncommitted when migration starts", async () => {
    const f = await seedExistingDelete(pool), workers = existingDeleteWorkers(pool, f);
    await runDueLifecycleJobs(pool, workers.reconciler, ["lifecycle"]);
    expect((await jobs()).rows).toEqual([]);
    const plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    const discarded = latch(), resume = latch();
    const gated = { connect: async () => {
      const client = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (sql.includes("UPDATE cloud_workspace_final_save_recoveries SET state='discarded'")) {
          discarded.resolve();
          await resume.promise;
        }
        return result;
      }, release: () => client.release() };
    } } as unknown as pg.Pool;
    const executing = manageCloudOwnerDiscardDelete(gated, f.request, { ...options(), execute: true, approval: plan.approval })
      .then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    const client = await pool.connect();
    let finished = false, migrationError: unknown, migrating: Promise<void> | undefined;
    try {
      await Promise.race([discarded.promise, executing.then(result => { throw result.error ?? new Error("discard gate not reached"); })]);
      expect((await jobs()).rows).toEqual([]);
      expect((await pool.query("SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts")).rowCount).toBe(0);
      await client.query("BEGIN");
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const source = await readFile(new URL(migration, directory), "utf8");
      migrating = (async () => { await client.query(source); await client.query("COMMIT"); })()
        .catch((error: unknown) => { migrationError = error; }).finally(() => { finished = true; });
      // Observe either the migration's completion or its actual lock wait;
      // release the old writer only after one of those boundaries is reached.
      await vi.waitFor(async () => {
        const waiting = (await pool.query(`SELECT wait_event_type='Lock' AS waiting
          FROM pg_stat_activity WHERE pid=$1`, [pid])).rows[0]?.waiting;
        expect(finished || waiting === true).toBe(true);
      }, { timeout: 3_000, interval: 10 });
    } finally {
      resume.resolve();
      await executing;
      await migrating;
      try { await client.query("ROLLBACK"); } finally { client.release(); }
    }
    expect(migrationError).toBeUndefined();
    expect((await executing).error).toBeUndefined();
    expect((await executing).value).toMatchObject({ state: "deleting", deleteIntentId: f.deleteId });
    expect((await jobs()).rows).toMatchObject([{ workspace_id: f.workspaceId, state: "queued", due: true }]);
    await runDueLifecycleJobs(pool, workers.reconciler, ["lifecycle"]);
    expect(workers.provider.delete).toHaveBeenCalledExactlyOnceWith(f.resourceId);
  }, 30_000);

  it("excludes a receipt whose current authority is no longer valid", async () => {
    const { f, workers } = await committedWithoutWake();
    await pool.query("UPDATE workspace_blobs SET legal_hold=true WHERE id=$1", [f.blobId]);
    expect((await pool.query("SELECT cloud_owner_existing_delete_current($1) AS current", [f.deleteId])).rows[0].current).toBe(false);
    const before = await retained(f);
    await apply();
    expect((await jobs()).rows).toEqual([]);
    expect(await retained(f)).toEqual(before);
    expect(await workers.erasure.processDeletionOnce()).toBe(false);
    expect(workers.provider.delete).not.toHaveBeenCalled();
  }, 30_000);

  it("does not revive a terminal Delete after a real nonretryable provider failure", async () => {
    const { f, workers } = await committedWithoutWake();
    workers.provider.delete.mockRejectedValue(new CloudProviderError("provider_storage_blocked", "Synthetic refusal", false));
    await workers.reconciler.auditJobs();
    await runDueLifecycleJobs(pool, workers.reconciler, ["lifecycle"]);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.deleteId])).rows[0].state).toBe("failed");
    expect((await jobs()).rows).toEqual([]);
    const before = await retained(f);
    await apply();
    expect((await jobs()).rows).toEqual([]);
    expect(await retained(f)).toEqual(before);
    expect(workers.provider.delete).toHaveBeenCalledOnce();
    expect(await workers.erasure.processDeletionOnce()).toBe(false);
  }, 30_000);

  it("preserves a dispatch in progress and records one rerun on its running job", async () => {
    const { f, workers } = await committedWithoutWake();
    await workers.reconciler.auditJobs();
    const [job] = (await claimJobs(pool, { owner: "migration-dispatch", limit: 1, kinds: [{ kind, leaseMs: 60_000 }] })).jobs;
    expect(job?.workspaceId).toBe(f.workspaceId);
    const entered = latch(), resume = latch(), original = workers.provider.delete.getMockImplementation()!;
    workers.provider.delete.mockImplementation(async () => { entered.resolve(); await resume.promise; await original(); });
    const running = workers.reconciler.runJob(job!);
    try {
      await Promise.race([entered.promise, running.then(() => { throw new Error("provider gate not reached"); })]);
      expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.deleteId])).rows[0].state)
        .toBe("dispatching");
      const before = await retained(f);
      await apply();
      expect((await jobs()).rows).toMatchObject([{ id: job!.id, state: "running", rerun_due: true }]);
      expect(await retained(f)).toEqual(before);
    } finally { resume.resolve(); await running; }
    expect(await completeJob(pool, job!)).toBe("requeued");
    await runDueLifecycleJobs(pool, workers.reconciler, ["lifecycle"]);
    expect((await jobs()).rows).toEqual([]);
    expect(workers.provider.delete).toHaveBeenCalledOnce();
    expect(workers.logger.error.mock.calls).toEqual([]);
  }, 30_000);

  it("keeps an observing Delete's future retry clock authoritative after an early backfill hint", async () => {
    const { f, workers } = await committedWithoutWake();
    workers.provider.delete.mockRejectedValue(new CloudProviderError("provider_unavailable", "Synthetic retry", true));
    await workers.reconciler.auditJobs();
    await runDueLifecycleJobs(pool, workers.reconciler, ["lifecycle"]);
    const intent = (await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=$1", [f.deleteId])).rows[0].value;
    expect(intent.state).toBe("observing");
    expect(Date.parse(intent.next_attempt_at)).toBeGreaterThan(Date.now());
    const before = await retained(f);
    await apply();
    expect((await jobs()).rows).toMatchObject([{ state: "queued", due: true }]);
    expect(await retained(f)).toEqual(before);
    await runDueLifecycleJobs(pool, workers.reconciler, ["lifecycle"]);
    expect((await jobs()).rows).toMatchObject([{ state: "queued", due: false }]);
    expect((await jobs()).rows[0].run_at.toISOString()).toBe(new Date(intent.next_attempt_at).toISOString());
    expect(workers.provider.delete).toHaveBeenCalledOnce();
  }, 30_000);
});
