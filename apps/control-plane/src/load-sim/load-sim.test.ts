// Database-free unit tests for the load simulator's budget check, projection
// guards, client-side cost meter and report file.

import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type pg from "pg";
import { BUDGET_POLICY, checkBudgets, type LoadBudgets } from "./budgets.js";
import { DatabaseCostMeter, emptyCost, type OperationCost } from "./instrument.js";
import { writeReport, type LoadSimulationReport } from "./report.js";
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
  targets: { quietTransactionsPerSecond: 0.5, perActiveWorkspaceTransactionsPerSecond: 0.01, boatCallsPerMinute: 1000 },
  steadyState: { perActiveWorkspaceTransactionsPerSecond: 10, perRunningEngineTransactionsPerSecond: 10, perStoppedWorkspaceTransactionsPerSecond: 1,
    notifyingCommitsPerActiveWorkspacePerSecond: 0.5 },
  perRequest,
});

const baseProjection = (): Projection => ({
  perWorkspace: { transactionsPerSecond: 1, statementsPerSecond: 1, roundTripsPerSecond: 1, byOperation: [] },
  perRunningEngineTransactionsPerSecond: 1,
  perStoppedWorkspaceTransactionsPerSecond: 0.5,
  perWorkspaceWorker: [],
  perConnectedClientTransactionsPerSecond: 0,
  atWorkspaces: [],
});

describe("checkBudgets", () => {
  it("flags notifying commits per active workspace above the budget", () => {
    const budgets = baseBudgets({});
    expect(checkBudgets(budgets, [], baseProjection(), 1)).toEqual([
      { subject: "steadyState", metric: "notifyingCommitsPerActiveWorkspacePerSecond", measured: 1, budget: 0.5 },
    ]);
    expect(checkBudgets(budgets, [], baseProjection(), 0.5)).toEqual([]);
  });

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

  it("flags a Boat call projection over the shared per-minute limit", () => {
    const budgets = baseBudgets({});
    const projection = { ...baseProjection(), atWorkspaces: [{ workspaces: 1000, transactionsPerSecond: 1, statementsPerSecond: 1, boatCallsPerMinutePerReplica: 600 }] };
    expect(checkBudgets(budgets, [], projection)).toEqual([
      { subject: "boatCallsPerMinute at 1000 workspaces (2 replicas)", metric: "boatCallsPerMinute", measured: 1200, budget: 1000 },
    ]);
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

describe("writeReport", () => {
  const report = { version: 1, generatedAt: "2026-10-16T14:00:00.000Z" } as LoadSimulationReport;
  const withRoot = (test: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), "zeros-load-sim-report-test-"));
    try { test(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };

  it("writes the default report into a fresh private directory, not a fixed shared path", () => withRoot(root => {
    // Another local user can pre-create a fixed name under the shared temporary directory.
    const planted = join(root, "planted");
    mkdirSync(planted);
    symlinkSync(planted, join(root, "zeros-load-sim"));
    const first = writeReport(report, undefined, root), second = writeReport(report, undefined, root);
    expect(readdirSync(planted)).toEqual([]);
    expect(dirname(first)).not.toBe(dirname(second));
    for (const path of [first, second]) {
      expect(dirname(dirname(path))).toBe(root);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      // Check and read the same open file, not the path twice.
      const fd = openSync(path, "r");
      try {
        expect(fstatSync(fd).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(fd, "utf8"))).toEqual(report);
      } finally { closeSync(fd); }
    }
  }));

  it("writes an explicit path as given, creating its parent", () => withRoot(root => {
    const out = join(root, "nested", "load.json");
    expect(writeReport(report, out, root)).toBe(out);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(report);
  }));
});
