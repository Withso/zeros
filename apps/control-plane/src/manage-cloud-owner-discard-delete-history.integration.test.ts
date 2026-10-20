import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { seedOwnerDeleteHistoricalCaptures } from "./cloud-workspaces/owner-discard-delete-history-test-fixtures.js";
import { CloudWorkspaceReconciler } from "./cloud-workspaces/reconciler.js";
import { CloudWorkspaceOperationsWorker } from "./cloud-workspaces/operations.js";
import { DatabaseCloudProviderOperationStore } from "./cloud-workspaces/provider-operation-store.js";
import type { CloudProviderResource, CloudWorkspaceProvider } from "./cloud-workspaces/provider.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("owner Delete with retained capture history",()=>{
  let pool:pg.Pool;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});});
  afterAll(async()=>pool.end());
  it("preserves all 40 captures through provider deletion and erases the two-generation history",async()=>{
    const f=await seedOwnerDeleteHistoricalCaptures(pool);
    const counts=(await pool.query(`SELECT
      (SELECT count(*)::int FROM workspace_checkpoint_requests WHERE workspace_id=$1) AS captures,
      (SELECT count(*)::int FROM cloud_workspace_final_save_recoveries WHERE workspace_id=$1) AS recoveries,
      (SELECT count(*)::int FROM cloud_workspace_local_command_writers WHERE workspace_id=$1) AS writers,
      (SELECT count(*)::int FROM workspace_blob_references WHERE workspace_id=$1) AS refs,
      (SELECT count(*)::int FROM workspace_checkpoints WHERE workspace_id=$1) AS checkpoints`,[f.workspaceId])).rows[0];
    expect(counts).toEqual({captures:40,recoveries:1,writers:4,refs:762,checkpoints:2});
    const aggregate=(await pool.query(`SELECT generation,state,reason,final_save_recovery_id IS NOT NULL AS linked,
      final_save_attempt_ordinal IS NOT NULL AS ordinal,final_save_retirement_id IS NOT NULL AS retired,checkpoint_id IS NOT NULL AS saved,
      count(*)::int AS n FROM workspace_checkpoint_requests WHERE workspace_id=$1
      GROUP BY generation,state,reason,linked,ordinal,retired,saved ORDER BY generation,state`,[f.workspaceId])).rows;
    expect(aggregate).toEqual([
      {generation:1,state:"succeeded",reason:"before_stop",linked:false,ordinal:false,retired:false,saved:true,n:1},
      {generation:2,state:"cancelled",reason:"before_stop",linked:false,ordinal:false,retired:false,saved:false,n:38},
      {generation:2,state:"expired",reason:"before_stop",linked:true,ordinal:true,retired:true,saved:false,n:1},
    ]);
    const intents=(await pool.query(`SELECT operation,state,count(*)::int AS n FROM cloud_workspace_lifecycle_intents
      WHERE workspace_id=$1 GROUP BY operation,state ORDER BY operation::text,state::text`,[f.workspaceId])).rows;
    expect(intents).toEqual([
      {operation:"create",state:"succeeded",n:2},{operation:"delete",state:"succeeded",n:1},
      {operation:"stop",state:"queued",n:1},{operation:"stop",state:"succeeded",n:5},
      {operation:"stop",state:"superseded",n:38},{operation:"wake",state:"succeeded",n:24},
    ]);
    const captures=async()=>(await pool.query("SELECT to_jsonb(request) AS row FROM workspace_checkpoint_requests request WHERE workspace_id=$1 ORDER BY id",[f.workspaceId])).rows;
    const before=await captures();
    const options={databaseUrl:process.env.TEST_DATABASE_URL!};
    const plan=await manageCloudOwnerDiscardDelete(pool,f.request,options);
    expect(plan.state).toBe("planned");
    const result=await manageCloudOwnerDiscardDelete(pool,f.request,{...options,execute:true,approval:plan.approval})
      .then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    expect(await captures()).toEqual(before);
    if(result.error){
      expect(result.error).toMatchObject({code:"40001",message:"owner delete capture facts are retained"});
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts")).rows[0].n).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='delete'",[f.workspaceId])).rows[0].n).toBe(1);
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(1);
    }
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({state:"deleting",providerDeletion:"pending",dataErasure:"pending"});
    expect((await pool.query("SELECT jsonb_array_length(source->'captures') AS n FROM cloud_workspace_owner_delete_receipts WHERE id=$1",[f.request.operationId])).rows[0].n).toBe(40);
    expect((await pool.query(`SELECT cloud_final_save_proven($1) AS proven,cloud_final_save_dispatchable($1) AS allowed`,[result.value!.deleteIntentId])).rows[0])
      .toEqual({proven:false,allowed:true});
    await expect(pool.query("UPDATE workspace_checkpoint_requests SET error_code='late_capture_mutation' WHERE id=$1",[f.cancelledRequestIds[0]]))
      .rejects.toMatchObject({code:"40001",message:"owner delete capture facts are retained"});
    expect(await captures()).toEqual(before);
    expect(await manageCloudOwnerDiscardDelete(pool,f.request,{...options,execute:true,approval:plan.approval}))
      .toMatchObject({state:"unchanged",deleteIntentId:result.value!.deleteIntentId});

    const receipt=(await pool.query("SELECT source FROM cloud_workspace_owner_delete_receipts WHERE id=$1",[f.request.operationId])).rows[0].source;
    const dispositions=(await pool.query(`SELECT * FROM cloud_workspace_owner_delete_dispositions
      WHERE receipt_id=$1 ORDER BY lifecycle_intent_id`,[f.request.operationId])).rows;
    expect(dispositions.map(row=>row.lifecycle_intent_id).sort())
      .toEqual([...receipt.history.map((row:{id:string})=>row.id),result.value!.deleteIntentId].sort());
    expect((await pool.query(`SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries
      WHERE workspace_id=$1 AND state='discarded'`,[f.workspaceId])).rows[0].n).toBe(46);
    const objectKey=(await pool.query("SELECT object_key FROM workspace_blobs WHERE id=$1",[f.blobId])).rows[0].object_key as string;
    expect(await f.store.get(objectKey)).not.toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_record_events WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(2);

    const journal=new DatabaseCloudProviderOperationStore(pool,"boat",f.account),deletionId=randomUUID();
    let resource:CloudProviderResource|null={resourceId:f.resourceId,workspaceId:f.workspaceId,organizationId:f.organizationId,
      generation:2,state:"archived",target:"test-region",metadata:{}};
    const provider={name:"boat",find:vi.fn(async()=>resource?[resource]:[]),inspect:vi.fn(async()=>resource),
      delete:vi.fn(async()=>{
        await journal.beginDelete(f.resourceId);
        await journal.bindDeletion(f.resourceId,deletionId);
        await journal.completeDeletion(f.resourceId,deletionId);
        resource=null;
      }),verifyAbsence:vi.fn(async()=>true),verifyManagedResourceOwnership:vi.fn(async()=>true),
      create:vi.fn(),start:vi.fn(),stop:vi.fn(),archive:vi.fn()};
    const logger={error:vi.fn(),warn:vi.fn(),info:vi.fn()};
    const reconciler=new CloudWorkspaceReconciler({pool,provider:provider as unknown as CloudWorkspaceProvider,
      workerId:"historical-owner-delete",logger});
    const erasure=new CloudWorkspaceOperationsWorker(pool,f.blobs,{workerId:"historical-owner-erasure",logger});
    const physicalDelete=vi.spyOn(f.store,"deleteAndFence");
    expect(await erasure.processDeletionOnce()).toBe(false);
    expect(await captures()).toEqual(before);
    await reconciler.runOnce(f.workspaceId);
    expect(provider.delete).toHaveBeenCalledExactlyOnceWith(f.resourceId);
    expect(provider.create).not.toHaveBeenCalled();expect(provider.start).not.toHaveBeenCalled();
    expect((await journal.get(f.resourceId))?.deletedAt).toBeInstanceOf(Date);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[result.value!.deleteIntentId])).rows[0].state).toBe("succeeded");
    expect((await pool.query(`SELECT generation,deletion_verified_at IS NOT NULL AS deleted FROM cloud_workspace_provider_bindings
      WHERE workspace_id=$1 ORDER BY generation`,[f.workspaceId])).rows)
      .toEqual([{generation:1,deleted:true},{generation:2,deleted:true}]);
    expect((await pool.query("SELECT data_deleted_at FROM cloud_workspaces WHERE id=$1",[f.workspaceId])).rows[0].data_deleted_at).toBeNull();
    expect(await captures()).toEqual(before);
    for(let pass=0;pass<6;pass++)await erasure.processDeletionOnce();
    expect(physicalDelete).toHaveBeenCalledExactlyOnceWith(objectKey);
    expect(await f.store.get(objectKey)).toBeNull();
    expect(logger.error.mock.calls).toEqual([]);
    expect((await pool.query("SELECT status,data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1",[f.workspaceId])).rows[0])
      .toEqual({status:"deleted",erased:true});
    expect((await pool.query("SELECT state,error_code FROM workspace_deletion_jobs WHERE workspace_id=$1",[f.workspaceId])).rows[0])
      .toEqual({state:"succeeded",error_code:null});
    for(const table of ["workspace_checkpoint_requests","workspace_checkpoints","workspace_blob_references",
      "workspace_content_heads","workspace_content_revisions","workspace_record_heads","workspace_record_batches",
      "workspace_record_events","workspace_record_entities","cloud_workspace_local_command_writers","cloud_workspace_final_save_recoveries"]){
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows[0].n,table).toBe(0);
    }
    expect((await pool.query("SELECT source FROM cloud_workspace_owner_delete_receipts WHERE id=$1",[f.request.operationId])).rows[0].source).toEqual(receipt);
    expect((await pool.query("SELECT * FROM cloud_workspace_owner_delete_dispositions WHERE receipt_id=$1 ORDER BY lifecycle_intent_id",[f.request.operationId])).rows)
      .toEqual(dispositions);
    expect(await manageCloudOwnerDiscardDelete(pool,f.request,{...options,execute:true,approval:plan.approval}))
      .toMatchObject({state:"unchanged",providerDeletion:"verified",dataErasure:"complete",deleteIntentId:result.value!.deleteIntentId});
  },60_000);
});
