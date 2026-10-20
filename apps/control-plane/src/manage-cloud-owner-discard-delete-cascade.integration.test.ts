import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { DeletionLifecycleProcessor, deletionRecoveryCode } from "./deletion-lifecycle.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { ownerDiscardDeleteRequest, seedOwnerDiscardDelete } from "./cloud-workspaces/owner-discard-delete-test-fixtures.js";
import { CloudWorkspaceReconciler } from "./cloud-workspaces/reconciler.js";
import { CloudWorkspaceOperationsWorker } from "./cloud-workspaces/operations.js";
import { DatabaseCloudProviderOperationStore } from "./cloud-workspaces/provider-operation-store.js";
import { DatabaseBuilderVmOperationStore } from "./cloud-workspaces/cloud-builder-vm-store.js";
import { CloudComputerTemplateRetentionWorker } from "./cloud-workspaces/computer-template-retention.js";
import { CloudProviderError, type CloudProviderResource, type CloudWorkspaceProvider } from "./cloud-workspaces/provider.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("W3 new cascade guards with inherited billing barrier isolated", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));

  async function eraseWorkspace() {
    const f = await seedOwnerDiscardDelete(pool, { crashedReady: true });
    // The general fixture has an active Computer template but no builder
    // journal. Seed that independent archived resource before approval so the
    // real retention worker can later close it without bypassing purge gates.
    const template = (await pool.query("SELECT build_id,account_scope FROM cloud_computer_templates WHERE org_id=$1", [f.organizationId])).rows[0];
    const templateResourceId = "bx_22222222", templateKey = `computer-build:${template.build_id}`;
    await pool.query("UPDATE cloud_computer_templates SET provider_resource_id=$2 WHERE build_id=$1", [template.build_id, templateResourceId]);
    const templateJournal = new DatabaseBuilderVmOperationStore(pool, template.account_scope);
    await templateJournal.prepare({ purpose: "computer-build", source: { kind: "base", baseImageId: "fixture-base" },
      name: "zeros-v2-w3-cascade-template", operationKey: templateKey, ttlSeconds: 600 }, "b".repeat(64),
    { path: "/sandboxes", body: { name: "zeros-v2-w3-cascade-template", type: "default", ttlSeconds: 600,
      noEnv: true, env: {}, snapshots: true } });
    await templateJournal.bind(templateKey, templateResourceId);
    await templateJournal.state(templateKey, "archived");
    const request = await ownerDiscardDeleteRequest(pool, f);
    const options = { databaseUrl: process.env.TEST_DATABASE_URL! };
    const plan = await manageCloudOwnerDiscardDelete(pool, request, options);
    const accepted = await manageCloudOwnerDiscardDelete(pool, request, { ...options, execute: true, approval: plan.approval });
    const operations = new DatabaseCloudProviderOperationStore(pool, "boat", f.account);
    const deletionOperationId = randomUUID();
    let resource: CloudProviderResource | null = { resourceId: f.resourceId, state: "running", workspaceId: f.workspaceId,
      organizationId: f.organizationId, generation: 1, target: "test-region", metadata: {} };
    const provider = {
      name: "boat", find: vi.fn(async () => resource ? [resource] : []), inspect: vi.fn(async () => resource),
      stop: vi.fn(async () => { resource = { ...resource!, state: "stopped" }; return resource; }),
      delete: vi.fn(async () => {
        // Exercise the real operation journal used by Boat's positive
        // deletion receipt; resource absence alone cannot clear org cleanup.
        await operations.beginDelete(f.resourceId);
        await operations.bindDeletion(f.resourceId, deletionOperationId);
        await operations.completeDeletion(f.resourceId, deletionOperationId);
        resource = null;
      }), verifyAbsence: vi.fn(async () => true),
      verifyManagedResourceOwnership: vi.fn(async () => true), create: vi.fn(), start: vi.fn(), archive: vi.fn(),
    };
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const worker = new CloudWorkspaceReconciler({ pool, provider: provider as unknown as CloudWorkspaceProvider,
      workerId: "w3-owner-delete-before-org-purge", logger });
    const erasure = new CloudWorkspaceOperationsWorker(pool, f.blobs, { workerId: "w3-owner-delete-record-erasure", logger });
    const physicalDelete = vi.spyOn(f.store, "deleteAndFence");
    await worker.runOnce(f.workspaceId);
    expect(provider.delete).toHaveBeenCalledOnce();
    expect((await operations.get(f.resourceId))?.deletedAt).toBeInstanceOf(Date);
    for (let pass = 0; pass < 6; pass++) await erasure.processDeletionOnce();
    expect(physicalDelete).toHaveBeenCalled();
    expect(logger.error.mock.calls).toEqual([]);
    expect((await pool.query("SELECT status,data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0])
      .toEqual({ status: "deleted", erased: true });
    expect((await pool.query("SELECT state FROM workspace_blobs WHERE org_id=$1", [f.organizationId])).rows)
      .toEqual([{ state: "deleted" }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_record_batches WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(0);
    return { ...f, accepted };
  }

  async function organizationPurge(organizationId: string, userId: string) {
    // No WorkOS link exists in these fixtures. The real processor therefore
    // needs no external identity deletion command, but still owns final purge.
    const id = randomUUID();
    await pool.query(`INSERT INTO deletion_requests
      (id,public_code,target_kind,target_id,target_organization_id,requested_by_user_id,
       requested_at,purge_after,state,purge_started_at)
      VALUES($1,$2,'organization',$3,$3,$4,now()-interval '31 days',now()-interval '1 day','provider_deleting',now())`,
    [id, deletionRecoveryCode(), organizationId, userId]);
    await pool.query(`UPDATE organizations SET lifecycle_status='purging',deletion_request_id=$2,
      deletion_scheduled_at=now()-interval '31 days',purge_after=now()-interval '1 day' WHERE id=$1`, [organizationId, id]);
    const templates = await pool.query("SELECT build_id,provider_resource_id,account_scope,billing_org FROM cloud_computer_templates WHERE org_id=$1", [organizationId]);
    for (const template of templates.rows) {
      const journal = new DatabaseBuilderVmOperationStore(pool, template.account_scope);
      let deleted = false;
      const providerRequest = vi.fn(async (path: string, input?: { method?: string; confirmDelete?: string }) => {
        expect(path).toBe(`/sandboxes/${template.provider_resource_id}`);
        if (input?.method === "DELETE") {
          expect(input.confirmDelete).toBe(template.provider_resource_id);
          deleted = true;
          return { operation: { id: `bdop_${"b".repeat(32)}`, kind: "sandbox", targetId: template.provider_resource_id } };
        }
        expect(deleted).toBe(true);
        throw new CloudProviderError("provider_not_found", "Synthetic completed template deletion", false);
      });
      const retention = new CloudComputerTemplateRetentionWorker(pool, { accountScope: template.account_scope,
        billingOrg: template.billing_org, journal, client: { request: providerRequest } });
      expect(await retention.tick(organizationId)).toBe(1);
      expect(providerRequest).toHaveBeenCalledTimes(2);
      expect((await journal.find(`computer-build:${template.build_id}`))?.state).toBe("deleted");
      expect((await pool.query("SELECT state FROM cloud_computer_templates WHERE build_id=$1", [template.build_id])).rows[0].state).toBe("retired");
    }
    const logger = { error: vi.fn(), warn: vi.fn() };
    const worker = new DeletionLifecycleProcessor(pool, { workerId: "w3-owner-delete-organization-purge", logger });
    expect(await worker.tick(1)).toBe(1);
    expect(logger.warn.mock.calls).toEqual([]);
    expect(logger.error.mock.calls).toEqual([]);
    return (await pool.query("SELECT state,last_error_code FROM deletion_requests WHERE id=$1", [id])).rows[0];
  }

  it("diagnostic: cascades the new receipts after fixture-owner removal of the inherited settled lease", async () => {
    const f = await eraseWorkspace();
    // Diagnostic only: the exact parent proves ordinary organization cleanup
    // cannot remove retained billing rows. Remove this synthetic settled row
    // as the fixture owner to expose the new cascade guards in isolation.
    // This is NOT a sanctioned product billing cleanup or an end-to-end pass.
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [f.wakeId])).rows[0].state).toBe("settled");
    expect((await pool.query("DELETE FROM managed_compute_allocation_leases WHERE id=$1", [f.wakeId])).rowCount).toBe(1);
    expect(await organizationPurge(f.organizationId, f.userId)).toEqual({ state: "purged", last_error_code: null });
    for (const table of ["cloud_workspaces", "cloud_workspace_owner_delete_receipts", "cloud_workspace_owner_delete_dispositions"]) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id=$1`, [f.organizationId])).rows[0].n).toBe(0);
    }
  });

  it("control: direct receipt and disposition deletion stays refused while the workspace exists", async () => {
    const f = await eraseWorkspace();
    await expect(pool.query("DELETE FROM cloud_workspace_owner_delete_receipts WHERE id=$1", [f.accepted.receiptId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("DELETE FROM cloud_workspace_owner_delete_dispositions WHERE receipt_id=$1", [f.accepted.receiptId]))
      .rejects.toMatchObject({ code: "55000" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts WHERE id=$1", [f.accepted.receiptId])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_dispositions WHERE receipt_id=$1", [f.accepted.receiptId])).rows[0].n).toBe(2);
  });

  it("control: the same organization worker completes an independent empty organization", async () => {
    const f = await eraseWorkspace(), organizationId = randomUUID();
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal) VALUES($1,$2,'W3 empty purge control',$3,false)",
      [organizationId, `w3-empty-${organizationId}`, f.userId]);
    expect(await organizationPurge(organizationId, f.userId)).toEqual({ state: "purged", last_error_code: null });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts WHERE id=$1", [f.accepted.receiptId])).rows[0].n).toBe(1);
  });
});
