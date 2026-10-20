import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { manageCloudProviderLoss, validateCloudProviderLossRequest } from "./manage-cloud-provider-loss.js";
import { seedExistingDelete } from "./cloud-workspaces/owner-existing-delete-test-fixtures.js";
import { BoatWorkspaceProvider } from "./cloud-workspaces/boat-provider.js";
import { DatabaseCloudProviderOperationStore } from "./cloud-workspaces/provider-operation-store.js";
import { CloudWorkspaceReconciler } from "./cloud-workspaces/reconciler.js";
import { CloudWorkspaceOperationsWorker } from "./cloud-workspaces/operations.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("W3 existing Delete with attested provider loss versus a bare 404", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });

  async function scenario(attested: boolean) {
    const f = await seedExistingDelete(pool);
    if (attested) {
      const request = validateCloudProviderLossRequest({
        databaseUrl: options().databaseUrl, channel: "alpha", execute: false,
        organizationId: f.organizationId, expectedOrganizationSlug: f.request.expectedOrganizationSlug, actorUserId: f.userId,
        workspaceId: f.workspaceId, generation: "2", resourceId: f.resourceId, accountScope: f.account,
        expectedProviderAccount: "w3-synthetic-provider-account", reason: "Synthetic exact provider loss before existing Delete repair",
      });
      const observedAt = (await pool.query("SELECT clock_timestamp() AS at")).rows[0].at as Date;
      const inventory = { observedAt, providerAccount: request.expectedProviderAccount, accountProof: null, resources: [] };
      const lookup = { resourceId: f.resourceId, observedAt, notFound: true };
      const plan = await manageCloudProviderLoss(pool, request, inventory, lookup);
      expect(await manageCloudProviderLoss(pool, { ...request, execute: true, approval: plan.approval! }, inventory, lookup))
        .toMatchObject({ state: "attested" });
      await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='absent' WHERE workspace_id=$1 AND generation=2", [f.workspaceId]);
    }
    const journal = new DatabaseCloudProviderOperationStore(pool, "boat", f.account);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: false, error: { code: "not_found", status: 404 } }, { status: 404 }));
    const access = { createSshAccess: vi.fn(), revokeSshAccess: vi.fn(), getPreviewEndpoint: vi.fn() };
    const provider = new BoatWorkspaceProvider({ apiKey: "w3-synthetic-fixture", billingOrg: "team_11111111-1111-4111-8111-111111111111", // gitleaks:allow — synthetic fixture
      operations: journal, access, ttlSeconds: null, imageRef: `boat:zeros-w3-qualified@sha256:${"a".repeat(64)}`,
      qualifiedStorageMiB: 20480, timeoutMs: 1000, fetch: fetcher });
    const deleteCall = vi.spyOn(provider, "delete");
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const reconciler = new CloudWorkspaceReconciler({ pool, provider, workerId: "w3-existing-delete-real-adapter", logger });
    const erasure = new CloudWorkspaceOperationsWorker(pool, f.blobs, { workerId: "w3-existing-delete-loss-erasure", logger });
    const plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    const accepted = await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: plan.approval });
    expect((await pool.query("SELECT deletion_verified_at FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 AND generation=2", [f.workspaceId])).rows[0].deletion_verified_at).toBeNull();
    expect((await pool.query("SELECT state,retired_at,sealed_sequence,seal_ack FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [f.writerEpoch])).rows[0])
      .toEqual({ state: "active", retired_at: null, sealed_sequence: null, seal_ack: null });
    expect(await erasure.processDeletionOnce()).toBe(false);
    return { ...f, journal, fetcher, access, deleteCall, logger, reconciler, erasure, accepted };
  }

  it("uses the existing immutable loss through the real adapter without fabricating a provider Delete receipt", async () => {
    const f = await scenario(true);
    const loss = (await pool.query("SELECT to_jsonb(a) AS value FROM cloud_workspace_provider_loss_attestations a WHERE workspace_id=$1", [f.workspaceId])).rows[0].value;
    const operation = await f.journal.get(f.resourceId);
    expect(operation).toMatchObject({ lostAt: expect.any(Date), deletedAt: null, deletionRequestedAt: null, deletionOperationId: null });
    await f.reconciler.runOnce(f.workspaceId);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.deleteCall).not.toHaveBeenCalled();
    expect((await pool.query(`SELECT d.state,b.deletion_verified_at>=dispatch.admitted_at AS verified,
      dispatch.settled_at>=dispatch.admitted_at AS settled FROM cloud_workspace_lifecycle_intents d
      JOIN cloud_workspace_provider_bindings b USING(workspace_id,org_id,generation)
      JOIN cloud_workspace_final_save_dispatches dispatch ON dispatch.lifecycle_intent_id=d.id WHERE d.id=$1`, [f.deleteId])).rows[0])
      .toEqual({ state: "succeeded", verified: true, settled: true });
    expect((await pool.query("SELECT state,retired_at,sealed_sequence,seal_ack FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [f.writerEpoch])).rows[0])
      .toEqual({ state: "retired", retired_at: expect.any(Date), sealed_sequence: null, seal_ack: null });
    const physicalDelete = vi.spyOn(f.store, "deleteAndFence");
    for (let pass = 0; pass < 6; pass++) await f.erasure.processDeletionOnce();
    expect(f.logger.error.mock.calls).toEqual([]);
    expect(physicalDelete).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].erased).toBe(true);
    expect(await f.journal.get(f.resourceId)).toEqual(operation);
    expect((await pool.query("SELECT to_jsonb(a) AS value FROM cloud_workspace_provider_loss_attestations a WHERE workspace_id=$1", [f.workspaceId])).rows[0].value).toEqual(loss);
    expect(await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: f.accepted.approval }))
      .toMatchObject({ state: "unchanged", providerDeletion: "verified", dataErasure: "complete" });
  });

  it("does not turn a bare provider 404 into deletion or native retirement despite the owner's loss disposition", async () => {
    const f = await scenario(false);
    await f.reconciler.runOnce(f.workspaceId);
    expect(f.fetcher).toHaveBeenCalled();
    expect(f.deleteCall).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state,error_code FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.deleteId])).rows[0])
      .toEqual({ state: "failed", error_code: "provider_not_found" });
    expect((await pool.query("SELECT deletion_verified_at FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 AND generation=2", [f.workspaceId])).rows[0].deletion_verified_at).toBeNull();
    expect((await pool.query("SELECT state,retired_at FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [f.writerEpoch])).rows[0])
      .toEqual({ state: "active", retired_at: null });
    expect(await f.erasure.processDeletionOnce()).toBe(false);
    expect((await pool.query("SELECT data_deleted_at FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].data_deleted_at).toBeNull();
    expect(await f.journal.get(f.resourceId)).toMatchObject({ lostAt: null, deletedAt: null, deletionRequestedAt: null, deletionOperationId: null });
    expect((await pool.query("SELECT state FROM workspace_blobs WHERE id=$1", [f.blobId])).rows[0].state).not.toBe("deleted");
  });
});
