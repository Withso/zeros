import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoadBudgetProbe, scenarioTotals } from "../../test-support/load-budget.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";
import { CloudExecutionMaintenance } from "./maintenance.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("execution wake request costs", () => {
  let pool: pg.Pool, probe: LoadBudgetProbe, f: ExecutionFixture;
  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 4000 });
    probe = new LoadBudgetProbe(pool);
    const startup = [vi.spyOn(CloudExecutionMaintenance.prototype, "affected"), vi.spyOn(CloudExecutionMaintenance.prototype, "due")];
    f = await executionFixture(pool, { teamOwnership: true });
    await f.activate();
    await f.cp.loginChanges.stop();
    // Stopping hints does not join the constructor's initial lookup queries.
    // Finish their real transactions before opening the request cost window.
    await Promise.all(startup.flatMap(spy => spy.mock.results.map(result => result.value)));
    for (const spy of startup) spy.mockRestore();
  });
  afterEach(async () => { await f?.close(); probe.close(); await pool.end(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function measure(name: string, path: string, send: () => Promise<Response>) {
    const { value, cost } = await probe.measure(name, () => probe.request(new Request(`https://api.example.test${path}`, { method: "POST" }), send));
    expect(cost.background.queries).toBe(0);
    expect(value.status).toBe(200);
    const totals = scenarioTotals(cost);
    expect(totals.queries).toBeGreaterThan(0);
    console.log(`[wake-cost] ${name} queries=${totals.queries} transactions=${totals.transactions}`);
    expect(totals.failures).toBe(0);
    expect(totals.inFlight).toBe(0);
    return { value, totals };
  }

  it.each([false, true])("issues a member connect ticket in at most two route transactions (team headers: %s)", async team => {
    expect((await f.hello()).status).toBe(200);
    const path = `/v1/cloud-v2/workspaces/${f.workspace.id}/connect`;
    const { value, totals } = await measure("connect", path, () => f.call(path, "POST", { wake: false }, f.viewer,
      team ? { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" } : {}));
    const result = await value.json();
    expect(result.protocols).toHaveLength(2);
    expect(result.features).toContain("relay-presence-v1");
    expect(totals.transactions).toBeLessThanOrEqual(2);
    expect(totals.queries).toBeLessThanOrEqual(25);
  });

  it("builds the initial worker configuration within the hello query budget", async () => {
    const { value, totals } = await measure("hello", "/v2/cloud/worker/hello", () => f.worker("hello", {
      protocol: 2, bootId: f.boot, runtimeSha256: "b".repeat(64),
    }));
    const { config } = await value.json();
    expect(config.actingUser).toBe(1);
    expect(config.bootstrapContextId).toEqual(expect.any(String));
    expect(totals.transactions).toBeLessThanOrEqual(18);
    expect(totals.queries).toBeLessThanOrEqual(70);
  });

  it("delivers clean-worker bootstrap material in at most four transactions", async () => {
    const hello = await f.hello();
    expect(hello.status).toBe(200);
    const { config } = await hello.json();
    const { value, totals } = await measure("bootstrap", "/v2/cloud/worker/bootstrap-lease", () => f.worker("bootstrap-lease", {
      contextId: config.bootstrapContextId,
    }));
    const lease = await value.json();
    expect(lease.contextId).toBe(config.bootstrapContextId);
    expect(lease.userId).toBe(f.creator.id);
    expect(lease.expiresAt).toBeGreaterThan(Date.now());
    expect(totals.transactions).toBeLessThanOrEqual(4);
    expect(totals.queries).toBeLessThanOrEqual(40);
  });

  it.each(["membership", "session", "stop"])("refuses a ticket when %s changes after the workspace read", async change => {
    expect((await f.hello()).status).toBe(200);
    const issue = f.cp.execution.clients.ticket.bind(f.cp.execution.clients);
    vi.spyOn(f.cp.execution.clients, "ticket").mockImplementationOnce(async (...args) => {
      if (change === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
      else if (change === "session") await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE user_id=$1", [f.viewer.id]);
      else await pool.query("UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1 WHERE id=$1", [f.workspace.id]);
      return issue(...args);
    });
    const result = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer);
    expect(result.status).not.toBe(200);
    expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE workspace_id=$1 AND user_id=$2", [f.workspace.id, f.viewer.id])).rowCount).toBe(0);
  });
});
