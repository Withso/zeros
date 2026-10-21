import pg from "pg";
import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx } from "../db.js";
import { runFinalSaveRecovery } from "./final-save-service.js";
import { deliverWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { seedInitialSetupDelete } from "./initial-setup-delete-test-fixtures.js";

const suite=process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Delete admitted during initial setup",()=>{
  let pool:pg.Pool;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6});});
  afterAll(async()=>pool.end());
  beforeEach(async()=>resetMigratedTestDatabase(pool));
  const due=(id:string)=>pool.query("UPDATE cloud_workspace_final_save_recoveries SET next_attempt_at=clock_timestamp() WHERE lifecycle_intent_id=$1",[id]);
  const row=async(id:string)=>(await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1",[id])).rows[0].value;
  it("captures the first registered source for the same accepted Delete after setup completes",async()=>{
    const f=await seedInitialSetupDelete(pool);
    const before=await row(f.deleteId);
    expect(before).toMatchObject({registered_at:null,boot_id:null,writer_epoch:null,current_request_id:null,attempt_ordinal:0});
    const intent=(await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=$1",[f.deleteId])).rows[0].value;
    const job=(await pool.query("SELECT id FROM workspace_deletion_jobs WHERE workspace_id=$1",[f.workspaceId])).rows[0].id;
    await due(f.deleteId);await runFinalSaveRecovery(pool,f.workspaceId,false);
    const blocked=await row(f.deleteId);expect(blocked).toMatchObject({state:"blocked",first_failure:"source_unavailable"});
    await f.ready();await due(f.deleteId);await runFinalSaveRecovery(pool,f.workspaceId,false);
    const requests=(await pool.query("SELECT id,reason,state FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1",[f.deleteId])).rows;
    expect(requests).toEqual([{id:expect.any(String),reason:"before_delete",state:"queued"}]);
    const after=await row(f.deleteId);
    expect(after).toMatchObject({engine_instance_id:f.engineInstanceId,boot_id:f.bootId,writer_epoch:f.writerEpoch,
      attempt_ordinal:0,retry_count:blocked.retry_count,first_failure:blocked.first_failure,failure_started_at:blocked.failure_started_at});
    const directive=await withSystemTx(pool,tx=>deliverWorkspaceCheckpointRequest(tx,{...f.scope,finalSaveVersion:1}));
    expect(directive?.finalSave?.source).toMatchObject({engineInstanceId:f.engineInstanceId,bootId:f.bootId,writerEpoch:f.writerEpoch});
    expect((await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=$1",[f.deleteId])).rows[0].value).toEqual(intent);
    expect((await pool.query("SELECT id FROM workspace_deletion_jobs WHERE workspace_id=$1",[f.workspaceId])).rows[0].id).toBe(job);
  });
  it("keeps an unregistered setup undispatched without inventing a capture or saved proof",async()=>{
    const f=await seedInitialSetupDelete(pool);await due(f.deleteId);await runFinalSaveRecovery(pool,f.workspaceId,false);
    expect(await row(f.deleteId)).toMatchObject({registered_at:null,boot_id:null,writer_epoch:null,current_request_id:null,state:"blocked"});
    expect((await withSystemTx(pool,tx=>tx.query("SELECT cloud_final_save_dispatchable($1) AS allowed",[f.deleteId]))).rows).toEqual([{allowed:false}]);
    expect((await pool.query("SELECT count(*)::int AS count FROM workspace_checkpoint_requests WHERE workspace_id=$1",[f.workspaceId])).rows).toEqual([{count:0}]);
  });
  it("rejects raw source retargeting while the first registration is still pending",async()=>{
    const f=await seedInitialSetupDelete(pool);
    await expect(withSystemTx(pool,tx=>tx.query("UPDATE cloud_workspace_final_save_recoveries SET registered_at=clock_timestamp() WHERE lifecycle_intent_id=$1",[f.deleteId])))
      .rejects.toMatchObject({code:"23514"});
    expect((await row(f.deleteId)).registered_at).toBeNull();
  });
});
