import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const report = (value: unknown) => {
  if (process.env.CLOUD_EXECUTION_PERSON_SQL_PROOF) appendFileSync(process.env.CLOUD_EXECUTION_PERSON_SQL_PROOF, `${JSON.stringify(value)}\n`);
};
database("0243 signature metadata and live migration cost", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 15000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.cp.loginChanges.stop(); await f.activate(); await f.hello(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it("captures bounded legacy inputs without copying the worker hash to tickets, prompts or intents", async () => {
    await f.login();
    const input = f.prompt(); expect((await f.send(input, f.viewer)).status).toBe(201);
    const authority = { signature: "a".repeat(64), permissionSignature: "b".repeat(64), sourceFingerprint: "c".repeat(64) };
    const ticket = randomBytes(32);
    await pool.query(`INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,user_id,expires_at,execution_authority)
      VALUES($1,$2,'connect',$3,clock_timestamp()+interval '1 minute',$4)`, [ticket, f.workspace.id, f.viewer.id, authority]);
    await pool.query("UPDATE cloud_v2_prompt_outbox SET execution_authority=$2 WHERE workspace_id=$1", [f.workspace.id, authority]);
    await pool.query("UPDATE cloud_v2_workspaces SET execution_intent_authority=$2 WHERE id=$1", [f.workspace.id, authority]);
    const values = [
      (await pool.query("SELECT execution_authority AS authority FROM cloud_v2_tokens WHERE token_hash=$1", [ticket])).rows[0].authority,
      (await pool.query("SELECT execution_authority AS authority FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rows[0].authority,
      (await pool.query("SELECT execution_intent_authority AS authority FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].authority,
    ];
    for (const value of values) {
      expect(value.legacyBasis.workerTokenHash).toBeNull();
      expect(Object.keys(value.legacyBasis).sort()).toEqual(["accessEpoch", "bootId", "permission", "policy", "stopGeneration", "workerTokenHash"]);
      expect(Buffer.byteLength(JSON.stringify(value.legacyBasis))).toBeLessThanOrEqual(65536);
    }
    const versionTwo = { signatureVersion: 2, signature: "d".repeat(64) };
    await pool.query("UPDATE cloud_v2_tokens SET execution_authority=$2 WHERE token_hash=$1", [ticket, versionTwo]);
    expect((await pool.query("SELECT execution_authority FROM cloud_v2_tokens WHERE token_hash=$1", [ticket])).rows[0].execution_authority).toEqual(versionTwo);
  });

  it("refuses a compatibility backfill above the bounded live set", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE cloud_v2_tokens DISABLE TRIGGER execution_legacy_ticket_basis");
      await client.query(`INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,user_id,expires_at,execution_authority)
        SELECT sha256(n::text::bytea),$1,'connect',$2,clock_timestamp()+interval '1 hour','{"signature":"legacy"}'
        FROM generate_series(1,10001) n`, [f.workspace.id, f.viewer.id]);
      const sql = readFileSync(new URL("../../../migrations/0243_cloud_execution_person_authority.sql", import.meta.url), "utf8");
      const guard = sql.match(/^DO \$\$[\s\S]*?^\$\$;/m)![0];
      await client.query("SAVEPOINT bounded_backfill");
      await expect(client.query(guard)).rejects.toMatchObject({ code: "P0001", message: "cloud_execution_legacy_backfill_limit" });
      await client.query("ROLLBACK TO SAVEPOINT bounded_backfill");
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_v2_tokens WHERE execution_authority ? 'legacyBasis'")).rows[0].n).toBe(0);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("measures live-only backfills and the versioned hot insertion paths", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [table, trigger] of [["cloud_v2_execution_contexts", "execution_legacy_context_basis"], ["cloud_v2_tokens", "execution_legacy_ticket_basis"],
        ["cloud_v2_prompt_outbox", "execution_legacy_prompt_basis"], ["cloud_v2_workspaces", "execution_legacy_intent_basis"]])
        await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      await client.query(`INSERT INTO cloud_v2_execution_contexts(id,workspace_id,org_id,user_id,kind,client_id,access_epoch,stop_generation,worker_boot_id,
        worker_token_hash,authority,source_fingerprint,expires_at,state,retired_at,material)
        SELECT gen_random_uuid(),w.id,w.org_id,$2,'client',gen_random_uuid(),w.access_epoch,w.stop_generation,w.worker_boot_id,w.worker_token_hash,
          '{"signature":"legacy"}',repeat('a',64),clock_timestamp()+interval '1 hour',CASE WHEN n<=1000 THEN 'active' ELSE 'retired' END,
          CASE WHEN n>1000 THEN clock_timestamp() END,CASE WHEN n<=1000 THEN '{"fixture":"preserved"}'::jsonb END
          FROM cloud_v2_workspaces w CROSS JOIN generate_series(1,10000) n WHERE w.id=$1`, [f.workspace.id, f.viewer.id]);
      await client.query(`INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,user_id,expires_at,execution_authority)
        SELECT sha256(n::text::bytea),$1,'connect',$2,clock_timestamp()+CASE WHEN n<=1000 THEN interval '1 hour' ELSE interval '-1 hour' END,
          '{"signature":"legacy"}' FROM generate_series(1,10000) n`, [f.workspace.id, f.viewer.id]);
      await client.query("INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id) VALUES($1,'migration')", [f.workspace.id]);
      await client.query(`INSERT INTO cloud_v2_prompt_outbox(workspace_id,user_message_id,chat_id,creator_user_id,sequence,epoch,access_epoch,payload_hash,payload_bytes,receipt,state,terminal_at,execution_authority)
        SELECT $1,'old-'||n,'migration',$2,n,0,0,repeat('a',64),0,'{}',CASE WHEN n<=1000 THEN 'queued' ELSE 'completed' END,
          CASE WHEN n>1000 THEN clock_timestamp() END,'{"permissionSignature":"legacy"}' FROM generate_series(1,10000) n`, [f.workspace.id, f.viewer.id]);
      await client.query("UPDATE cloud_v2_workspaces SET execution_intent_authority='{\"permissionSignature\":\"legacy\"}' WHERE id=$1", [f.workspace.id]);
      for (const [table, trigger] of [["cloud_v2_execution_contexts", "execution_legacy_context_basis"], ["cloud_v2_tokens", "execution_legacy_ticket_basis"],
        ["cloud_v2_prompt_outbox", "execution_legacy_prompt_basis"], ["cloud_v2_workspaces", "execution_legacy_intent_basis"]]) {
        await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
        await client.query(`ANALYZE ${table}`);
      }
      const sql = readFileSync(new URL("../../../migrations/0243_cloud_execution_person_authority.sql", import.meta.url), "utf8");
      const statements = sql.match(/^UPDATE cloud_v2_[\s\S]*?;/gm)!;
      expect(statements).toHaveLength(4);
      const before = (await client.query("SELECT state,access_epoch,stop_generation,worker_boot_id,worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
      await client.query("SAVEPOINT before_backfill");
      for (const statement of statements) {
        const plan = (await client.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${statement}`)).rows[0]["QUERY PLAN"][0];
        expect(plan.Triggers.some((trigger: { "Trigger Name": string }) => trigger["Trigger Name"].startsWith("execution_legacy_"))).toBe(true);
        report({ kind: "backfill", statement, plan });
      }
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_v2_execution_contexts WHERE authority ? 'legacyBasis'")).rows[0].n).toBe(1000);
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_v2_tokens WHERE execution_authority ? 'legacyBasis'")).rows[0].n).toBe(1000);
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_v2_prompt_outbox WHERE execution_authority ? 'legacyBasis'")).rows[0].n).toBe(1000);
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_v2_execution_contexts WHERE state='active' AND material='{\"fixture\":\"preserved\"}'")).rows[0].n).toBe(1000);
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_v2_tokens WHERE expires_at>clock_timestamp()")).rows[0].n).toBe(1000);
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_v2_prompt_outbox WHERE state='queued'")).rows[0].n).toBe(1000);
      expect((await client.query("SELECT state,access_epoch,stop_generation,worker_boot_id,worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0]).toEqual(before);
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_v2_execution_invalidations")).rows[0].n).toBe(0);
      const triggers = (await client.query(`SELECT tgrelid::regclass::text AS table_name,tgname,pg_get_triggerdef(oid) AS definition
        FROM pg_trigger WHERE NOT tgisinternal AND tgrelid=ANY(ARRAY['cloud_v2_tokens'::regclass,'cloud_v2_prompt_outbox'::regclass,
          'cloud_v2_execution_contexts'::regclass,'cloud_v2_workspaces'::regclass]) ORDER BY tgrelid,tgname`)).rows;
      report({ kind: "backfill-triggers", triggers });
      await client.query("ROLLBACK TO SAVEPOINT before_backfill");
      await client.query(`DROP FUNCTION capture_cloud_execution_legacy_basis(),fence_cloud_execution_person_resources(),fence_cloud_execution_sync() CASCADE;
        DROP TRIGGER execution_member_insert ON organization_members;
        DROP TRIGGER execution_organization_personal ON organizations;
        DROP INDEX execution_person_tickets;
        ALTER TABLE cloud_v2_workspaces DROP COLUMN sync_context_boot_ids;
        ALTER TABLE cloud_v2_execution_contexts DROP COLUMN sync_device_id,DROP COLUMN sync_registration_id,DROP COLUMN sync_instance_id,DROP COLUMN sync_connected_at`);
      const migrationStarted = performance.now();
      await client.query(sql);
      report({ kind: "complete-migration", milliseconds: performance.now() - migrationStarted, backfilled: 3001, retainedHistory: 27000 });
      for (const version of [1, 2]) {
        const authority = version === 2 ? { signatureVersion: 2, signature: "new" } : { signature: "legacy" };
        const offset = version * 20000;
        const inserts = [{ table: "tokens", query: `INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,user_id,expires_at,execution_authority)
          SELECT sha256(n::text::bytea),$1,'connect',$2,clock_timestamp()+interval '1 minute',$3
          FROM generate_series($4::int,$4::int+999) n` },
        { table: "contexts", query: `INSERT INTO cloud_v2_execution_contexts(id,workspace_id,org_id,user_id,kind,client_id,access_epoch,stop_generation,worker_boot_id,
          worker_token_hash,authority,source_fingerprint,expires_at)
          SELECT gen_random_uuid(),w.id,w.org_id,$2,'client',gen_random_uuid(),w.access_epoch,w.stop_generation,w.worker_boot_id,w.worker_token_hash,
            $3,repeat('a',64),clock_timestamp()+interval '1 hour' FROM cloud_v2_workspaces w CROSS JOIN generate_series($4::int,$4::int+999) n WHERE w.id=$1` },
        { table: "prompts", query: `INSERT INTO cloud_v2_prompt_outbox(workspace_id,user_message_id,chat_id,creator_user_id,sequence,epoch,access_epoch,payload_hash,payload_bytes,receipt,state,execution_authority)
          SELECT $1,'new-'||n,'migration',$2,n,0,0,repeat('a',64),0,'{}','queued',$3 FROM generate_series($4::int,$4::int+999) n` }];
        for (const insert of inserts) {
          const plan = (await client.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${insert.query}`, [f.workspace.id, f.viewer.id, authority, offset])).rows[0]["QUERY PLAN"][0];
          report({ kind: "hot-insert", table: insert.table, version, rows: 1000, plan });
        }
      }
      report({ kind: "locks", rows: { contexts: 12000, tokens: 12000, prompts: 12000, workspaces: 2 }, locks: (await client.query(
        "SELECT relation::regclass::text AS relation,mode FROM pg_locks WHERE pid=pg_backend_pid() AND relation IS NOT NULL AND granted ORDER BY relation,mode")).rows });
    } finally { await client.query("ROLLBACK"); client.release(); }
  }, 30_000);
});
