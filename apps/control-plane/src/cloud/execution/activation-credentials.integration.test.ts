import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { manageCloudExecution, type CloudExecutionChange } from "../../manage-cloud-execution.js";
import { createCloudV2ProxyRoutes } from "../proxy.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const url = process.env.TEST_DATABASE_URL, database = url ? describe : describe.skip;
database("activation fences legacy credential delivery", () => {
  let pool: pg.Pool, f: ExecutionFixture, input: CloudExecutionChange;
  const run = async (action: CloudExecutionChange["action"]) => {
    const request = { ...input, action }, options = { databaseUrl: url!, channel: "development" };
    const plan = await manageCloudExecution(pool, request, options);
    return manageCloudExecution(pool, request, { ...options, execute: true, approval: plan.planSha256 });
  };
  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 8, statement_timeout: 6000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool); await f.hello();
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [f.admin.id]);
    input = { activationId: randomUUID(), action: "prepare", channel: "development", organizationId: f.organizationId,
      workspaceId: f.workspace.id, initiatorUserId: f.viewer.id, operatorUserId: f.admin.id,
      runtimeSha256: "b".repeat(64), reason: "Local fixture qualification of credential drain fences" };
    await run("prepare");
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it("refuses new legacy material during drain while accepting final history and activity", async () => {
    const config = vi.spyOn(f.cp.workers, "config"), github = vi.spyOn(f.cp.workers, "githubToken");
    const mcp = vi.fn(async () => ({ headers: { authorization: "synthetic-mcp-secret" } }));
    f.cp.workers.mcpAuthorization = mcp;
    await run("activate");
    for (const [path, body, method] of [["config", undefined, "GET"], ["github-token", {}, "POST"],
      [`mcp/${randomUUID()}/authorization`, {}, "POST"]] as const) {
      const response = await f.worker(path, body, { method });
      expect([path, response.status]).toEqual([path, 409]);
      expect(await response.json()).toMatchObject({ error: { code: "actor_busy" } });
    }
    expect(config).not.toHaveBeenCalled(); expect(github).not.toHaveBeenCalled(); expect(mcp).not.toHaveBeenCalled();
    expect((await f.worker("history", { t: "history", bootId: f.boot, sequence: 1, chats: [{ id: "last-checkpoint" }] })).status).toBe(200);
    expect((await f.worker("activity", { idle: true })).status).toBe(200);
  });

  it.each(["github", "mcp"])("discards a %s credential whose read was admitted before drain", async kind => {
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    if (kind === "github") f.cp.workers.githubToken = async () => {
      entered(); await barrier; return { token: "synthetic-github-secret", expiresAt: Date.now() + 60000 };
    };
    else f.cp.workers.mcpAuthorization = async () => { entered(); await barrier; return { headers: { authorization: "synthetic-mcp-secret" } }; };
    const pending = f.worker(kind === "github" ? "github-token" : `mcp/${randomUUID()}/authorization`, {});
    await held;
    try { await run("activate"); } finally { release(); }
    const response = await pending;
    expect(response.status).toBe(401);
    expect(await response.text()).not.toMatch(/synthetic-|token.*expiresAt/);
  });

  it("does not start a proxy upstream after activation while a vault read was held", async () => {
    const token = await f.cp.store.issueToken({ workspaceId: f.workspace.id, kind: "proxy", userId: null, ttlMs: 60000 });
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    const app = createCloudV2ProxyRoutes({ ...f.cp.proxy, fetch: upstream, logins: async () => {
      entered(); await barrier; return { kind: "codex-api-key", apiKey: "synthetic-proxy-secret" };
    } });
    const pending = app.request("/v2/cloud/proxy/openai/responses", { method: "POST",
      headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: "{}" });
    await held;
    try { await run("activate"); } finally { release(); }
    expect((await pending).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});
