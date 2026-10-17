// Scenarios for the control-plane load simulator: per-request hot-path cost,
// real-time steady state at the product's real cadences, and a projection of
// both onto any workspace count.

import { addCost, emptyCost, percentile, type OperationCost } from "./instrument.js";
import type { SimulatedWorkspace, Simulator, SimulatorOperationName } from "./harness.js";
import type { ServerStats, ServerWindow } from "./server-stats.js";

export type Cadence = {
  /** Mean seconds between requests for one workspace. */
  periodSeconds: number;
  /** True when the next request waits for the previous one to finish. */
  afterCompletion: boolean;
  /** `engine` runs whenever the workspace runs; `client` only while a desktop is connected. */
  role: "engine" | "client";
  source: string;
};

/** Steady-state cadences for one running workspace with one connected desktop.
 * Keep in step with the referenced constants; the doc lists the same table. */
export const STEADY_STATE_CADENCES = {
  "engine.credentialControls": { periodSeconds: 0.5, afterCompletion: true, role: "engine",
    source: "apps/desktop/src/engine/cloud-local-command-queue-boot.ts: controls poll 500 ms after each exchange" },
  "engine.heartbeat": { periodSeconds: 10, afterCompletion: false, role: "engine",
    source: "engine-heartbeat.ts DEFAULT_ENGINE_HEARTBEAT_INTERVAL_MS, sent in the registration document" },
  "engine.durableRecordHead": { periodSeconds: 10, afterCompletion: false, role: "engine",
    source: "cloud-runtime-registration.ts synchronizeDurableRecord after each accepted heartbeat" },
  "engine.actorConfirm": { periodSeconds: 5, afterCompletion: false, role: "client",
    source: "cloud-local-command-queue-boot.ts: re-confirm at half of the 10 s confirmedUntil" },
  "client.renew": { periodSeconds: 5, afterCompletion: false, role: "client",
    source: "apps/desktop/src/engine/transport/cloud.ts: renew at half of MAX_CLIENT_AUTHORITY_LEASE_MS (10 s)" },
  "client.relayRevalidate": { periodSeconds: 5, afterCompletion: false, role: "client",
    source: "runtime-bridge.ts authorityCheckMs default 5 s" },
  "client.catalog": { periodSeconds: 30, afterCompletion: false, role: "client",
    source: "renderer/state/cloud-workspace-lifecycle.tsx: catalog refresh every 30 s (2 s during transitions)" },
} as const satisfies Partial<Record<SimulatorOperationName, Cadence>>;

export type SteadyOperation = keyof typeof STEADY_STATE_CADENCES;

/** Reconciler work that grows with each running workspace. The background
 * reconciler drives these itself; `marginal` costs are measured as the
 * difference between one seeded workspace and an empty inventory, and
 * `runningOnly` work stops when the workspace does. */
export const WORKER_PER_WORKSPACE_CADENCES = {
  "worker.engineHealthJob": { periodSeconds: 90, marginal: false, runningOnly: true,
    source: "lifecycle-jobs.ts DUE.engineHealth: one job run per engine lease period (90 s) while the workspace runs" },
  "worker.reconcileDrift": { periodSeconds: 21_600, marginal: false, runningOnly: false,
    source: "reconciler.ts sweepScopeInventory: the paged inventory keeps matched bindings pushed to the 6 h inventoryFallbackMs horizon; only then does a per-workspace drift inspect run" },
  "worker.reconcileOrphans": { periodSeconds: 60, marginal: true, runningOnly: false,
    source: "reconciler.ts orphanSweepAt: one paged inventory sweep per 60 s, work per managed provider resource" },
} as const satisfies Partial<Record<SimulatorOperationName, { periodSeconds: number; marginal: boolean; runningOnly: boolean; source: string }>>;

export type WorkerPerWorkspaceOperation = keyof typeof WORKER_PER_WORKSPACE_CADENCES;

/** Sub-operations that a measured request issues under its own name. */
const NESTED: Partial<Record<SimulatorOperationName, readonly string[]>> = { "client.catalog": ["client.auth"] };

export type HotPathResult = {
  operation: string;
  iterations: number;
  perCall: Omit<OperationCost, "calls">;
  p50Ms: number;
  p95Ms: number;
  /** pg_stat_statements top-level execution time per call, when available. */
  serverExecMsPerCall: number | null;
  /** Lower bound on request latency against a remote database. */
  roundTripFloorMsAt5msRtt: number;
};

function perCall(cost: OperationCost, calls: number): Omit<OperationCost, "calls"> {
  const { calls: _calls, ...rest } = cost;
  return Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, calls ? value / calls : 0])) as Omit<OperationCost, "calls">;
}

function deltaCosts(after: Map<string, OperationCost>, before: Map<string, OperationCost>): Map<string, OperationCost> {
  const result = new Map<string, OperationCost>();
  for (const [name, cost] of after) {
    const prior = before.get(name) ?? emptyCost();
    const delta = emptyCost();
    for (const key of Object.keys(delta) as (keyof OperationCost)[]) delta[key] = cost[key] - prior[key];
    result.set(name, delta);
  }
  return result;
}

function combined(costs: Map<string, OperationCost>, operation: string): OperationCost {
  const total = { ...(costs.get(operation) ?? emptyCost()) };
  for (const nested of NESTED[operation as SimulatorOperationName] ?? []) {
    const { calls: _calls, ...rest } = costs.get(nested) ?? emptyCost();
    addCost(total, { ...rest, calls: 0 });
  }
  return total;
}

/** Serial, warmed, one request at a time: per-request cost without contention. */
export async function measureHotPaths(sim: Simulator, options: {
  /** Absent only when measuring worker operations against an empty inventory. */
  workspace?: SimulatedWorkspace; iterations: number; warmup?: number; server?: ServerStats | null;
  operations?: readonly SimulatorOperationName[];
}): Promise<HotPathResult[]> {
  const names = options.operations ?? (Object.keys(sim.operations) as SimulatorOperationName[]);
  const results: HotPathResult[] = [];
  const workspace = options.workspace as SimulatedWorkspace;
  for (const name of names) {
    const operation = sim.operations[name] as (workspace: SimulatedWorkspace) => Promise<unknown>;
    const prepare = sim.prepare[name];
    const call = async (label: string) => {
      if (prepare) await prepare(workspace);
      await sim.meter.measure(label, () => operation(workspace));
    };
    for (let index = 0; index < (options.warmup ?? 2); index += 1) await call(`warmup.${name}`);
    const close = options.server?.statements ? await options.server.begin() : null;
    sim.meter.reset();
    for (let index = 0; index < options.iterations; index += 1) await call(name);
    const costs = sim.meter.snapshot();
    const samples = sim.meter.latencySamples(name);
    const server: ServerWindow | null = close ? await close() : null;
    const cost = combined(costs, name);
    const unattributed = costs.get("unattributed");
    if (unattributed && unattributed.roundTrips) throw new Error(`${name} issued unattributed queries`);
    const average = perCall(cost, cost.calls);
    results.push({
      operation: name,
      iterations: cost.calls,
      perCall: average,
      p50Ms: percentile(samples, 50),
      p95Ms: percentile(samples, 95),
      serverExecMsPerCall: server?.execMs === null || server === null ? null : server.execMs / options.iterations,
      roundTripFloorMsAt5msRtt: average.roundTrips * 5,
    });
  }
  return results;
}

export type ScenarioResult = {
  name: string;
  activeWorkspaces: number;
  background: boolean;
  durationSeconds: number;
  totals: OperationCost;
  transactionsPerSecond: number;
  statementsPerSecond: number;
  roundTripsPerSecond: number;
  /** Commits carrying a NOTIFY per second; the database serializes them.
   * Includes authority-cache hints, counted per delivery, so an upper bound. */
  notifyingCommitsPerSecond: number;
  /** Authority-cache invalidation hints delivered per second (0152 triggers). */
  authorityCacheNotificationsPerSecond: number;
  /** Client-measured database wall time per second (loopback). */
  clientDbMsPerSecond: number;
  /** Control-plane process CPU (user+system), simulator included. */
  processCpuMsPerSecond: number;
  operations: Array<{ operation: string; requestsPerSecond: number; transactionsPerSecond: number; statementsPerSecond: number;
    roundTripsPerSecond: number; errors: number }>;
  server: (ServerWindow & { transactionsPerSecond: number; execMsPerSecond: number | null }) | null;
  providerCalls: Record<string, number>;
  /** Operation-level failures during the whole run, warmup included. */
  failures: Record<string, number>;
  firstFailure: Record<string, string>;
};

/** Seeded PRNG, so stagger offsets are reproducible across runs. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Real-time run: every active workspace's engine and desktop loops at their
 * real cadences, plus production's idle background workers. */
export async function runScenario(sim: Simulator, options: {
  name: string; activeWorkspaces: number; durationMs: number; warmupMs: number; background: boolean;
  server?: ServerStats | null; operations?: readonly SteadyOperation[];
}): Promise<ScenarioResult> {
  const active = sim.workspaces.slice(0, options.activeWorkspaces);
  if (active.length !== options.activeWorkspaces) throw new Error("not enough seeded workspaces");
  const loops: Promise<void>[] = [];
  const failures: Record<string, number> = {};
  const firstFailure: Record<string, string> = {};
  const sleepers = new Map<NodeJS.Timeout, () => void>();
  const run = new AbortController();
  const next = random(0x5eed + options.activeWorkspaces);
  const sleep = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(() => { sleepers.delete(timer); resolve(); }, ms);
    sleepers.set(timer, resolve);
  });
  const operationNames = options.operations ?? (Object.keys(STEADY_STATE_CADENCES) as SteadyOperation[]);
  for (const workspace of active) {
    for (const name of operationNames) {
      const cadence: Cadence = STEADY_STATE_CADENCES[name];
      const operation = sim.operations[name] as (workspace: SimulatedWorkspace) => Promise<unknown>;
      const periodMs = cadence.periodSeconds * 1000;
      loops.push((async () => {
        await sleep(next() * periodMs);
        while (!run.signal.aborted) {
          const started = Date.now();
          await sim.meter.measure(name, () => operation(workspace)).catch((error: unknown) => {
            failures[name] = (failures[name] ?? 0) + 1;
            firstFailure[name] ??= error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : String(error);
          });
          // The run can end while the operation is in flight; do not start another sleep.
          if (run.signal.aborted) break;
          await sleep(cadence.afterCompletion ? periodMs : Math.max(0, periodMs - (Date.now() - started)));
        }
      })());
    }
  }
  const stopBackground = options.background ? sim.startBackgroundWorkers() : null;
  await new Promise(resolve => setTimeout(resolve, options.warmupMs));
  const close = options.server ? await options.server.begin() : null;
  const providerBefore = new Map(sim.boat.calls);
  const notificationsBefore = sim.notifications.count, authorityNotificationsBefore = sim.notifications.authorityCache;
  const before = sim.meter.snapshot();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  await new Promise(resolve => setTimeout(resolve, options.durationMs));
  run.abort();
  for (const [timer, resolve] of sleepers) {
    clearTimeout(timer);
    resolve();
  }
  sleepers.clear();
  await Promise.all(loops);
  await stopBackground?.();
  const seconds = (performance.now() - started) / 1000;
  const cpu = process.cpuUsage(cpuBefore);
  const after = sim.meter.snapshot();
  const server = close ? await close() : null;
  const costs = deltaCosts(after, before);
  const totals = emptyCost();
  for (const cost of costs.values()) addCost(totals, cost);
  const providerCalls = Object.fromEntries([...sim.boat.calls].map(([name, count]) => [name, count - (providerBefore.get(name) ?? 0)])
    .filter(([, count]) => (count as number) > 0));
  return {
    name: options.name,
    activeWorkspaces: options.activeWorkspaces,
    background: options.background,
    durationSeconds: seconds,
    totals,
    transactionsPerSecond: totals.transactions / seconds,
    statementsPerSecond: totals.statements / seconds,
    roundTripsPerSecond: totals.roundTrips / seconds,
    // Client-visible pg_notify commits (e.g. checkpoint hints) plus
    // trigger-issued job wake-ups and authority-cache hints counted by the
    // listener.
    notifyingCommitsPerSecond: (totals.notifyingCommits + sim.notifications.count - notificationsBefore +
      sim.notifications.authorityCache - authorityNotificationsBefore) / seconds,
    authorityCacheNotificationsPerSecond: (sim.notifications.authorityCache - authorityNotificationsBefore) / seconds,
    clientDbMsPerSecond: totals.clientDbMs / seconds,
    processCpuMsPerSecond: (cpu.user + cpu.system) / 1000 / seconds,
    operations: [...costs].filter(([, cost]) => cost.roundTrips || cost.calls).map(([operation, cost]) => ({
      operation,
      requestsPerSecond: cost.calls / seconds,
      transactionsPerSecond: cost.transactions / seconds,
      statementsPerSecond: cost.statements / seconds,
      roundTripsPerSecond: cost.roundTrips / seconds,
      errors: cost.errors,
    })).sort((a, b) => b.transactionsPerSecond - a.transactionsPerSecond),
    server: server ? { ...server, transactionsPerSecond: server.transactions / seconds,
      execMsPerSecond: server.execMs === null ? null : server.execMs / seconds } : null,
    providerCalls,
    failures,
    firstFailure,
  };
}

export type Projection = {
  /** Upper bound per active workspace: every loop at its nominal cadence. */
  /** One running workspace with one connected desktop. */
  perWorkspace: { transactionsPerSecond: number; statementsPerSecond: number; roundTripsPerSecond: number;
    byOperation: Array<{ operation: SteadyOperation; role: Cadence["role"]; requestsPerSecond: number; transactionsPerSecond: number }> };
  /** A running workspace with no desktop connected: engine loops and its reconciler share. */
  perRunningEngineTransactionsPerSecond: number;
  /** A settled stopped workspace: no engine loops, no engine-health job, the
   * drift fallback horizon and its sweep share only. */
  perStoppedWorkspaceTransactionsPerSecond: number;
  /** The reconciler's share of perRunningEngineTransactionsPerSecond. */
  perWorkspaceWorker: Array<{ operation: WorkerPerWorkspaceOperation; transactionsPerCycle: number; transactionsPerSecond: number;
    statementsPerSecond: number }>;
  /** Added by each connected desktop. */
  perConnectedClientTransactionsPerSecond: number;
  atWorkspaces: Array<{ workspaces: number; transactionsPerSecond: number; statementsPerSecond: number;
    /** One replica's sweeps plus fallback drift inspects; every replica shares Boat's 1000/min/IP. */
    boatCallsPerMinutePerReplica: number }>;
};

/** Boat calls one replica issues at N workspaces: one paged list per minute
 * (100 per page) plus one inspect per fallback drift run (6 h horizon). */
function projectedBoatCallsPerMinute(workspaces: number): number {
  return Math.max(1, Math.ceil(workspaces / 100)) + workspaces * (60 / 21_600);
}

export function projectSteadyState(hotPaths: readonly HotPathResult[], quietTransactionsPerSecond: number,
  workspaceCounts: readonly number[], emptyInventory: readonly HotPathResult[] = []): Projection {
  const perWorkspaceWorker = (Object.entries(WORKER_PER_WORKSPACE_CADENCES) as [WorkerPerWorkspaceOperation, typeof WORKER_PER_WORKSPACE_CADENCES[WorkerPerWorkspaceOperation]][])
    .map(([operation, cadence]) => {
      const loaded = hotPaths.find(result => result.operation === operation)?.perCall;
      if (!loaded) throw new Error(`missing hot-path measurement for ${operation}`);
      const empty = emptyInventory.find(result => result.operation === operation)?.perCall;
      if (cadence.marginal && !empty) throw new Error(`missing empty-inventory measurement for ${operation}`);
      const transactionsPerCycle = cadence.marginal ? loaded.transactions - empty!.transactions : loaded.transactions;
      const statementsPerCycle = cadence.marginal ? loaded.statements - empty!.statements : loaded.statements;
      return { operation, transactionsPerCycle, transactionsPerSecond: transactionsPerCycle / cadence.periodSeconds,
        statementsPerSecond: statementsPerCycle / cadence.periodSeconds };
    });
  const workerPerSecond = perWorkspaceWorker.reduce((total, row) => total + row.transactionsPerSecond, 0);
  const workerStatementsPerSecond = perWorkspaceWorker.reduce((total, row) => total + row.statementsPerSecond, 0);
  const stoppedWorkerPerSecond = perWorkspaceWorker
    .filter(row => !WORKER_PER_WORKSPACE_CADENCES[row.operation].runningOnly)
    .reduce((total, row) => total + row.transactionsPerSecond, 0);
  const byOperation = (Object.entries(STEADY_STATE_CADENCES) as [SteadyOperation, Cadence][]).map(([operation, cadence]) => {
    const hot = hotPaths.find(result => result.operation === operation);
    if (!hot) throw new Error(`missing hot-path measurement for ${operation}`);
    const requestsPerSecond = 1 / cadence.periodSeconds;
    return { operation, role: cadence.role, requestsPerSecond, transactionsPerSecond: requestsPerSecond * hot.perCall.transactions,
      statementsPerSecond: requestsPerSecond * hot.perCall.statements, roundTripsPerSecond: requestsPerSecond * hot.perCall.roundTrips };
  });
  const sum = (key: "transactionsPerSecond" | "statementsPerSecond" | "roundTripsPerSecond", role?: Cadence["role"]) =>
    byOperation.filter(row => !role || row.role === role).reduce((total, row) => total + row[key], 0);
  const perWorkspace = { transactionsPerSecond: sum("transactionsPerSecond") + workerPerSecond, statementsPerSecond: sum("statementsPerSecond") + workerStatementsPerSecond,
    roundTripsPerSecond: sum("roundTripsPerSecond"),
    byOperation: byOperation.map(({ operation, role, requestsPerSecond, transactionsPerSecond }) => ({ operation, role, requestsPerSecond, transactionsPerSecond }))
      .sort((a, b) => b.transactionsPerSecond - a.transactionsPerSecond) };
  return {
    perWorkspace,
    perRunningEngineTransactionsPerSecond: sum("transactionsPerSecond", "engine") + workerPerSecond,
    // The quiet floor is global, not per workspace; a stopped workspace adds
    // only its non-running worker cycles (drift fallback, sweep share).
    perStoppedWorkspaceTransactionsPerSecond: stoppedWorkerPerSecond,
    perWorkspaceWorker,
    perConnectedClientTransactionsPerSecond: sum("transactionsPerSecond", "client"),
    atWorkspaces: workspaceCounts.map(workspaces => ({ workspaces,
      transactionsPerSecond: quietTransactionsPerSecond + workspaces * perWorkspace.transactionsPerSecond,
      statementsPerSecond: workspaces * perWorkspace.statementsPerSecond,
      boatCallsPerMinutePerReplica: projectedBoatCallsPerMinute(workspaces) })),
  };
}
