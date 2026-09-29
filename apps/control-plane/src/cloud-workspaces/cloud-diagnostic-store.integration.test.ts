import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthedUser } from "../auth.js";
import { runMigrations } from "../migrate.js";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { retainCloudDiagnostic, runCloudDiagnosticCleanup, recoverCloudDiagnostic, diagnosticStorageFailed } from "./cloud-diagnostic-store.js";
import { diagnosticPhases } from "./cloud-diagnostics.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("retained lifecycle diagnostics", () => {
  let pool: pg.Pool, f: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public"); await runMigrations(pool); f = await seedReadyCloudWorkspace(pool); });
  const scope = (id=randomUUID()) => ({ workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1, operationKind: "engine" as const, operationId: id });
  const diagnostic = { phase: "authority_check" as const, code: "engine_unavailable", retryable: false, errorClass: "unknown" as const, decision: "direct_stop" as const };
  it("preserves recovery evidence when 0113 rejects ready after 0114 is installed", async () => {
    // beforeEach applies the actual migration chain in order, including both
    // guards. No replacement trigger or mocked publication is used here.
    expect((await pool.query("SELECT name FROM schema_migrations WHERE name LIKE '0113_%' OR name LIKE '0114_%' ORDER BY name")).rows.map(row => row.name))
      .toEqual(["0113_cloud_workspace_recovery.sql","0114_cloud_lifecycle_diagnostics.sql"]);
    await pool.query("UPDATE cloud_workspaces SET status='failed',desired_state='stopped' WHERE id=$1",[f.workspaceId]);
    const id = await retainCloudDiagnostic(pool,scope(),diagnostic);
    await withSystemTx(pool,async tx => {
      await tx.query(`INSERT INTO cloud_workspace_generations SELECT (jsonb_populate_record(NULL::cloud_workspace_generations,
        to_jsonb(g)||jsonb_build_object('generation',2))).* FROM cloud_workspace_generations g WHERE workspace_id=$1 AND generation=1`,[f.workspaceId]);
      const drain = randomUUID();
      await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,state,completed_at)
        VALUES($1,$2,1,$3,'stop',$4,$5,'succeeded',now())`,[drain,f.workspaceId,f.organizationId,randomUUID(),randomBytes(32)]);
      await tx.query(`INSERT INTO cloud_workspace_generation_transitions(id,workspace_id,org_id,operation,source_generation,template_generation,candidate_generation,state,drain_intent_id,completed_at)
        VALUES($1,$2,$3,'recover',1,1,2,'cancelled',$4,now())`,[randomUUID(),f.workspaceId,f.organizationId,drain]);
    });
    expect((await pool.query("SELECT cloud_workspace_generation_quarantined($1,1,$2) AS quarantined",[f.workspaceId,f.organizationId])).rows[0].quarantined).toBe(true);
    const boundary = async () => (await pool.query("SELECT diagnostic_recovery_at,diagnostic_recovery_generation FROM cloud_workspaces WHERE id=$1",[f.workspaceId])).rows[0];
    const app = new Hono();
    app.use("*",async(c,next) => { c.set("user",{id:f.userId} as AuthedUser); await next(); });
    app.route("/",createCloudWorkspaceRoutes(pool,null,{workosEnabled:false}));
    const publicError = async () => {
      const response = await app.request(`/v1/cloud-workspaces/${f.workspaceId}`);
      expect(response.status).toBe(200);
      return (await response.json()).workspace.error;
    };
    const before = {boundary:await boundary(),error:await publicError()};
    expect(before.error).toMatchObject({code:"cloud_workspace_engine_expired",message:expect.stringContaining(id!)});
    await withSystemTx(pool,tx => tx.query("UPDATE cloud_workspaces SET status='ready',desired_state='running' WHERE id=$1",[f.workspaceId]));
    expect((await pool.query("SELECT status,desired_state,last_error_code FROM cloud_workspaces WHERE id=$1",[f.workspaceId])).rows[0])
      .toEqual({status:"failed",desired_state:"stopped",last_error_code:"recovery_needed"});
    expect.soft(await boundary()).toEqual(before.boundary);
    expect.soft(await publicError()).toEqual(before.error);
    await runCloudDiagnosticCleanup(pool);
    expect((await pool.query("SELECT recovered_at,recovered_generation FROM cloud_workspace_diagnostic_incidents WHERE id=$1",[id])).rows[0])
      .toEqual({recovered_at:null,recovered_generation:null});
    expect(await publicError()).toEqual(before.error);
  });
  it("commits ready under a locked diagnostic row and reconciles recovery later", async () => {
    const id = await retainCloudDiagnostic(pool, scope(), diagnostic);
    await pool.query("UPDATE cloud_workspaces SET status='setting_up' WHERE id=$1", [f.workspaceId]);
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM cloud_workspace_diagnostic_incidents WHERE id=$1 FOR UPDATE", [id]);
    try {
      await withSystemTx(pool, async tx => {
        await tx.query("SET LOCAL statement_timeout='750ms'");
        await tx.query("UPDATE cloud_workspaces SET status='ready' WHERE id=$1", [f.workspaceId]);
      });
      expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].status).toBe("ready");
      expect((await pool.query("SELECT recovered_at FROM cloud_workspace_diagnostic_incidents WHERE id=$1", [id])).rows[0].recovered_at).toBeNull();
      // An hourly job that is not due must still retry publication bookkeeping;
      // the locked row is skipped without delaying that pass.
      await pool.query("UPDATE cloud_workspace_diagnostic_cleanup SET next_run_at=now()+interval '1 hour'");
      await runCloudDiagnosticCleanup(pool);
      expect((await pool.query("SELECT recovered_at FROM cloud_workspace_diagnostic_incidents WHERE id=$1", [id])).rows[0].recovered_at).toBeNull();
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    // A later stop cannot lose the committed ready boundary or make newer
    // failures look recovered when the background job retries skipped work.
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [f.workspaceId]);
    const later = await retainCloudDiagnostic(pool, scope(), diagnostic);
    await runCloudDiagnosticCleanup(pool);
    const rows = (await pool.query("SELECT id,recovered_at FROM cloud_workspace_diagnostic_incidents ORDER BY first_at")).rows;
    expect(rows.find(row => row.id === id).recovered_at).not.toBeNull();
    expect(rows.find(row => row.id === later).recovered_at).toBeNull();
  });
  it.each(["publication", "reconciliation"])("reserves recovery growth in organization byte caps (%s)", async path => {
    const digest = { expected: "a".repeat(64), observed: "b".repeat(64) };
    const cause = { phase:"image_preflight", code:"setup_image_contract_invalid", errorClass:"provider", retryable:false,
      elapsedMs:86400000, fundedTtlMs:86400000, providerTtlMs:86400000, retryCount:10000, decision:"reject_setup", claim:"current",
      setup:{version:1,phase:"image_preflight",checks:{metadata:false,source:false,engine:false,osRelease:false,packageInventory:false,node:false,
        execution:false,report:false,profile:false,qualified:false,build:false,helpers:false,resources:false,runtime:false},
        digests:{osRelease:digest,packageInventory:digest,node:digest},files:{node:false,supervisor:false,setup:false,engine:false},exit:"nonzero"} };
    const events = Array.from({ length:16 }, () => ({ diagnostic:cause,firstAt:new Date().toISOString(),lastAt:new Date().toISOString(),count:1 }));
    await withSystemTx(pool, async tx => {
      await tx.query("CREATE TEMP TABLE diagnostic_clone_ids(id uuid) ON COMMIT DROP");
      await tx.query("INSERT INTO diagnostic_clone_ids SELECT gen_random_uuid() FROM generate_series(1,70)");
      await tx.query(`INSERT INTO cloud_workspaces SELECT (jsonb_populate_record(NULL::cloud_workspaces,to_jsonb(w)||jsonb_build_object('id',ids.id,'status','setting_up'))).*
        FROM cloud_workspaces w CROSS JOIN diagnostic_clone_ids ids WHERE w.id=$1`, [f.workspaceId]);
      await tx.query(`INSERT INTO workspace_billing_epochs SELECT (jsonb_populate_record(NULL::workspace_billing_epochs,to_jsonb(b)||jsonb_build_object('workspace_id',ids.id))).*
        FROM workspace_billing_epochs b CROSS JOIN diagnostic_clone_ids ids WHERE b.workspace_id=$1`, [f.workspaceId]);
      await tx.query(`INSERT INTO cloud_workspace_generations SELECT (jsonb_populate_record(NULL::cloud_workspace_generations,to_jsonb(g)||jsonb_build_object('workspace_id',ids.id))).*
        FROM cloud_workspace_generations g CROSS JOIN diagnostic_clone_ids ids WHERE g.workspace_id=$1`, [f.workspaceId]);
      await tx.query(`INSERT INTO cloud_workspace_diagnostic_incidents(workspace_id,org_id,generation,operation_kind,operation_id,reason,first_cause,terminal_cause,events)
        SELECT ids.id,$1,1,'engine',gen_random_uuid(),'image_integrity_rejected',$2,$2,$3 FROM diagnostic_clone_ids ids CROSS JOIN generate_series(1,8)`, [f.organizationId,JSON.stringify(cause),JSON.stringify(events)]);
    });
    const bytes = async () => Number((await pool.query("SELECT sum(octet_length(row_to_json(d)::text)) AS bytes FROM cloud_workspace_diagnostic_incidents d WHERE org_id=$1", [f.organizationId])).rows[0].bytes);
    await runCloudDiagnosticCleanup(pool);
    // Fill the remaining headroom with bounded event counts, so the fixture is
    // deterministically near the cap despite schema/serialization size changes.
    let remaining = 8388608 - 100 - await bytes();
    for (const row of (await pool.query("SELECT id,events FROM cloud_workspace_diagnostic_incidents")).rows) {
      if (remaining <= 0) break;
      for (const event of row.events) {
        const extra = Math.min(15, remaining);
        event.count = Number("1".repeat(extra + 1)); remaining -= extra;
      }
      await pool.query("UPDATE cloud_workspace_diagnostic_incidents SET events=$2 WHERE id=$1", [row.id, JSON.stringify(row.events)]);
    }
    expect(remaining).toBe(0);
    await pool.query("UPDATE cloud_workspace_diagnostic_cleanup SET next_run_at=now()");
    await runCloudDiagnosticCleanup(pool);
    expect(await bytes()).toBeLessThanOrEqual(8388608);
    if (path === "publication") {
      await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspaces SET status='ready',desired_state='running' WHERE org_id=$1", [f.organizationId]));
      for (let batch=0;batch<3;batch++) await runCloudDiagnosticCleanup(pool);
    } else {
      // Exercise the post-reconciliation writer independently of the trigger.
      await pool.query("ALTER TABLE cloud_workspaces DISABLE TRIGGER cloud_workspace_ready_diagnostic_recovery");
      await pool.query("UPDATE cloud_workspaces SET status='ready',desired_state='running' WHERE org_id=$1", [f.organizationId]);
      for (const row of (await pool.query("SELECT DISTINCT workspace_id FROM cloud_workspace_diagnostic_incidents")).rows)
        await recoverCloudDiagnostic(pool,{workspaceId:row.workspace_id,organizationId:f.organizationId,generation:1});
      await pool.query("ALTER TABLE cloud_workspaces ENABLE TRIGGER cloud_workspace_ready_diagnostic_recovery");
    }
    expect(Number((await pool.query("SELECT count(*) AS n FROM cloud_workspace_diagnostic_incidents WHERE recovered_at IS NULL")).rows[0].n)).toBe(0);
    expect(await bytes()).toBeLessThanOrEqual(8388608);
  });
  it("bounds storage-failure bookkeeping so a locked counter cannot defer a safety stop", async () => {
    const blocker = await pool.connect();
    await blocker.query("BEGIN; SELECT id FROM cloud_workspace_diagnostic_cleanup FOR UPDATE");
    const attempt = diagnosticStorageFailed(pool).then(() => true);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([attempt, new Promise<boolean>(resolve => {
        timeout = setTimeout(() => resolve(false), 1500);
      })]);
      expect(completed).toBe(true);
    } finally {
      clearTimeout(timeout);
      await blocker.query("ROLLBACK");
      blocker.release();
      await attempt;
    }
  });
  it("coalesces repeated causes, preserves first and terminal through compaction and expires details", async () => {
    const identity=scope();
    const retryDiagnostic = { ...diagnostic,decision:"retry" as const };
    const id=await retainCloudDiagnostic(pool,identity,retryDiagnostic);
    await retainCloudDiagnostic(pool,identity,retryDiagnostic);
    for (const phase of diagnosticPhases) await retainCloudDiagnostic(pool,identity,{ ...retryDiagnostic,phase });
    let row=(await pool.query("SELECT * FROM cloud_workspace_diagnostic_incidents WHERE id=$1",[id])).rows[0];
    expect(row.events.length).toBeLessThanOrEqual(16);
    expect(row.first_cause.phase).toBe("authority_check");
    expect(row.terminal_cause.phase).toBe("engine_readiness");
    expect(row.events[0].count).toBe(3);
    await recoverCloudDiagnostic(pool,identity);
    row=(await pool.query("SELECT * FROM cloud_workspace_diagnostic_incidents WHERE id=$1",[id])).rows[0];
    expect(row.recovered_at).not.toBeNull(); expect(row.first_cause).toEqual(retryDiagnostic);
    await pool.query(`UPDATE cloud_workspace_diagnostic_incidents SET first_at=now()-interval '9 days',last_at=now()-interval '8 days',
      events=(SELECT jsonb_agg(event||jsonb_build_object('lastAt',now()-interval '8 days')) FROM jsonb_array_elements(events) event)`);
    await runCloudDiagnosticCleanup(pool);
    row=(await pool.query("SELECT * FROM cloud_workspace_diagnostic_incidents WHERE id=$1",[id])).rows[0];
    expect(row.events).toEqual([]); expect(row.terminal_cause).toMatchObject({ phase: "engine_readiness",code: "engine_unavailable" });
    await pool.query("UPDATE cloud_workspace_diagnostic_incidents SET last_at=now()-interval '31 days'");
    await pool.query("UPDATE cloud_workspace_diagnostic_cleanup SET next_run_at=now()");
    await runCloudDiagnosticCleanup(pool);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_diagnostic_incidents")).rowCount).toBe(0);
  });
  it("bounds concurrent workspace retention and rejects stale setup claims and tenants", async () => {
    await Promise.all(Array.from({ length: 12 }, () => retainCloudDiagnostic(pool,scope(),diagnostic)));
    expect((await pool.query("SELECT sum(jsonb_array_length(events))::int AS n,count(*)::int AS rows FROM cloud_workspace_diagnostic_incidents")).rows[0]).toMatchObject({ rows: 8,n:8 });
    expect(await retainCloudDiagnostic(pool,{ ...scope(),generation: 2 },diagnostic)).toBeNull();
    expect(await retainCloudDiagnostic(pool,{ ...scope(),organizationId: randomUUID() },diagnostic)).toBeNull();
    const setup=(await pool.query("SELECT id,execution_fence FROM cloud_workspace_setup_runs WHERE workspace_id=$1 LIMIT 1",[f.workspaceId])).rows[0];
    expect(await retainCloudDiagnostic(pool,{ ...scope(setup.id),operationKind:"setup",executionFence:Number(setup.execution_fence)+1 },diagnostic)).toBeNull();
    await recoverCloudDiagnostic(pool,{...scope(),setupRunId:setup.id,executionFence:Number(setup.execution_fence)+1});
    expect((await pool.query("SELECT 1 FROM cloud_workspace_diagnostic_incidents WHERE recovered_at IS NOT NULL")).rowCount).toBe(0);
    await recoverCloudDiagnostic(pool,{...scope(),generation:2});
    expect((await pool.query("SELECT 1 FROM cloud_workspace_diagnostic_incidents WHERE recovered_at IS NOT NULL")).rowCount).toBe(0);
    await withSystemTx(pool, async tx => {
      await tx.query("SET LOCAL ROLE zeros_app");
      await tx.query("SELECT set_config('app.system','off',true)");
      expect((await tx.query("SELECT 1 FROM cloud_workspace_diagnostic_incidents")).rowCount).toBe(0);
    });
  });
  it("links recovery only after ready publication while preserving the original cause",async()=>{
    const id=await retainCloudDiagnostic(pool,scope(),diagnostic);
    await pool.query("UPDATE cloud_workspaces SET status='setting_up' WHERE id=$1",[f.workspaceId]);
    await recoverCloudDiagnostic(pool,scope());
    expect((await pool.query("SELECT recovered_at FROM cloud_workspace_diagnostic_incidents WHERE id=$1",[id])).rows[0].recovered_at).toBeNull();
    await pool.query("UPDATE cloud_workspaces SET status='ready',last_error_code=NULL,last_error_message=NULL WHERE id=$1",[f.workspaceId]);
    await runCloudDiagnosticCleanup(pool);
    const row=(await pool.query("SELECT * FROM cloud_workspace_diagnostic_incidents WHERE id=$1",[id])).rows[0];
    expect(row.recovered_at).not.toBeNull(); expect(row.recovered_generation).toBe(1); expect(row.first_cause).toEqual(diagnostic);
  });
});
