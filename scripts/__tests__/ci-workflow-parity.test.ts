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
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  name?: string;
  needs?: string | string[];
  steps?: Step[];
  strategy?: { "fail-fast"?: boolean; matrix?: Record<string, number[]> };
  "runs-on"?: unknown;
  "timeout-minutes"?: unknown;
  services?: unknown;
};
type Workflow = { jobs: Record<string, Job> };

const ROOT = path.resolve(import.meta.dirname, "../..");
const PART_ONE_GUARDS = [
  "Fetch origin/main (for the migration forward-only guard)",
  "Check preload allowlist is in sync",
  "Cloud runtime version-skew contracts",
  "Verify model catalog (strict)",
  "Cursor asarUnpack closure is covered",
  "Cursor SDK host actually loads (real spawn, source runtime)",
  "Cursor SDK host actually works (real spawn, SHIPPED runtime)",
  "Claude CLI actually launches under the Agent SDK",
  "Codex app-server actually boots and matches the pin",
  "Migration ladder is forward-only",
  "Secret scan (tracked files)",
  "Third-party license inventory is current",
  "Production dependency audit has no unreviewed high advisory",
  "Prod VITE_* env-set is wired into release.yml",
  "Electron security posture intact",
  "Codex protocol pin in lockstep",
  "Bundled agent runtime pins are exact and provable",
  "electron-builder source paths resolve",
  "Control-plane migrations naming + forward-only",
  "Control-plane expand/contract migration phases",
  "Desktop ↔ web deep-link schemes in lockstep",
  "Install web hub dependencies",
  "Web hub unit tests (schemes + host routing)",
  "Agent stream-translator contract (offline fixtures)",
  "Wire-protocol version-bump reminder (advisory)",
  "Settings schemas regenerate cleanly",
];
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
  "Decide whether the database suites run": "CI_FULL_DATABASE",
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

  it.each(["ci.yml", "preflight.yml"])(
    "runs four unique native Vitest legs with shared setup and one owner for each guard in %s",
    (file) => {
      const jobs = workflow(file).jobs;
      const job = jobs["test-shard"]!;
      const parts = job.strategy?.matrix?.part;
      expect(parts).toEqual([1, 2, 3, 4]);
      expect(job.strategy?.["fail-fast"]).toBe(false);
      expect(job.name).toBe("tests-vitest (${{ matrix.part }}/4)");
      const steps = job.steps!;
      const shared = steps.filter((step) => !step.if);
      expect(shared.map((step) => step.name)).toEqual([
        ...(file === "ci.yml" ? ["Verify scope result"] : []),
        "Checkout",
        "Setup pnpm",
        "Setup Node",
        "Install JS dependencies",
        "Install control-plane contract dependencies",
        "Install contained-execution runtime",
        "Install Playwright Chromium headless shell",
        "Run vitest suite",
      ]);
      expect(
        steps
          .filter((step) => step.if === "matrix.part == 1")
          .map((step) => step.name),
      ).toEqual(PART_ONE_GUARDS);
      expect(
        steps
          .filter((step) => step.if === "matrix.part == 2")
          .map((step) => step.name),
      ).toEqual(["Code + Design containment matrix"]);
      expect(
        steps.every(
          (step) => !step.if || /^matrix\.part == [12]$/.test(step.if),
        ),
      ).toBe(true);
      const suite = shared.find((step) => step.name === "Run vitest suite")!;
      expect(suite.env).toEqual({ VITEST_PART: "${{ matrix.part }}" });
      expect(suite.run).toBe(
        'bash scripts/ci/with-userns.sh pnpm test:git --shard="${VITEST_PART}/4"',
      );
      const invocations = parts!.map((part) =>
        suite.run!.replace("${VITEST_PART}", String(part)),
      );
      expect(new Set(invocations).size).toBe(4);
      expect(invocations.at(-1)).toContain('--shard="4/4"');
      for (const guard of steps.filter((step) => step.if)) {
        expect(
          parts!.filter((part) => guard.if === `matrix.part == ${part}`),
          guard.name,
        ).toHaveLength(1);
      }
      expect(jobs.test!.name).toBe("test");
      expect(jobs.test!.if).toBe("always()");
      expect(
        (jobs.test!.needs as string[]).filter((id) => id !== "scope"),
      ).toEqual(["test-shard"]);
      const verdict = jobs.test!.steps!.find(
        (step) => step.name === "Enforce the test result",
      )!;
      for (const result of ["success", "failure", "cancelled", "skipped"]) {
        const outcome = spawnSync("bash", ["-c", verdict.run!], {
          encoding: "utf8",
          env: { ...process.env, TEST_RESULT: result },
        });
        expect(outcome.status, result).toBe(result === "success" ? 0 : 1);
      }
    },
  );

  it.each(["ci.yml", "preflight.yml"])(
    "uploads eight distinct database reports and checks all eight in the stable aggregate in %s",
    (file) => {
      const jobs = workflow(file).jobs;
      const database = jobs["control-plane-database"]!;
      expect(database.strategy).toEqual({
        "fail-fast": false,
        matrix: { shard: [1, 2, 3, 4, 5, 6, 7, 8] },
      });
      const suite = database.steps!.find(
        (step) =>
          step.name ===
          "Control-plane tests (migrations + auth/invite contracts)",
      )!;
      expect(suite.env?.SHARD).toBe("${{ matrix.shard }}");
      expect(suite.run).toContain('--shard="${SHARD}/8"');
      expect(suite.run).toContain(
        '--outputFile.json="${RUNNER_TEMP}/control-plane-report/shard-${SHARD}.json"',
      );
      const upload = database.steps!.find(
        (step) => step.name === "Upload the shard's test report",
      )!;
      expect(upload.if).toBe("always()");
      expect(upload.with?.name).toBe(
        "control-plane-database-report-${{ matrix.shard }}",
      );
      const artifacts = database.strategy!.matrix!.shard!.map((shard) =>
        String(upload.with!.name).replace("${{ matrix.shard }}", String(shard)),
      );
      expect(new Set(artifacts).size).toBe(8);
      expect(artifacts.at(-1)).toBe("control-plane-database-report-8");
      const aggregate = jobs["control-plane"]!;
      expect(aggregate.name).toBe("control plane");
      expect(aggregate.if).toBe("always()");
      const download = aggregate.steps!.find(
        (step) => step.name === "Download database shard reports",
      )!;
      expect(download.with?.pattern).toBe("control-plane-database-report-*");
      expect(download.with?.["merge-multiple"]).toBe(true);
      const verdict = aggregate.steps!.find(
        (step) => step.name === "Enforce control-plane results",
      )!;
      expect(verdict.env?.DATABASE_SHARDS).toBe(8);
      expect(verdict.run).toBe(
        'node scripts/ci/control-plane-results.mjs "$RUNNER_TEMP/control-plane-reports"',
      );
    },
  );

  it("admits Alpha only through all five successful critical aggregates", () => {
    const gate = preflight.jobs["alpha-gate"];
    expect(gate).toBeDefined();
    expect(gate!.name).toBe("alpha-gate");
    expect(gate!.if).toBe("always() && github.event_name != 'pull_request'");
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
