import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_DATABASE_CONTEXT } from "../../db-context.js";
import { withSystemTx, withUserTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const report = (facts: unknown) => {
  if (process.env.CLOUD_EXECUTION_PAYER_SQL_PROOF) appendFileSync(process.env.CLOUD_EXECUTION_PAYER_SQL_PROOF, `${JSON.stringify(facts)}\n`);
};
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("0245 payer guard, RLS and cost", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 15000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.cp.loginChanges.stop(); await f.login(); await f.activate(); await f.hello(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it("keeps payer pins in system-only context rows, bounds their shape, and never changes the pin on renewal", async () => {
    const turn = await f.dispatch(), contextId = turn.begun.contextId;
    const selection = (await pool.query("SELECT selection FROM cloud_v2_execution_contexts WHERE id=$1", [contextId])).rows[0].selection;
    expect(Buffer.byteLength(JSON.stringify(selection))).toBeLessThan(1024);
    expect(Object.keys(selection).sort()).toEqual(["connectionRevision", "credentialId", "credentialRevision", "payer", "source", "version"]);
    expect(Object.keys(selection.payer).sort()).toEqual(["accountRevision", "memberCreatedAt", "memberRevision", "userId"]);
    expect((await withUserTx(pool, f.creator.id, tx => tx.query("SELECT selection FROM cloud_v2_execution_contexts WHERE id=$1", [contextId]))).rowCount).toBe(0);
    expect((await withUserTx(pool, f.creator.id, tx => tx.query("UPDATE cloud_v2_execution_contexts SET selection='{}' WHERE id=$1", [contextId]))).rowCount).toBe(0);
    for (const value of [{ ...selection, payer: { ...selection.payer, userId: f.viewer.id } }, { ...selection, version: 3 },
      { ...selection, extra: "x".repeat(1024) }, { source: selection.source, credentialId: selection.credentialId,
        credentialRevision: selection.credentialRevision, connectionRevision: selection.connectionRevision }]) {
      await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_execution_contexts SET selection=$2 WHERE id=$1", [contextId, value])))
        .rejects.toMatchObject({ code: "23514" });
    }
    expect((await f.worker("execution-leases/renew", { contextIds: [contextId] })).status).toBe(200);
    expect((await pool.query("SELECT selection FROM cloud_v2_execution_contexts WHERE id=$1", [contextId])).rows[0].selection).toEqual(selection);
    expect((await pool.query("SELECT has_function_privilege('public','guard_cloud_execution_payer()','execute') AS allowed")).rows[0].allowed).toBe(false);
  });

  it("measures the expand on 10000 historical rows and indexed empty cutoffs and guard cost for every selection version", async () => {
    const turn = await f.dispatch();
    const tx = await pool.connect();
    try {
      await tx.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      await tx.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state)
        SELECT gen_random_uuid(),org_id,creator_user_id,'Fixture history',repository,'history-'||n,base_branch,'stopped'
        FROM cloud_v2_workspaces w,generate_series(1,10000) n WHERE w.id=$1`, [f.workspace.id]);
      await tx.query(`INSERT INTO cloud_v2_execution_contexts(id,workspace_id,org_id,user_id,kind,client_id,access_epoch,stop_generation,
        worker_boot_id,worker_token_hash,authority,source_fingerprint,expires_at,state,retired_at)
        SELECT gen_random_uuid(),workspace_id,org_id,user_id,'client',gen_random_uuid(),access_epoch,stop_generation,
          worker_boot_id,worker_token_hash,authority,source_fingerprint,expires_at,'retired',clock_timestamp()
        FROM cloud_v2_execution_contexts c,generate_series(1,10000) n WHERE c.id=$1`, [turn.begun.contextId]);
      await tx.query("ANALYZE cloud_v2_execution_contexts");
      const prior = readFileSync(new URL("../../../migrations/0243_cloud_execution_person_authority.sql", import.meta.url), "utf8");
      const start = prior.indexOf("CREATE OR REPLACE FUNCTION fence_cloud_execution_authority()");
      await tx.query(prior.slice(start, prior.indexOf("\n$$;", start) + 4));
      await tx.query("DROP TRIGGER execution_payer_guard ON cloud_v2_execution_contexts; DROP INDEX cloud_execution_payer_live; DROP FUNCTION guard_cloud_execution_payer(); ALTER TABLE cloud_v2_workspaces DROP COLUMN creator_agent_logins");
      const count = (await tx.query("SELECT count(*)::int AS n FROM cloud_v2_execution_contexts")).rows[0].n;
      const sql = readFileSync(new URL("../../../migrations/0245_cloud_execution_payer.sql", import.meta.url), "utf8");
      const heap = (await tx.query("SELECT relfilenode FROM pg_class WHERE oid='cloud_v2_workspaces'::regclass")).rows[0].relfilenode;
      await tx.query(`COMMIT; BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      const started = performance.now(); await tx.query(sql); const elapsed = performance.now() - started;
      expect((await tx.query("SELECT count(*)::int AS n FROM cloud_v2_execution_contexts")).rows[0].n).toBe(count);
      expect((await tx.query("SELECT relfilenode FROM pg_class WHERE oid='cloud_v2_workspaces'::regclass")).rows[0].relfilenode).toBe(heap);
      report({ path: "expand", rows: count, milliseconds: elapsed, backfilled: 0,
        workspaceRows: (await tx.query("SELECT count(*)::int AS n FROM cloud_v2_workspaces")).rows[0].n, rewritten: false,
        locks: (await tx.query("SELECT relation::regclass::text AS relation,mode FROM pg_locks WHERE pid=pg_backend_pid() AND relation IN ('cloud_v2_execution_contexts'::regclass,'cloud_v2_workspaces'::regclass) AND granted ORDER BY relation,mode")).rows });
      await tx.query(`COMMIT; BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      await tx.query("SET LOCAL ROLE zeros_app");
      for (const version of [0, 1, 2]) {
        const measured = (await tx.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) WITH copied AS MATERIALIZED (
          SELECT jsonb_populate_record(NULL::cloud_v2_execution_contexts,to_jsonb(c)||jsonb_build_object(
            'id',gen_random_uuid(),'chat_id',$2||'-'||n,'user_message_id',$2||'-'||n,'dispatch_id',gen_random_uuid(),
            'kind',CASE WHEN $3=0 THEN 'client' ELSE 'turn' END,'client_id',gen_random_uuid(),
            'agent',CASE WHEN $3=0 THEN NULL ELSE c.agent END,'credential_id',CASE WHEN $3=0 THEN NULL ELSE c.credential_id END,
            'selection',CASE WHEN $3=0 THEN NULL WHEN $3=1 THEN c.selection-'version'-'payer' ELSE c.selection END)) AS value
          FROM cloud_v2_execution_contexts c,generate_series(1,250) n WHERE c.id=$1)
          INSERT INTO cloud_v2_execution_contexts SELECT (value).* FROM copied`, [turn.begun.contextId, `cost-${version}`, version])).rows[0]["QUERY PLAN"][0];
        const guard = measured.Triggers.find((item: any) => item["Trigger Name"] === "execution_payer_guard");
        expect(guard.Calls).toBe(250);
        report({ path: "guard-insert", version, rows: 250, milliseconds: measured["Execution Time"], guardMilliseconds: guard.Time,
          guardPerRowMs: guard.Time / guard.Calls });
      }
      await tx.query("RESET ROLE; ANALYZE cloud_v2_execution_contexts; SET LOCAL ROLE zeros_app");
      const plan = (await tx.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) WITH target AS MATERIALIZED (
        SELECT id FROM cloud_v2_execution_contexts WHERE state='active'
          AND (user_id=$1 OR (selection->>'version'='2' AND selection#>>'{payer,userId}'=$1::text)) ORDER BY id FOR UPDATE)
        UPDATE cloud_v2_execution_contexts SET state='revoked',reason='access_revoked' WHERE id IN (SELECT id FROM target)`, [randomUUID()])).rows[0]["QUERY PLAN"][0];
      const indexes = (node: any): string[] => [...(node["Index Name"] ? [node["Index Name"]] : []), ...(node.Plans ?? []).flatMap(indexes)];
      expect(plan.Plan["Actual Rows"]).toBe(0);
      report({ path: "empty-cutoff", rows: 0, indexes: indexes(plan.Plan), milliseconds: plan["Execution Time"], plan });
      expect(indexes(plan.Plan)).toContain("cloud_execution_payer_live");
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  }, 30_000);
});
