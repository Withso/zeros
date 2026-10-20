import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { existingDeleteWorkers, seedExistingDelete } from "./cloud-workspaces/owner-existing-delete-test-fixtures.js";
import { resetDeliveredHistory, seedDeliveredHistoryRepair } from "./cloud-workspaces/w3-existing-delete-delivered-history-fixtures.js";
import { seedReadyCloudWorkspace } from "./cloud-workspaces/test-fixtures.js";
import { requestCloudWorkspaceDeletion } from "./cloud-workspaces/routes.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("W3 existing Delete admission and stale worker boundaries", () => {
  let pool: pg.Pool, app: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 });
    app = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=zeros_app", max: 2 });
  });
  afterAll(async () => { await app.end(); await pool.end(); });
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });

  function pauseAfterReceipt() {
    const inserted = latch(), resume = latch();
    const gated = { connect: async () => {
      const client = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (sql.includes("INSERT INTO cloud_workspace_owner_existing_delete_receipts")) {
          inserted.resolve();
          await resume.promise;
        }
        return result;
      }, release: () => client.release() };
    } } as unknown as pg.Pool;
    return { inserted, resume, pool: gated };
  }

  async function execute(f: Awaited<ReturnType<typeof seedExistingDelete>>) {
    const plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    return manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: plan.approval });
  }

  it.each(["intent", "custody", "capture", "content"] as const)(
    "serializes %s changes while the first receipt is invisible to another app transaction", async kind => {
      const f = await seedExistingDelete(pool);
      const before = (await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0].value;
      const plan = await manageCloudOwnerDiscardDelete(pool, f.request, options()), gate = pauseAfterReceipt();
      const running = manageCloudOwnerDiscardDelete(gate.pool, f.request, { ...options(), execute: true, approval: plan.approval })
        .then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
      await Promise.race([gate.inserted.promise, running.then(result => { throw result.error ?? new Error("Receipt gate not reached"); })]);
      let invisible: number | undefined, mutationError: unknown;
      let result: Awaited<typeof running>;
      try {
        invisible = (await withSystemTx(app, tx => tx.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_existing_delete_receipts"))).rows[0].n;
        mutationError = await withSystemTx(app, async tx => {
          await tx.query("SET LOCAL lock_timeout='250ms'");
          if (kind === "intent") await tx.query("UPDATE cloud_workspace_lifecycle_intents SET attempt_count=attempt_count+1 WHERE id=$1", [f.deleteId]);
          if (kind === "custody") await tx.query("UPDATE cloud_workspace_final_save_recoveries SET custody_id=$2 WHERE lifecycle_intent_id=$1", [f.deleteId, randomUUID()]);
          if (kind === "capture") await tx.query("UPDATE workspace_checkpoint_requests SET error_code='w3_late_metadata' WHERE workspace_id=$1 AND reason='manual'", [f.workspaceId]);
          if (kind === "content") await tx.query("UPDATE workspace_content_heads SET current_revision=current_revision+1 WHERE workspace_id=$1", [f.workspaceId]);
        }).then(() => undefined, (error: unknown) => error);
      } finally { gate.resume.resolve(); result = await running; }
      expect(invisible).toBe(0);
      expect(mutationError).toMatchObject({ code: "55P03" });
      expect(result.error).toBeUndefined();
      expect(result.value).toMatchObject({ state: "deleting", deleteIntentId: f.deleteId });
      expect((await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0].value)
        .toEqual({ ...before, state: "discarded", next_attempt_at: "infinity" });
      expect((await pool.query(`SELECT receipt.source->'recovery'->>'custody_id' AS approved_custody,
        (SELECT attempt_count FROM cloud_workspace_lifecycle_intents WHERE id=receipt.delete_intent_id) AS actual_attempts,
        (SELECT current_revision::int FROM workspace_content_heads WHERE workspace_id=receipt.workspace_id) AS revision
        FROM cloud_workspace_owner_existing_delete_receipts receipt WHERE id=$1`, [f.request.operationId])).rows[0])
        .toEqual({ approved_custody: null, actual_attempts: 0, revision: 1 });
    }, 30_000,
  );

  it("refuses custody acquired before admission without issuing a loss receipt", async () => {
    const f = await seedExistingDelete(pool), plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    await withSystemTx(app, tx => tx.query("UPDATE cloud_workspace_final_save_recoveries SET custody_id=$2 WHERE lifecycle_intent_id=$1", [f.deleteId, randomUUID()]));
    await expect(manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: plan.approval }))
      .rejects.toMatchObject({ code: "owner_delete_source_unavailable" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_existing_delete_receipts")).rows[0].n).toBe(0);
  });

  it("retains the committed recovery byte-for-byte against a stale app retry or custody write", async () => {
    const f = await seedExistingDelete(pool);
    await execute(f);
    const before = (await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0].value;
    await withSystemTx(app, tx => tx.query(`UPDATE cloud_workspace_final_save_recoveries SET custody_id=$2,state='retrying',
      retry_count=retry_count+1,next_attempt_at=clock_timestamp(),last_failure='custody' WHERE lifecycle_intent_id=$1`, [f.deleteId, randomUUID()]));
    expect((await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0].value).toEqual(before);
    await expect(withSystemTx(app, tx => tx.query("UPDATE workspace_checkpoint_requests SET error_code='w3_late_capture' WHERE workspace_id=$1", [f.workspaceId])))
      .rejects.toMatchObject({ code: "40001" });
    expect((await withSystemTx(app, tx => tx.query("SELECT cloud_final_save_proven($1) AS proven,cloud_final_save_dispatchable($1) AS dispatchable", [f.deleteId]))).rows[0])
      .toEqual({ proven: false, dispatchable: true });
  });

  it("does not revive a positively completed Delete through stale app updates", async () => {
    const f = await seedExistingDelete(pool), workers = existingDeleteWorkers(pool, f);
    const accepted = await execute(f);
    await workers.reconciler.runOnce(f.workspaceId);
    const before = (await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=$1", [f.deleteId])).rows[0].value;
    expect(before.state).toBe("succeeded");
    for (const sql of ["UPDATE cloud_workspace_lifecycle_intents SET state='queued',completed_at=NULL WHERE id=$1",
      "UPDATE cloud_workspace_lifecycle_intents SET error_code='late_retry',attempt_count=attempt_count+1 WHERE id=$1"]) {
      await expect(withSystemTx(app, tx => tx.query(sql, [f.deleteId]))).rejects.toMatchObject({ code: "40001" });
    }
    expect(await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: accepted.approval })).toMatchObject({ state: "unchanged" });
    expect((await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=$1", [f.deleteId])).rows[0].value).toEqual(before);
    expect(workers.provider.delete).toHaveBeenCalledOnce();
  });

  it("retains both terminal lifecycle rows and delivered capture facts after historical disposition", async () => {
    await resetDeliveredHistory(pool);
    const f = await seedDeliveredHistoryRepair(pool), plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    const before = (await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=ANY($1::uuid[]) ORDER BY id", [[f.stopId, f.deleteId]])).rows;
    await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: plan.approval });
    for (const id of [f.stopId, f.deleteId]) {
      await expect(withSystemTx(app, tx => tx.query("UPDATE cloud_workspace_lifecycle_intents SET state='queued',completed_at=NULL WHERE id=$1", [id])))
        .rejects.toMatchObject({ code: "40001" });
    }
    expect((await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=ANY($1::uuid[]) ORDER BY id", [[f.stopId, f.deleteId]])).rows).toEqual(before);
    const capture = (await pool.query("SELECT to_jsonb(q) AS value FROM workspace_checkpoint_requests q WHERE id=$1", [f.requestId])).rows[0].value;
    await withSystemTx(app, tx => tx.query("UPDATE workspace_checkpoint_requests SET delivery_count=delivery_count+1 WHERE id=$1", [f.requestId]));
    expect((await pool.query("SELECT to_jsonb(q) AS value FROM workspace_checkpoint_requests q WHERE id=$1", [f.requestId])).rows[0].value).toEqual(capture);
  }, 30_000);

  it("keeps another organization's accepted Delete outside A's receipt through A to B to A", async () => {
    const a = await seedExistingDelete(pool), b = await seedReadyCloudWorkspace(pool);
    expect(b.organizationId).not.toBe(a.organizationId);
    const bDelete = await withSystemTx(pool, tx => requestCloudWorkspaceDeletion(tx, { ...b, actorUserId: b.userId, idempotencyKey: `w3-isolation:${randomUUID()}` }));
    const before = (await pool.query("SELECT to_jsonb(w) AS value FROM cloud_workspaces w WHERE id=$1", [b.workspaceId])).rows[0].value;
    const accepted = await execute(a);
    expect((await pool.query("SELECT to_jsonb(w) AS value FROM cloud_workspaces w WHERE id=$1", [b.workspaceId])).rows[0].value).toEqual(before);
    expect((await withSystemTx(app, tx => tx.query("SELECT cloud_final_save_dispatchable($1) AS a,cloud_final_save_dispatchable($2) AS b", [a.deleteId, bDelete.intent.id]))).rows[0])
      .toEqual({ a: true, b: false });
    expect(await manageCloudOwnerDiscardDelete(pool, a.request, { ...options(), execute: true, approval: accepted.approval })).toMatchObject({ state: "unchanged", deleteIntentId: a.deleteId });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_existing_delete_receipts")).rows[0].n).toBe(1);
  });
});
