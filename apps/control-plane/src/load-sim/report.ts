import type { HotPathResult, Projection, ScenarioResult } from "./simulation.js";
import type { StatementSample } from "./server-stats.js";

export type LoadSimulationReport = {
  version: 1;
  generatedAt: string;
  environment: { node: string; postgres: string; cpus: number; statementsTracked: boolean; workosEnabled: boolean };
  config: { scenarios: number[]; durationSeconds: number; quietDurationSeconds: number; warmupSeconds: number; iterations: number;
    background: boolean };
  /** Measured with exactly one seeded workspace; these are the budgeted costs. */
  hotPaths: HotPathResult[];
  /** Reconciler requests before any workspace exists. */
  emptyInventory: HotPathResult[];
  /** Reconciler requests after the largest scenario, to show growth with inventory. */
  workerAtScale: { seededWorkspaces: number; results: HotPathResult[] };
  scenarios: ScenarioResult[];
  projection: Projection;
  /** pg_stat_statements top statements of the largest scenario. */
  topStatements: StatementSample[];
};

const fixed = (value: number | null | undefined, digits = 2) => value === null || value === undefined ? "n/a" : value.toFixed(digits);

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map(row => `| ${row.join(" | ")} |`)].join("\n");
}

export function formatReport(report: LoadSimulationReport): string {
  const sections: string[] = [];
  sections.push(`# Control-plane database load simulation\n\n${report.generatedAt}; PostgreSQL ${report.environment.postgres}; ` +
    `Node ${report.environment.node}; ${report.environment.cpus} CPUs; WorkOS authority ${report.environment.workosEnabled ? "on" : "off"}.`);
  sections.push("## Per-request cost (serial, warmed)\n\n" + table(
    ["Operation", "Tx", "Statements", "Round trips", "Checkouts", "p50 ms", "p95 ms", "Server exec ms", "RTT floor @5 ms"],
    report.hotPaths.map(row => [row.operation, fixed(row.perCall.transactions), fixed(row.perCall.statements), fixed(row.perCall.roundTrips),
      fixed(row.perCall.checkouts), fixed(row.p50Ms), fixed(row.p95Ms), fixed(row.serverExecMsPerCall, 3), fixed(row.roundTripFloorMsAt5msRtt, 0)])));
  sections.push(`## Reconciler requests by inventory size\n\n` + table(
    ["Operation", "Tx (empty)", "Tx (1 workspace)", `Tx (${report.workerAtScale.seededWorkspaces} workspaces)`, `Statements (${report.workerAtScale.seededWorkspaces})`],
    report.workerAtScale.results.map(row => {
      const empty = report.emptyInventory.find(item => item.operation === row.operation);
      const one = report.hotPaths.find(item => item.operation === row.operation);
      return [row.operation, fixed(empty?.perCall.transactions), fixed(one?.perCall.transactions), fixed(row.perCall.transactions), fixed(row.perCall.statements)];
    })));
  sections.push("## Real-time scenarios\n\n" + table(
    ["Scenario", "Active", "Seconds", "Tx/s", "Tx/s per active", "Statements/s", "Round trips/s", "Client DB ms/s", "CP CPU ms/s", "Server tx/s", "Server exec ms/s", "Failures"],
    report.scenarios.map(row => {
      const quiet = report.scenarios.find(item => item.activeWorkspaces === 0 && item.background === row.background);
      const perActive = row.activeWorkspaces ? (row.transactionsPerSecond - (quiet?.transactionsPerSecond ?? 0)) / row.activeWorkspaces : null;
      return [row.name, String(row.activeWorkspaces), fixed(row.durationSeconds, 1), fixed(row.transactionsPerSecond), fixed(perActive),
        fixed(row.statementsPerSecond), fixed(row.roundTripsPerSecond), fixed(row.clientDbMsPerSecond), fixed(row.processCpuMsPerSecond),
        fixed(row.server?.transactionsPerSecond), fixed(row.server?.execMsPerSecond), String(Object.values(row.failures).reduce((a, b) => a + b, 0))];
    })));
  const largest = report.scenarios.at(-1);
  if (largest) sections.push(`## Transactions by operation (${largest.name})\n\n` + table(
    ["Operation", "Requests/s", "Tx/s", "Statements/s", "Round trips/s"],
    largest.operations.map(row => [row.operation, fixed(row.requestsPerSecond), fixed(row.transactionsPerSecond),
      fixed(row.statementsPerSecond), fixed(row.roundTripsPerSecond)])));
  sections.push(`## Projection at nominal cadence\n\nPer active workspace: ${fixed(report.projection.perWorkspace.transactionsPerSecond, 3)} tx/s, ` +
    `${fixed(report.projection.perWorkspace.statementsPerSecond, 3)} statements/s, ${fixed(report.projection.perWorkspace.roundTripsPerSecond, 3)} round trips/s ` +
    `(running engine alone ${fixed(report.projection.perRunningEngineTransactionsPerSecond, 3)} tx/s; each connected desktop adds ` +
    `${fixed(report.projection.perConnectedClientTransactionsPerSecond, 3)} tx/s).\n\n` +
    table(["Operation", "Role", "Requests/s", "Tx/s"], report.projection.perWorkspace.byOperation.map(row =>
      [row.operation, row.role, fixed(row.requestsPerSecond, 3), fixed(row.transactionsPerSecond, 3)])) + "\n\n" +
    table(["Reconciler share", "Tx per 60 s cycle", "Tx/s"], report.projection.perWorkspaceWorker.map(row =>
      [row.operation, fixed(row.transactionsPerCycle), fixed(row.transactionsPerSecond, 3)])) + "\n\n" +
    table(["Workspaces", "Tx/s", "Statements/s"], report.projection.atWorkspaces.map(row =>
      [String(row.workspaces), fixed(row.transactionsPerSecond), fixed(row.statementsPerSecond)])));
  if (report.topStatements.length) sections.push(`## Top statements by server time (${largest?.name ?? ""})\n\n` + table(
    ["Total ms", "Calls", "Mean ms", "Query"],
    report.topStatements.slice(0, 10).map(row => [fixed(row.totalExecMs, 1), String(row.calls), fixed(row.meanExecMs, 3),
      "`" + row.query.replaceAll("|", "\\|").replaceAll("`", "'").slice(0, 160) + "`"])));
  return sections.join("\n\n") + "\n";
}
