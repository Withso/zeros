import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { existingDeleteWorkers, seedExistingDelete } from "./cloud-workspaces/owner-existing-delete-test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("W3 captured idle history never borrows a different loss receipt family", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));

  it("retains a successful idle history gap despite a completed existing-Delete loss receipt", async () => {
    const f = await seedExistingDelete(pool), idleId = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,operation,state,completed_at,attempt_count,dispatched_at,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,2,'stop','succeeded',clock_timestamp(),5,clock_timestamp(),
        'system:idle:'||$4::text||':legacy',digest($1::text,'sha256'))`, [idleId,f.workspaceId,f.organizationId,f.engineInstanceId]);
    const options = { databaseUrl: process.env.TEST_DATABASE_URL! };
    const plan = await manageCloudOwnerDiscardDelete(pool,f.request,options);
    const accepted = await manageCloudOwnerDiscardDelete(pool,f.request,{ ...options,execute:true,approval:plan.approval });
    const source = (await pool.query("SELECT source FROM cloud_workspace_owner_existing_delete_receipts WHERE id=$1", [accepted.receiptId])).rows[0].source;
    expect(source.history).toContainEqual(expect.objectContaining({ id: idleId, state: "succeeded", attempt_count: 5 }));
    const workers = existingDeleteWorkers(pool,f);
    await workers.reconciler.runOnce(f.workspaceId);
    expect(workers.provider.delete).toHaveBeenCalledOnce();
    expect((await workers.journal.get(f.resourceId))?.deletedAt).toBeInstanceOf(Date);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.deleteId])).rows[0].state).toBe("succeeded");
    expect((await pool.query(`SELECT cloud_owner_delete_captured_idle_history($1) AS covered,
      cloud_final_save_deletion_claimable($2,$3) AS claimable`, [idleId,f.workspaceId,f.organizationId])).rows[0])
      .toEqual({ covered:false,claimable:false });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [idleId])).rows[0].n).toBe(0);
    expect(await workers.erasure.processDeletionOnce()).toBe(false);
    expect((await pool.query("SELECT data_deleted_at FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].data_deleted_at).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_blob_references WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBeGreaterThan(0);
  });
});
