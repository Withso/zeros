import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { withSystemTx } from "./db.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { ownerDiscardDeleteRequest, seedOwnerDiscardDelete } from "./cloud-workspaces/owner-discard-delete-test-fixtures.js";
import { seedReadyCloudWorkspace } from "./cloud-workspaces/test-fixtures.js";
import { requestCloudWorkspaceDeletion } from "./cloud-workspaces/routes.js";
import { ensureFinalSaveRecovery } from "./cloud-workspaces/final-save-recovery.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("complete-loss operator authority and concurrency", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });
  const receipts = async () => (await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts")).rows[0].n;
  async function fixture(crashedReady = false) {
    const f = await seedOwnerDiscardDelete(pool, { crashedReady });
    return { ...f, request: await ownerDiscardDeleteRequest(pool, f) };
  }
  async function execute(f: Awaited<ReturnType<typeof fixture>>) {
    const plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    return manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: plan.approval });
  }
  async function readyAgain(f: Awaited<ReturnType<typeof fixture>>, live: boolean) {
    await pool.query(`UPDATE cloud_workspace_endpoint_grants SET revoked_at=NULL,expires_at=now()+interval '10 minutes'
      WHERE id=(SELECT registration_grant_id FROM cloud_workspace_engine_instances WHERE id=$1)`, [f.current.engineInstanceId]);
    await pool.query(`UPDATE cloud_workspace_engine_instances SET state='ready',revoked_at=NULL,
      lease_expires_at=now()+CASE WHEN $2 THEN interval '1 minute' ELSE interval '-1 minute' END WHERE id=$1`, [f.current.engineInstanceId,live]);
  }

  it.each(["organizationId", "workspaceId", "ownerUserId", "operatorUserId", "stopIntentId", "requestId", "engineInstanceId", "allocationLeaseId"] as const)(
    "refuses a foreign %s without writing", async field => {
      const f = await fixture();
      await expect(manageCloudOwnerDiscardDelete(pool, { ...f.request, [field]: randomUUID() }, options())).rejects.toThrow();
      expect(await receipts()).toBe(0);
    });

  it.each([{ sourceGeneration: 2 }, { providerResourceId: "bx_new23456" }, { providerAccountScope: "other-account" },
    { expectedOrganizationSlug: "another-organization" }])("refuses changed exact pins %j", async changed => {
    const f = await fixture();
    await expect(manageCloudOwnerDiscardDelete(pool, { ...f.request, ...changed }, options())).rejects.toThrow();
    expect(await receipts()).toBe(0);
  });

  it.each(["operationId", "approvalReference", "reason", "target"] as const)("binds execution to approved %s", async field => {
    const f = await fixture(), plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    const target = new URL(options().databaseUrl); target.pathname += "_different";
    await expect(manageCloudOwnerDiscardDelete(pool, { ...f.request,
      ...(field === "operationId" ? { operationId: randomUUID() } : field === "approvalReference"
        ? { ownerApprovalReference: "A different complete-loss approval" } : field === "reason" ? { reason: "A different operator explanation" } : {}) },
    { ...options(), ...(field === "target" ? { databaseUrl: target.toString() } : {}), execute: true, approval: plan.approval }))
      .rejects.toMatchObject({ code: "owner_delete_approval_mismatch" });
    expect(await receipts()).toBe(0);
  });

  it.each(["content", "report", "authority", "history"] as const)("requires a new plan after captured %s changes", async changed => {
    const f = await fixture(), plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    if (changed === "content") await pool.query("UPDATE workspace_content_heads SET current_revision=current_revision+1 WHERE workspace_id=$1", [f.workspaceId]);
    if (changed === "report") await pool.query("UPDATE workspace_checkpoint_requests SET final_save_capture_report='{\"failure\":\"capture_failed\"}' WHERE id=$1", [f.requestId]);
    if (changed === "authority") await pool.query("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1", [f.workspaceId]);
    if (changed === "history") await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,operation,state,completed_at,idempotency_key,request_sha256,affects_workspace)
      VALUES($1::uuid,$2,$3,1,'stop','superseded',now(),$1::text,digest($1::text,'sha256'),false)`, [randomUUID(),f.workspaceId,f.organizationId]);
    await expect(manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: plan.approval }))
      .rejects.toMatchObject({ code: "owner_delete_approval_mismatch" });
    expect(await receipts()).toBe(0);
  });

  it.each(["liveEngine", "capture", "hold", "operator", "ownerMembership", "personal"] as const)("refuses unsafe %s", async changed => {
    const f = await fixture(changed === "liveEngine");
    if (changed === "liveEngine") await readyAgain(f, true);
    if (changed === "capture") await pool.query(`INSERT INTO workspace_checkpoint_requests
      (id,workspace_id,org_id,generation,reason,state,idempotency_key,deadline_at)
      VALUES($1::uuid,$2,$3,1,'manual','queued',$1::text,now()+interval '1 minute')`, [randomUUID(),f.workspaceId,f.organizationId]);
    if (changed === "hold") await pool.query("UPDATE workspace_checkpoints SET legal_hold=true WHERE id=$1", [f.checkpointId]);
    if (changed === "operator") await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [f.userId]);
    if (changed === "ownerMembership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId,f.userId]);
    if (changed === "personal") {
      const id = randomUUID();
      await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Local fixture',$3,true,false)", [id,`personal-${id}`,f.userId]);
      f.request = { ...f.request, organizationId: id, expectedOrganizationSlug: `personal-${id}` };
    }
    await expect(manageCloudOwnerDiscardDelete(pool, f.request, options())).rejects.toThrow();
    expect(await receipts()).toBe(0);
  });

  it("closes expired ready authority without claiming native retirement", async () => {
    const f = await fixture(true);
    await readyAgain(f, false);
    await execute(f);
    expect((await pool.query("SELECT state,revoked_at IS NOT NULL AS revoked,final_checkpoint_at FROM cloud_workspace_engine_instances WHERE id=$1", [f.current.engineInstanceId])).rows[0])
      .toEqual({ state: "revoked", revoked: true, final_checkpoint_at: null });
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven", [f.stopId])).rows[0].proven).toBe(false);
  });

  it("retains the exact bounded historical inventory and cannot adopt a later child", async () => {
    const f = await fixture(), historicalId = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,operation,state,completed_at,idempotency_key,request_sha256,affects_workspace)
      VALUES($1::uuid,$2,$3,1,'stop','superseded',now(),$1::text,digest($1::text,'sha256'),false)`, [historicalId,f.workspaceId,f.organizationId]);
    const accepted = await execute(f);
    expect((await pool.query("SELECT lifecycle_intent_id FROM cloud_workspace_owner_delete_dispositions ORDER BY lifecycle_intent_id")).rows.map(r => r.lifecycle_intent_id))
      .toEqual([f.stopId, historicalId, accepted.deleteIntentId].sort());
    await expect(withSystemTx(pool, tx => requestCloudWorkspaceDeletion(tx, { organizationId: f.organizationId,
      workspaceId: f.workspaceId, actorUserId: f.userId, idempotencyKey: randomUUID(), discardUncheckpointed: true })))
      .rejects.toMatchObject({ code: "40001" });
    await expect(pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,operation,idempotency_key,request_sha256,affects_workspace)
      VALUES($1::uuid,$2,$3,1,'stop',$1::text,digest($1::text,'sha256'),false)`, [randomUUID(),f.workspaceId,f.organizationId]))
      .rejects.toMatchObject({ code: "40001" });
    expect(await receipts()).toBe(1);
  });

  it("keeps capture and Stop facts terminal under stale workers", async () => {
    const f = await fixture(), accepted = await execute(f);
    const capture = (await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1", [f.requestId])).rows[0];
    const recovery = (await pool.query("SELECT * FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.stopId])).rows[0];
    for (const state of ["queued", "failed", "succeeded"]) {
      await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state=$2::cloud_workspace_intent_state,
        completed_at=CASE WHEN $2::text='queued' THEN NULL ELSE now() END WHERE id=$1`, [f.stopId,state]);
      await pool.query("UPDATE cloud_workspace_final_save_recoveries SET state='retrying',next_attempt_at=now(),retry_count=retry_count+1 WHERE lifecycle_intent_id=$1", [f.stopId]);
      await pool.query("UPDATE workspace_checkpoint_requests SET final_save_capture_report='{\"late\":true}' WHERE id=$1", [f.requestId]);
    }
    expect((await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1", [f.requestId])).rows[0]).toEqual(capture);
    expect((await pool.query("SELECT * FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.stopId])).rows[0]).toEqual(recovery);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.stopId])).rows[0].state).toBe("superseded");
    await expect(pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',completed_at=NULL WHERE id=$1", [f.stopId])).rejects.toMatchObject({ code: "40001" });
    await withSystemTx(pool, tx => ensureFinalSaveRecovery(tx, accepted.deleteIntentId!));
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven,cloud_final_save_proven($2) AS delete_proven", [f.stopId,accepted.deleteIntentId])).rows[0])
      .toEqual({ proven: false, delete_proven: false });
  });

  it.each(["engine", "lease", "binding", "generation", "content", "intent"] as const)("refuses late %s mutation after loss admission", async changed => {
    const f = await fixture(changed === "engine"), accepted = await execute(f);
    const sql = changed === "engine" ? "UPDATE cloud_workspace_engine_instances SET state='ready',revoked_at=NULL,lease_expires_at=now()+interval '1 minute' WHERE workspace_id=$1"
      : changed === "lease" ? "UPDATE managed_compute_allocation_leases SET funded_until=funded_until+interval '1 minute' WHERE workspace_id=$1"
      : changed === "binding" ? "UPDATE cloud_workspace_provider_bindings SET provider_resource_id='bx_new23456' WHERE workspace_id=$1"
      : changed === "generation" ? "UPDATE cloud_workspace_generations SET image_ref='replacement' WHERE workspace_id=$1"
      : changed === "content" ? "UPDATE workspace_content_heads SET current_revision=current_revision+1 WHERE workspace_id=$1"
      : "UPDATE cloud_workspace_lifecycle_intents SET request_sha256=digest('changed','sha256') WHERE workspace_id=$1 AND operation='delete'";
    await expect(pool.query(sql, [f.workspaceId])).rejects.toThrow();
    expect((await pool.query("SELECT cloud_final_save_dispatchable($1) AS allowed", [accepted.deleteIntentId])).rows[0].allowed).toBe(true);
  });

  it("serializes engine renewal before the first receipt exists", async () => {
    const f = await fixture(true);
    await readyAgain(f, false);
    const held = await pool.connect();
    try {
      await held.query("BEGIN");
      await held.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      await expect(pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=now()+interval '1 minute' WHERE id=$1", [f.current.engineInstanceId]))
        .rejects.toMatchObject({ code: "55P03" });
      expect(await receipts()).toBe(0);
    } finally { await held.query("ROLLBACK"); held.release(); }
    await execute(f);
    await expect(pool.query("UPDATE cloud_workspace_endpoint_grants SET revoked_at=NULL WHERE id=(SELECT registration_grant_id FROM cloud_workspace_engine_instances WHERE id=$1)", [f.current.engineInstanceId]))
      .rejects.toMatchObject({ code: "40001" });
  });

  it("rolls the receipt back when normal Delete admission fails", async () => {
    const f = await fixture(), plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    await pool.query(`CREATE FUNCTION fixture_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture admission failure' USING ERRCODE='40001'; END $$;
      CREATE TRIGGER fixture_refuse_delete BEFORE INSERT ON workspace_deletion_jobs FOR EACH ROW EXECUTE FUNCTION fixture_refuse_delete()`);
    await expect(manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: plan.approval })).rejects.toMatchObject({ code: "40001" });
    expect(await receipts()).toBe(0);
    expect((await pool.query("SELECT state FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.stopId])).rows[0].state).toBe("blocked");
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='delete'", [f.workspaceId])).rows[0].n).toBe(0);
  });

  it("concurrent identical executions commit exactly once", async () => {
    const f = await fixture(), plan = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    const input = { ...options(), execute: true, approval: plan.approval };
    const result = await Promise.all([manageCloudOwnerDiscardDelete(pool, f.request, input), manageCloudOwnerDiscardDelete(pool, f.request, input)]);
    expect(result.map(r => r.state).sort()).toEqual(["deleting", "unchanged"]);
    expect(result[0]!.deleteIntentId).toBe(result[1]!.deleteIntentId); expect(await receipts()).toBe(1);
  });

  it("keeps another organization workspace and owner state independent", async () => {
    const f = await fixture(), other = await seedReadyCloudWorkspace(pool);
    const original = (await pool.query("SELECT * FROM cloud_workspaces WHERE id=$1", [other.workspaceId])).rows[0];
    await execute(f);
    expect((await pool.query("SELECT * FROM cloud_workspaces WHERE id=$1", [other.workspaceId])).rows[0]).toEqual(original);
    expect((await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=lease_expires_at+interval '1 minute' WHERE id=$1 RETURNING id", [other.engineInstanceId])).rowCount).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts WHERE workspace_id=$1", [other.workspaceId])).rows[0].n).toBe(0);
  });

  it("refuses the application role and raw receipt mutation", async () => {
    const f = await fixture(), app = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=zeros_app", max: 1 });
    try {
      await expect(manageCloudOwnerDiscardDelete(app, f.request, options())).rejects.toMatchObject({ code: "owner_delete_database_owner_required" });
      const accepted = await execute(f);
      await expect(withSystemTx(app, tx => tx.query("UPDATE cloud_workspace_owner_delete_receipts SET reason='Application overwrite' WHERE id=$1", [accepted.receiptId])))
        .rejects.toMatchObject({ code: "42501" });
      await expect(pool.query("UPDATE cloud_workspace_owner_delete_receipts SET reason='Owner overwrite attempt' WHERE id=$1", [accepted.receiptId]))
        .rejects.toMatchObject({ code: "55000" });
      await expect(pool.query("DELETE FROM cloud_workspace_owner_delete_dispositions WHERE receipt_id=$1", [accepted.receiptId]))
        .rejects.toMatchObject({ code: "55000" });
      await expect(pool.query("TRUNCATE cloud_workspace_owner_delete_dispositions")).rejects.toMatchObject({ code: "55000" });
    } finally { await app.end(); }
  });
});
