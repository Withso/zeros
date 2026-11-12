import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("operator activation and legacy execution fences", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.activate(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it("does not release a clean process boot without legacy-material cleanup", async () => {
    const hello = await f.worker("hello", { protocol: 2, bootId: f.boot, runtimeSha256: "b".repeat(64) });
    expect(hello.status).toBe(200);
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].state).toBe("starting");
    const { bootstrapContextId } = (await hello.json()).config;
    const response = await f.worker("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "execution_not_retired" } });
    expect((await f.worker("bootstrap-lease", { contextId: bootstrapContextId })).status).toBe(409);
    expect((await pool.query("SELECT clean_at FROM cloud_v2_execution_boots WHERE workspace_id=$1", [f.workspace.id])).rows[0].clean_at).toBeNull();
  });

  it("hides an active workspace from released system SQL without the protocol marker", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      expect((await client.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows).toEqual([]);
      expect((await client.query("UPDATE cloud_v2_workspaces SET active_at=clock_timestamp() WHERE id=$1 RETURNING id", [f.workspace.id])).rows).toEqual([]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});
