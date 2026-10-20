import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "../db.js";
import { claimJobs, completeJob, enqueueJobStandalone } from "../job-queue.js";
import { manageCloudOwnerDiscardDelete } from "../manage-cloud-owner-discard-delete.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { runDueLifecycleJobs } from "./lifecycle-job-test-utils.js";
import { existingDeleteWorkers, seedExistingDelete } from "./owner-existing-delete-test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const kind = "cloud_lifecycle_intent";
type Fixture = Awaited<ReturnType<typeof seedExistingDelete>>;

suite("discarded recovery wake transaction and queue boundaries", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });
  afterAll(async () => { await pool.end(); });
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });
  const jobs = (f: Fixture) => pool.query(
    "SELECT to_jsonb(job) AS value FROM control_plane_jobs job WHERE workspace_id=$1 AND kind=$2", [f.workspaceId, kind]);
  const enqueue = (f: Fixture, runAt?: Date) => enqueueJobStandalone(pool, {
    kind, dedupeKey: `workspace:${f.workspaceId}`, orgId: f.organizationId, workspaceId: f.workspaceId,
    ...(runAt ? { runAt } : {}),
  });
  async function drained() {
    const f = await seedExistingDelete(pool), workers = existingDeleteWorkers(pool, f);
    expect(await runDueLifecycleJobs(pool, workers.reconciler, ["lifecycle"])).toBeGreaterThan(0);
    expect((await jobs(f)).rows).toEqual([]);
    expect(workers.provider.delete).not.toHaveBeenCalled();
    return { f, workers };
  }
  async function accept(f: Fixture) {
    const plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    return manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: plan.approval });
  }

  it("rolls the new job back with a receipt failure after the discard update", async () => {
    const { f, workers } = await drained();
    const plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    let scheduledInside = false, invisibleOutside = false;
    const failing = { connect: async () => {
      const client = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (sql.includes("UPDATE cloud_workspace_final_save_recoveries SET state='discarded'")) {
          scheduledInside = (await client.query("SELECT 1 FROM control_plane_jobs WHERE workspace_id=$1 AND kind=$2",
            [f.workspaceId, kind])).rowCount === 1;
          invisibleOutside = (await jobs(f)).rows.length === 0;
          throw new Error("synthetic_failure_after_discard");
        }
        return result;
      }, release: () => client.release() };
    } } as unknown as pg.Pool;
    await expect(manageCloudOwnerDiscardDelete(failing, f.request, { ...options(), execute: true, approval: plan.approval }))
      .rejects.toThrow("synthetic_failure_after_discard");
    expect({ scheduledInside, invisibleOutside }).toEqual({ scheduledInside: true, invisibleOutside: true });
    expect((await jobs(f)).rows).toEqual([]);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts")).rowCount).toBe(0);
    expect((await pool.query("SELECT state FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1",
      [f.deleteId])).rows[0].state).toBe("blocked");
    expect(workers.provider.delete).not.toHaveBeenCalled();
  }, 30_000);

  it("moves one queued job earlier, preserves recovery scheduling, and does not enqueue on receipt replay", async () => {
    const { f } = await drained();
    await enqueue(f, new Date(Date.now() + 600_000));
    const original = (await jobs(f)).rows[0].value;
    const recoveryJobs = () => pool.query(`SELECT to_jsonb(job) AS value FROM control_plane_jobs job
      WHERE workspace_id=$1 AND kind='cloud_final_save_recovery' ORDER BY id`, [f.workspaceId]);
    const recoveryBefore = (await recoveryJobs()).rows;
    const accepted = await accept(f), after = (await jobs(f)).rows;
    expect(after).toHaveLength(1);
    expect(after[0].value).toMatchObject({ id: original.id, state: "queued", org_id: f.organizationId, workspace_id: f.workspaceId });
    expect(Date.parse(after[0].value.run_at)).toBeLessThan(Date.parse(original.run_at));
    expect((await recoveryJobs()).rows).toEqual(recoveryBefore);
    expect(await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: accepted.approval }))
      .toMatchObject({ state: "unchanged", receiptId: accepted.receiptId });
    expect((await jobs(f)).rows).toEqual(after);
  }, 30_000);

  it("retains a wake that arrives while the prior blocked job is completing", async () => {
    const { f, workers } = await drained();
    await enqueue(f);
    const [running] = (await claimJobs(pool, {
      owner: "discard-wake-boundary", limit: 1, kinds: [{ kind, leaseMs: 60_000 }],
    })).jobs;
    expect(running?.workspaceId).toBe(f.workspaceId);
    // The old handler observed the block, but has not completed its queue row.
    await workers.reconciler.runJob(running!);
    expect(workers.provider.delete).not.toHaveBeenCalled();
    await accept(f);
    const row = (await jobs(f)).rows[0].value;
    expect(row).toMatchObject({ id: running!.id, state: "running", lease_token: running!.leaseToken });
    expect(row.rerun_at).not.toBeNull();
    expect(await completeJob(pool, running!)).toBe("requeued");
    expect((await jobs(f)).rows[0].value).toMatchObject({ id: running!.id, state: "queued", attempts: 0 });
    await runDueLifecycleJobs(pool, workers.reconciler, ["lifecycle"]);
    expect(workers.provider.delete).toHaveBeenCalledExactlyOnceWith(f.resourceId);
    expect((await jobs(f)).rows).toEqual([]);
    expect(workers.logger.error.mock.calls).toEqual([]);
  }, 30_000);

  it("cannot authorize an unreceipted discard or dispatch merely by adding a queue hint", async () => {
    const { f, workers } = await drained();
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_final_save_recoveries
      SET state='discarded',next_attempt_at='infinity' WHERE lifecycle_intent_id=$1`, [f.deleteId])))
      .rejects.toMatchObject({ code: "23514" });
    expect((await jobs(f)).rows).toEqual([]);
    await enqueue(f);
    await runDueLifecycleJobs(pool, workers.reconciler, ["lifecycle"]);
    expect((await jobs(f)).rows).toEqual([]);
    expect(workers.provider.delete).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state,attempt_count,dispatched_at FROM cloud_workspace_lifecycle_intents WHERE id=$1",
      [f.deleteId])).rows[0]).toEqual({ state: "queued", attempt_count: 0, dispatched_at: null });
    expect(await workers.erasure.processDeletionOnce()).toBe(false);
  }, 30_000);
});
