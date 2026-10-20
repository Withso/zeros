import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { resetDeliveredHistory, migrateDeliveredHistory } from "./cloud-workspaces/w3-existing-delete-delivered-history-fixtures.js";
import { seedReadyCloudWorkspace } from "./cloud-workspaces/test-fixtures.js";
import { seedOwnerDiscardDelete, ownerDiscardDeleteRequest } from "./cloud-workspaces/owner-discard-delete-test-fixtures.js";
import { existingDeleteWorkers } from "./cloud-workspaces/owner-existing-delete-test-fixtures.js";
import { withSystemTx } from "./db.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("owner loss inventory retains successful legacy idle history with no capture", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString:process.env.TEST_DATABASE_URL,max:6 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetDeliveredHistory(pool),30_000);
  async function scenario() {
    const first = await seedReadyCloudWorkspace(pool), idleId = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,operation,state,completed_at,attempt_count,dispatched_at,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,'stop','succeeded',clock_timestamp(),5,clock_timestamp(),
        'system:idle:'||$4::text||':legacy',digest($1::text,'sha256'))`, [idleId,first.workspaceId,first.organizationId,first.engineInstanceId]);
    await migrateDeliveredHistory(pool,"adoption");
    const f = await seedOwnerDiscardDelete(pool,{ readyFixture:first,crashedReady:true });
    const request = await ownerDiscardDeleteRequest(pool,f), options = { databaseUrl:process.env.TEST_DATABASE_URL! };
    const plan = await manageCloudOwnerDiscardDelete(pool,request,options);
    const accepted = await manageCloudOwnerDiscardDelete(pool,request,{ ...options,execute:true,approval:plan.approval });
    const receipt = (await pool.query("SELECT source FROM cloud_workspace_owner_delete_receipts WHERE id=$1", [accepted.receiptId])).rows[0].source;
    expect(receipt.history).toContainEqual(expect.objectContaining({ id:idleId,state:"succeeded",attemptCount:5,recovery:null }));
    expect((await pool.query("SELECT cloud_workspace_drain_is_mandatory($1) AS mandatory", [idleId])).rows[0].mandatory).toBe(false);
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [idleId])).rows[0].n).toBe(0);
    const workers = existingDeleteWorkers(pool,f);
    return { ...f,idleId,accepted,workers,receipt };
  }
  it("admits only the captured historical gap after its approved Delete really completes", async () => {
    const f = await scenario();
    await f.workers.reconciler.runOnce(f.workspaceId);
    expect(f.workers.provider.delete).toHaveBeenCalledExactlyOnceWith(f.resourceId);
    expect((await f.workers.journal.get(f.resourceId))?.deletedAt).toBeInstanceOf(Date);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.accepted.deleteIntentId])).rows[0].state).toBe("succeeded");
    await migrateDeliveredHistory(pool,"repair");
    expect((await pool.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS allowed", [f.workspaceId,f.organizationId])).rows[0].allowed).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.idleId])).rows[0].n).toBe(0);
    for (let pass=0; pass<6; pass++) await f.workers.erasure.processDeletionOnce();
    expect(f.workers.logger.error.mock.calls).toEqual([]);
    expect((await pool.query("SELECT data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].erased).toBe(true);
    expect((await pool.query("SELECT source FROM cloud_workspace_owner_delete_receipts WHERE id=$1", [f.accepted.receiptId])).rows[0].source).toEqual(f.receipt);
  },30_000);
  it("control: owner loss does not allow erasure before the real provider Delete", async () => {
    const f = await scenario();
    await migrateDeliveredHistory(pool,"repair");
    expect((await pool.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS allowed", [f.workspaceId,f.organizationId])).rows[0].allowed).toBe(false);
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE workspace_deletion_jobs SET lease_owner='legacy',lease_expires_at=clock_timestamp()+interval '1 minute'
      WHERE workspace_id=$1`, [f.workspaceId]))).rejects.toMatchObject({ code:"40001" });
  },30_000);
});
