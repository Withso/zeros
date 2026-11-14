import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBackgroundRatchet, assertBaselineRatchet, compareBackground, compareReports, compareRevisions, LOAD_BUDGET_SOURCE, readBackgroundDefinitions, readBudgetDefinitions, renderCensus, renderComparison, renderRouteComparison } from "./load-budget-report.js";
import type { BackgroundDefinition } from "./load-budget.js";
import { CENSUS_CAPTURE, CENSUS_PROFILES } from "./load-budget-census.js";

const definitions = [{ phase: "R1", scenario: "workspace-list", metric: "transactions", baseline: 10, maximum: 3, expectedFailure: true }] as const;
const report = (observed: number, baseline = 10) => ({ version: 1 as const, profile: "load-budget-r1", wallClock: false, statementDelayMs: 0,
  budgets: [{ ...definitions[0], baseline, observed }], scenarios: [] });
const backgroundReport = (limits: readonly BackgroundDefinition[], names = ["idle", "r1-fallback-idle"]) => ({
  scenarios: names.map(name => ({ name, elapsedMs: 5000, routes: [],
    background: { requests: 0, statements: 0, transactions: 0, githubCalls: 0, workspaceUpdateLocks: 0 } })),
  backgroundBudgets: names.flatMap(scenario => [
    ...limits.flatMap(limit => ["calls", "queriesPerCall", "statementsPerCall", "transactionsPerCall"].map(metric =>
      ({ scenario, operation: limit.operation, metric, observed: 0, baseline: 0, ratchet: "PASS" as const }))),
    ...["queries", "statements", "transactions", "githubCalls", "failures", "inFlight"].map(metric =>
      ({ scenario, operation: "unattributed", metric, observed: 0, baseline: 0, ratchet: "PASS" as const })),
  ]),
});

describe("load comparison ratchet", () => {
  it("reads literal budgets without evaluating a revision's JavaScript", () => {
    const text = `throw new Error('must not execute'); export const LOAD_BUDGETS = ${JSON.stringify(definitions)} as const;`;
    expect(readBudgetDefinitions(text)).toEqual(definitions);
    expect(() => readBudgetDefinitions("export const LOAD_BUDGETS = arbitraryCode();")).toThrow("literal");
    expect(() => readBudgetDefinitions("export const LOAD_BUDGETS = [{ ...other }];")).toThrow("literal");
    expect(() => readBudgetDefinitions(`export const LOAD_BUDGETS = ${JSON.stringify([...definitions, ...definitions])};`)).toThrow("Duplicate");
  });

  it("allows a lower baseline and target promotion, but rejects increases, removals and reopened targets", () => {
    expect(() => assertBaselineRatchet(definitions, [{ ...definitions[0], baseline: 3, expectedFailure: false }])).not.toThrow();
    expect(() => assertBaselineRatchet(definitions, [{ ...definitions[0], baseline: 11 }])).toThrow("baseline increased");
    expect(() => assertBaselineRatchet(definitions, [])).toThrow("budget removed");
    expect(() => assertBaselineRatchet(definitions, [{ ...definitions[0], maximum: 4 }])).toThrow("target increased");
    expect(() => assertBaselineRatchet([{ ...definitions[0], expectedFailure: false }], definitions)).toThrow("target reopened");
  });

  it("reports actual measurements and checks the candidate against its recorded ceiling", () => {
    const compared = compareReports(report(10), report(3, 3), [{ ...definitions[0], baseline: 3, expectedFailure: false }]);
    expect(compared).toMatchObject([{ before: 10, after: 3, delta: -7, ratchet: "PASS", target: "PASS" }]);
    expect(renderComparison(compared, "a".repeat(40), "b".repeat(40))).toContain("| R1 | workspace-list | transactions | 10 | 3 | -7 | 3 | 3 | 3 | PASS | PASS |");
    expect(compareReports(report(10), report(11), definitions)[0]?.ratchet).toBe("FAIL");
  });

  it("uses the full SQL observation for the target even when the request ratchet passes", () => {
    const after = { ...report(3, 3), budgets: [{ ...definitions[0], observed: 3, targetObserved: 5 }] };
    expect(compareReports(report(10), after, [{ ...definitions[0], baseline: 3 }]))
      .toMatchObject([{ after: 3, ratchet: "PASS", targetObserved: 5, target: "FAIL" }]);
  });

  it("pins background call costs and timer rates without executing revision code", () => {
    const limits = [{ operation: "authority", initialCalls: 1, periodsMs: [5000], queries: 3, statements: 5, transactions: 1 }];
    const source = `throw new Error('must not execute'); export const LOAD_BACKGROUND_BUDGETS = ${JSON.stringify(limits)} as const;`;
    expect(readBackgroundDefinitions(source)).toEqual(limits);
    expect(readBackgroundDefinitions("export const LOAD_BUDGETS = [];")).toEqual([]);
    expect(() => readBackgroundDefinitions(source.replace("[5000]", "[0]"))).toThrow("Invalid background budget");
    expect(() => assertBackgroundRatchet(limits, [{ ...limits[0]!, statements: 6 }])).toThrow("ceiling increased");
    expect(() => assertBackgroundRatchet(limits, [{ ...limits[0]!, initialCalls: 2 }])).toThrow("ceiling increased");
    expect(() => assertBackgroundRatchet(limits, [{ ...limits[0]!, periodsMs: [4000] }])).toThrow("ceiling increased");
    expect(() => assertBackgroundRatchet(limits, [])).toThrow("budget removed");
    expect(() => assertBackgroundRatchet(limits, [{ ...limits[0]!, statements: 4, periodsMs: [10000] }])).not.toThrow();
    const before = { ...report(3), ...backgroundReport(limits) };
    const after = structuredClone(before);
    after.backgroundBudgets.find(row => row.scenario === "idle" && row.metric === "calls")!.observed = 2;
    expect(compareBackground(before, after, limits).every(row => row.ratchet === "PASS")).toBe(true);
    after.backgroundBudgets.find(row => row.scenario === "idle" && row.metric === "calls")!.observed = 3;
    expect(compareBackground(before, after, limits).filter(row => row.ratchet === "FAIL"))
      .toMatchObject([{ scenario: "idle", metric: "calls", observed: 3, baseline: 2 }]);
    after.backgroundBudgets.find(row => row.scenario === "idle" && row.metric === "statementsPerCall")!.observed = 6;
    expect(compareBackground(before, after, limits).filter(row => row.ratchet === "FAIL")).toHaveLength(2);
    expect(() => compareBackground(before, { ...after, backgroundBudgets: [] }, limits)).toThrow("Incomplete");
  });

  it("rejects incomplete, duplicate, incomparable or nonnumeric observations", () => {
    expect(() => compareReports(report(10), { ...report(3), budgets: [] }, definitions)).toThrow("Missing");
    expect(() => compareReports(report(10), { ...report(3), budgets: [...report(3).budgets, ...report(3).budgets] }, definitions)).toThrow("Duplicate");
    expect(() => compareReports(report(10), report(Number.NaN), definitions)).toThrow("Invalid");
    expect(() => compareReports(report(10), { ...report(3), wallClock: true }, definitions)).toThrow("profiles differ");
    expect(() => compareReports(report(10), { ...report(3), statementDelayMs: 5 }, definitions)).toThrow("profiles differ");
  });

  it("requires matching census provenance and prints assumptions separately from measurements", () => {
    const budgets = [{ phase: "R1", scenario: "census-connected", metric: "requests", baseline: 41, maximum: 10, expectedFailure: true }];
    const captured = { ...report(41), census: CENSUS_CAPTURE, budgets: budgets.map(row => ({ ...row, observed: 41 })) };
    expect(compareReports(captured, captured, budgets)).toMatchObject([{ before: 41, after: 41, ratchet: "PASS", target: "FAIL" }]);
    expect(() => compareReports({ ...captured, census: undefined }, captured, budgets)).toThrow("profiles differ");
    expect(() => compareReports({ ...captured, census: undefined }, { ...captured, census: undefined }, budgets)).toThrow("provenance");
    const text = renderCensus(captured);
    expect(text).toContain("assumed bodies");
    expect(text).toContain("POST /v2/cloud/worker/prompts/pull | unknown | 12 | no");
    expect(text).toContain("GET /v1/release-identity | unknown | 4 | no");
    expect(text).toContain("messages.windowOlder");
    expect(text).toContain("gh.prSync");
    expect(text).toContain(CENSUS_CAPTURE.sourceSha256);
  });

  it("prints changed per-route counts, retaining background lock costs", () => {
    const counts = { requests: 0, statements: 0, transactions: 0, githubCalls: 0, workspaceUpdateLocks: 0 };
    const first = { ...report(10), scenarios: [{ name: "r1-fallback-idle", background: counts,
      routes: [{ ...counts, method: "GET", route: "/v1/cloud-v2/workspaces", requests: 5, statements: 200, transactions: 50 }] },
    { name: "read-frame", routes: [], background: { ...counts, workspaceUpdateLocks: 1 } }] };
    const second = { ...report(3), scenarios: [{ name: "r1-fallback-idle", background: counts,
      routes: [{ ...counts, method: "GET", route: "/v1/cloud-v2/workspaces", requests: 5, statements: 60, transactions: 15 }] },
    { name: "read-frame", routes: [], background: counts }] };
    const text = renderRouteComparison(first, second);
    expect(text).toContain("| r1-fallback-idle | GET /v1/cloud-v2/workspaces | 5 → 5 | 200 → 60 | 50 → 15 |");
    expect(text).toContain("| read-frame | background | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 1 → 0 |");
  });
});

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), "load-budget-report-")); directories.push(directory);
  const git = async (...args: string[]) => (await exec("git", ["-C", directory, ...args])).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.test");
  for (const path of ["apps/control-plane/src/test-support", "apps/cloud-worker/node_modules", "apps/control-plane/node_modules", "packages/protocol/node_modules", "node_modules/@zeros"])
    await mkdir(join(directory, path), { recursive: true });
  await symlink(join(directory, "packages/protocol"), join(directory, "node_modules/@zeros/protocol"), "dir");
  await writeFile(join(directory, ".gitignore"), "node_modules/\n.context/\n");
  await writeFile(join(directory, "pnpm-lock.yaml"), "fixture-lock\n");
  await writeFile(join(directory, "apps/control-plane/pnpm-lock.yaml"), "fixture-lock\n");
  await writeFile(join(directory, LOAD_BUDGET_SOURCE), `export const LOAD_BUDGETS = ${JSON.stringify(definitions)} as const;\n`);
  await writeFile(join(directory, "cost.txt"), "10");
  await writeFile(join(directory, "packages/protocol/package.json"), JSON.stringify({ name: "@zeros/protocol", cost: 10 }));
  await writeFile(join(directory, "read-package.cjs"), 'process.stdout.write(String(require("@zeros/protocol/package.json").cost));');
  await git("add", "."); await git("commit", "-qm", "fixture before");
  const base = await git("rev-parse", "HEAD");
  await writeFile(join(directory, "cost.txt"), "3");
  await writeFile(join(directory, "packages/protocol/package.json"), JSON.stringify({ name: "@zeros/protocol", cost: 3 }));
  await git("add", "."); await git("commit", "-qm", "fixture after");
  return { directory, git, base, head: await git("rev-parse", "HEAD") };
}

describe("before/after command isolation", () => {
  it("pins both Git trees, overlays the same harness and preserves the caller's dirty checkout", async () => {
    const repo = await repository();
    vi.stubEnv("TEST_DATABASE_URL", "postgres://fixture@127.0.0.1/owned_test");
    await writeFile(join(repo.directory, "cost.txt"), "caller-edit");
    const source = fileURLToPath(new URL("./load-budget.ts", import.meta.url));
    const shared = readBudgetDefinitions(await readFile(source, "utf8"));
    const background = readBackgroundDefinitions(await readFile(source, "utf8"));
    const visits: string[] = [], overlays: string[] = [];
    let running = false;
    const result = await compareRevisions({ cwd: repo.directory, base: repo.base, head: repo.head,
      execute: async (checkout, path) => {
        expect(running).toBe(false); running = true;
        const value = Number(await readFile(join(checkout, "cost.txt"), "utf8")); visits.push(String(value));
        expect((await exec(process.execPath, [join(checkout, "read-package.cjs")], { cwd: checkout })).stdout).toBe(String(value));
        overlays.push(await readFile(join(checkout, LOAD_BUDGET_SOURCE), "utf8"));
        await writeFile(path, JSON.stringify({ ...report(value), census: CENSUS_CAPTURE,
          ...backgroundReport(background, ["idle", "r1-fallback-idle", ...CENSUS_PROFILES.map(profile => profile.name)]), budgets: shared.map(row => ({ ...row,
          observed: row.scenario === "workspace-list" ? value : row.baseline })) }));
        running = false;
      } });
    expect(result.passed).toBe(true);
    expect(visits).toEqual(["10", "3"]);
    expect(overlays[0]).toBe(overlays[1]);
    expect(result.markdown).toContain("| workspace-list | transactions | 10 | 3 | -7 |");
    expect(await repo.git("rev-parse", "HEAD")).toBe(repo.head);
    expect(await readFile(join(repo.directory, "cost.txt"), "utf8")).toBe("caller-edit");
    expect((await repo.git("worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
  });

  it("refuses a raised recorded number before any workload and cleans up an unsuccessful workload", async () => {
    const repo = await repository(), execute = vi.fn(async () => { throw new Error("synthetic setup failed"); });
    vi.stubEnv("TEST_DATABASE_URL", "postgres://fixture@127.0.0.1/owned_test");
    await expect(compareRevisions({ cwd: repo.directory, base: repo.base, head: repo.head, execute })).rejects.toThrow("synthetic setup failed");
    expect((await repo.git("worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
    execute.mockClear();
    await writeFile(join(repo.directory, LOAD_BUDGET_SOURCE), `export const LOAD_BUDGETS = ${JSON.stringify([{ ...definitions[0], baseline: 11 }])};`);
    await repo.git("add", "."); await repo.git("commit", "-qm", "fixture forbidden baseline");
    await expect(compareRevisions({ cwd: repo.directory, base: repo.base, head: "HEAD", execute })).rejects.toThrow("baseline increased");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects effective-host overrides and non-test databases before running either revision", async () => {
    const repo = await repository(), execute = vi.fn(async () => { throw new Error("workload must not run"); });
    for (const url of ["postgres://fixture@127.0.0.1/owned_test?host=example.test", "postgres://fixture@127.0.0.1/customer_data",
      "postgres://fixture@example.test/owned_test", "postgres://fixture@127.0.0.1/owned_test#ignored"]) {
      vi.stubEnv("TEST_DATABASE_URL", url);
      await expect(compareRevisions({ cwd: repo.directory, base: repo.base, head: repo.head, execute })).rejects.toThrow("local test database");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("starts the documented Node/tsx executable on Node 22 too, without node -e imports", async () => {
    const script = fileURLToPath(new URL("./load-budget-report.ts", import.meta.url));
    const result = await exec(process.execPath, ["--import", "tsx", script, "--help"], { cwd: dirname(script) });
    expect(result.stdout).toContain("--base origin/main --head HEAD");
    expect(result.stderr).toBe("");
  });
});
