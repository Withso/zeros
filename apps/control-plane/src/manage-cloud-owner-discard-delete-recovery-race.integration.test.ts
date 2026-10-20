import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { ownerDiscardDeleteRequest, seedOwnerDiscardDelete } from "./cloud-workspaces/owner-discard-delete-test-fixtures.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("W3 owner Delete recovery-source admission", () => {
  let pool: pg.Pool, app: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 });
    app = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=zeros_app", max: 2 });
  });
  afterAll(async () => { await app.end(); await pool.end(); });
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });
  async function fixture() {
    const f = await seedOwnerDiscardDelete(pool);
    const request = await ownerDiscardDeleteRequest(pool, f);
    const plan = await manageCloudOwnerDiscardDelete(pool, request, options());
    expect((await pool.query("SELECT custody_id FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.stopId])).rows[0].custody_id).toBeNull();
    return { ...f, request, plan };
  }

  it("does not adopt a late custody identity outside the approved source", async () => {
    const f = await fixture(), inserted = latch(), resume = latch();
    const gated = { connect: async () => {
      const client = await pool.connect();
      return { query: async (text: string, values?: unknown[]) => {
        const result = await client.query(text, values);
        if (text.includes("INSERT INTO cloud_workspace_owner_delete_receipts")) {
          inserted.resolve(); await resume.promise;
        }
        return result;
      }, release: () => client.release() };
    } } as unknown as pg.Pool;
    const running = manageCloudOwnerDiscardDelete(gated, f.request, { ...options(), execute: true, approval: f.plan.approval })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await Promise.race([inserted.promise, running.then(result => { throw result.error ?? new Error("Receipt gate not reached"); })]);
    let refused: string | undefined;
    try {
      await withSystemTx(app, async tx => {
        await tx.query("SET LOCAL lock_timeout='250ms'");
        await tx.query("UPDATE cloud_workspace_final_save_recoveries SET custody_id=$2 WHERE lifecycle_intent_id=$1", [f.stopId, randomUUID()]);
      });
    } catch (error) { refused = (error as { code?: string }).code; }
    finally { resume.resolve(); }
    const result = await running;
    if (refused) expect(["55P03", "40001", "23514"]).toContain(refused);
    if (result.error) {
      expect(["40001", "23514"]).toContain(result.error.code);
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts")).rows[0].n).toBe(0);
      return;
    }
    expect(result.value?.state).toBe("deleting");
    const approved = (await pool.query(`SELECT entry->'recovery'->>'custody_id' AS custody_id
      FROM cloud_workspace_owner_delete_receipts receipt, jsonb_array_elements(receipt.source->'history') entry
      WHERE receipt.id=$1 AND entry->>'id'=$2`, [f.request.operationId, f.stopId])).rows[0].custody_id;
    expect(approved).toBeNull();
    const actual = (await pool.query("SELECT custody_id,state FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.stopId])).rows[0];
    expect(actual.state).toBe("discarded");
    expect(actual.custody_id).toBe(approved);
  });

  it("control: custody that changes before execution requires a new approval", async () => {
    const f = await fixture();
    await withSystemTx(app, tx => tx.query("UPDATE cloud_workspace_final_save_recoveries SET custody_id=$2 WHERE lifecycle_intent_id=$1", [f.stopId, randomUUID()]));
    await expect(manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: f.plan.approval }))
      .rejects.toMatchObject({ code: "owner_delete_approval_mismatch" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts")).rows[0].n).toBe(0);
  });

  it("control: a committed disposition retains its original null custody", async () => {
    const f = await fixture();
    await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: f.plan.approval });
    await withSystemTx(app, tx => tx.query("UPDATE cloud_workspace_final_save_recoveries SET custody_id=$2 WHERE lifecycle_intent_id=$1", [f.stopId, randomUUID()]));
    expect((await pool.query("SELECT custody_id,state FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.stopId])).rows[0])
      .toEqual({ custody_id: null, state: "discarded" });
  });
});
