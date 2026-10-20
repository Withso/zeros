import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { existingDeleteWorkers, seedExistingDelete } from "./cloud-workspaces/owner-existing-delete-test-fixtures.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve=done; });
  return { promise,resolve };
}
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("existing Delete loss receipt boundaries", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool=new pg.Pool({ connectionString:process.env.TEST_DATABASE_URL,max:6 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options=() => ({ databaseUrl:process.env.TEST_DATABASE_URL! });
  async function accept(f: Awaited<ReturnType<typeof seedExistingDelete>>) {
    const plan=await manageCloudOwnerDiscardDelete(pool,f.request,options());
    return manageCloudOwnerDiscardDelete(pool,f.request,{ ...options(),execute:true,approval:plan.approval });
  }

  it("refuses app-role loss authority without a migration-owner receipt", async () => {
    const f=await seedExistingDelete(pool);
    await expect(withSystemTx(pool,tx => tx.query("INSERT INTO cloud_workspace_owner_existing_delete_receipts DEFAULT VALUES")))
      .rejects.toMatchObject({ code:"42501" });
    await expect(withSystemTx(pool,tx => tx.query("UPDATE cloud_workspace_final_save_recoveries SET state='discarded' WHERE lifecycle_intent_id=$1",[f.deleteId])))
      .rejects.toMatchObject({ code:"23514" });
    expect((await pool.query("SELECT state FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1",[f.deleteId])).rows[0].state).toBe("blocked");
  });

  it.each([false,true])("rolls back a valid receipt missing its required atomic projection (disposition=%s)", async disposition => {
    const f=await seedExistingDelete(pool),client=await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.system','on',true)");
      const result=await client.query(`INSERT INTO cloud_workspace_owner_existing_delete_receipts
        (id,workspace_id,org_id,generation,delete_intent_id,recovery_intent_id,kind,owner_user_id,operator_user_id,
         owner_acknowledged_complete_loss,owner_approval_reference,reason,source,source_sha256,recovery_sha256,delete_key,
         delete_sha256,request_sha256,plan_sha256,target_fingerprint,database_principal)
        SELECT $1,$2,$3,2,$4,$4,'pending_delete',$5,$5,true,'Synthetic complete-loss acknowledgement','Synthetic exact existing Delete loss',
          source,digest(convert_to(source::text,'UTF8'),'sha256'),decode(source->>'recoverySha256','hex'),source->>'deleteKey',
          decode(source->>'deleteSha256','hex'),digest('request','sha256'),digest('plan','sha256'),repeat('a',64),current_user
        FROM (SELECT cloud_owner_existing_delete_source($4,$4) AS source) observed`,
      [f.request.operationId,f.workspaceId,f.organizationId,f.deleteId,f.userId]);
      expect(result.rowCount).toBe(1);
      if (disposition) await client.query("UPDATE cloud_workspace_final_save_recoveries SET state='discarded',next_attempt_at='infinity' WHERE lifecycle_intent_id=$1",[f.deleteId]);
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code:"23514" });
    } finally { await client.query("ROLLBACK");client.release(); }
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_existing_delete_receipts")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT state FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1",[f.deleteId])).rows[0].state).toBe("blocked");
  });

  it.each(["attempt","custody","content"] as const)("serializes %s drift before the first receipt becomes visible", async kind => {
    const f=await seedExistingDelete(pool),plan=await manageCloudOwnerDiscardDelete(pool,f.request,options());
    const inserted=latch(),resume=latch();
    const gated={ connect:async () => {
      const client=await pool.connect();
      return { query:async (text:string,values?:unknown[]) => {
        const result=await client.query(text,values);
        if (text.includes("INSERT INTO cloud_workspace_owner_existing_delete_receipts")) {
          inserted.resolve();await resume.promise;
        }
        return result;
      },release:() => client.release() };
    } } as unknown as pg.Pool;
    const running=manageCloudOwnerDiscardDelete(gated,f.request,{ ...options(),execute:true,approval:plan.approval })
      .then(value => ({ value,error:undefined }),error => ({ value:undefined,error }));
    await Promise.race([inserted.promise,running.then(result => { throw result.error ?? new Error("Receipt gate not reached"); })]);
    try {
      await expect(withSystemTx(pool,async tx => {
        await tx.query("SET LOCAL lock_timeout='250ms'");
        if (kind==="attempt") await tx.query("UPDATE cloud_workspace_lifecycle_intents SET attempt_count=attempt_count+1 WHERE id=$1",[f.deleteId]);
        if (kind==="custody") await tx.query("UPDATE cloud_workspace_final_save_recoveries SET custody_id=$2 WHERE lifecycle_intent_id=$1",[f.deleteId,randomUUID()]);
        if (kind==="content") await tx.query("UPDATE workspace_content_heads SET current_revision=current_revision+1 WHERE workspace_id=$1",[f.workspaceId]);
      })).rejects.toMatchObject({ code:"55P03" });
    } finally { resume.resolve();await running; }
    const result=await running;expect(result.error).toBeUndefined();expect(result.value?.state).toBe("deleting");
    const source=(await pool.query("SELECT source FROM cloud_workspace_owner_existing_delete_receipts WHERE id=$1",[f.request.operationId])).rows[0].source;
    expect(source.history).toContainEqual(expect.objectContaining({ id:f.deleteId,attempt_count:0 }));
    expect(source.recovery.custody_id).toBeNull();
    expect((await pool.query("SELECT attempt_count FROM cloud_workspace_lifecycle_intents WHERE id=$1",[f.deleteId])).rows[0].attempt_count).toBe(0);
    expect((await pool.query("SELECT custody_id FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1",[f.deleteId])).rows[0].custody_id).toBeNull();
    expect((await pool.query("SELECT current_revision FROM workspace_content_heads WHERE workspace_id=$1",[f.workspaceId])).rows[0].current_revision).toBe("1");
  });

  it("retains a successful actual Delete and refuses replacement, direct receipt deletion and truncation", async () => {
    const f=await seedExistingDelete(pool),workers=existingDeleteWorkers(pool,f),accepted=await accept(f);
    await workers.reconciler.runOnce(f.workspaceId);
    expect(workers.provider.delete).toHaveBeenCalledExactlyOnceWith(f.resourceId);
    const original=(await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=$1",[f.deleteId])).rows[0].value;
    expect(original.state).toBe("succeeded");
    await expect(withSystemTx(pool,tx => tx.query("UPDATE cloud_workspace_lifecycle_intents SET state='queued',completed_at=NULL WHERE id=$1",[f.deleteId])))
      .rejects.toMatchObject({ code:"40001" });
    await expect(withSystemTx(pool,tx => tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1,$2,2,$3,'delete',$4,digest($4::text,'sha256'))`,[f.workspaceId,f.organizationId,f.userId,randomUUID()])))
      .rejects.toMatchObject({ code:"40001" });
    await expect(pool.query("DELETE FROM cloud_workspace_owner_existing_delete_receipts WHERE id=$1",[accepted.receiptId]))
      .rejects.toMatchObject({ code:"55000" });
    await expect(pool.query("TRUNCATE cloud_workspace_owner_existing_delete_receipts"))
      .rejects.toMatchObject({ code:"55000" });
    expect((await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=$1",[f.deleteId])).rows[0].value).toEqual(original);
    expect(await manageCloudOwnerDiscardDelete(pool,f.request,{ ...options(),execute:true,approval:accepted.approval })).toMatchObject({ state:"unchanged" });
  });

  it("keeps selected loss immutable under a stale recovery update", async () => {
    const f=await seedExistingDelete(pool);await accept(f);
    const before=(await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1",[f.deleteId])).rows[0].value;
    await withSystemTx(pool,tx => tx.query("UPDATE cloud_workspace_final_save_recoveries SET state='blocked',custody_id=$2,next_attempt_at=clock_timestamp() WHERE lifecycle_intent_id=$1",[f.deleteId,randomUUID()]));
    expect((await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1",[f.deleteId])).rows[0].value).toEqual(before);
  });
});
