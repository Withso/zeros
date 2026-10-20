import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { ownerDiscardDeleteRequest, seedOwnerDiscardDelete } from "./cloud-workspaces/owner-discard-delete-test-fixtures.js";
import { CloudWorkspaceReconciler } from "./cloud-workspaces/reconciler.js";
import { CloudProviderError, type CloudProviderResource, type CloudWorkspaceProvider } from "./cloud-workspaces/provider.js";
import { CloudWorkspaceOperationsWorker } from "./cloud-workspaces/operations.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("owner Delete retains provider, meter and erasure custody", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });
  async function fixture() {
    const f = await seedOwnerDiscardDelete(pool, { crashedReady: true });
    const request = await ownerDiscardDeleteRequest(pool, f);
    let resource: CloudProviderResource | null = { resourceId: f.resourceId, state: "running", workspaceId: f.workspaceId,
      organizationId: f.organizationId, generation: 1, target: "test-region", metadata: {} };
    const methods = { name: "boat", find: vi.fn(async () => resource ? [resource] : []), inspect: vi.fn(async () => resource),
      stop: vi.fn(async () => { resource = { ...resource!, state: "stopped" }; return resource; }),
      delete: vi.fn(async () => { resource = null; }), verifyAbsence: vi.fn(async () => true),
      verifyManagedResourceOwnership: vi.fn(async () => true), create: vi.fn(), start: vi.fn(), archive: vi.fn() };
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const worker = new CloudWorkspaceReconciler({ pool, provider: methods as unknown as CloudWorkspaceProvider,
      workerId: "owner-delete-worker-test", logger });
    const erasure = new CloudWorkspaceOperationsWorker(pool, f.blobs, { workerId: "owner-delete-erasure-test", logger });
    const accept = async () => {
      const plan = await manageCloudOwnerDiscardDelete(pool, request, options());
      return manageCloudOwnerDiscardDelete(pool, request, { ...options(), execute: true, approval: plan.approval });
    };
    const due = async () => { await pool.query("UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at=now() WHERE workspace_id=$1 AND operation='delete'", [f.workspaceId]); };
    const dataDeleted = async () => (await pool.query("SELECT data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].erased as boolean;
    return { ...f, request, accept, methods, worker, erasure, due, dataDeleted, logger };
  }

  it("waits for independent compute settlement before provider deletion", async () => {
    const f = await fixture();
    await pool.query("UPDATE managed_compute_allocation_leases SET state='draining',settled_at=NULL,stopped_observed_at=NULL WHERE id=$1", [f.wakeId]);
    const accepted = await f.accept();
    await f.worker.runOnce(f.workspaceId);
    expect(f.methods.stop).toHaveBeenCalledTimes(1); expect(f.methods.delete).not.toHaveBeenCalled();
    expect(await f.erasure.processDeletionOnce()).toBe(false); expect(await f.dataDeleted()).toBe(false);
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [f.wakeId])).rows[0].state).toBe("draining");
    // This fixture supplies the existing meter's terminal observation; the
    // owner operator itself must not create or alter any billing settlement.
    await pool.query("UPDATE managed_compute_allocation_leases SET state='settled',settled_at=now(),stopped_observed_at=now() WHERE id=$1", [f.wakeId]);
    await f.due(); await f.worker.runOnce(f.workspaceId);
    expect(f.methods.delete).toHaveBeenCalledTimes(1);
    expect(f.logger.error.mock.calls).toEqual([]);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [accepted.deleteIntentId])).rows[0].state).toBe("succeeded");
    expect(f.logger.error).not.toHaveBeenCalled();
  });

  it("retains a real nonretryable provider failure and replay never restarts it", async () => {
    const f = await fixture(), accepted = await f.accept();
    f.methods.delete.mockRejectedValue(new CloudProviderError("provider_storage_blocked", "Synthetic provider refusal", false));
    await f.worker.runOnce(f.workspaceId);
    const intent = (await pool.query("SELECT state,error_code,attempt_count FROM cloud_workspace_lifecycle_intents WHERE id=$1", [accepted.deleteIntentId])).rows[0];
    expect(intent).toMatchObject({state:"failed",error_code:"provider_storage_blocked"});
    const before = (await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [f.workspaceId])).rows[0];
    expect(await manageCloudOwnerDiscardDelete(pool,f.request,{...options(),execute:true,approval:accepted.approval})).toMatchObject({state:"unchanged",providerDeletion:"pending",dataErasure:"pending"});
    expect((await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [f.workspaceId])).rows[0]).toEqual(before);
    expect((await pool.query("SELECT state,error_code,attempt_count FROM cloud_workspace_lifecycle_intents WHERE id=$1", [accepted.deleteIntentId])).rows[0]).toEqual(intent);
    expect((await pool.query("SELECT settled_at FROM cloud_workspace_final_save_dispatches WHERE lifecycle_intent_id=$1", [accepted.deleteIntentId])).rows[0].settled_at).toBeNull();
    expect(await f.erasure.processDeletionOnce()).toBe(false); expect(await f.dataDeleted()).toBe(false);
  });

  it("does not erase while an accepted asynchronous provider Delete still has a resource", async () => {
    const f = await fixture(), accepted = await f.accept();
    f.methods.delete.mockImplementationOnce(async () => {});
    await f.worker.runOnce(f.workspaceId);
    expect(f.methods.delete).toHaveBeenCalledOnce(); expect(await f.dataDeleted()).toBe(false);
    expect((await pool.query("SELECT deletion_verified_at FROM cloud_workspace_provider_bindings WHERE workspace_id=$1", [f.workspaceId])).rows[0].deletion_verified_at).toBeNull();
    expect((await pool.query("SELECT settled_at FROM cloud_workspace_final_save_dispatches WHERE lifecycle_intent_id=$1", [accepted.deleteIntentId])).rows[0].settled_at).toBeNull();
    expect(await f.erasure.processDeletionOnce()).toBe(false);
    await f.due(); await f.worker.runOnce(f.workspaceId);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [accepted.deleteIntentId])).rows[0].state).toBe("succeeded");
  });

  it("rechecks current authority after preparatory provider I/O", async () => {
    const f = await fixture(); await f.accept();
    const original = f.methods.inspect.getMockImplementation()!;
    f.methods.inspect.mockImplementationOnce(async () => {
      await pool.query("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1", [f.workspaceId]);
      return original();
    });
    await f.worker.runOnce(f.workspaceId);
    expect(f.methods.delete).not.toHaveBeenCalled(); expect(f.methods.stop).not.toHaveBeenCalled();
    expect(await f.dataDeleted()).toBe(false);
  });

  it("refuses provider Delete when a blob legal hold arrives during preparatory I/O", async () => {
    const f = await fixture(); await f.accept();
    const original = f.methods.inspect.getMockImplementation()!;
    f.methods.inspect.mockImplementationOnce(async () => {
      await pool.query("UPDATE workspace_blobs SET legal_hold=true WHERE id=$1",[f.blobId]);
      return original();
    });
    await f.worker.runOnce(f.workspaceId);
    expect(f.methods.delete).not.toHaveBeenCalled();
    expect(await f.erasure.processDeletionOnce()).toBe(false); expect(await f.dataDeleted()).toBe(false);
  });

  it("honors a legal hold added after provider deletion", async () => {
    const f = await fixture(); await f.accept(); await f.worker.runOnce(f.workspaceId);
    expect(f.methods.delete).toHaveBeenCalledOnce();
    await pool.query("UPDATE workspace_checkpoints SET legal_hold=true WHERE id=$1", [f.checkpointId]);
    expect(await f.erasure.processDeletionOnce()).toBe(false); expect(await f.dataDeleted()).toBe(false);
    await pool.query("UPDATE workspace_checkpoints SET legal_hold=false WHERE id=$1", [f.checkpointId]);
    for (let i=0; i<6; i++) await f.erasure.processDeletionOnce();
    expect(await f.dataDeleted()).toBe(true);
  });

  it("keeps actual object deletion failures pending without a data-erasure receipt", async () => {
    const f = await fixture(); await f.accept(); await f.worker.runOnce(f.workspaceId);
    const deletion=vi.spyOn(f.store,"deleteAndFence").mockRejectedValue(new Error("fixture_object_failure"));
    for (let i=0; i<3; i++) await f.erasure.processDeletionOnce();
    expect(deletion).toHaveBeenCalled(); expect(await f.dataDeleted()).toBe(false);
    expect((await pool.query("SELECT state FROM workspace_deletion_jobs WHERE workspace_id=$1", [f.workspaceId])).rows[0].state).not.toBe("succeeded");
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_checkpoints WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(1);
    deletion.mockRestore();
  });

  it("requires positive deletion of every noncurrent generation before the plan", async () => {
    const f = await fixture();
    await pool.query(`INSERT INTO cloud_workspace_generations SELECT expanded.* FROM cloud_workspace_generations g,
      LATERAL jsonb_populate_record(NULL::cloud_workspace_generations,to_jsonb(g)||'{"generation":2}'::jsonb) expanded
      WHERE g.workspace_id=$1 AND g.generation=1`, [f.workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_provider_bindings(workspace_id,org_id,generation,provider,provider_resource_id,observed_state)
      VALUES($1,$2,2,'boat','bx_old23456','absent')`, [f.workspaceId,f.organizationId]);
    await expect(manageCloudOwnerDiscardDelete(pool,f.request,options())).rejects.toMatchObject({code:"owner_delete_source_unavailable"});
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='deleted',deletion_verified_at=now() WHERE workspace_id=$1 AND generation=2", [f.workspaceId]);
    const accepted=await f.accept();
    await f.worker.runOnce(f.workspaceId);
    for (let i=0; i<6; i++) await f.erasure.processDeletionOnce();
    expect(await f.dataDeleted()).toBe(true);
    expect((await pool.query("SELECT source->'generations' AS generations FROM cloud_workspace_owner_delete_receipts WHERE id=$1", [accepted.receiptId])).rows[0].generations)
      .toEqual([expect.objectContaining({generation:1,deletionVerifiedAt:null}),expect.objectContaining({generation:2,deletionVerifiedAt:expect.any(String)})]);
    expect(f.methods.delete).toHaveBeenCalledWith(f.resourceId); expect(f.methods.delete).toHaveBeenCalledOnce();
  });
});
