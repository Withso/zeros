import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { resetDeliveredHistory, seedDeliveredHistoryRepair } from "./cloud-workspaces/w3-existing-delete-delivered-history-fixtures.js";
import { DatabaseCloudWorkspaceBlobService, MemoryCloudWorkspaceObjectStore } from "./cloud-workspaces/object-store.js";
import { CloudWorkspaceOperationsWorker } from "./cloud-workspaces/operations.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("existing successful Delete erasure after historical loss", () => {
  let pool:pg.Pool;
  beforeAll(() => { pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetDeliveredHistory(pool),30_000);
  it("physically erases the delivered legacy capture only through the ordinary erasure worker", async () => {
    const f=await seedDeliveredHistoryRepair(pool),store=new MemoryCloudWorkspaceObjectStore();
    const objects=(await pool.query("SELECT object_key FROM workspace_blobs WHERE org_id=$1",[f.organizationId])).rows;
    expect(objects.length).toBeGreaterThan(0);
    // The independent fixture already committed and verified the checkpoint
    // metadata. Retain synthetic object bytes here to observe actual deletion.
    for (const object of objects) await store.putIfAbsent(object.object_key,Buffer.from("synthetic retained ciphertext"));
    const physicalDelete=vi.spyOn(store,"deleteAndFence");
    const blobs=new DatabaseCloudWorkspaceBlobService({pool,objectStore:store,workosEnabled:false,
      encryptionKeyV1:randomBytes(32).toString("base64url")});
    const logger={error:vi.fn()},worker=new CloudWorkspaceOperationsWorker(pool,blobs,{workerId:"historical-loss-erasure",logger});
    expect(await worker.processDeletionOnce()).toBe(false);
    expect(physicalDelete).not.toHaveBeenCalled();
    const before=(await pool.query("SELECT to_jsonb(q) AS value FROM workspace_checkpoint_requests q WHERE id=$1",[f.requestId])).rows[0].value;
    const options={databaseUrl:process.env.TEST_DATABASE_URL!};
    const plan=await manageCloudOwnerDiscardDelete(pool,f.request,options);
    const accepted=await manageCloudOwnerDiscardDelete(pool,f.request,{...options,execute:true,approval:plan.approval});
    expect((await pool.query("SELECT to_jsonb(q) AS value FROM workspace_checkpoint_requests q WHERE id=$1",[f.requestId])).rows[0].value).toEqual(before);
    const receipt=(await pool.query("SELECT source FROM cloud_workspace_owner_existing_delete_receipts WHERE id=$1",[accepted.receiptId])).rows[0].source;
    for (let pass=0;pass<6;pass++) await worker.processDeletionOnce();
    expect(logger.error.mock.calls).toEqual([]);
    for (const object of objects) {
      expect(physicalDelete).toHaveBeenCalledWith(object.object_key);
      expect(await store.get(object.object_key)).toBeNull();
    }
    expect((await pool.query("SELECT data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1",[f.workspaceId])).rows[0].erased).toBe(true);
    for (const table of ["workspace_checkpoint_requests","workspace_blob_references","workspace_checkpoints","workspace_record_events",
      "workspace_record_entities","workspace_content_heads","cloud_workspace_local_command_writers","cloud_workspace_final_save_recoveries"]) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows[0].n,table).toBe(0);
    }
    expect((await pool.query("SELECT source FROM cloud_workspace_owner_existing_delete_receipts WHERE id=$1",[accepted.receiptId])).rows[0].source).toEqual(receipt);
    expect(receipt.captures).toContainEqual(before);
    expect(await manageCloudOwnerDiscardDelete(pool,f.request,{...options,execute:true,approval:plan.approval}))
      .toMatchObject({state:"unchanged",deleteIntentId:f.deleteId,providerDeletion:"verified",dataErasure:"complete"});
    expect(f.provider.delete).toHaveBeenCalledOnce();
  },30_000);
});
