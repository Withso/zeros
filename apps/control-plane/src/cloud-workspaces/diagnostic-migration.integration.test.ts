import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const directory = new URL("../../migrations/", import.meta.url);
suite("0114 with released lifecycle writers", () => {
  let pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>, sql: string;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5, statement_timeout: 15000 });
    sql = await readFile(new URL("0114_cloud_lifecycle_diagnostics.sql", directory), "utf8");
  });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now(),checksum text)");
    const client = await pool.connect();
    try {
      for (const file of (await readdir(directory)).filter(file => /^\d{4}.*\.sql$/.test(file) && Number(file.slice(0, 4)) <= 113).sort()) {
        await client.query("BEGIN");
        await client.query(await readFile(new URL(file, directory), "utf8"));
        await client.query("COMMIT");
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
  });
  async function apply(client: pg.PoolClient) {
    try { await client.query("BEGIN; SET LOCAL deadlock_timeout='100ms'"); await client.query(sql); await client.query("COMMIT"); return null; }
    catch (error) { await client.query("ROLLBACK"); return (error as { code: string }).code; }
  }
  it("lets an overlapping released wake commit without a table-lock upgrade deadlock", async () => {
    const wake = await pool.connect(), ddl = await pool.connect();
    let migration: Promise<string | null> | undefined;
    try {
      await wake.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      // Released routes.ts order: parent, workspace FOR UPDATE, journal read,
      // then workspace UPDATE. Run real migration SQL while paused at the read.
      await wake.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [fixture.organizationId]);
      await wake.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [fixture.workspaceId, fixture.organizationId]);
      await wake.query("SELECT 1 FROM cloud_workspace_provider_operations WHERE workspace_id=$1 AND generation=1 AND org_id=$2 AND (create_closed_at IS NOT NULL OR lost_at IS NOT NULL)", [fixture.workspaceId, fixture.organizationId]);
      const pid = (await ddl.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      migration = apply(ddl);
      let waiting = false;
      for (let n = 0; n < 200; n++) {
        waiting = (await pool.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted AND relation IN ('cloud_workspaces'::regclass,'cloud_workspace_provider_operations'::regclass)", [pid])).rowCount !== 0;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await wake.query("UPDATE cloud_workspaces SET desired_state='running',status='waking',version=version+1,authority_epoch=authority_epoch+1,updated_at=now(),last_error_code=NULL,last_error_message=NULL WHERE id=$1", [fixture.workspaceId]);
      await wake.query("COMMIT");
      expect(await migration).toBeNull();
      expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].status).toBe("waking");
    } finally {
      await wake.query("ROLLBACK");
      await migration;
      wake.release(); ddl.release();
    }
  });
  it("bounds migration lock acquisition and can retry after a released writer drains", async () => {
    const wake = await pool.connect(), ddl = await pool.connect();
    try {
      await wake.query("BEGIN");
      await wake.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [fixture.workspaceId]);
      await wake.query("SELECT 1 FROM cloud_workspace_provider_operations LIMIT 1");
      const started = performance.now();
      const result = await apply(ddl);
      expect(result).toBe("55P03");
      expect(performance.now() - started).toBeLessThan(5000);
      expect((await pool.query("SELECT to_regclass('cloud_workspace_diagnostic_incidents') AS table_name")).rows[0].table_name).toBeNull();
      await wake.query("COMMIT");
      expect(await apply(ddl)).toBeNull();
    } finally { await wake.query("ROLLBACK"); wake.release(); ddl.release(); }
  });
});
