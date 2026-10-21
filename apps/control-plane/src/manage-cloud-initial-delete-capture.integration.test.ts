import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { withSystemTx } from "./db.js";
import { manageCloudInitialDeleteCapture as manage } from "./manage-cloud-initial-delete-capture.js";
import { seedInitialDeleteCapture } from "./cloud-workspaces/initial-delete-capture-test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("initial Delete capture operator", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });
  const snapshot = async (table: string, key: string, id: string) =>
    (await pool.query(`SELECT to_jsonb(row) AS value FROM ${table} row WHERE ${key}=$1`, [id])).rows[0]?.value;

  it("plans without writes and captures once while retaining the existing Delete, job and entire original recovery", async () => {
    const f = await seedInitialDeleteCapture(pool);
    const recovery = await snapshot("cloud_workspace_final_save_recoveries", "lifecycle_intent_id", f.deleteId);
    const intent = await snapshot("cloud_workspace_lifecycle_intents", "id", f.deleteId);
    const job = await snapshot("workspace_deletion_jobs", "workspace_id", f.workspaceId);
    const plan = await manage(pool, f.request, options());
    expect(plan.state).toBe("planned");
    expect(await snapshot("cloud_workspace_final_save_recoveries", "lifecycle_intent_id", f.deleteId)).toEqual(recovery);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_initial_delete_captures")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_checkpoint_requests")).rows[0].n).toBe(0);
    const accepted = await manage(pool, f.request, { ...options(), execute: true, approval: plan.approval });
    expect(accepted).toMatchObject({ state: "capture_queued", deleteIntentId: f.deleteId, captureRequestId: expect.any(String) });
    expect(await manage(pool, f.request, { ...options(), execute: true, approval: plan.approval })).toEqual({ ...accepted, state: "unchanged" });
    const receipt = await snapshot("cloud_workspace_initial_delete_captures", "lifecycle_intent_id", f.deleteId);
    expect(receipt.original_recovery).toEqual(recovery);
    expect(receipt.bound_recovery).toMatchObject({ engine_instance_id: f.engineInstanceId, boot_id: f.bootId, writer_epoch: f.writerEpoch,
      allocation_lease_id: f.leaseId, original_request_id: null, current_request_id: null });
    expect(await snapshot("cloud_workspace_lifecycle_intents", "id", f.deleteId)).toEqual(intent);
    expect(await snapshot("workspace_deletion_jobs", "workspace_id", f.workspaceId)).toEqual(job);
    expect((await withSystemTx(pool, tx => tx.query("SELECT cloud_final_save_proven($1) AS proven,cloud_final_save_dispatchable($1) AS allowed", [f.deleteId]))).rows)
      .toEqual([{ proven: false, allowed: false }]);
  });

  it.each(["engineInstanceId", "bootId", "writerEpoch", "allocationLeaseId", "setupRunId"] as const)("refuses a changed %s", async key => {
    const f = await seedInitialDeleteCapture(pool);
    await expect(manage(pool, { ...f.request, [key]: randomUUID() }, options())).rejects.toMatchObject({ code: "initial_delete_source_changed" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_initial_delete_captures")).rows[0].n).toBe(0);
  });

  it("binds approval to the database/login and detects source drift before execution", async () => {
    const f = await seedInitialDeleteCapture(pool), plan = await manage(pool, f.request, options());
    const other = new URL(options().databaseUrl); other.username = "different-operator";
    await expect(manage(pool, f.request, { databaseUrl: other.toString(), execute: true, approval: plan.approval }))
      .rejects.toMatchObject({ code: "initial_delete_approval_mismatch" });
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET custody_id=gen_random_uuid() WHERE lifecycle_intent_id=$1", [f.deleteId]);
    await expect(manage(pool, f.request, { ...options(), execute: true, approval: plan.approval }))
      .rejects.toMatchObject({ code: "initial_delete_source_unavailable" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_initial_delete_captures")).rows[0].n).toBe(0);
  });

  it("requires a platform owner, exact organization and the actual workspace owner", async () => {
    const f = await seedInitialDeleteCapture(pool);
    await expect(manage(pool, { ...f.request, expectedOrganizationSlug: "wrong-organization" }, options()))
      .rejects.toMatchObject({ code: "initial_delete_organization_changed" });
    await expect(manage(pool, { ...f.request, ownerUserId: randomUUID() }, options()))
      .rejects.toMatchObject({ code: "initial_delete_workspace_changed" });
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [f.userId]);
    await expect(manage(pool, f.request, options())).rejects.toMatchObject({ code: "initial_delete_operator_required" });
  });

  it("rolls back the receipt and source when the first request cannot be committed", async () => {
    const f = await seedInitialDeleteCapture(pool);
    const original = await snapshot("cloud_workspace_final_save_recoveries", "lifecycle_intent_id", f.deleteId);
    await expect(withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_initial_delete_captures(lifecycle_intent_id,workspace_id,org_id,generation,setup_run_id,
        workos_required,capture_request_id,original_recovery,bound_recovery,source_sha256)
        SELECT $1,$2,$3,1,(source->>'setupRunId')::uuid,false,gen_random_uuid(),source->'original',source->'bound',
          digest(convert_to(source::text,'UTF8'),'sha256') FROM (SELECT cloud_initial_delete_capture_source($1,false) AS source) candidate`,
      [f.deleteId, f.workspaceId, f.organizationId]);
    })).rejects.toMatchObject({ code: "23514" });
    expect(await snapshot("cloud_workspace_final_save_recoveries", "lifecycle_intent_id", f.deleteId)).toEqual(original);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_initial_delete_captures")).rows[0].n).toBe(0);
  });

  it.each([
    ["provider binding", "UPDATE cloud_workspace_provider_bindings SET provider_resource_id='different-resource' WHERE workspace_id=$1"],
    ["allocation", "UPDATE managed_compute_allocation_leases SET state='settled',settled_at=clock_timestamp() WHERE workspace_id=$1"],
    ["setup completion", "UPDATE cloud_workspace_setup_runs SET state='failed',error_code='late-failure' WHERE workspace_id=$1"],
  ])("does not commit a capture after same-transaction %s drift", async (_name, sql) => {
    const f = await seedInitialDeleteCapture(pool);
    await expect(withSystemTx(pool, async tx => {
      expect((await tx.query("SELECT admit_cloud_initial_delete_capture($1,NULL,false) AS id", [f.deleteId])).rows[0].id).toEqual(expect.any(String));
      await tx.query(sql!, [f.workspaceId]);
    })).rejects.toMatchObject({ code: "23514" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_initial_delete_captures")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_checkpoint_requests")).rows[0].n).toBe(0);
  });
});
