import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import budgetFile from "./budgets.json" with { type: "json" };
import type { LoadBudgets, RequestBudget } from "./budgets.js";
import { createSimulator, type Simulator, type SimulatorOperationName } from "./harness.js";
import { DatabaseCostMeter } from "./instrument.js";
import { measureHotPaths, projectSteadyState, runScenario, STEADY_STATE_CADENCES, type HotPathResult } from "./simulation.js";

const budgets = budgetFile as LoadBudgets;
const perRequest: Record<string, RequestBudget> = budgets.perRequest;

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("control-plane database load simulator", () => {
  let sim: Simulator;
  let hotPaths: HotPathResult[];
  let emptyInventory: HotPathResult[];

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    try { await resetMigratedTestDatabase(admin); } finally { await admin.end(); }
    sim = await createSimulator({ databaseUrl: url!, meter: new DatabaseCostMeter(), workosEnabled: true });
    emptyInventory = await measureHotPaths(sim, { operations: ["worker.reconcileOrphans"], iterations: 2, warmup: 1 });
    await sim.seedWorkspace();
    hotPaths = await measureHotPaths(sim, { workspace: sim.workspaces[0]!, iterations: 3, warmup: 1 });
  }, 120_000);
  afterAll(async () => { await sim?.close(); });

  it("counts a batched transaction setup as one round trip of several statements", async () => {
    const meter = sim.meter;
    meter.reset();
    await meter.measure("probe.tx", () => withSystemTx(sim.pools.api, tx => tx.query("SELECT 1")));
    await meter.measure("probe.autocommit", () => sim.pools.api.query("SELECT 1"));
    const costs = meter.snapshot();
    // BEGIN; SET LOCAL ROLE; set_config is one round trip carrying three statements.
    expect(costs.get("probe.tx")).toMatchObject({ calls: 1, transactions: 1, commits: 1, roundTrips: 3, statements: 5, checkouts: 1, errors: 0 });
    expect(costs.get("probe.autocommit")).toMatchObject({ calls: 1, transactions: 1, roundTrips: 1, statements: 1, checkouts: 0 });
  });

  it("keeps a budget for exactly the simulated operations", () => {
    expect(Object.keys(perRequest).sort()).toEqual(Object.keys(sim.operations).sort());
  });

  it.each(Object.keys(perRequest) as SimulatorOperationName[])("keeps %s within its per-request database budget", name => {
    const measured = hotPaths.find(result => result.operation === name)!;
    const budget = perRequest[name]!;
    expect(measured.perCall.errors).toBe(0);
    expect(measured.perCall.transactions, "transactions").toBeLessThanOrEqual(budget.transactions);
    expect(measured.perCall.statements, "statements").toBeLessThanOrEqual(budget.statements);
    expect(measured.perCall.roundTrips, "round trips").toBeLessThanOrEqual(budget.roundTrips);
  });

  it("keeps the steady-state transaction rate per active workspace within budget", () => {
    const projection = projectSteadyState(hotPaths, 0, [1], emptyInventory);
    expect(projection.perWorkspace.transactionsPerSecond).toBeLessThanOrEqual(budgets.steadyState.perActiveWorkspaceTransactionsPerSecond);
    expect(projection.perRunningEngineTransactionsPerSecond).toBeLessThanOrEqual(budgets.steadyState.perRunningEngineTransactionsPerSecond);
  });

  it("drives one workspace's engine and desktop loops in real time without failures or excess transactions", async () => {
    const result = await runScenario(sim, { name: "1 active", activeWorkspaces: 1, durationMs: 3_000, warmupMs: 500, background: false });
    expect(result.failures).toEqual({});
    const known = new Set<string>([...Object.keys(STEADY_STATE_CADENCES), "client.auth"]);
    expect(result.operations.map(row => row.operation).filter(name => !known.has(name))).toEqual([]);
    expect(result.operations.find(row => row.operation === "engine.credentialControls")?.requestsPerSecond).toBeGreaterThan(1);
    // Cadences are minimum periods: each loop fires at most once per period,
    // plus one request already in flight when the window opens.
    const ceiling = Object.entries(STEADY_STATE_CADENCES).reduce((total, [name, cadence]) => {
      const transactions = hotPaths.find(row => row.operation === name)!.perCall.transactions;
      return total + (Math.floor(result.durationSeconds / cadence.periodSeconds) + 2) * transactions;
    }, 0);
    expect(result.totals.transactions).toBeLessThanOrEqual(ceiling);
  }, 30_000);
});
