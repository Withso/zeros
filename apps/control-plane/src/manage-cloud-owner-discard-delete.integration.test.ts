import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { seedOwnerDiscardDelete } from "./cloud-workspaces/owner-discard-delete-test-fixtures.js";
import type { CloudOwnerDiscardDeleteRequest } from "./cloud-owner-discard-delete-contract.js";
import { CloudWorkspaceReconciler } from "./cloud-workspaces/reconciler.js";
import type { CloudProviderResource, CloudWorkspaceProvider } from "./cloud-workspaces/provider.js";
import { CloudWorkspaceOperationsWorker } from "./cloud-workspaces/operations.js";
import { runFinalSaveRecovery } from "./cloud-workspaces/final-save-service.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("owner-approved complete loss and ordinary Delete", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });
  async function fixture(crashedReady = false, engineFailureStop = false) {
    const f = await seedOwnerDiscardDelete(pool, { crashedReady, engineFailureStop });
    const slug = (await pool.query("SELECT slug FROM organizations WHERE id=$1", [f.organizationId])).rows[0].slug as string;
    const request: CloudOwnerDiscardDeleteRequest = { version: 1, channel: "development", operationId: randomUUID(),
      organizationId: f.organizationId, expectedOrganizationSlug: slug, workspaceId: f.workspaceId,
      ownerUserId: f.userId, operatorUserId: f.userId, sourceGeneration: 1, stopIntentId: f.stopId, requestId: f.requestId,
      engineInstanceId: f.current.engineInstanceId, allocationLeaseId: f.wakeId, providerResourceId: f.resourceId,
      providerAccountScope: f.account, ownerAcknowledgedCompleteDataLoss: true,
      ownerApprovalReference: "synthetic owner approval for complete deletion", reason: "Synthetic irrecoverable final save; delete all workspace data" };
    return { ...f, request };
  }
  async function execute(f: Awaited<ReturnType<typeof fixture>>) {
    const plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    return manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: plan.approval });
  }
  it("plans without mutation and refuses an unapproved execution", async () => {
    const f = await fixture();
    const original = (await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1", [f.requestId])).rows;
    expect(await manageCloudOwnerDiscardDelete(pool, f.request, options())).toMatchObject({ state: "planned", deleteIntentId: null,
      providerDeletion: "pending", dataErasure: "pending" });
    await expect(manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true })).rejects.toMatchObject({ code: "owner_delete_approval_mismatch" });
    expect((await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1", [f.requestId])).rows).toEqual(original);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_deletion_jobs")).rows[0].n).toBe(0);
  });
  it.each([false, true])("discards exact custody truthfully and replays the one Delete (crashed ready: %s)", async crashedReady => {
    const f = await fixture(crashedReady);
    const original = (await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1", [f.requestId])).rows;
    const before = (await pool.query("SELECT * FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.stopId])).rows[0];
    const accepted = await execute(f);
    expect(accepted).toMatchObject({ state: "deleting", providerDeletion: "pending", dataErasure: "pending" });
    expect((await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1", [f.requestId])).rows).toEqual(original);
    expect((await pool.query("SELECT * FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.stopId])).rows[0])
      .toEqual({ ...before, state: "discarded", next_attempt_at: Infinity });
    if (crashedReady) {
      expect(before.custody_id).not.toBeNull(); expect(before.writer_epoch).toBe(f.writerEpoch);
      expect(original[0]).toMatchObject({ delivery_count: 1, final_save_capture_report: { failure: "capture_failed" } });
      expect((await pool.query("SELECT sealed_sequence,seal_ack FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [f.writerEpoch])).rows[0])
        .toEqual({ sealed_sequence: null, seal_ack: null });
    }
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven,cloud_final_save_dispatchable($1) AS allowed", [accepted.deleteIntentId])).rows[0])
      .toEqual({ proven: false, allowed: true });
    expect((await pool.query("SELECT state,error_code,affects_workspace FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.stopId])).rows[0])
      .toEqual({ state: "superseded", error_code: "owner_discarded", affects_workspace: false });
    expect(await runFinalSaveRecovery(pool, f.workspaceId, false)).toBe(0);
    expect(await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: accepted.approval }))
      .toEqual({ ...accepted, state: "unchanged" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='delete'", [f.workspaceId])).rows[0].n).toBe(1);
  });
  it.each([false, true])("uses the real provider reconciler and erasure worker; receipt alone is not completion (engine failure: %s)", async engineFailureStop => {
    const f = await fixture(false, engineFailureStop);
    const accepted = await execute(f);
    let resource: CloudProviderResource | null = { resourceId: f.resourceId, workspaceId: f.workspaceId, organizationId: f.organizationId,
      generation: 1, state: "archived", target: "test-region", metadata: {} };
    const provider = { name: "boat", find: vi.fn(async () => resource ? [resource] : []), inspect: vi.fn(async () => resource),
      delete: vi.fn(async () => { resource = null; }), verifyAbsence: vi.fn(async () => true),
      verifyManagedResourceOwnership: vi.fn(async () => true), stop: vi.fn(), create: vi.fn(), start: vi.fn(), archive: vi.fn(),
    } as unknown as CloudWorkspaceProvider;
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const reconciler = new CloudWorkspaceReconciler({ pool, provider, workerId: "owner-discard-delete-test", logger });
    const erasure = new CloudWorkspaceOperationsWorker(pool, f.blobs, { workerId: "owner-discard-erasure" });
    expect(await erasure.processDeletionOnce()).toBe(false);
    for (let i=0; i<3; i++) await reconciler.runOnce(f.workspaceId);
    expect(logger.error.mock.calls).toEqual([]);
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(provider.create).not.toHaveBeenCalled(); expect(provider.start).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [accepted.deleteIntentId])).rows[0].state).toBe("succeeded");
    expect((await pool.query("SELECT data_deleted_at FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].data_deleted_at).toBeNull();
    for (let i=0; i<6; i++) await erasure.processDeletionOnce();
    expect((await pool.query("SELECT state,error_code FROM workspace_deletion_jobs WHERE workspace_id=$1", [f.workspaceId])).rows[0])
      .toEqual({ state: "succeeded", error_code: null });
    expect((await pool.query("SELECT data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].erased).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_checkpoints WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT state,deleted_at IS NOT NULL AS deleted FROM workspace_blobs WHERE id=$1", [f.blobId])).rows[0])
      .toEqual({ state: "deleted", deleted: true });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(1);
    expect(await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: accepted.approval }))
      .toMatchObject({ state: "unchanged", providerDeletion: "verified", dataErasure: "complete", deleteIntentId: accepted.deleteIntentId });
  });
});
