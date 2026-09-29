#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// control-plane-results — the single required `control plane` verdict
// ──────────────────────────────────────────────────────────
//
// Branch protection requires one check named `control plane`. Its work runs in
// separate jobs: an always-on typecheck and audit, a scope decision, and the
// database suites split across shards that each own a Postgres service. This
// script turns those job results and the shards' Vitest JSON reports into one
// verdict, so a failed, cancelled or missing shard can never read as green.
//
// It also replaces the old skip-guard, which re-ran the whole migration file
// only to count its passes. When TEST_DATABASE_URL does not reach the suites,
// every DB-backed describe skips and Vitest still exits 0. The reports from the
// only run already hold the evidence, so a database run must show:
//   - every control-plane test file reported by exactly one shard;
//   - no failed test or file;
//   - no skipped, pending or todo test in a file that reads TEST_DATABASE_URL;
//   - a passing test in the migration ladder, which executes the real SQL.
//
// Usage: node scripts/ci/control-plane-results.mjs <reports-dir>
// Environment: SCOPE_RESULT, DATABASE_SCOPE, STATIC_RESULT, DATABASE_RESULT
// (GitHub job results), and DATABASE_SHARDS (the shard count).
// ──────────────────────────────────────────────────────────

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../apps/control-plane",
);
const MIGRATION_LADDER = { file: "src/migrations.test.ts", suite: "migration ladder" };
const NOT_RUN = new Set(["skipped", "pending", "todo"]);

/** Package-relative test files, matching vitest.config.ts `src/**\/*.test.ts`. */
export function listControlPlaneTestFiles(packageDir = PACKAGE_DIR) {
  return readdirSync(path.join(packageDir, "src"), { recursive: true })
    .map((file) => `src/${String(file).split(path.sep).join("/")}`)
    .filter((file) => file.endsWith(".test.ts"))
    .sort();
}

export function databaseBackedTestFiles(files, packageDir = PACKAGE_DIR) {
  return new Set(
    files.filter((file) =>
      readFileSync(path.join(packageDir, file), "utf8").includes(
        "TEST_DATABASE_URL",
      ),
    ),
  );
}

/** Shard number → parsed report, from `shard-<n>.json` files. */
export function readShardReports(directory) {
  const reports = new Map();
  if (!existsSync(directory)) return reports;
  for (const name of readdirSync(directory)) {
    const shard = /^shard-(\d+)\.json$/.exec(name)?.[1];
    if (!shard) continue;
    try {
      reports.set(
        Number(shard),
        JSON.parse(readFileSync(path.join(directory, name), "utf8")),
      );
    } catch (error) {
      reports.set(Number(shard), { unreadable: String(error) });
    }
  }
  return reports;
}

function relativeTestFile(name) {
  const normalized = String(name).split("\\").join("/");
  const marker = "/apps/control-plane/";
  const index = normalized.lastIndexOf(marker);
  return index >= 0 ? normalized.slice(index + marker.length) : normalized;
}

export function validateShardReports({ reports, shards, testFiles, databaseFiles }) {
  const problems = [];
  const reportedBy = new Map();
  let ladderPassed = false;

  for (let shard = 1; shard <= shards; shard += 1) {
    const report = reports.get(shard);
    if (!report) {
      problems.push(`Shard ${shard}/${shards} uploaded no Vitest report.`);
      continue;
    }
    if (report.unreadable || !Array.isArray(report.testResults)) {
      problems.push(`Shard ${shard}/${shards} report is unreadable.`);
      continue;
    }
    if (report.testResults.length === 0) {
      problems.push(`Shard ${shard}/${shards} ran no test files.`);
    }
    for (const result of report.testResults) {
      const file = relativeTestFile(result.name);
      reportedBy.set(file, [...(reportedBy.get(file) ?? []), shard]);
      if (result.status !== "passed") {
        problems.push(`${file} ${result.status}${result.message ? `: ${result.message}` : ""}`);
      }
      const notRun = [];
      for (const test of result.assertionResults ?? []) {
        if (test.status === "failed") {
          problems.push(`${file} › ${test.fullName} failed.`);
        } else if (NOT_RUN.has(test.status) && databaseFiles.has(file)) {
          notRun.push(test);
        }
        if (
          file === MIGRATION_LADDER.file &&
          test.ancestorTitles?.[0] === MIGRATION_LADDER.suite &&
          test.status === "passed"
        ) {
          ladderPassed = true;
        }
      }
      if (notRun.length) {
        problems.push(
          `${file} did not run ${notRun.length} database-backed ${notRun.length === 1 ? "test" : "tests"}, ` +
            `for example "${notRun[0].fullName}" (${notRun[0].status}).`,
        );
      }
    }
  }
  if (problems.length === 0 && reports.size > shards) {
    problems.push(`Found ${reports.size} shard reports for ${shards} shards.`);
  }

  for (const file of testFiles) {
    const owners = reportedBy.get(file) ?? [];
    if (owners.length === 0) {
      problems.push(`${file} was not run by any shard.`);
    } else if (owners.length > 1) {
      problems.push(`${file} was run by shards ${owners.join(", ")}.`);
    }
  }
  for (const file of reportedBy.keys()) {
    if (!testFiles.includes(file)) problems.push(`${file} is not a known test file.`);
  }
  if (!ladderPassed) {
    problems.push(
      `No "${MIGRATION_LADDER.suite}" test passed in ${MIGRATION_LADDER.file}, so the database suites did not run.`,
    );
  }
  return problems;
}

export function enforceControlPlaneResults({ env, reports, testFiles, databaseFiles }) {
  const problems = [];
  if (env.SCOPE_RESULT !== "success") {
    problems.push(`The scope decision was ${env.SCOPE_RESULT || "missing"}.`);
  }
  if (env.STATIC_RESULT !== "success") {
    problems.push(`Typecheck and audit were ${env.STATIC_RESULT || "missing"}.`);
  }
  if (env.DATABASE_SCOPE === "false") {
    if (env.DATABASE_RESULT !== "skipped") {
      problems.push(`Database suites were out of scope but ${env.DATABASE_RESULT || "missing"}.`);
    }
    return problems;
  }
  if (env.DATABASE_SCOPE !== "true") {
    problems.push(`The database scope was ${env.DATABASE_SCOPE || "missing"}.`);
    return problems;
  }
  if (env.DATABASE_RESULT !== "success") {
    problems.push(`Database shards were ${env.DATABASE_RESULT || "missing"}.`);
  }
  const shards = Number(env.DATABASE_SHARDS);
  if (!Number.isInteger(shards) || shards < 1) {
    problems.push(`DATABASE_SHARDS must be a positive integer, not ${env.DATABASE_SHARDS}.`);
    return problems;
  }
  return [
    ...problems,
    ...validateShardReports({ reports, shards, testFiles, databaseFiles }),
  ];
}

function shardSummary(reports) {
  const rows = [...reports.entries()]
    .sort(([left], [right]) => left - right)
    .map(([shard, report]) => {
      const results = report.testResults ?? [];
      const seconds = results.reduce(
        (total, result) => total + Math.max(0, (result.endTime ?? 0) - (result.startTime ?? 0)),
        0,
      ) / 1000;
      return `| ${shard} | ${results.length} | ${report.numTotalTests ?? 0} | ${seconds.toFixed(1)} |`;
    });
  return rows.length
    ? ["| Shard | Files | Tests | Test seconds |", "| --- | --- | --- | --- |", ...rows].join("\n")
    : "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reports = readShardReports(process.argv[2] ?? "control-plane-reports");
  const testFiles = listControlPlaneTestFiles();
  const problems = enforceControlPlaneResults({
    env: process.env,
    reports,
    testFiles,
    databaseFiles: databaseBackedTestFiles(testFiles),
  });
  for (const problem of problems) console.error(`::error::${problem}`);
  if (process.env.GITHUB_STEP_SUMMARY && reports.size) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Control-plane database shards\n\n${shardSummary(reports)}\n`);
  }
  if (problems.length) process.exit(1);
  console.log(
    process.env.DATABASE_SCOPE === "false"
      ? "Control plane passed; its database inputs did not change."
      : `Control plane passed across ${reports.size} database shards.`,
  );
}
