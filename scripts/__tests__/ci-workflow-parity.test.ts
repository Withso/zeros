import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// CI selects whole workloads while Preflight remains full release evidence.
// Its required quality aggregate also runs the incident-marker guard on every
// PR. The executable selection suite verifies each selection-only exception.

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, unknown>;
};
type Job = {
  if?: string;
  name?: string;
  needs?: string | string[];
  steps?: Step[];
  strategy?: unknown;
  "runs-on"?: unknown;
  "timeout-minutes"?: unknown;
  services?: unknown;
};
type Workflow = { jobs: Record<string, Job> };

const ROOT = path.resolve(import.meta.dirname, "../..");
const workflow = (file: string) =>
  load(
    readFileSync(path.join(ROOT, ".github/workflows", file), "utf8"),
  ) as Workflow;

const PR_ONLY_JOBS = new Set(["scope", "quality", "ci-gate"]);
// The Alpha gate and composer browser shards run only in full Preflight.
const PREFLIGHT_ONLY_JOBS = new Set(["alpha-gate", "ui-smoke-shard"]);
const PR_ONLY_STEPS = new Set([
  "Prettier — changed files only (advisory)",
  "Reject unresolved CI incident markers",
  "Verify scope result",
  "Verify CI selection",
  "Combine database selections",
]);
// Preflight's quality workload has its own producer in CI so the required
// quality check can enforce incident markers even when that workload skips.
const CI_WORKLOADS: Record<string, string> = { quality: "quality-workload" };
const SELECTION_INPUTS: Record<string, string> = {
  "Enforce the test result": "TEST_RESULT",
  "Enforce the source-sync result": "SOURCE_SYNC_RESULT",
  "Enforce control-plane results": "DATABASE_RESULT",
};
const comparable = (job: Job) => ({
  name: job.name,
  needs: (typeof job.needs === "string"
    ? [job.needs]
    : (job.needs ?? [])
  ).filter((id) => id !== "scope"),
  strategy: job.strategy,
  runner: job["runs-on"],
  timeout: job["timeout-minutes"],
  services: job.services,
  steps: (job.steps ?? [])
    .filter((step) => !PR_ONLY_STEPS.has(step.name ?? ""))
    .map(({ name, run, uses, if: condition, env, ...settings }) => ({
      ...settings,
      name,
      run,
      uses,
      if: condition,
      env: Object.fromEntries(
        Object.entries(env ?? {}).filter(
          ([key]) => key !== SELECTION_INPUTS[name ?? ""],
        ),
      ),
    })),
});

describe("CI and Preflight job parity", () => {
  const ci = workflow("ci.yml");
  const preflight = workflow("preflight.yml");

  it("defines the same workloads apart from explicit profile gates", () => {
    expect(
      Object.keys(ci.jobs)
        .filter((id) => !PR_ONLY_JOBS.has(id))
        .map((id) => (id === "quality-workload" ? "quality" : id))
        .sort(),
    ).toEqual(
      Object.keys(preflight.jobs)
        .filter((id) => !PREFLIGHT_ONLY_JOBS.has(id))
        .sort(),
    );
    expect(ci.jobs.quality.name).toBe("quality");
    expect(ci.jobs["quality-workload"].name).toBe("quality-workload");
  });

  it.each(
    Object.keys(workflow("preflight.yml").jobs).filter(
      (id) => id !== "ui-smoke" && !PREFLIGHT_ONLY_JOBS.has(id),
    ),
  )(
    "keeps the %s workload identical apart from pull-request selection steps",
    (id) => {
      const candidate = comparable(ci.jobs[CI_WORKLOADS[id] ?? id]!);
      if (CI_WORKLOADS[id]) candidate.name = preflight.jobs[id]!.name;
      expect(candidate).toEqual(comparable(preflight.jobs[id]!));
    },
  );

  it("admits Alpha only through all five successful critical aggregates", () => {
    const gate = preflight.jobs["alpha-gate"];
    expect(gate).toBeDefined();
    expect(gate!.name).toBe("alpha-gate");
    expect(gate!.if).toBe("always()");
    expect(gate!.needs).toEqual([
      "quality",
      "test",
      "build",
      "control-plane",
      "secret-scan",
    ]);
    expect(ci.jobs["alpha-gate"]).toBeUndefined();
    const step = gate!.steps![0]!;
    expect(step.env).toEqual({
      QUALITY_RESULT: "${{ needs.quality.result }}",
      TEST_RESULT: "${{ needs.test.result }}",
      BUILD_RESULT: "${{ needs.build.result }}",
      CONTROL_PLANE_RESULT: "${{ needs.control-plane.result }}",
      SECRET_SCAN_RESULT: "${{ needs.secret-scan.result }}",
    });
    const success = Object.fromEntries(
      Object.keys(step.env!).map((key) => [key, "success"]),
    );
    const run = (env: Record<string, string>) =>
      spawnSync("bash", ["-c", step.run!], {
        env: { ...process.env, ...env },
        encoding: "utf8",
      });
    expect(run(success).status).toBe(0);
    for (const key of Object.keys(success)) {
      for (const result of ["failure", "cancelled", "skipped", ""]) {
        const rejected = run({ ...success, [key]: result });
        expect(rejected.status, `${key}=${result}`).toBe(1);
        expect(rejected.stdout).toContain("::error::");
      }
    }
  });

  it("reuses Preflight's browser setup for the full selected PR composer suite", () => {
    expect(ci.jobs["ui-smoke"].name).toBe("ui-smoke (composer)");
    const candidate = comparable(ci.jobs["ui-smoke"]).steps;
    const full = comparable(preflight.jobs["ui-smoke-shard"]).steps;
    expect(candidate.slice(0, -1)).toEqual(full.slice(0, -1));
    expect(candidate.at(-1)).toEqual({
      name: "Run composer UI smoke suite",
      run: "pnpm test:ui-smoke",
      uses: undefined,
      if: undefined,
      env: {},
    });
  });

  it("runs all browser shards only in post-merge Preflight", () => {
    expect(ci.jobs).not.toHaveProperty("ui-smoke-shard");
    expect(preflight.jobs["ui-smoke-shard"]?.name).toBe(
      "tests-ui-smoke (${{ matrix.shard }}/3)",
    );
    expect(preflight.jobs["ui-smoke-shard"]?.strategy).toEqual({
      "fail-fast": false,
      matrix: { shard: [1, 2, 3] },
    });
    expect(preflight.jobs["ui-smoke-shard"]?.steps?.at(-1)).toMatchObject({
      name: "Run composer UI smoke shard",
      env: { SHARD: "${{ matrix.shard }}" },
      run: 'pnpm test:ui-smoke --shard="${SHARD}/3"',
    });
    expect(preflight.jobs["ui-smoke"].name).toBe("ui-smoke (composer)");
    expect(preflight.jobs["ui-smoke"].if).toBe("always()");
    expect(preflight.jobs["ui-smoke"].needs).toEqual(["ui-smoke-shard"]);
  });

  it.each(["success", "failure", "cancelled", "skipped"])(
    "keeps the required Preflight composer aggregate red unless its matrix succeeds (%s)",
    (result) => {
      const step = preflight.jobs["ui-smoke"]!.steps![0]!;
      const outcome = spawnSync("bash", ["-c", step.run!], {
        encoding: "utf8",
        env: { ...process.env, UI_SMOKE_RESULT: result },
      });
      expect(outcome.status, outcome.stderr).toBe(result === "success" ? 0 : 1);
    },
  );
});
