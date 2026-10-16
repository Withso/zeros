// Control-plane database load simulator.
//
//   LOAD_SIM_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/zeros_load_sim \
//     pnpm --dir apps/control-plane load:db
//   pnpm --dir apps/control-plane load:db -- --workspaces 0,1,10 --duration 20 --out /tmp/load.json
//   pnpm --dir apps/control-plane load:db -- --help
//
// The database is DROPPED AND REBUILT from the migration ladder before the
// run, so only a disposable loopback database is accepted. Real control-plane
// services, routes and workers run in this process against it; Boat is an
// in-memory fake, and engines/desktops are simulated at their real cadences.
// See docs/cloud-workspace/load-simulator.md.

import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { parseArgs } from "node:util";
import pg from "pg";
import { rebuildMigratedTestDatabase } from "../test-database.js";
import { budgetsFromMeasurement, checkBudgets, type LoadBudgets } from "./budgets.js";
import { assertDisposableLoopbackDatabase } from "./database-guard.js";
import { createSimulator } from "./harness.js";
import { DatabaseCostMeter } from "./instrument.js";
import { formatReport, writeReport, type LoadSimulationReport } from "./report.js";
import { ServerStats } from "./server-stats.js";
import { measureHotPaths, projectSteadyState, runScenario, type HotPathResult, type ScenarioResult } from "./simulation.js";
import type { SimulatorOperationName } from "./harness.js";

const WORKER_OPERATIONS: readonly SimulatorOperationName[] = ["worker.lifecycleJobClaim", "worker.reconcileOnce", "worker.reconcileDrift", "worker.reconcileOrphans"];
const EMPTY_INVENTORY_OPERATIONS: readonly SimulatorOperationName[] = ["worker.lifecycleJobClaim", "worker.reconcileOnce", "worker.reconcileOrphans"];

/** Ceilings so a mistyped flag cannot monopolise a shared machine. */
const LOAD_SIMULATOR_CAPS = { workspaces: 200, durationSeconds: 600, iterations: 1_000 } as const;

const usage = `Usage: load:db [--workspaces 0,1,10,50] [--duration 30] [--quiet-duration 120] [--warmup 5] [--iterations 25]
               [--no-background] [--workos off] [--out <report.json>] [--write-budgets <budgets.json>]
Requires LOAD_SIM_DATABASE_URL pointing at a disposable loopback database; it is rebuilt.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // `pnpm load:db -- --flag` forwards the separator itself.
  if (argv[0] === "--") argv.shift();
  const { values } = parseArgs({ args: argv, options: {
    workspaces: { type: "string", default: "0,1,10,50" },
    duration: { type: "string", default: "30" },
    "quiet-duration": { type: "string", default: "120" },
    warmup: { type: "string", default: "5" },
    iterations: { type: "string", default: "25" },
    "no-background": { type: "boolean", default: false },
    workos: { type: "string", default: "on" },
    out: { type: "string" },
    "write-budgets": { type: "string" },
    help: { type: "boolean", default: false },
  } });
  if (values.help) { console.log(usage); return; }
  const databaseUrl = process.env.LOAD_SIM_DATABASE_URL;
  if (!databaseUrl) throw new Error(`LOAD_SIM_DATABASE_URL is required.\n${usage}`);
  await assertDisposableLoopbackDatabase(databaseUrl);
  const scenarios = values.workspaces.split(",").map(value => Number(value.trim()));
  const durationSeconds = Number(values.duration), quietDurationSeconds = Number(values["quiet-duration"]), warmupSeconds = Number(values.warmup), iterations = Number(values.iterations);
  if (scenarios.some(count => !Number.isSafeInteger(count) || count < 0 || count > LOAD_SIMULATOR_CAPS.workspaces) ||
      [...scenarios].sort((a, b) => a - b).join() !== scenarios.join() ||
      !(durationSeconds > 0 && durationSeconds <= LOAD_SIMULATOR_CAPS.durationSeconds) ||
      !(quietDurationSeconds > 0 && quietDurationSeconds <= LOAD_SIMULATOR_CAPS.durationSeconds) ||
      !(warmupSeconds >= 0 && warmupSeconds <= 60) ||
      !Number.isSafeInteger(iterations) || iterations < 1 || iterations > LOAD_SIMULATOR_CAPS.iterations)
    throw new Error(`Invalid options (ascending workspace counts up to ${LOAD_SIMULATOR_CAPS.workspaces}).\n${usage}`);
  const background = !values["no-background"];
  const workosEnabled = values.workos !== "off";

  const budgets = JSON.parse(readFileSync(new URL("./budgets.json", import.meta.url), "utf8")) as LoadBudgets;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1, application_name: "zeros-load-sim-admin" });
  console.error("[load:db] rebuilding the disposable database from the migration ladder");
  const log = console.log;
  console.log = () => {};
  try { await rebuildMigratedTestDatabase(admin); } finally { console.log = log; }
  const server = await ServerStats.open(admin, { installStatements: true });
  const postgres = (await admin.query<{ server_version: string }>("SHOW server_version")).rows[0]!.server_version;
  const meter = new DatabaseCostMeter();
  const sim = await createSimulator({ databaseUrl, meter, workosEnabled });
  const results: ScenarioResult[] = [];
  let topStatements: LoadSimulationReport["topStatements"] = [];
  let hotPaths: HotPathResult[] | null = null;
  const measureAtOneWorkspace = async () => {
    await sim.seedWorkspace();
    console.error(`[load:db] measuring per-request cost at one seeded workspace (${iterations} iterations each)`);
    return measureHotPaths(sim, { workspace: sim.workspaces[0]!, iterations, server });
  };
  try {
    console.error("[load:db] measuring reconciler work against an empty inventory");
    const emptyInventory = await measureHotPaths(sim, { operations: EMPTY_INVENTORY_OPERATIONS, iterations, server });
    for (const count of scenarios) {
      if (count > 0 && !hotPaths) hotPaths = await measureAtOneWorkspace();
      while (sim.workspaces.length < count) {
        await sim.seedWorkspace();
        if (sim.workspaces.length % 10 === 0) console.error(`[load:db] seeded ${sim.workspaces.length} workspaces`);
      }
      // Idle workers wake about once a minute, so the quiet window must span several wakes.
      const seconds = count === 0 ? quietDurationSeconds : durationSeconds;
      console.error(`[load:db] scenario ${count} active workspaces for ${seconds}s`);
      const result = await runScenario(sim, { name: `${count} active`, activeWorkspaces: count, durationMs: seconds * 1000,
        warmupMs: warmupSeconds * 1000, background, server });
      results.push(result);
      if (result.server?.top.length) topStatements = result.server.top;
    }
    hotPaths ??= await measureAtOneWorkspace();
    console.error(`[load:db] measuring reconciler work at ${sim.workspaces.length} seeded workspaces`);
    const workerAtScale = { seededWorkspaces: sim.workspaces.length,
      results: await measureHotPaths(sim, { workspace: sim.workspaces[0]!, operations: WORKER_OPERATIONS, iterations: Math.min(iterations, 5), server }) };
    const quiet = results.find(result => result.activeWorkspaces === 0)?.transactionsPerSecond ?? 0;
    const report: LoadSimulationReport = {
      version: 1,
      generatedAt: new Date().toISOString(),
      environment: { node: process.version, postgres, cpus: cpus().length, statementsTracked: server.statements, workosEnabled },
      config: { scenarios, durationSeconds, quietDurationSeconds, warmupSeconds, iterations, background },
      hotPaths,
      emptyInventory,
      workerAtScale,
      scenarios: results,
      projection: projectSteadyState(hotPaths, quiet, [0, 1, 10, 50, 100, 500], emptyInventory),
      topStatements,
    };
    const out = writeReport(report, values.out);
    console.log(formatReport(report));
    console.error(`[load:db] report written to ${out}`);
    if (values["write-budgets"]) {
      writeFileSync(values["write-budgets"], JSON.stringify(budgetsFromMeasurement(hotPaths, report.projection, budgets.targets), null, 2) + "\n");
      console.error(`[load:db] budgets derived from this run written to ${values["write-budgets"]}`);
    }
    const violations = checkBudgets(budgets, hotPaths, report.projection);
    for (const violation of violations) {
      console.error(violation.metric === "budget" ? `[load:db] ${violation.subject} has no entry in budgets.json`
        : violation.metric === "measured" ? `[load:db] budgets.json lists ${violation.subject}, which was not measured`
        : violation.metric === "transactionsFloor" ? `[load:db] ${violation.subject} must cost at least one transaction per request (floor ${violation.budget}, measured ${violation.measured})`
        : `[load:db] over budget: ${violation.subject} ${violation.metric} ${violation.measured} > ${violation.budget}`);
    }
    if (violations.length) process.exitCode = 1;
    else console.error("[load:db] within budgets.json");
    // A scenario whose operations failed only under real-time concurrency must
    // not pass green just because the budgets held.
    for (const result of results) {
      const failed = Object.entries(result.failures);
      if (!failed.length) continue;
      console.error(`[load:db] FAIL: scenario "${result.name}" recorded operation failures: ` +
        failed.map(([operation, count]) => `${operation} ×${count}`).join(", ") +
        (result.firstFailure ? ` (first: ${result.firstFailure})` : ""));
      process.exitCode = 1;
    }
    const quietRate = results.find(result => result.activeWorkspaces === 0)?.transactionsPerSecond;
    console.error(`[load:db] targets: quiet ${quietRate?.toFixed(3) ?? "n/a"} tx/s (target ${budgets.targets.quietTransactionsPerSecond}); ` +
      `per active workspace ${report.projection.perWorkspace.transactionsPerSecond.toFixed(3)} tx/s (target ${budgets.targets.perActiveWorkspaceTransactionsPerSecond})`);
  } finally {
    await sim.close();
    await admin.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
