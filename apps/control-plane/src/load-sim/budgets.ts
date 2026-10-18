// Absolute database budgets for the load simulator. budgets.json holds
// today's measured cost plus headroom; lowering a budget is a ratchet,
// raising one needs a reviewed reason in the same change.

import type { HotPathResult, Projection } from "./simulation.js";

export type RequestBudget = { transactions: number; statements: number; roundTrips: number };

export type LoadBudgets = {
  version: 1;
  policy: string;
  /** PLAN targets; reported against, not enforced, until the hot paths are rebuilt. */
  targets: { quietTransactionsPerSecond: number; perActiveWorkspaceTransactionsPerSecond: number };
  steadyState: { perActiveWorkspaceTransactionsPerSecond: number; perRunningEngineTransactionsPerSecond: number;
    perStoppedWorkspaceTransactionsPerSecond: number;
    /** Notifying commits per active workspace per second (jobs channel
     * included); PostgreSQL serializes notifying commits at commit time. */
    notifyingCommitsPerActiveWorkspacePerSecond: number;
    /** Authority-cache hints per active workspace per second (0151); they
     * also count towards the notifying commits above. */
    authorityCacheNotificationsPerActiveWorkspacePerSecond: number };
  perRequest: Record<string, RequestBudget>;
};

export const BUDGET_POLICY = "transactions: measured, no headroom (a new transaction is a deliberate change); " +
  "statements and round trips: ceil(measured x 1.25); steady-state tx/s: measured x 1.1 rounded up to 0.01.";

/** Derive budgets from a measurement using BUDGET_POLICY. */
export function budgetsFromMeasurement(hotPaths: readonly HotPathResult[], projection: Projection,
  targets: LoadBudgets["targets"], notifyingCommitsPerActiveWorkspace = 0, authorityCacheNotificationsPerActiveWorkspace = 0): LoadBudgets {
  const up = (value: number) => Math.ceil(value * 100 - 1e-9) / 100;
  return {
    version: 1,
    policy: BUDGET_POLICY,
    targets,
    steadyState: {
      perActiveWorkspaceTransactionsPerSecond: up(projection.perWorkspace.transactionsPerSecond * 1.1),
      perRunningEngineTransactionsPerSecond: up(projection.perRunningEngineTransactionsPerSecond * 1.1),
      perStoppedWorkspaceTransactionsPerSecond: up(projection.perStoppedWorkspaceTransactionsPerSecond * 1.1),
      notifyingCommitsPerActiveWorkspacePerSecond: Math.max(0.01, up(notifyingCommitsPerActiveWorkspace * 1.1)),
      authorityCacheNotificationsPerActiveWorkspacePerSecond: Math.max(0.01, up(authorityCacheNotificationsPerActiveWorkspace * 1.1)),
    },
    perRequest: Object.fromEntries(hotPaths.map(row => [row.operation, {
      transactions: Math.ceil(row.perCall.transactions - 1e-9),
      statements: Math.ceil(row.perCall.statements * 1.25 - 1e-9),
      roundTrips: Math.ceil(row.perCall.roundTrips * 1.25 - 1e-9),
    }])),
  };
}

export type BudgetViolation = { subject: string; metric: string; measured: number; budget: number };

export function checkBudgets(budgets: LoadBudgets, hotPaths: readonly HotPathResult[], projection: Projection,
  notifyingCommitsPerActiveWorkspace = 0, authorityCacheNotificationsPerActiveWorkspace = 0): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  for (const [operation, budget] of Object.entries(budgets.perRequest)) {
    const row = hotPaths.find(result => result.operation === operation);
    if (!row) {
      violations.push({ subject: operation, metric: "measured", measured: 0, budget: 1 });
      continue;
    }
    // Floor: an operation that costs zero transactions has silently become a no-op.
    if (row.perCall.transactions < 1) violations.push({ subject: operation, metric: "transactionsFloor", measured: row.perCall.transactions, budget: 1 });
    for (const metric of ["transactions", "statements", "roundTrips"] as const) {
      if (row.perCall[metric] > budget[metric]) violations.push({ subject: operation, metric, measured: row.perCall[metric], budget: budget[metric] });
    }
  }
  for (const row of hotPaths) {
    if (!budgets.perRequest[row.operation]) violations.push({ subject: row.operation, metric: "budget", measured: 1, budget: 0 });
  }
  const steady = [
    ["perActiveWorkspaceTransactionsPerSecond", projection.perWorkspace.transactionsPerSecond],
    ["perRunningEngineTransactionsPerSecond", projection.perRunningEngineTransactionsPerSecond],
    ["perStoppedWorkspaceTransactionsPerSecond", projection.perStoppedWorkspaceTransactionsPerSecond],
  ] as const;
  if (notifyingCommitsPerActiveWorkspace > budgets.steadyState.notifyingCommitsPerActiveWorkspacePerSecond)
    violations.push({ subject: "steadyState", metric: "notifyingCommitsPerActiveWorkspacePerSecond",
      measured: notifyingCommitsPerActiveWorkspace, budget: budgets.steadyState.notifyingCommitsPerActiveWorkspacePerSecond });
  if (authorityCacheNotificationsPerActiveWorkspace > budgets.steadyState.authorityCacheNotificationsPerActiveWorkspacePerSecond)
    violations.push({ subject: "steadyState", metric: "authorityCacheNotificationsPerActiveWorkspacePerSecond",
      measured: authorityCacheNotificationsPerActiveWorkspace, budget: budgets.steadyState.authorityCacheNotificationsPerActiveWorkspacePerSecond });
  for (const [metric, measured] of steady) {
    if (measured > budgets.steadyState[metric]) violations.push({ subject: "steadyState", metric, measured, budget: budgets.steadyState[metric] });
  }
  return violations;
}
