import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_V2_WORKSPACE_COLUMNS } from "../store.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type Plan = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: Plan[];
};
const shape = (plan: Plan): unknown => ({ node: plan["Node Type"], index: plan["Index Name"], plans: plan.Plans?.map(shape) });
const planNodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
const workspaceScans = (plan: Plan) => planNodes(plan).filter(node => node["Relation Name"] === "cloud_v2_workspaces");
type WorkspacePlanWork = { ok: boolean; examinedRows?: number; bitmapIndexEntries?: number; scanType?: string; reason?: string };
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const bitmapIndexes = (plan: Plan): Plan[] => plan["Node Type"] === "Bitmap Index Scan" ? [plan] : (plan.Plans ?? []).flatMap(bitmapIndexes);
const workspacePlanWork = (plan: Plan, bound: number, bitmapIndexBound = bound * 3): WorkspacePlanWork => {
  if (!Number.isSafeInteger(bound) || bound < 1) return { ok: false, reason: "invalid workspace work bound" };
  if (!Number.isSafeInteger(bitmapIndexBound) || bitmapIndexBound < 1) return { ok: false, reason: "invalid bitmap index work bound" };
  const scans = workspaceScans(plan);
  if (scans.length !== 1) return { ok: false, reason: `expected one cloud_v2_workspaces scan, got ${scans.length}` };
  const scan = scans[0]!;
  const rows = count(scan["Actual Rows"]), loops = count(scan["Actual Loops"]);
  if (rows === null) return { ok: false, scanType: scan["Node Type"], reason: "missing Actual Rows" };
  if (loops === null || loops === 0) return { ok: false, scanType: scan["Node Type"], reason: "missing or invalid Actual Loops" };
  const filtered = scan["Rows Removed by Filter"] === undefined ? 0 : count(scan["Rows Removed by Filter"]);
  const rechecked = scan["Rows Removed by Index Recheck"] === undefined ? 0 : count(scan["Rows Removed by Index Recheck"]);
  if (filtered === null || rechecked === null) return { ok: false, scanType: scan["Node Type"], reason: "invalid removed-row counter" };
  const examinedRows = Math.ceil((rows + filtered + rechecked) * loops);
  const scanType = scan["Node Type"];
  if (!Number.isSafeInteger(examinedRows)) return { ok: false, examinedRows, scanType, reason: "invalid workspace work count" };
  const indexed = ((scanType === "Index Scan" || scanType === "Index Only Scan") && Boolean(scan["Index Name"])) ||
    (scanType === "Bitmap Heap Scan" && bitmapIndexes(scan).every(index => Boolean(index["Index Name"])) && bitmapIndexes(scan).length > 0);
  if (!indexed) return { ok: false, examinedRows, scanType, reason: `unsupported workspace access: ${scanType}` };
  if (examinedRows > bound) return { ok: false, examinedRows, scanType, reason: `workspace examined ${examinedRows} rows; bound is ${bound}` };
  const bitmapIndexEntries = bitmapIndexes(scan).reduce((total, index) => {
    const indexRows = count(index["Actual Rows"]), indexLoops = count(index["Actual Loops"]);
    if (indexRows === null || indexLoops === null || indexLoops === 0) return Number.NaN;
    const indexFiltered = index["Rows Removed by Filter"] === undefined ? 0 : count(index["Rows Removed by Filter"]);
    const indexRechecked = index["Rows Removed by Index Recheck"] === undefined ? 0 : count(index["Rows Removed by Index Recheck"]);
    if (indexFiltered === null || indexRechecked === null) return Number.NaN;
    return total + Math.ceil((indexRows + indexFiltered + indexRechecked) * indexLoops);
  }, 0);
  if (!Number.isSafeInteger(bitmapIndexEntries)) return { ok: false, examinedRows, scanType, reason: "missing or invalid bitmap index counters" };
  if (bitmapIndexEntries > bitmapIndexBound)
    return { ok: false, examinedRows, bitmapIndexEntries, scanType, reason: `bitmap index examined ${bitmapIndexEntries} entries; bound is ${bitmapIndexBound}` };
  return { ok: true, examinedRows, bitmapIndexEntries, scanType };
};
const median = (values: number[]) => values.sort((a,b) => a-b)[Math.floor(values.length/2)]!;
const report = (value: unknown) => {
  if (process.env.CLOUD_EXECUTION_SQL_PROOF_FILE) appendFileSync(process.env.CLOUD_EXECUTION_SQL_PROOF_FILE, `${JSON.stringify(value)}\n`);
};

describe("workspace executor-work plan guard", () => {
  it("counts bitmap heap tuples once rather than adding bitmap index entries", () => {
    const plan: Plan = { "Node Type": "Limit", Plans: [{ "Node Type": "Bitmap Heap Scan", "Relation Name": "cloud_v2_workspaces",
      "Actual Rows": 501, "Actual Loops": 1, Plans: [{ "Node Type": "Bitmap Index Scan", "Index Name": "cloud_v2_workspaces_creator",
        "Actual Rows": 996, "Actual Loops": 1 }] }] };
    expect(workspacePlanWork(plan, 501)).toMatchObject({ ok: true, examinedRows: 501, bitmapIndexEntries: 996, scanType: "Bitmap Heap Scan" });
  });

  it("accounts for bitmap index loops and removed entries separately", () => {
    const plan: Plan = { "Node Type": "Bitmap Heap Scan", "Relation Name": "cloud_v2_workspaces", "Actual Rows": 1, "Actual Loops": 1,
      Plans: [{ "Node Type": "Bitmap Index Scan", "Index Name": "workspaces_test_idx", "Actual Rows": 10, "Actual Loops": 2,
        "Rows Removed by Index Recheck": 1 }] };
    expect(workspacePlanWork(plan, 1, 22)).toMatchObject({ ok: true, examinedRows: 1, bitmapIndexEntries: 22 });
  });

  it("rejects unbounded bitmap index work even when heap rows are bounded", () => {
    const plan: Plan = { "Node Type": "Bitmap Heap Scan", "Relation Name": "cloud_v2_workspaces", "Actual Rows": 1, "Actual Loops": 1,
      Plans: [{ "Node Type": "Bitmap Index Scan", "Index Name": "workspaces_test_idx", "Actual Rows": 1504, "Actual Loops": 1 }] };
    expect(workspacePlanWork(plan, 501, 1503)).toMatchObject({ ok: false, examinedRows: 1, bitmapIndexEntries: 1504 });
  });

  it("fails closed when a bitmap index counter is missing", () => {
    const plan: Plan = { "Node Type": "Bitmap Heap Scan", "Relation Name": "cloud_v2_workspaces", "Actual Rows": 1, "Actual Loops": 1,
      Plans: [{ "Node Type": "Bitmap Index Scan", "Index Name": "workspaces_test_idx", "Actual Loops": 1 }] };
    expect(workspacePlanWork(plan, 1)).toMatchObject({ ok: false, reason: "missing or invalid bitmap index counters" });
  });

  it("multiplies scan rows and filter/recheck removals by loops", () => {
    const plan: Plan = { "Node Type": "Index Scan", "Relation Name": "cloud_v2_workspaces", "Index Name": "workspaces_test_idx",
      "Actual Rows": 20, "Actual Loops": 3, "Rows Removed by Filter": 2, "Rows Removed by Index Recheck": 1 };
    expect(workspacePlanWork(plan, 68)).toMatchObject({ ok: false, examinedRows: 69 });
  });

  it("fails closed when actual row or loop counters are missing", () => {
    const plan: Plan = { "Node Type": "Index Scan", "Relation Name": "cloud_v2_workspaces", "Index Name": "workspaces_test_idx",
      "Actual Rows": 1, "Actual Loops": 1 };
    const missingRows = { ...plan };
    delete missingRows["Actual Rows"];
    const missingLoops = { ...plan };
    delete missingLoops["Actual Loops"];
    expect(workspacePlanWork(missingRows, 1)).toMatchObject({ ok: false, reason: "missing Actual Rows" });
    expect(workspacePlanWork(missingLoops, 1)).toMatchObject({ ok: false, reason: "missing or invalid Actual Loops" });
  });

  it("rejects a workspace sequential scan even when another relation has an index", () => {
    const plan: Plan = { "Node Type": "Nested Loop", Plans: [
      { "Node Type": "Seq Scan", "Relation Name": "cloud_v2_workspaces", "Actual Rows": 501, "Actual Loops": 1, "Rows Removed by Filter": 9502 },
      { "Node Type": "Index Scan", "Relation Name": "organization_members", "Index Name": "organization_members_user_idx", "Actual Rows": 1, "Actual Loops": 1 },
    ] };
    expect(workspacePlanWork(plan, 501)).toMatchObject({ ok: false, examinedRows: 10003, scanType: "Seq Scan" });
  });

  it("requires a bitmap index beneath a workspace bitmap heap scan", () => {
    const plan: Plan = { "Node Type": "Bitmap Heap Scan", "Relation Name": "cloud_v2_workspaces", "Actual Rows": 1, "Actual Loops": 1,
      Plans: [{ "Node Type": "Seq Scan", "Relation Name": "organization_members", "Actual Rows": 1, "Actual Loops": 1 }] };
    expect(workspacePlanWork(plan, 1)).toMatchObject({ ok: false, reason: "unsupported workspace access: Bitmap Heap Scan" });
  });
});

database("0240 protocol policy cost and migration locks", () => {
  let pool: pg.Pool, f: ExecutionFixture, expectedListIds: string[];
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, statement_timeout: 15_000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool);
    const existing = (await pool.query("SELECT created_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    await pool.query("VACUUM (ANALYZE) cloud_v2_workspaces");
    const inserted = await pool.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state,created_at)
      SELECT gen_random_uuid(),$1,CASE WHEN n<=500 THEN $2::uuid ELSE $3::uuid END,'Fixture','example/project','work','main','stopped',
        ($4::timestamptz - interval '1 minute') - make_interval(secs=>CASE WHEN n<=2 THEN 1 ELSE n END)
        FROM generate_series(1,10000) n RETURNING id,creator_user_id,created_at`,
    [f.organizationId,f.creator.id,f.viewer.id,existing.created_at]);
    await pool.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state,created_at)
      VALUES(gen_random_uuid(),$1,$2,'Nonmember fixture','example/project','work','main','stopped',$3::timestamptz - interval '2 minutes')`,
    [f.organizationId,f.outsider.id,existing.created_at]);
    const eligible = [{ id: f.workspace.id, created_at: existing.created_at }, ...inserted.rows.filter(row => row.creator_user_id === f.creator.id)];
    expect(eligible).toHaveLength(501);
    expect(inserted.rows.filter(row => row.creator_user_id === f.creator.id && row.created_at.getTime() === inserted.rows[0].created_at.getTime())).toHaveLength(2);
    const compareUuidBytes = (a: string, b: string) => Buffer.from(a.replaceAll("-", ""), "hex").compare(Buffer.from(b.replaceAll("-", ""), "hex"));
    expectedListIds = eligible.sort((a,b) => b.created_at.getTime()-a.created_at.getTime() || compareUuidBytes(a.id,b.id)).slice(0,200).map(row => row.id);
    await pool.query("ANALYZE cloud_v2_workspaces; ANALYZE organization_members; ANALYZE organizations; ANALYZE users");
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  // The 496 real EXPLAIN samples measure executor cost; their wall clock also includes database round trips.
  it("keeps released list and hot-read workspace scans bounded for both legacy and prepared rows", async () => {
    // Each fixture starts with one workspace version and changes execution_mode twice; bitmap entries may revisit each version.
    const bitmapIndexEntryBound = (eligibleWorkspaceRows: number) => eligibleWorkspaceRows * 3;
    const columns = CLOUD_V2_WORKSPACE_COLUMNS.join(","), queries = {
      list: { sql: `SELECT ${columns} FROM cloud_v2_workspaces w WHERE w.org_id=$1 AND w.creator_user_id=$2 AND w.state<>'deleted'
        AND EXISTS(SELECT 1 FROM organization_members m WHERE m.org_id=w.org_id AND m.user_id=$2) ORDER BY w.created_at DESC,w.id LIMIT 200`,
      values: [f.organizationId,f.creator.id], rows: 200, eligibleWorkspaceRows: 501, bitmapIndexEntryBound: bitmapIndexEntryBound(501), expectedIds: expectedListIds },
      hot: { sql: `SELECT ${columns},access_epoch::text,login_revision::text FROM cloud_v2_workspaces w
        WHERE w.id=$1 AND w.creator_user_id=$2 AND w.state<>'deleted' AND ${CLOUD_V2_LIVE_ACCESS}`,
      values: [f.workspace.id,f.creator.id], rows: 1, eligibleWorkspaceRows: 1, bitmapIndexEntryBound: bitmapIndexEntryBound(1), expectedIds: [f.workspace.id] },
    };
    const client = await pool.connect();
    try {
      const explainWithSettings = async (sql: string, values: string[], settings: string): Promise<Plan> => {
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
          await client.query(settings);
          return (await client.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values)).rows[0]["QUERY PLAN"][0].Plan;
        } finally { await client.query("ROLLBACK"); }
      };
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
              const samples: number[] = []; let plan!: Plan, work!: WorkspacePlanWork;
              for (let n=0; n<31; n++) {
                const explained = (await client.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${query.sql}`, query.values)).rows[0]["QUERY PLAN"][0];
                plan = explained.Plan;
                expect(plan["Actual Rows"]).toBe(query.rows);
                work = workspacePlanWork(plan, query.eligibleWorkspaceRows, query.bitmapIndexEntryBound);
                expect(work.ok, `${mode}/${name} policy=${policy} marker=${marker} sample=${n}: ${work.reason}`).toBe(true);
                if (n) samples.push(explained["Execution Time"]);
              }
              const actualIds = (await client.query(query.sql, query.values)).rows.map(row => row.id);
              expect(actualIds).toHaveLength(query.rows);
              expect(actualIds).toEqual(query.expectedIds);
              if (name === "list") {
                expect((await client.query(query.sql, [f.organizationId,f.outsider.id])).rows).toEqual([]);
              } else {
                expect((await client.query(query.sql, [f.workspace.id,f.viewer.id])).rows).toEqual([]);
              }
              const medianMs = median(samples);
              observations.push({ policy,marker,medianMs });
              report({ mode,name,policy,marker,plan,shape: shape(plan),workspaceWork: work,workspaceWorkBound: query.eligibleWorkspaceRows,
                bitmapIndexEntryBound: query.bitmapIndexEntryBound,medianMs,rows: query.rows });
            } finally { await client.query("ROLLBACK"); }
          }
          report({ mode,name,additionalMicrosecondsPerReturnedRow: (observations[3]!.medianMs-observations[1]!.medianMs)*1000/query.rows });
        }
      }
      const sequentialPlan = await explainWithSettings(queries.list.sql, queries.list.values,
        "SET LOCAL enable_indexscan=off; SET LOCAL enable_indexonlyscan=off; SET LOCAL enable_bitmapscan=off; SET LOCAL enable_seqscan=on");
      const sequentialWork = workspacePlanWork(sequentialPlan, queries.list.eligibleWorkspaceRows);
      expect(sequentialPlan["Actual Rows"]).toBe(200);
      expect(sequentialWork).toMatchObject({ ok: false, scanType: "Seq Scan" });
      expect(sequentialWork.examinedRows).toBeGreaterThan(queries.list.eligibleWorkspaceRows);
      report({ negative: "workspace-sequential-scan", plan: sequentialPlan, shape: shape(sequentialPlan), workspaceWork: sequentialWork });

      const broadIndexSql = "SELECT w.id FROM cloud_v2_workspaces w WHERE lower(w.creator_user_id::text)=lower($1) AND w.state<>'deleted' ORDER BY w.id";
      const broadIndexPlan = await explainWithSettings(broadIndexSql, [f.creator.id],
        "SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off; SET LOCAL enable_indexscan=on; SET LOCAL enable_indexonlyscan=on");
      const broadIndexWork = workspacePlanWork(broadIndexPlan, queries.list.eligibleWorkspaceRows);
      const broadIndexRows = await client.query(broadIndexSql, [f.creator.id]);
      expect(broadIndexPlan["Actual Rows"]).toBe(501);
      expect(broadIndexRows.rows).toHaveLength(501);
      expect(["Index Scan","Index Only Scan"]).toContain(broadIndexWork.scanType);
      expect(broadIndexWork).toMatchObject({ ok: false });
      expect(broadIndexWork.examinedRows).toBeGreaterThan(queries.list.eligibleWorkspaceRows);
      report({ negative: "unbounded-workspace-index-scan", plan: broadIndexPlan, shape: shape(broadIndexPlan), workspaceWork: broadIndexWork, rows: broadIndexRows.rows.length,
        workspaceWorkBound: queries.list.eligibleWorkspaceRows });
    } finally { client.release(); }
  }, 30_000);

  it("accepts bounded bitmap and incremental-index plans with identical results", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='legacy'");
    const columns = CLOUD_V2_WORKSPACE_COLUMNS.join(",");
    const sql = `SELECT ${columns} FROM cloud_v2_workspaces w WHERE w.org_id=$1 AND w.creator_user_id=$2 AND w.state<>'deleted'
      AND EXISTS(SELECT 1 FROM organization_members m WHERE m.org_id=w.org_id AND m.user_id=$2) ORDER BY w.created_at DESC,w.id LIMIT 200`;
    const values = [f.organizationId,f.creator.id];
    const scenarios = [
      { name: "bitmap", settings: "SET LOCAL enable_indexscan=off; SET LOCAL enable_indexonlyscan=off; SET LOCAL enable_bitmapscan=on; SET LOCAL enable_seqscan=off" },
      { name: "incremental-index", settings: "SET LOCAL enable_bitmapscan=off; SET LOCAL enable_indexscan=on; SET LOCAL enable_indexonlyscan=on; SET LOCAL enable_seqscan=off; SET LOCAL enable_incremental_sort=on" },
    ];
    const client = await pool.connect();
    try {
      const plans: Plan[] = [], ids: string[][] = [];
      for (const scenario of scenarios) {
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
          await client.query(scenario.settings);
          const explained = (await client.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values)).rows[0]["QUERY PLAN"][0];
          plans.push(explained.Plan);
          ids.push((await client.query(sql, values)).rows.map(row => row.id));
          expect(explained.Plan["Actual Rows"]).toBe(200);
          report({ plannerVariation: scenario.name, plan: explained.Plan, ids: ids.at(-1) });
        } finally { await client.query("ROLLBACK"); }
      }
      expect(ids[0]).toHaveLength(200);
      expect(ids[1]).toEqual(ids[0]);
      expect(ids[0]).toEqual(expectedListIds);
      const bitmapScan = workspaceScans(plans[0]!)[0]!;
      const indexScan = workspaceScans(plans[1]!)[0]!;
      expect(bitmapScan["Node Type"]).toBe("Bitmap Heap Scan");
      expect(indexScan["Node Type"]).toBe("Index Scan");
      expect(planNodes(plans[1]!).some(node => node["Node Type"] === "Incremental Sort")).toBe(true);
      expect(workspacePlanWork(plans[0]!, 501)).toMatchObject({ ok: true });
      expect(workspacePlanWork(plans[1]!, 501)).toMatchObject({ ok: true });
      report({ plannerVariationAccepted: true, bitmap: shape(plans[0]!), incrementalIndex: shape(plans[1]!), rows: ids[0].length });
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
      report({ foreignKey: "cloud_execution_transition_scope", rows: 10003, durationMs, locks,
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
      expect((await client.query("SELECT count(*)::int AS count FROM cloud_v2_workspaces")).rows[0].count).toBe(10003);
      report({ migration: "0240", rows: 10003, durationMs, locks });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});
