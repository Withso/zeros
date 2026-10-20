import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { existingDeleteWorkers, seedExistingDelete } from "./cloud-workspaces/owner-existing-delete-test-fixtures.js";
import { DatabaseCloudWorkspaceHealthService } from "./cloud-workspaces/health.js";
import { CloudProviderError } from "./cloud-workspaces/provider.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("owner loss for an already accepted Delete", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString:process.env.TEST_DATABASE_URL,max:6 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl:process.env.TEST_DATABASE_URL! });
  const manage = manageCloudOwnerDiscardDelete as (pool: pg.Pool, request: unknown,
    options: { databaseUrl:string;execute?:boolean;approval?:string }) => ReturnType<typeof manageCloudOwnerDiscardDelete>;

  it("records explicit loss without replacing the ordinary Delete or inventing a capture", async () => {
    const f = await seedExistingDelete(pool);
    const recovery = (await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0].value;
    expect(recovery).toMatchObject({ state:"blocked",first_failure:"source_unavailable",original_request_id:null,current_request_id:null,
      checkpoint_id:null,proven_request_id:null,generation:2 });
    const intent = (await pool.query("SELECT id,idempotency_key,request_sha256,attempt_count,dispatched_at FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.deleteId])).rows[0];
    const health = new DatabaseCloudWorkspaceHealthService(pool,{ setupExecutionEnabled:true,durabilityEnabled:true,outboxDeliveryEnabled:true });
    expect((await health.read()).reasons).toContain("final_save_blocked");
    const planned = await manage(pool,f.request,options()).then(value => ({ value,error:undefined }), error => ({ value:undefined,error }));
    expect(planned.error).toBeUndefined();
    const result = await manage(pool,f.request,{ ...options(),execute:true,approval:planned.value!.approval });
    expect(result).toMatchObject({ state:"deleting",deleteIntentId:f.deleteId,providerDeletion:"pending",dataErasure:"pending" });
    expect((await pool.query("SELECT id,idempotency_key,request_sha256,attempt_count,dispatched_at FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.deleteId])).rows[0]).toEqual(intent);
    const after = (await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0].value;
    expect(after).toEqual({ ...recovery,state:"discarded",next_attempt_at:"infinity" });
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven,cloud_final_save_dispatchable($1) AS dispatchable", [f.deleteId])).rows[0])
      .toEqual({ proven:false,dispatchable:true });
    expect((await health.read()).reasons).not.toContain("final_save_blocked");
    expect(await manage(pool,f.request,{ ...options(),execute:true,approval:planned.value!.approval })).toMatchObject({ state:"unchanged",deleteIntentId:f.deleteId });
  });

  it("control: without the loss receipt an ordinary dead-source Delete cannot dispatch or erase", async () => {
    const f = await seedExistingDelete(pool), workers = existingDeleteWorkers(pool,f);
    await workers.reconciler.runOnce(f.workspaceId);
    expect(workers.provider.delete).not.toHaveBeenCalled();
    expect(await workers.erasure.processDeletionOnce()).toBe(false);
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven,cloud_final_save_dispatchable($1) AS dispatchable", [f.deleteId])).rows[0])
      .toEqual({ proven:false,dispatchable:false });
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0].n).toBe(0);
  });

  async function accept(f: Awaited<ReturnType<typeof seedExistingDelete>>) {
    const plan = await manage(pool,f.request,options());
    return manage(pool,f.request,{ ...options(),execute:true,approval:plan.approval });
  }

  it("runs actual provider, object and record deletion before retiring the unsealed native source", async () => {
    const f = await seedExistingDelete(pool), workers = existingDeleteWorkers(pool,f);
    const objectKey = (await pool.query("SELECT object_key FROM workspace_blobs WHERE id=$1", [f.blobId])).rows[0].object_key as string;
    expect(await f.store.get(objectKey)).not.toBeNull();
    const physicalDelete = vi.spyOn(f.store,"deleteAndFence"), accepted = await accept(f);
    const receipt = (await pool.query("SELECT source FROM cloud_workspace_owner_existing_delete_receipts WHERE id=$1", [accepted.receiptId])).rows[0].source;
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=clock_timestamp()
      WHERE workspace_id=$1 AND writer_epoch=$2`, [f.workspaceId,f.writerEpoch]))).rejects.toMatchObject({ code:"40001" });
    expect(await workers.erasure.processDeletionOnce()).toBe(false);
    await workers.reconciler.runOnce(f.workspaceId);
    expect(workers.provider.delete).toHaveBeenCalledExactlyOnceWith(f.resourceId);
    expect((await workers.journal.get(f.resourceId))?.deletedAt).toBeInstanceOf(Date);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.deleteId])).rows[0].state).toBe("succeeded");
    expect((await pool.query("SELECT state,retired_at,sealed_sequence,seal_ack FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [f.writerEpoch])).rows[0])
      .toEqual({ state:"retired",retired_at:expect.any(Date),sealed_sequence:null,seal_ack:null });
    expect((await pool.query("SELECT retired_at FROM cloud_agent_boot_bindings WHERE id=$1", [f.bindingId])).rows[0].retired_at).toBeInstanceOf(Date);
    for (let pass=0; pass<6; pass++) await workers.erasure.processDeletionOnce();
    expect(workers.logger.error.mock.calls).toEqual([]);
    expect(physicalDelete).toHaveBeenCalledExactlyOnceWith(objectKey);
    expect(await f.store.get(objectKey)).toBeNull();
    expect((await pool.query("SELECT status,data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0])
      .toEqual({ status:"deleted",erased:true });
    for (const table of ["workspace_blob_references","workspace_checkpoints","workspace_record_events","workspace_record_entities",
      "workspace_record_batches","workspace_content_heads","cloud_workspace_local_command_writers","cloud_workspace_final_save_recoveries"]) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`, [f.workspaceId])).rows[0].n,table).toBe(0);
    }
    expect((await pool.query("SELECT source FROM cloud_workspace_owner_existing_delete_receipts WHERE id=$1", [accepted.receiptId])).rows[0].source).toEqual(receipt);
    expect(await manage(pool,f.request,{ ...options(),execute:true,approval:accepted.approval }))
      .toMatchObject({ state:"unchanged",deleteIntentId:f.deleteId,providerDeletion:"verified",dataErasure:"complete" });
    expect(workers.provider.create).not.toHaveBeenCalled(); expect(workers.provider.start).not.toHaveBeenCalled();
  });

  it.each([
    ["dispatched", "UPDATE cloud_workspace_lifecycle_intents SET dispatched_at=clock_timestamp() WHERE id=$1"],
    ["claimed", "UPDATE cloud_workspace_lifecycle_intents SET attempt_count=1 WHERE id=$1"],
    ["native custody", "UPDATE cloud_workspace_final_save_recoveries SET custody_id=gen_random_uuid() WHERE lifecycle_intent_id=$1"],
  ])("refuses a changed %s pending Delete", async (_name,sql) => {
    const f = await seedExistingDelete(pool);
    await pool.query(sql,[f.deleteId]);
    await expect(manage(pool,f.request,options())).rejects.toMatchObject({ code:"owner_delete_source_unavailable" });
  });

  it("refuses a live source and requires the explicit complete-loss acknowledgement", async () => {
    const f = await seedExistingDelete(pool);
    await expect(manage(pool,{ ...f.request,ownerAcknowledgedCompleteDataLoss:false },options())).rejects.toMatchObject({ code:"owner_delete_request_invalid" });
    await pool.query(`UPDATE cloud_workspace_endpoint_grants SET revoked_at=NULL,expires_at=clock_timestamp()+interval '5 minutes'
      WHERE id=(SELECT registration_grant_id FROM cloud_workspace_engine_instances WHERE id=$1)`, [f.engineInstanceId]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=NULL,state='ready',lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [f.engineInstanceId]);
    await expect(manage(pool,f.request,options())).rejects.toMatchObject({ code:"owner_delete_source_unavailable" });
  });

  it("keeps retry clocks outside approval while refusing a changed target or source", async () => {
    const f = await seedExistingDelete(pool), plan = await manage(pool,f.request,options());
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET retry_count=retry_count+1,next_attempt_at=now()+interval '5 minutes',last_checked_at=now() WHERE lifecycle_intent_id=$1", [f.deleteId]);
    expect((await manage(pool,f.request,options())).approval).toBe(plan.approval);
    await expect(manage(pool,{ ...f.request,engineInstanceId:randomUUID() },options())).rejects.toMatchObject({ code:"owner_delete_source_changed" });
    const changedTarget = new URL(options().databaseUrl); changedTarget.pathname="/another-database";
    await expect(manage(pool,f.request,{ databaseUrl:changedTarget.toString(),execute:true,approval:plan.approval }))
      .rejects.toMatchObject({ code:"owner_delete_approval_mismatch" });
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET custody_id=gen_random_uuid() WHERE lifecycle_intent_id=$1", [f.deleteId]);
    await expect(manage(pool,f.request,{ ...options(),execute:true,approval:plan.approval })).rejects.toMatchObject({ code:"owner_delete_source_unavailable" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_existing_delete_receipts")).rows[0].n).toBe(0);
  });

  it("retains real provider failure and refuses terminal revival or replacement", async () => {
    const f = await seedExistingDelete(pool), workers = existingDeleteWorkers(pool,f), accepted = await accept(f);
    workers.provider.delete.mockRejectedValue(new CloudProviderError("provider_storage_blocked","Synthetic refusal",false));
    await workers.reconciler.runOnce(f.workspaceId);
    const intent = (await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=$1", [f.deleteId])).rows[0].value;
    expect(intent).toMatchObject({ state:"failed",error_code:"provider_storage_blocked" });
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_lifecycle_intents SET state='queued',completed_at=NULL WHERE id=$1", [f.deleteId])))
      .rejects.toMatchObject({ code:"40001" });
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspaces SET accepted_lifecycle_intent_id=NULL WHERE id=$1", [f.workspaceId])))
      .rejects.toMatchObject({ code:"40001" });
    expect(await manage(pool,f.request,{ ...options(),execute:true,approval:accepted.approval })).toMatchObject({ state:"unchanged" });
    expect((await pool.query("SELECT to_jsonb(i) AS value FROM cloud_workspace_lifecycle_intents i WHERE id=$1", [f.deleteId])).rows[0].value).toEqual(intent);
    expect(await workers.erasure.processDeletionOnce()).toBe(false);
  });

  it("rechecks legal holds after real provider preparation", async () => {
    const f = await seedExistingDelete(pool), workers = existingDeleteWorkers(pool,f); await accept(f);
    const inspect = workers.provider.inspect.getMockImplementation()!;
    workers.provider.inspect.mockImplementationOnce(async () => {
      await pool.query("UPDATE workspace_blobs SET legal_hold=true WHERE id=$1", [f.blobId]);
      return inspect();
    });
    await workers.reconciler.runOnce(f.workspaceId);
    expect(workers.provider.delete).not.toHaveBeenCalled();
    expect(await workers.erasure.processDeletionOnce()).toBe(false);
  });
});
