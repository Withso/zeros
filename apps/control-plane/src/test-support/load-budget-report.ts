import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, open, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type { BackgroundDefinition, backgroundBudgetTable } from "./load-budget.js";

export type BudgetDefinition = { phase: string; scenario: string; metric: string; baseline: number; maximum: number; expectedFailure: boolean };
export type LoadReport = { version: 1; profile: string; wallClock: boolean; wallProfile?: string; statementDelayMs: number;
  budgets: Array<BudgetDefinition & { observed: number; targetObserved?: number }>;
  backgroundBudgets?: ReturnType<typeof backgroundBudgetTable>; scenarios: unknown[] };
type Comparison = BudgetDefinition & { before: number; after: number; delta: number; targetObserved: number; ratchet: "PASS" | "FAIL"; target: "PASS" | "FAIL" };
export const LOAD_BUDGET_SOURCE = "apps/control-plane/src/test-support/load-budget.ts";
export const LOAD_HARNESS_FILES = [LOAD_BUDGET_SOURCE, "apps/control-plane/src/test-support/load-budget-fixture.ts",
  "apps/control-plane/src/load-budget.integration.test.ts"] as const;
const key = (row: Pick<BudgetDefinition, "scenario" | "metric">) => `${row.scenario}:${row.metric}`;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function unique<T extends Pick<BudgetDefinition, "scenario" | "metric">>(rows: readonly T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (!row || typeof row.scenario !== "string" || typeof row.metric !== "string") throw new Error("Invalid load measurement");
    if (result.has(key(row))) throw new Error(`Duplicate budget: ${key(row)}`);
    result.set(key(row), row);
  }
  return result;
}

function literalRows(source: string, name: string, optional = false): Record<string, unknown>[] {
  const tree = ts.createSourceFile("load-budget.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .find(value => ts.isIdentifier(value.name) && value.name.text === name);
  if (!declaration && optional) return [];
  let expression = declaration?.initializer;
  while (expression && (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression))) expression = expression.expression;
  if (!expression || !ts.isArrayLiteralExpression(expression)) throw new Error("Budgets must be a literal array");
  return expression.elements.map(element => {
    if (!ts.isObjectLiteralExpression(element)) throw new Error("Budgets must contain literal objects");
    const row: Record<string, unknown> = {};
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) throw new Error("Budgets must contain literal fields");
      const value = property.initializer;
      if (Object.hasOwn(row, property.name.text)) throw new Error("Duplicate budget field");
      row[property.name.text] = ts.isNumericLiteral(value) ? Number(value.text) : ts.isStringLiteral(value) ? value.text
        : value.kind === ts.SyntaxKind.TrueKeyword ? true : value.kind === ts.SyntaxKind.FalseKeyword ? false
        : ts.isArrayLiteralExpression(value) && value.elements.every(ts.isNumericLiteral) ? value.elements.filter(ts.isNumericLiteral).map(value => Number(value.text)) : undefined;
    }
    return row;
  });
}

export function readBudgetDefinitions(source: string): BudgetDefinition[] {
  const rows = literalRows(source, "LOAD_BUDGETS").map(row => {
    if (Object.keys(row).sort().join() !== "baseline,expectedFailure,maximum,metric,phase,scenario" ||
        !integer(row.baseline) || !integer(row.maximum) || typeof row.expectedFailure !== "boolean" ||
        ![row.phase, row.scenario, row.metric].every(value => typeof value === "string" && /^[a-zA-Z0-9-]+$/.test(value)))
      throw new Error("Budgets must contain valid literal fields");
    return row as BudgetDefinition;
  });
  unique(rows); return rows;
}

export function readBackgroundDefinitions(source: string): BackgroundDefinition[] {
  const names = new Set<string>();
  return literalRows(source, "LOAD_BACKGROUND_BUDGETS", true).map(row => {
    if (Object.keys(row).sort().join() !== "initialCalls,operation,periodsMs,queries,statements,transactions" ||
        typeof row.operation !== "string" || !/^[a-z-]+$/.test(row.operation) || names.has(row.operation) ||
        ![row.initialCalls, row.queries, row.statements, row.transactions].every(integer) ||
        !Array.isArray(row.periodsMs) || !row.periodsMs.every(value => integer(value) && value > 0))
      throw new Error("Invalid background budget");
    names.add(row.operation);
    return row as BackgroundDefinition;
  });
}

export function assertBackgroundRatchet(base: readonly BackgroundDefinition[], head: readonly BackgroundDefinition[]): void {
  for (const row of base) {
    const next = head.find(value => value.operation === row.operation);
    if (!next) throw new Error(`Background budget removed: ${row.operation}`);
    if ((["initialCalls", "queries", "statements", "transactions"] as const).some(key => next[key] > row[key]) ||
        next.periodsMs.length > row.periodsMs.length || [...next.periodsMs].sort((a, b) => a - b)
          .some((period, index) => period < [...row.periodsMs].sort((a, b) => a - b)[index]!))
      throw new Error(`Background ceiling increased: ${row.operation}`);
  }
}

export function assertBaselineRatchet(base: readonly BudgetDefinition[], head: readonly BudgetDefinition[]): void {
  const prior = unique(base), next = unique(head);
  for (const [id, row] of prior) {
    const candidate = next.get(id);
    if (!candidate) throw new Error(`Load budget removed: ${id}`);
    if (candidate.baseline > row.baseline) throw new Error(`Load baseline increased: ${id}`);
    if (candidate.maximum > row.maximum) throw new Error(`Load target increased: ${id}`);
    if (!row.expectedFailure && candidate.expectedFailure) throw new Error(`Load target reopened: ${id}`);
  }
}

export function compareReports(before: LoadReport, after: LoadReport, definitions: readonly BudgetDefinition[]): Comparison[] {
  if (before.version !== 1 || after.version !== 1 || before.profile !== after.profile ||
      before.wallClock !== after.wallClock || before.wallProfile !== after.wallProfile || before.statementDelayMs !== after.statementDelayMs) throw new Error("Load comparison profiles differ");
  const prior = unique(before.budgets), next = unique(after.budgets);
  return definitions.map(budget => {
    const first = prior.get(key(budget)), second = next.get(key(budget));
    if (!first || !second) throw new Error(`Missing measurement: ${key(budget)}`);
    const targetObserved = second.targetObserved ?? second.observed;
    if (!integer(first.observed) || !integer(second.observed) || !integer(targetObserved)) throw new Error(`Invalid measurement: ${key(budget)}`);
    return { ...budget, before: first.observed, after: second.observed, delta: second.observed - first.observed,
      targetObserved, ratchet: second.observed <= budget.baseline ? "PASS" : "FAIL", target: targetObserved <= budget.maximum ? "PASS" : "FAIL" };
  });
}

export function renderComparison(rows: readonly Comparison[], base: string, head: string): string {
  return [`Load budget: ${base} → ${head}. Same harness, isolated checkouts, serial PostgreSQL runs.`, "",
    "R1 idle: server cost at the approved fallback rates, with renewals excluded. Idle ratchets count HTTP work; target observations include background SQL. Request frequency is qualified separately by scheduler tests and live idle counts.", "",
    "| Phase | Scenario | Metric | Before | After | Delta | Baseline | Target observation | Target | Ratchet | Target result |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...rows.map(row => `| ${row.phase} | ${row.scenario} | ${row.metric} | ${row.before} | ${row.after} | ${row.delta > 0 ? "+" : ""}${row.delta} | ${row.baseline} | ${row.targetObserved} | ${row.maximum} | ${row.ratchet} | ${row.target} |`), ""].join("\n");
}

export function compareBackground(before: LoadReport, after: LoadReport, limits: readonly BackgroundDefinition[]) {
  const first = before.backgroundBudgets, second = after.backgroundBudgets;
  if (!first || !second) throw new Error("Missing background measurements");
  const id = (row: typeof first[number]) => `${row.scenario}:${row.operation}:${row.metric}`;
  const expected = ["idle", "r1-fallback-idle"].flatMap(scenario => [
    ...limits.flatMap(limit => ["calls", "queriesPerCall", "statementsPerCall", "transactionsPerCall"].map(metric => `${scenario}:${limit.operation}:${metric}`)),
    ...["queries", "statements", "transactions", "githubCalls", "failures", "inFlight"].map(metric => `${scenario}:unattributed:${metric}`),
  ]);
  if (new Set(first.map(id)).size !== first.length || new Set(second.map(id)).size !== second.length ||
      first.length !== expected.length || second.length !== expected.length ||
      expected.some(key => !first.some(row => id(row) === key) || !second.some(row => id(row) === key)))
    throw new Error("Incomplete background measurements");
  return second.map(row => {
    const prior = first.find(value => id(value) === id(row))!;
    const limit = limits.find(value => value.operation === row.operation);
    const scenario = after.scenarios.find(value => (value as { name?: string })?.name === row.scenario) as { elapsedMs?: number } | undefined;
    if (!scenario || !Number.isFinite(scenario.elapsedMs) || scenario.elapsedMs! < 0 ||
        ![row.observed, row.baseline, prior.observed].every(integer)) throw new Error("Invalid background measurement");
    const metric = row.metric.replace(/PerCall$/, "");
    const baseline = row.operation === "unattributed" ? 0 : !limit ? undefined : row.metric === "calls"
      ? limit.initialCalls + limit.periodsMs.reduce((sum, period) => sum + Math.floor(scenario.elapsedMs! / period), 0)
      : ["queries", "statements", "transactions"].includes(metric) ? limit[metric as "queries"] : undefined;
    if (baseline === undefined) throw new Error("Unknown background measurement");
    return { ...row, baseline, before: prior.observed, ratchet: row.observed <= baseline ? "PASS" : "FAIL" };
  });
}

function renderBackground(rows: ReturnType<typeof compareBackground>): string {
  return ["", "Background: call counts are bounded by startup/teardown plus the maximum timer ticks in each measured wall-clock window. SQL cost is capped per call; unattributed SQL has a zero budget.", "",
    "| Scenario | Operation | Metric | Before | After | Ceiling | Ratchet |",
    "| --- | --- | --- | ---: | ---: | ---: | --- |",
    ...rows.map(row => `| ${row.scenario} | ${row.operation} | ${row.metric} | ${row.before} | ${row.observed} | ${row.baseline} | ${row.ratchet} |`), ""].join("\n");
}

export function renderRouteComparison(before: LoadReport, after: LoadReport): string {
  const costs = (report: LoadReport) => {
    const result = new Map<string, { scenario: string; route: string; requests: number; statements: number; transactions: number; githubCalls: number; workspaceUpdateLocks: number }>();
    for (const value of report.scenarios) {
      const scenario = value as { name: string; routes: Array<Record<string, unknown>>; background: Record<string, unknown> };
      if (!scenario || typeof scenario.name !== "string" || !/^[a-z0-9-]+$/.test(scenario.name) || !Array.isArray(scenario.routes)) throw new Error("Invalid route measurement");
      if (["turn-lease", "running-stream", "periodic-renewals"].includes(scenario.name)) continue;
      for (const row of [...scenario.routes, { ...scenario.background, method: "", route: "background", requests: 0 }]) {
        const route = `${row.method} ${row.route}`.trim();
        if (!/^(?:GET|POST) \/[a-zA-Z0-9/:_-]+$|^background$/.test(route)) throw new Error("Invalid route measurement");
        const count = (metric: string) => { if (!integer(row[metric])) throw new Error("Invalid route count"); return row[metric]; };
        const id = `${scenario.name}:${route}`, prior = result.get(id);
        result.set(id, { scenario: scenario.name, route, requests: count("requests") + (prior?.requests ?? 0), statements: count("statements") + (prior?.statements ?? 0),
          transactions: count("transactions") + (prior?.transactions ?? 0), githubCalls: count("githubCalls") + (prior?.githubCalls ?? 0),
          workspaceUpdateLocks: count("workspaceUpdateLocks") + (prior?.workspaceUpdateLocks ?? 0) });
      }
    }
    return result;
  };
  const first = costs(before), second = costs(after), lines: string[] = [];
  for (const id of new Set([...first.keys(), ...second.keys()])) {
    const left = first.get(id), right = second.get(id), label = right ?? left!;
    const metrics = ["requests", "statements", "transactions", "githubCalls", "workspaceUpdateLocks"] as const;
    if (metrics.every(metric => (left?.[metric] ?? 0) === (right?.[metric] ?? 0))) continue;
    lines.push(`| ${label.scenario} | ${label.route} | ${metrics.map(metric => `${left?.[metric] ?? 0} → ${right?.[metric] ?? 0}`).join(" | ")} |`);
  }
  if (!lines.length) return "\nPer-route counts are unchanged. Full route tables are in before.json and after.json.\n";
  return ["", "Changed route totals (before → after):", "",
    "| Scenario | Route | Requests | SQL statements | Transactions | GitHub calls | Workspace update locks |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |", ...lines, ""].join("\n");
}

async function command(executable: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", () => reject(new Error("Load comparison command unavailable")));
    child.once("close", code => code === 0 ? resolveCommand(output.trim()) : reject(new Error("Load comparison Git or dependency check failed")));
  });
}

async function runSuite(root: string, report: string, log: string, databaseUrl: string): Promise<void> {
  const output = await open(log, "wx", 0o600);
  try {
    const result = await new Promise<number | null>((resolveRun, reject) => {
      const child = spawn(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "src/load-budget.integration.test.ts",
        "--maxWorkers=2", "-t", "load-budget workload"], { cwd: join(root, "apps/control-plane"),
        env: { ...process.env, TEST_DATABASE_URL: databaseUrl, CLOUD_API_TEST_CLIENT_ROOT: pathToFileURL(`${root}/`).href, LOAD_BUDGET_REPORT_PATH: report },
        detached: true, stdio: ["ignore", output.fd, output.fd] });
      let stopped = false, kill: ReturnType<typeof setTimeout> | undefined;
      const signal = (value: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, value); } catch { /* Already exited. */ } } };
      const stop = () => { stopped = true; signal("SIGTERM"); kill ??= setTimeout(() => signal("SIGKILL"), 5000); };
      const deadline = setTimeout(stop, 720_000);
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      const cleanup = () => { clearTimeout(deadline); clearTimeout(kill); process.off("SIGINT", stop); process.off("SIGTERM", stop); };
      child.once("error", () => reject(new Error("Load comparison test process unavailable")));
      child.once("close", code => { cleanup(); resolveRun(stopped ? 1 : code); });
    });
    if (result !== 0) throw new Error("Load comparison workload failed; inspect its retained log");
  } finally { await output.close(); }
}

async function linkDependencies(root: string, checkout: string, path: string): Promise<void> {
  const source = join(root, path), target = join(checkout, path);
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".cache" || entry.name === ".vite") continue;
    if (entry.name.startsWith("@")) { await linkDependencies(root, checkout, join(path, entry.name)); continue; }
    const installed = await realpath(join(source, entry.name)), local = relative(root, installed);
    const destination = /^(packages|apps)\//.test(local) && !local.split("/").includes("node_modules") ? join(checkout, local) : installed;
    await symlink(destination, join(target, entry.name), entry.isDirectory() ? "dir" : "file");
  }
}

export async function compareRevisions(options: { cwd: string; base: string; head: string; output?: string;
  execute?: (checkout: string, report: string, log: string) => Promise<void> }): Promise<{ markdown: string; directory: string; passed: boolean }> {
  if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to an owned local test database; the suite resets it");
  let databaseUrl: string | undefined;
  try {
    const address = new URL(process.env.TEST_DATABASE_URL);
    if (["postgres:", "postgresql:"].includes(address.protocol) && !address.search && !address.hash &&
        /^\/(?:postgres|test|test_[a-z0-9_]+|[a-z0-9_]+_tests?)$/i.test(address.pathname)) {
      if (address.hostname === "localhost") {
        const resolved = await lookup("localhost", { all: true });
        if (resolved.length && resolved.every(value => value.address === "127.0.0.1" || value.address === "::1"))
          address.hostname = resolved.some(value => value.address === "127.0.0.1") ? "127.0.0.1" : "[::1]";
      }
      if (["127.0.0.1", "[::1]"].includes(address.hostname)) databaseUrl = address.href;
    }
  } catch { /* Report a closed reason without the connection string. */ }
  if (!databaseUrl) throw new Error("Load comparison requires a local test database named postgres, test, test_* or *_test, without URL overrides");
  const root = await command("git", ["rev-parse", "--show-toplevel"], options.cwd);
  const git = (args: string[]) => command("git", args, root);
  const base = await git(["rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`]);
  const head = await git(["rev-parse", "--verify", "--end-of-options", `${options.head}^{commit}`]);
  const previousSource = await git(["show", `${base}:${LOAD_BUDGET_SOURCE}`]);
  const candidateSource = await git(["show", `${head}:${LOAD_BUDGET_SOURCE}`]);
  const previous = readBudgetDefinitions(previousSource), candidate = readBudgetDefinitions(candidateSource);
  const previousBackground = readBackgroundDefinitions(previousSource), candidateBackground = readBackgroundDefinitions(candidateSource);
  assertBaselineRatchet(previous, candidate);
  assertBackgroundRatchet(previousBackground, candidateBackground);
  const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const harness = await Promise.all(LOAD_HARNESS_FILES.map(async path => ({ path, content: await readFile(join(harnessRoot, path), "utf8") })));
  const definitions = readBudgetDefinitions(harness.find(file => file.path === LOAD_BUDGET_SOURCE)!.content);
  const backgroundDefinitions = readBackgroundDefinitions(harness.find(file => file.path === LOAD_BUDGET_SOURCE)!.content);
  const backgroundLimits = backgroundDefinitions.map(row => candidateBackground.find(value => value.operation === row.operation) ?? row);
  assertBackgroundRatchet(previousBackground, backgroundLimits);
  // A newer harness can add measurements to an older revision. Its new rows
  // use their first recorded ceilings; existing rows use the candidate's.
  const limits = definitions.map(row => candidate.find(value => key(value) === key(row)) ?? row);
  assertBaselineRatchet(previous, limits);
  for (const path of ["pnpm-lock.yaml", "apps/control-plane/pnpm-lock.yaml"]) {
    const installed = await readFile(join(root, path), "utf8");
    for (const revision of [base, head]) if (await git(["show", `${revision}:${path}`]) !== installed.trim())
      throw new Error("Load comparison needs identical installed dependency locks on both revisions");
  }
  const parent = options.output ? resolve(options.output) : join(root, ".context");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "load-budget-comparison-"));
  const harnessSha256 = createHash("sha256").update(JSON.stringify(harness)).digest("hex");
  await writeFile(join(directory, "source.json"), JSON.stringify({ base, head, node: process.version, harnessSha256 }, null, 2) + "\n", { flag: "wx" });
  const samples: LoadReport[] = [];
  for (const [side, revision] of [["before", base], ["after", head]] as const) {
    const checkout = join(directory, side), reportPath = join(directory, `${side}.json`);
    await git(["worktree", "add", "--quiet", "--detach", checkout, revision]);
    try {
      for (const file of harness) {
        await mkdir(dirname(join(checkout, file.path)), { recursive: true });
        await writeFile(join(checkout, file.path), file.content);
      }
      // Workspace package links must resolve inside each revision too. Sharing
      // an entire node_modules would silently load the caller's protocol tree.
      for (const path of ["node_modules", "apps/control-plane/node_modules", "apps/cloud-worker/node_modules", "packages/protocol/node_modules"])
        await linkDependencies(root, checkout, path);
      if (options.execute) await options.execute(checkout, reportPath, join(directory, `${side}.log`));
      else await runSuite(checkout, reportPath, join(directory, `${side}.log`), databaseUrl);
      samples.push(JSON.parse(await readFile(reportPath, "utf8")) as LoadReport);
    } finally { await git(["worktree", "remove", "--force", checkout]); }
  }
  const rows = compareReports(samples[0]!, samples[1]!, limits);
  const background = compareBackground(samples[0]!, samples[1]!, backgroundLimits);
  const markdown = renderComparison(rows, base, head) + renderBackground(background) + renderRouteComparison(samples[0]!, samples[1]!);
  await writeFile(join(directory, "comparison.md"), markdown, { flag: "wx" });
  await writeFile(join(directory, "comparison.json"), JSON.stringify(rows, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(directory, "background.json"), JSON.stringify(background, null, 2) + "\n", { flag: "wx" });
  return { markdown, directory, passed: [...rows, ...background].every(row => row.ratchet === "PASS") };
}

async function main(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.info("TEST_DATABASE_URL=<local test database> node --import tsx apps/control-plane/src/test-support/load-budget-report.ts --base origin/main --head HEAD [--output .context]\nRuns both revisions serially with the same harness; the test database is reset. Optional LOAD_BUDGET_WALL_CLOCK=1, LOAD_BUDGET_WALL_PROFILE=r1 (default observed), and LOAD_BUDGET_STATEMENT_DELAY_MS=5 apply to both.");
    return;
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!, value = args[index + 1];
    if (!["--base", "--head", "--output"].includes(flag) || !value || flags.has(flag)) throw new Error("Invalid load comparison arguments; use --help");
    flags.set(flag, value);
  }
  const result = await compareRevisions({ cwd: process.cwd(), base: flags.get("--base") ?? "origin/main", head: flags.get("--head") ?? "HEAD",
    ...(flags.has("--output") ? { output: flags.get("--output")! } : {}) });
  console.info(result.markdown);
  console.info(`Evidence: ${result.directory}`);
  if (!result.passed) { console.error("Load ratchet failed; lower the measured cost, never raise the baseline."); process.exitCode = 1; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main(process.argv.slice(2)).catch(error => {
    const message = error instanceof Error && /^(Load |Invalid load |Set TEST_DATABASE_URL)/.test(error.message) ? error.message : "Load comparison failed; inspect retained evidence";
    console.error(message); process.exitCode = 1;
  });
}
