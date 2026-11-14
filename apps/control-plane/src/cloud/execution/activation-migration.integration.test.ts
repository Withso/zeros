import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_V2_WORKSPACE_COLUMNS } from "../store.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type Plan = { "Node Type": string; "Index Name"?: string; Plans?: Plan[]; "Actual Rows"?: number; Filter?: string };
const shape = (plan: Plan): unknown => ({ node: plan["Node Type"], index: plan["Index Name"], plans: plan.Plans?.map(shape) });
const median = (values: number[]) => values.sort((a,b) => a-b)[Math.floor(values.length/2)]!;
const report = (value: unknown) => {
  if (process.env.CLOUD_EXECUTION_SQL_PROOF_FILE) appendFileSync(process.env.CLOUD_EXECUTION_SQL_PROOF_FILE, `${JSON.stringify(value)}\n`);
};
database("0240 protocol policy cost and migration locks", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, statement_timeout: 15_000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool);
    await pool.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state,created_at)
      SELECT gen_random_uuid(),$1,CASE WHEN n<=500 THEN $2::uuid ELSE $3::uuid END,'Fixture','example/project','work','main','stopped',
        clock_timestamp()-make_interval(secs=>n) FROM generate_series(1,10000) n`, [f.organizationId,f.creator.id,f.viewer.id]);
    await pool.query("ANALYZE cloud_v2_workspaces; ANALYZE organization_members; ANALYZE organizations; ANALYZE users");
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  // The 496 real EXPLAIN samples measure executor cost; their wall clock also includes database round trips.
  it("keeps released list and hot-read index plans for both legacy and prepared rows", async () => {
    const columns = CLOUD_V2_WORKSPACE_COLUMNS.join(","), queries = {
      list: { sql: `SELECT ${columns} FROM cloud_v2_workspaces w WHERE w.org_id=$1 AND w.creator_user_id=$2 AND w.state<>'deleted'
        AND EXISTS(SELECT 1 FROM organization_members m WHERE m.org_id=w.org_id AND m.user_id=$2) ORDER BY w.created_at DESC,w.id LIMIT 200`,
      values: [f.organizationId,f.creator.id], rows: 200 },
      hot: { sql: `SELECT ${columns},access_epoch::text,login_revision::text FROM cloud_v2_workspaces w
        WHERE w.id=$1 AND w.creator_user_id=$2 AND w.state<>'deleted' AND ${CLOUD_V2_LIVE_ACCESS}`,
      values: [f.workspace.id,f.creator.id], rows: 1 },
    };
    const client = await pool.connect();
    try {
      for (const mode of ["legacy","prepared"]) {
        await client.query("UPDATE cloud_v2_workspaces SET execution_mode=$1", [mode]);
        for (const [name, query] of Object.entries(queries)) {
          const observations = [];
          for (const policy of [false,true]) for (const marker of [false,true]) {
            await client.query("BEGIN");
            try {
              if (!policy) await client.query("DROP POLICY cloud_execution_protocol ON cloud_v2_workspaces");
              await client.query("SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
              if (marker) await client.query("SELECT set_config('app.cloud_execution_protocol','1',true)");
              const samples: number[] = []; let plan!: Plan;
              for (let n=0; n<31; n++) {
                const explained = (await client.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${query.sql}`, query.values)).rows[0]["QUERY PLAN"][0];
                plan = explained.Plan;
                if (n) samples.push(explained["Execution Time"]);
              }
              expect(plan["Actual Rows"]).toBe(query.rows);
              expect(JSON.stringify(plan)).toMatch(/Index Scan|Index Only Scan|Bitmap Index Scan/);
              observations.push({ policy,marker,medianMs: median(samples),shape: shape(plan) });
              report({ mode,name,policy,marker,plan,medianMs: median(samples),rows: query.rows });
            } finally { await client.query("ROLLBACK"); }
          }
          for (const item of observations.slice(1)) expect(item.shape).toEqual(observations[0]!.shape);
          report({ mode,name,additionalMicrosecondsPerReturnedRow: (observations[3]!.medianMs-observations[1]!.medianMs)*1000/query.rows });
        }
      }
    } finally { client.release(); }
  }, 30_000);

  it("measures the scoped foreign key and verifies column-selective SET NULL on real PostgreSQL", async () => {
    const existing = (await pool.query("SELECT pg_get_constraintdef(oid) AS sql FROM pg_constraint WHERE conname='cloud_execution_transition_scope'")).rows[0].sql as string;
    expect(existing).toContain("ON DELETE SET NULL (execution_transition_id)");
    await pool.query("ALTER TABLE cloud_v2_workspaces DROP CONSTRAINT cloud_execution_transition_scope");
    const client = await pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout='1s'");
      const start = performance.now();
      await client.query(`ALTER TABLE cloud_v2_workspaces ADD CONSTRAINT cloud_execution_transition_scope ${existing}`);
      const durationMs = performance.now()-start;
      const locks = (await client.query(`SELECT relation::regclass::text AS relation,mode FROM pg_locks WHERE pid=pg_backend_pid()
        AND relation IN ('cloud_v2_workspaces'::regclass,'cloud_v2_execution_activations'::regclass) AND granted ORDER BY relation,mode`)).rows;
      expect(locks).toContainEqual({ relation: "cloud_v2_workspaces", mode: "ShareRowExclusiveLock" });
      expect(locks).toContainEqual({ relation: "cloud_v2_execution_activations", mode: "ShareRowExclusiveLock" });
      report({ foreignKey: "cloud_execution_transition_scope", rows: 10002, durationMs, locks,
        postgres: (await client.query("SHOW server_version")).rows[0].server_version });
      await client.query("COMMIT");
    } finally { await client.query("ROLLBACK"); client.release(); }
    const a = (await pool.query(`INSERT INTO cloud_v2_execution_activations(id,workspace_id,org_id,runtime_sha256,target_fingerprint,request_hash,reason_hash,prepared_snapshot)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,decode($5,'hex'),decode($5,'hex'),'{}') RETURNING id`,
    [f.workspace.id,f.organizationId,"b".repeat(64),"c".repeat(16),"d".repeat(64)])).rows[0].id;
    await pool.query("UPDATE cloud_v2_workspaces SET execution_transition_id=$2 WHERE id=$1", [f.workspace.id,a]);
    await pool.query("DELETE FROM cloud_v2_execution_activations WHERE id=$1", [a]);
    expect((await pool.query("SELECT id,org_id,execution_transition_id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows)
      .toEqual([{ id: f.workspace.id,org_id: f.organizationId,execution_transition_id: null }]);
  });

  it("pins the reviewed SQL, resets inherited app grants and preserves owner-only activation identity", async () => {
    const source = readFileSync(new URL("../../../migrations/0240_cloud_execution_activation.sql", import.meta.url), "utf8");
    const statement = source.match(/CREATE POLICY cloud_execution_protocol[\s\S]*?;/)![0];
    expect(createHash("sha256").update(statement).digest("hex")).toBe("f517b301b8cdf2d2fb9d4f43fa8ef5ddb5a741e6fd32c3e08545ec63d6d9cacd");
    for (const table of ["cloud_v2_execution_activations","cloud_v2_execution_activation_receipts"]) {
      for (const privilege of ["INSERT","DELETE","TRUNCATE","UPDATE"])
        expect((await pool.query("SELECT has_table_privilege('zeros_app',$1,$2) AS allowed", [table,privilege])).rows[0].allowed).toBe(false);
      expect((await pool.query("SELECT has_table_privilege('zeros_app',$1,'SELECT') AS allowed", [table])).rows[0].allowed).toBe(true);
    }
    expect((await pool.query("SELECT has_column_privilege('zeros_app','cloud_v2_execution_activations','phase','UPDATE') AS allowed")).rows[0].allowed).toBe(true);
    for (const column of ["runtime_sha256","initiator_user_id","operator_user_id","intent_id","started_at","deadline_at","prepared_snapshot"])
      expect((await pool.query("SELECT has_column_privilege('zeros_app','cloud_v2_execution_activations',$1,'UPDATE') AS allowed", [column])).rows[0].allowed).toBe(false);
  });

  it("measures the complete migration lock interval, including the first ADD COLUMN", async () => {
    const source = readFileSync(new URL("../../../migrations/0240_cloud_execution_activation.sql", import.meta.url), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DROP POLICY cloud_execution_protocol ON cloud_v2_workspaces;
        ALTER TABLE cloud_v2_workspaces DROP CONSTRAINT cloud_execution_transition_scope;
        DROP TABLE cloud_v2_execution_activation_receipts,cloud_v2_execution_activations;
        ALTER TABLE cloud_v2_workspaces DROP COLUMN execution_transition_id,DROP COLUMN execution_restore_claimed_at;
        ALTER TABLE cloud_v2_execution_boots DROP COLUMN legacy_material,DROP COLUMN first_failed_legacy_material`);
      const start = performance.now();
      await client.query(source);
      const durationMs = performance.now() - start;
      const locks = (await client.query(`SELECT relation::regclass::text AS relation,mode FROM pg_locks WHERE pid=pg_backend_pid()
        AND relation='cloud_v2_workspaces'::regclass AND granted ORDER BY mode`)).rows;
      expect(locks).toContainEqual({ relation: "cloud_v2_workspaces", mode: "AccessExclusiveLock" });
      expect((await client.query("SELECT count(*)::int AS count FROM cloud_v2_workspaces")).rows[0].count).toBe(10002);
      report({ migration: "0240", rows: 10002, durationMs, locks });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});
