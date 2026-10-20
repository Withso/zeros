import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { resetDeliveredHistory, seedDeliveredHistoryRepair } from "./cloud-workspaces/w3-existing-delete-delivered-history-fixtures.js";
import { DatabaseCloudWorkspaceHealthService } from "./cloud-workspaces/health.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("W3 exact repair of an adopted delivered legacy cancellation", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool=new pg.Pool({ connectionString:process.env.TEST_DATABASE_URL,max:6 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetDeliveredHistory(pool),30_000);
  const manage = manageCloudOwnerDiscardDelete as (pool:pg.Pool,request:unknown,
    options:{ databaseUrl:string;execute?:boolean;approval?:string }) => ReturnType<typeof manageCloudOwnerDiscardDelete>;
  const options = () => ({ databaseUrl:process.env.TEST_DATABASE_URL! });
  async function facts(f:Awaited<ReturnType<typeof seedDeliveredHistoryRepair>>) {
    const capture=(await pool.query("SELECT to_jsonb(q) AS value FROM workspace_checkpoint_requests q WHERE id=$1",[f.requestId])).rows[0].value;
    const history=(await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1",[f.stopId])).rows[0].value;
    const saved=(await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1",[f.deleteId])).rows[0].value;
    const lifecycle=(await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=ANY($1::uuid[]) ORDER BY id",[[f.stopId,f.deleteId]])).rows.map(row=>row.value);
    const job=(await pool.query("SELECT to_jsonb(j) AS value FROM workspace_deletion_jobs j WHERE workspace_id=$1",[f.workspaceId])).rows[0].value;
    return { capture,history,saved,lifecycle,job };
  }
  async function scenario() {
    const f=await seedDeliveredHistoryRepair(pool),before=await facts(f);
    expect(before.capture).toMatchObject({ state:"cancelled",delivery_count:3,error_code:"workspace_active",checkpoint_id:null,
      final_save_recovery_id:f.stopId,final_save_attempt_ordinal:0,final_save_capture_report:null,final_save_commit_report:null,final_save_reconcile_report:null });
    expect(before.capture.last_delivered_at).not.toBeNull();
    expect(before.capture.final_save_retirement_id).not.toBeNull();
    expect(before.history).toMatchObject({ state:"blocked",last_failure:"custody",engine_instance_id:f.engineInstanceId,
      original_request_id:f.requestId,current_request_id:f.requestId,checkpoint_id:null,proven_request_id:null,custody_id:null });
    expect(before.saved).toMatchObject({ state:"proven",engine_instance_id:f.successor.engineInstanceId });
    expect(f.successor.engineInstanceId).not.toBe(f.engineInstanceId);
    expect(before.lifecycle.find(row=>row.id===f.stopId)).toMatchObject({ state:"superseded",error_code:"workspace_active",attempt_count:0,dispatched_at:null });
    expect(before.lifecycle.find(row=>row.id===f.deleteId)).toMatchObject({ state:"succeeded" });
    expect(before.job).toMatchObject({ idempotency_key:`lifecycle.${f.deleteId}`,state:"waiting_for_provider" });
    expect(f.provider.delete).toHaveBeenCalledOnce();
    expect(f.logger.error).not.toHaveBeenCalled();
    expect((await pool.query(`SELECT dispatch.settled_at>=dispatch.admitted_at AS settled,
      binding.deletion_verified_at>=dispatch.admitted_at AS verified,operation.deletion_stage,operation.deleted_at IS NOT NULL AS journal_deleted
      FROM cloud_workspace_final_save_dispatches dispatch JOIN cloud_workspace_provider_bindings binding
        USING(workspace_id,org_id,generation) JOIN cloud_workspace_provider_operations operation USING(workspace_id,org_id,generation)
      WHERE dispatch.lifecycle_intent_id=$1`,[f.deleteId])).rows[0]).toEqual({ settled:true,verified:true,deletion_stage:"completed",journal_deleted:true });
    expect((await pool.query("SELECT cloud_workspace_drain_is_mandatory($1) AS mandatory,cloud_final_save_proven($1) AS historical_proven,cloud_final_save_proven($2) AS delete_proven",[f.stopId,f.deleteId])).rows[0])
      .toEqual({ mandatory:false,historical_proven:false,delete_proven:true });
    return { f,before };
  }
  it("records only the selected loss while retaining three deliveries and both original lifecycle identities",async()=>{
    const { f,before }=await scenario();
    const health=new DatabaseCloudWorkspaceHealthService(pool,{ setupExecutionEnabled:true,durabilityEnabled:true,outboxDeliveryEnabled:true });
    expect((await health.read()).reasons).toContain("final_save_blocked");
    const plan=await manage(pool,f.request,options()).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    expect(plan.error).toBeUndefined();
    expect(await facts(f)).toEqual(before);
    const accepted=await manage(pool,f.request,{ ...options(),execute:true,approval:plan.value!.approval });
    expect(accepted).toMatchObject({ deleteIntentId:f.deleteId,providerDeletion:"verified",dataErasure:"pending" });
    expect(await facts(f)).toEqual({ ...before,history:{ ...before.history,state:"discarded",next_attempt_at:"infinity" } });
    expect((await pool.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS claimable",[f.workspaceId,f.organizationId])).rows[0].claimable).toBe(true);
    expect((await health.read()).reasons).not.toContain("final_save_blocked");
    expect(await manage(pool,f.request,{ ...options(),execute:true,approval:plan.value!.approval })).toMatchObject({ state:"unchanged",deleteIntentId:f.deleteId });
    expect(await facts(f)).toEqual({ ...before,history:{ ...before.history,state:"discarded",next_attempt_at:"infinity" } });
  },30_000);
  it("control: the existing blocked history remains unclaimable without its owner disposition",async()=>{
    const { f,before }=await scenario();
    expect((await pool.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS claimable",[f.workspaceId,f.organizationId])).rows[0].claimable).toBe(false);
    expect(await facts(f)).toEqual(before);
  },30_000);
  it("control: absence of complete-loss acknowledgement refuses without changing either lifecycle",async()=>{
    const { f,before }=await scenario();
    await expect(manage(pool,{ ...f.request,ownerAcknowledgedCompleteDataLoss:false },options())).rejects.toMatchObject({ code:"owner_delete_request_invalid" });
    expect(await facts(f)).toEqual(before);
  },30_000);
});
