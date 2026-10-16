// Database-free unit tests for the load simulator's budget check, projection
// guards and client-side cost meter.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { BUDGET_POLICY, checkBudgets, type LoadBudgets } from "./budgets.js";
import { DatabaseCostMeter, emptyCost, type OperationCost } from "./instrument.js";
import { projectSteadyState, STEADY_STATE_CADENCES, WORKER_PER_WORKSPACE_CADENCES, type HotPathResult, type Projection } from "./simulation.js";

const perCall = (overrides: Partial<OperationCost> = {}): Omit<OperationCost, "calls"> => {
  const { calls: _calls, ...rest } = { ...emptyCost(), roundTrips: 1, statements: 1, transactions: 1, ...overrides };
  return rest;
};

const hotPath = (operation: string, overrides: Partial<OperationCost> = {}): HotPathResult => ({
  operation, iterations: 1, perCall: perCall(overrides), p50Ms: 0, p95Ms: 0, serverExecMsPerCall: null, roundTripFloorMsAt5msRtt: 0,
});

const baseBudgets = (perRequest: LoadBudgets["perRequest"]): LoadBudgets => ({
  version: 1,
  policy: BUDGET_POLICY,
  targets: { quietTransactionsPerSecond: 0.5, perActiveWorkspaceTransactionsPerSecond: 0.01 },
  steadyState: { perActiveWorkspaceTransactionsPerSecond: 10, perRunningEngineTransactionsPerSecond: 10 },
  perRequest,
});

const baseProjection = (): Projection => ({
  perWorkspace: { transactionsPerSecond: 1, statementsPerSecond: 1, roundTripsPerSecond: 1, byOperation: [] },
  perRunningEngineTransactionsPerSecond: 1,
  perWorkspaceWorker: [],
  perConnectedClientTransactionsPerSecond: 0,
  atWorkspaces: [],
});

describe("checkBudgets", () => {
  it("flags a budgeted operation that was not measured", () => {
    const budgets = baseBudgets({ "engine.heartbeat": { transactions: 1, statements: 1, roundTrips: 1 } });
    expect(checkBudgets(budgets, [], baseProjection())).toEqual([
      { subject: "engine.heartbeat", metric: "measured", measured: 0, budget: 1 },
    ]);
  });

  it("flags a measured operation with no entry in budgets.json", () => {
    const budgets = baseBudgets({});
    expect(checkBudgets(budgets, [hotPath("engine.heartbeat")], baseProjection())).toEqual([
      { subject: "engine.heartbeat", metric: "budget", measured: 1, budget: 0 },
    ]);
  });

  it("flags an over-budget measurement", () => {
    const budgets = baseBudgets({ "engine.heartbeat": { transactions: 1, statements: 1, roundTrips: 1 } });
    const violations = checkBudgets(budgets, [hotPath("engine.heartbeat", { statements: 2 })], baseProjection());
    expect(violations).toEqual([{ subject: "engine.heartbeat", metric: "statements", measured: 2, budget: 1 }]);
  });

  it("flags an operation whose per-request transactions fall below one", () => {
    const budgets = baseBudgets({ "engine.heartbeat": { transactions: 1, statements: 1, roundTrips: 1 } });
    const violations = checkBudgets(budgets, [hotPath("engine.heartbeat", { transactions: 0 })], baseProjection());
    expect(violations).toEqual([{ subject: "engine.heartbeat", metric: "transactionsFloor", measured: 0, budget: 1 }]);
  });
});

describe("projectSteadyState", () => {
  const allOperations = [
    ...Object.keys(STEADY_STATE_CADENCES),
    ...Object.keys(WORKER_PER_WORKSPACE_CADENCES),
  ].map(operation => hotPath(operation));

  it("throws when a hot-path measurement is missing", () => {
    expect(() => projectSteadyState([], 0, [0])).toThrow("missing hot-path measurement");
    expect(() => projectSteadyState(allOperations.filter(row => row.operation !== "worker.reconcileDrift"), 0, [0]))
      .toThrow("missing hot-path measurement for worker.reconcileDrift");
  });

  it("throws when a marginal operation lacks an empty-inventory measurement", () => {
    expect(() => projectSteadyState(allOperations, 0, [0])).toThrow("missing empty-inventory measurement for worker.reconcileOrphans");
  });
});

describe("DatabaseCostMeter", () => {
  const fakePool = () => {
    const client = {
      query: () => Promise.resolve({ rows: [] }),
      release: () => {},
    };
    const pool = {
      query: () => Promise.resolve({ rows: [] }),
      connect: () => Promise.resolve(client),
    };
    return pool as unknown as pg.Pool;
  };

  it("counts each autocommit statement as one transaction", async () => {
    const meter = new DatabaseCostMeter();
    const pool = meter.instrument(fakePool());
    await meter.measure("op", async () => {
      await pool.query("SELECT 1");
      await pool.query("SELECT 2");
    });
    const cost = meter.snapshot().get("op")!;
    expect(cost.roundTrips).toBe(2);
    expect(cost.statements).toBe(2);
    expect(cost.transactions).toBe(2);
  });

  it("counts a batched BEGIN..COMMIT block as one transaction", async () => {
    const meter = new DatabaseCostMeter();
    const pool = meter.instrument(fakePool());
    await meter.measure("op", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT 1");
        await client.query("SELECT 2");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });
    const cost = meter.snapshot().get("op")!;
    expect(cost.roundTrips).toBe(4);
    expect(cost.transactions).toBe(1);
    expect(cost.commits).toBe(1);
    expect(cost.checkouts).toBe(1);
  });
});
