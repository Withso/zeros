import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { ownerDiscardDeleteRequest, seedOwnerDiscardDelete } from "./cloud-workspaces/owner-discard-delete-test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("owner discard is atomic and bounded", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });
  async function fixture(crashedReady = false) {
    const f = await seedOwnerDiscardDelete(pool, { crashedReady });
    return { ...f, request: await ownerDiscardDeleteRequest(pool, f) };
  }
  async function execute(f: Awaited<ReturnType<typeof fixture>>) {
    const plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    return manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: plan.approval });
  }

  it("cannot commit a valid source receipt without its exact normal Delete and dispositions", async () => {
    const f = await fixture(), client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.system','on',true)");
      const inserted = await client.query(`INSERT INTO cloud_workspace_owner_delete_receipts
        (id,workspace_id,org_id,generation,stop_intent_id,request_id,owner_user_id,operator_user_id,
         owner_acknowledged_complete_loss,owner_approval_reference,reason,source,source_sha256,
         delete_key,request_sha256,plan_sha256,target_fingerprint,database_principal)
        SELECT $1::uuid,$2,$3,1,$4,$5,$6,$6,true,'Synthetic exact owner approval','Synthetic complete loss request',
          source,digest(convert_to(source::text,'UTF8'),'sha256'),'owner-discard-delete.'||$1::text,
          digest('request','sha256'),digest('plan','sha256'),repeat('a',64),current_user
        FROM (SELECT cloud_owner_delete_source($4) AS source) observed`,
      [f.request.operationId,f.workspaceId,f.organizationId,f.stopId,f.requestId,f.userId]);
      expect(inserted.rowCount).toBe(1);
      await expect(client.query("COMMIT")).rejects.toMatchObject({code:"23514"});
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT state FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1",[f.stopId])).rows[0].state).toBe("blocked");
  });

  it("allows the normal application worker to read exact authority, never final-save proof", async () => {
    const f = await fixture(), accepted = await execute(f);
    const observed = await withSystemTx(pool, tx => tx.query(`SELECT current_user AS principal,
      cloud_final_save_dispatchable($1) AS dispatchable,cloud_final_save_proven($1) AS proven,
      cloud_final_save_deletion_claimable($2,$3) AS claimable,cloud_workspace_data_purge_authorized($2,$3) AS purge`,
    [accepted.deleteIntentId,f.workspaceId,f.organizationId]));
    expect(observed.rows[0]).toEqual({principal:"zeros_app",dispatchable:true,proven:false,claimable:false,purge:false});
  });

  it("refuses premature native retirement while retaining the delivered unsealed writer", async () => {
    const f = await fixture(true); await execute(f);
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_local_command_writers
      SET state='retired',retired_at=clock_timestamp() WHERE workspace_id=$1 AND writer_epoch=$2`,[f.workspaceId,f.writerEpoch])))
      .rejects.toMatchObject({code:"40001"});
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_agent_boot_bindings SET retired_at=clock_timestamp() WHERE workspace_id=$1",[f.workspaceId])))
      .rejects.toMatchObject({code:"40001"});
    expect((await pool.query("SELECT state,retired_at,sealed_sequence,seal_ack FROM cloud_workspace_local_command_writers WHERE workspace_id=$1",[f.workspaceId])).rows[0])
      .toEqual({state:"active",retired_at:null,sealed_sequence:null,seal_ack:null});
  });

  it("refuses an oversized source during planning before offering an unusable approval", async () => {
    const f = await fixture();
    await pool.query(`INSERT INTO workspace_checkpoint_requests
      (workspace_id,org_id,generation,reason,state,idempotency_key,created_at,deadline_at,completed_at,final_save_capture_report)
      SELECT $1,$2,1,'manual','failed','large-report.'||n::text,now()-interval '2 minutes',now()-interval '1 minute',now(),jsonb_build_object('detail',repeat('a',7000))
      FROM generate_series(1,160) n`,[f.workspaceId,f.organizationId]);
    const size = (await pool.query("SELECT octet_length(cloud_owner_delete_source($1)::text) AS bytes",[f.stopId])).rows[0].bytes;
    expect(size).toBeGreaterThan(1_048_576);
    await expect(manageCloudOwnerDiscardDelete(pool,f.request,options())).rejects.toMatchObject({code:"owner_delete_source_too_large"});
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts")).rows[0].n).toBe(0);
  });
});
