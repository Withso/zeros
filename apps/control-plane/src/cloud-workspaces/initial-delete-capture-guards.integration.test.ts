import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx } from "../db.js";
import { seedInitialDeleteCapture } from "./initial-delete-capture-test-fixtures.js";
import { seedFinalSaveEngine } from "./final-save-test-fixtures.js";
import { manageCloudInitialDeleteCapture as manage } from "../manage-cloud-initial-delete-capture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("initial Delete source boundaries", () => {
  let pool: pg.Pool, app: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
    app = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=zeros_app", max: 3 });
  });
  afterAll(async () => { await app.end(); await pool.end(); });
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });
  const admit = (id: string) => withSystemTx(app, tx => tx.query("SELECT admit_cloud_initial_delete_capture($1,NULL,false) AS id", [id]));

  it.each([
    ["earlier registration", "UPDATE cloud_workspace_engine_instances SET registered_at=created_at WHERE workspace_id=$1"],
    ["revoked engine", "UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=clock_timestamp() WHERE workspace_id=$1"],
    ["expired engine lease", "UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=clock_timestamp()-interval '1 hour',lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1"],
    ["later authority epoch", "UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1"],
    ["dispatch attempt", "UPDATE cloud_workspace_lifecycle_intents SET attempt_count=1 WHERE workspace_id=$1 AND operation='delete'"],
    ["native custody", "UPDATE cloud_workspace_final_save_recoveries SET custody_id=gen_random_uuid() WHERE workspace_id=$1"],
    ["retired writer", "UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=clock_timestamp() WHERE workspace_id=$1"],
    ["a prior request", "INSERT INTO workspace_checkpoint_requests(workspace_id,org_id,generation,reason,state,idempotency_key,deadline_at,completed_at) SELECT id,org_id,1,'manual','cancelled','prior-request',clock_timestamp()+interval '1 minute',clock_timestamp() FROM cloud_workspaces WHERE id=$1"],
  ])("refuses %s without changing the recovery or creating a receipt", async (_name, sql) => {
    const f = await seedInitialDeleteCapture(pool);
    await withSystemTx(pool, tx => tx.query(sql!, [f.workspaceId]));
    const before = (await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0].value;
    expect((await admit(f.deleteId)).rows).toEqual([{ id: null }]);
    expect((await pool.query("SELECT to_jsonb(r) AS value FROM cloud_workspace_final_save_recoveries r WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0].value).toEqual(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_initial_delete_captures")).rows[0].n).toBe(0);
  });

  it("retains the existing guard that prevents an unresolved Delete from becoming terminal", async () => {
    const f = await seedInitialDeleteCapture(pool);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_lifecycle_intents SET state='superseded',error_code='fixture_superseded',completed_at=clock_timestamp() WHERE id=$1", [f.deleteId]));
    expect((await pool.query("SELECT state,completed_at FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.deleteId])).rows)
      .toEqual([{ state: "queued", completed_at: null }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_initial_delete_captures")).rows[0].n).toBe(0);
  });

  it("refuses replacement enrollment instead of rebinding an already pinned source", async () => {
    const f = await seedInitialDeleteCapture(pool);
    await withSystemTx(pool, tx => seedFinalSaveEngine(tx, { ...f, setupAttempt: 2 }));
    expect((await admit(f.deleteId)).rows).toEqual([{ id: null }]);
    expect((await pool.query("SELECT engine_instance_id,registered_at FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.deleteId])).rows)
      .toEqual([{ engine_instance_id: f.engineInstanceId, registered_at: null }]);
  });

  it("serializes two first binders into one request and retains raw source immutability", async () => {
    const f = await seedInitialDeleteCapture(pool);
    const [first, second] = await Promise.all([admit(f.deleteId), admit(f.deleteId)]);
    expect(first.rows[0].id).toEqual(expect.any(String)); expect(second.rows).toEqual(first.rows);
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [f.deleteId])).rows[0].n).toBe(1);
    for (const sql of ["UPDATE cloud_workspace_final_save_recoveries SET engine_instance_id=gen_random_uuid() WHERE lifecycle_intent_id=$1",
      "UPDATE cloud_workspace_final_save_recoveries SET registration_token_sha256=$2 WHERE lifecycle_intent_id=$1"]) {
      await expect(withSystemTx(app, tx => tx.query(sql, sql.includes("$2") ? [f.deleteId, randomBytes(32)] : [f.deleteId])))
        .rejects.toMatchObject({ code: "23514" });
    }
    await expect(pool.query("UPDATE cloud_workspace_initial_delete_captures SET original_recovery='{}' WHERE lifecycle_intent_id=$1", [f.deleteId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("DELETE FROM cloud_workspace_initial_delete_captures WHERE lifecycle_intent_id=$1", [f.deleteId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("TRUNCATE cloud_workspace_initial_delete_captures")).rejects.toMatchObject({ code: "55000" });
  });

  it.each(["engine", "writer", "lease"] as const)("locks %s authority while the first receipt is invisible", async kind => {
    const f = await seedInitialDeleteCapture(pool), held = await pool.connect();
    try {
      await held.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      const request = (await held.query("SELECT admit_cloud_initial_delete_capture($1,NULL,false) AS id", [f.deleteId])).rows[0].id;
      expect(request).toEqual(expect.any(String));
      expect((await withSystemTx(app, tx => tx.query("SELECT count(*)::int AS n FROM cloud_workspace_initial_delete_captures"))).rows[0].n).toBe(0);
      await expect(withSystemTx(app, async tx => {
        await tx.query("SET LOCAL lock_timeout='250ms'");
        const sql = kind === "engine" ? "UPDATE cloud_workspace_engine_instances SET revoked_at=clock_timestamp(),state='revoked' WHERE workspace_id=$1"
          : kind === "writer" ? "UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=clock_timestamp() WHERE workspace_id=$1"
          : "UPDATE managed_compute_allocation_leases SET state='settled',settled_at=clock_timestamp() WHERE workspace_id=$1";
        await tx.query(sql, [f.workspaceId]);
      })).rejects.toMatchObject({ code: "55P03" });
      await held.query("COMMIT");
      expect((await admit(f.deleteId)).rows).toEqual([{ id: request }]);
    } finally { await held.query("ROLLBACK").catch(() => {}); held.release(); }
  });

  it("keeps owner/organization A-to-B-to-A requests isolated and requires a migration owner for the operator", async () => {
    const a = await seedInitialDeleteCapture(pool), b = await seedInitialDeleteCapture(pool);
    const plan = await manage(pool, a.request, options());
    await expect(manage(pool, { ...a.request, deleteIntentId: b.deleteId }, options())).rejects.toMatchObject({ code: "initial_delete_source_changed" });
    await expect(manage(app, a.request, options())).rejects.toMatchObject({ code: "initial_delete_database_owner_required" });
    const first = await manage(pool, a.request, { ...options(), execute: true, approval: plan.approval });
    expect((await pool.query("SELECT current_request_id FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [b.deleteId])).rows[0].current_request_id).toBeNull();
    expect(await manage(pool, a.request, { ...options(), execute: true, approval: plan.approval })).toMatchObject({ state: "unchanged", captureRequestId: first.captureRequestId });
    await expect(manage(pool, { ...b.request, deleteIntentId: a.deleteId, engineInstanceId: randomUUID() }, options()))
      .rejects.toMatchObject({ code: "initial_delete_source_unavailable" });
  });
});
