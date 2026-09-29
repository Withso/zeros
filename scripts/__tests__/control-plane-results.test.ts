// `control plane` is the one required check for the sharded control-plane
// jobs. Its old skip-guard re-ran the migration file to prove the DB suites were
// not silently skipped; the aggregate now proves that from the shards' reports.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  databaseBackedTestFiles,
  enforceControlPlaneResults,
  listControlPlaneTestFiles,
  readShardReports,
} from "../ci/control-plane-results.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RESULTS = path.join(ROOT, "scripts/ci/control-plane-results.mjs");
const CHECKOUT = "/home/runner/work/zeros/zeros/apps/control-plane";

type Status = "passed" | "failed" | "skipped" | "pending" | "todo";
type Test = { suite: string; title: string; status: Status };

const testFiles = [
  "src/auth.test.ts",
  "src/migrations.test.ts",
  "src/routes.integration.test.ts",
];
const databaseFiles = new Set(["src/migrations.test.ts", "src/routes.integration.test.ts"]);

function fileResult(file: string, tests: Test[]) {
  return {
    name: `${CHECKOUT}/${file}`,
    status: tests.some((test) => test.status === "failed") ? "failed" : "passed",
    message: "",
    startTime: 1_000,
    endTime: 3_000,
    assertionResults: tests.map((test) => ({
      ancestorTitles: [test.suite],
      fullName: `${test.suite} ${test.title}`,
      title: test.title,
      status: test.status,
    })),
  };
}

function report(...results: ReturnType<typeof fileResult>[]) {
  const tests = results.flatMap((result) => result.assertionResults);
  return {
    numTotalTests: tests.length,
    numPassedTests: tests.filter((test) => test.status === "passed").length,
    success: results.every((result) => result.status === "passed"),
    testResults: results,
  };
}

/** The shape a run with a reachable database produces. */
function passingReports(status: Status = "passed") {
  return new Map([
    [1, report(fileResult("src/auth.test.ts", [{ suite: "auth", title: "rejects", status: "passed" }]))],
    [
      2,
      report(
        fileResult("src/migrations.test.ts", [
          { suite: "cloud migration regression contracts", title: "is static", status: "passed" },
          { suite: "migration ladder", title: "replays from every intermediate revision", status },
        ]),
        fileResult("src/routes.integration.test.ts", [{ suite: "routes", title: "signs up", status }]),
      ),
    ],
  ]);
}

const databaseRun = {
  SCOPE_RESULT: "success",
  DATABASE_SCOPE: "true",
  STATIC_RESULT: "success",
  DATABASE_RESULT: "success",
  DATABASE_SHARDS: "2",
};

const enforce = (env: Record<string, string>, reports = passingReports()) =>
  enforceControlPlaneResults({ env, reports, testFiles, databaseFiles });

describe("control-plane results", () => {
  it("accepts every shard passing with its database suites executed", () => {
    expect(enforce(databaseRun)).toEqual([]);
  });

  it("rejects a green run whose database suites all skipped", () => {
    const problems = enforce(databaseRun, passingReports("skipped"));
    expect(problems).toContain(
      'src/routes.integration.test.ts did not run 1 database-backed test, for example "routes signs up" (skipped).',
    );
    expect(problems.join("\n")).toMatch(/No "migration ladder" test passed/);
  });

  it.each(["pending", "todo"] as const)("rejects a %s database-backed test", (status) => {
    expect(enforce(databaseRun, passingReports(status))).not.toEqual([]);
  });

  it("allows a skipped test only in a file that never reads TEST_DATABASE_URL", () => {
    const reports = passingReports();
    reports.set(1, report(fileResult("src/auth.test.ts", [{ suite: "auth", title: "on win32", status: "skipped" }])));
    expect(enforce(databaseRun, reports)).toEqual([]);
  });

  it("rejects failures, lost shards, and files run twice or never", () => {
    const failed = passingReports();
    failed.set(1, report(fileResult("src/auth.test.ts", [{ suite: "auth", title: "rejects", status: "failed" }])));
    expect(enforce({ ...databaseRun, DATABASE_RESULT: "failure" }, failed)).toEqual([
      "Database shards were failure.",
      "src/auth.test.ts failed",
      "src/auth.test.ts › auth rejects failed.",
    ]);

    const lost = passingReports();
    lost.delete(1);
    expect(enforce(databaseRun, lost)).toEqual([
      "Shard 1/2 uploaded no Vitest report.",
      "src/auth.test.ts was not run by any shard.",
    ]);

    const twice = passingReports();
    twice.set(1, report(
      fileResult("src/auth.test.ts", [{ suite: "auth", title: "rejects", status: "passed" }]),
      fileResult("src/routes.integration.test.ts", [{ suite: "routes", title: "signs up", status: "passed" }]),
    ));
    expect(enforce(databaseRun, twice)).toEqual([
      "src/routes.integration.test.ts was run by shards 1, 2.",
    ]);
  });

  it("requires the scope decision and the typecheck and audit to pass", () => {
    expect(enforce({ ...databaseRun, STATIC_RESULT: "failure" })).toEqual([
      "Typecheck and audit were failure.",
    ]);
    expect(enforce({ ...databaseRun, SCOPE_RESULT: "failure", DATABASE_SCOPE: "" })).toEqual([
      "The scope decision was failure.",
      "The database scope was missing.",
    ]);
    expect(enforce({ ...databaseRun, DATABASE_RESULT: "cancelled" })).toEqual([
      "Database shards were cancelled.",
    ]);
  });

  it("passes an unchanged scope only when the shards were skipped", () => {
    const outOfScope = { ...databaseRun, DATABASE_SCOPE: "false", DATABASE_RESULT: "skipped" };
    expect(enforce(outOfScope, new Map())).toEqual([]);
    expect(enforce({ ...outOfScope, DATABASE_RESULT: "failure" }, new Map())).toEqual([
      "Database suites were out of scope but failure.",
    ]);
  });

  it("classifies the real control-plane files", () => {
    const files = listControlPlaneTestFiles();
    const database = databaseBackedTestFiles(files);
    expect(files).toContain("src/migrations.test.ts");
    expect(files).toContain("src/cloud-workspaces/reconciler.integration.test.ts");
    expect(database.has("src/migrations.test.ts")).toBe(true);
    expect(database.has("src/test-database.integration.test.ts")).toBe(true);
    expect(database.has("src/auth.test.ts")).toBe(false);
  });
});

describe("control-plane results command", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails the required check when TEST_DATABASE_URL never reached the suites", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "control-plane-results-"));
    directories.push(directory);
    // Every real file is reported and green, but each DB-backed test skipped.
    const files = listControlPlaneTestFiles();
    const database = databaseBackedTestFiles(files);
    writeFileSync(
      path.join(directory, "shard-1.json"),
      JSON.stringify(report(...files.map((file) => fileResult(file, [{
        suite: file === "src/migrations.test.ts" ? "migration ladder" : "suite",
        title: "runs",
        status: database.has(file) ? "skipped" : "passed",
      }])))),
    );
    expect(readShardReports(directory).size).toBe(1);

    const result = spawnSync(process.execPath, [RESULTS, directory], {
      encoding: "utf8",
      env: { ...process.env, ...databaseRun, DATABASE_SHARDS: "1", GITHUB_STEP_SUMMARY: "" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '::error::src/migrations.test.ts did not run 1 database-backed test, for example "migration ladder runs" (skipped).',
    );
    // One annotation per file, not one per skipped test.
    expect(result.stderr.split("\n").filter((line) => line.startsWith("::error::")).length)
      .toBe(database.size + 1);
  });
});
