import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("execution storage and inactive rollout through the production composition", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it("keeps old create statements in legacy mode and does not enable execution from a feature header", async () => {
    const stored = (await pool.query("SELECT to_jsonb(w) AS value FROM cloud_v2_workspaces w WHERE id=$1", [f.workspace.id])).rows[0].value;
    expect(stored.execution_mode).toBe("legacy");
    const response = await f.hello(); expect(response.status).toBe(200);
    const config = (await response.json()).config;
    expect(config).not.toHaveProperty("actingUser"); expect(config).not.toHaveProperty("bootstrapContextId");
    const document = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}`, "GET", undefined, f.creator, { "X-Zeros-Team-Sharing": "1" });
    expect(document.status).toBe(200); expect(await document.json()).not.toHaveProperty("teamWriting");
  });

  it("refuses lease creation in a legacy workspace even for a current capable worker", async () => {
    expect((await f.hello()).status).toBe(200);
    const response = await f.worker("execution-leases/renew", { contextIds: [f.workspace.id] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "worker_update_required" } });
  });
});
