import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { ownerDiscardDeleteRequest, seedOwnerDiscardDelete } from "./cloud-workspaces/owner-discard-delete-test-fixtures.js";
import { CloudWorkspaceReconciler } from "./cloud-workspaces/reconciler.js";
import { CloudWorkspaceOperationsWorker } from "./cloud-workspaces/operations.js";
import { CloudProviderError, type CloudProviderResource, type CloudWorkspaceProvider } from "./cloud-workspaces/provider.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("W3 exact owner Delete terminal custody", () => {
  let pool: pg.Pool;
  let app: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 });
    app = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=zeros_app", max: 2 });
  });
  afterAll(async () => { await app.end(); await pool.end(); });
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });

  async function fixture(terminal: "failed" | "succeeded") {
    const f = await seedOwnerDiscardDelete(pool, { crashedReady: true });
    const request = await ownerDiscardDeleteRequest(pool, f);
    const plan = await manageCloudOwnerDiscardDelete(pool, request, options());
    const accepted = await manageCloudOwnerDiscardDelete(pool, request, { ...options(), execute: true, approval: plan.approval });
    let resource: CloudProviderResource | null = { resourceId: f.resourceId, state: "running", workspaceId: f.workspaceId,
      organizationId: f.organizationId, generation: 1, target: "test-region", metadata: {} };
    const methods = {
      name: "boat", find: vi.fn(async () => resource ? [resource] : []), inspect: vi.fn(async () => resource),
      stop: vi.fn(async () => { resource = { ...resource!, state: "stopped" }; return resource; }),
      delete: vi.fn(async () => {
        if (terminal === "failed") throw new CloudProviderError("provider_storage_blocked", "Synthetic terminal provider refusal", false);
        resource = null;
      }),
      verifyAbsence: vi.fn(async () => true), verifyManagedResourceOwnership: vi.fn(async () => true),
      create: vi.fn(), start: vi.fn(), archive: vi.fn(),
    };
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const worker = new CloudWorkspaceReconciler({ pool, provider: methods as unknown as CloudWorkspaceProvider,
      workerId: "w3-owner-delete-terminal", logger });
    const erasure = new CloudWorkspaceOperationsWorker(pool, f.blobs, { workerId: "w3-owner-delete-erasure", logger });
    const intent = async () => (await pool.query(`SELECT state,completed_at,error_code,error_message,attempt_count,dispatched_at
      FROM cloud_workspace_lifecycle_intents WHERE id=$1`, [accepted.deleteIntentId])).rows[0];
    await worker.runOnce(f.workspaceId);
    expect(methods.delete).toHaveBeenCalledTimes(1);
    expect((await intent()).state).toBe(terminal);
    expect(logger.error.mock.calls).toEqual([]);
    return { ...f, request, accepted, methods, worker, erasure, intent };
  }

  it.each([
    ["failed", "queued"], ["failed", "observing"],
    ["succeeded", "queued"], ["succeeded", "observing"],
  ] as const)("keeps actual %s Delete terminal after stale %s update from zeros_app", async (terminal, stale) => {
    const f = await fixture(terminal);
    const before = await f.intent();
    let refusal: string | undefined;
    try {
      await withSystemTx(app, tx => tx.query(`UPDATE cloud_workspace_lifecycle_intents SET
        state=$2::cloud_workspace_intent_state,completed_at=NULL,next_attempt_at=clock_timestamp(),
        lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`, [f.accepted.deleteIntentId, stale]));
    } catch (error) { refusal = (error as { code?: string }).code; }
    if (refusal) expect(["40001", "23514", "55000"]).toContain(refusal);
    expect(await f.intent()).toEqual(before);
    await f.worker.runOnce(f.workspaceId);
    expect(f.methods.delete).toHaveBeenCalledTimes(1);
  });

  it("control: operator replay preserves a real failed Delete and does not erase", async () => {
    const f = await fixture("failed"), before = await f.intent();
    const replay = await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: f.accepted.approval });
    expect(replay).toMatchObject({ state: "unchanged", deleteIntentId: f.accepted.deleteIntentId,
      providerDeletion: "pending", dataErasure: "pending" });
    expect(await f.intent()).toEqual(before);
    expect(await f.erasure.processDeletionOnce()).toBe(false);
    expect(f.methods.delete).toHaveBeenCalledTimes(1);
  });

  it("control: positive exact provider Delete retires unsealed custody and completes ordinary erasure", async () => {
    const f = await fixture("succeeded");
    expect((await pool.query(`SELECT state,sealed_sequence,seal_ack FROM cloud_workspace_local_command_writers
      WHERE writer_epoch=$1`, [f.writerEpoch])).rows[0]).toEqual({ state: "retired", sealed_sequence: null, seal_ack: null });
    for (let pass = 0; pass < 6; pass++) await f.erasure.processDeletionOnce();
    expect((await pool.query("SELECT data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].erased).toBe(true);
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven", [f.stopId])).rows[0].proven).toBe(false);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_dispositions WHERE receipt_id=$1", [f.accepted.receiptId])).rows[0].n).toBe(2);
  });
});
