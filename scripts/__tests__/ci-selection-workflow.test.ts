import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

import { createLedger, decideScope, loadPolicy } from "../ci/scope.mjs";

type Step = {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  on: Record<string, { types?: string[] }>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
};

const ROOT = path.resolve(import.meta.dirname, "../..");
const source = readFileSync(
  path.join(ROOT, ".github/workflows/ci.yml"),
  "utf8",
);
const ci = load(source) as Workflow;
const JOBS = [
  "quality",
  "vitest",
  "build",
  "macos",
  "control-plane-db",
  "ui-smoke",
  "control-plane-static",
  "secret-scan",
] as const;
const PRODUCERS: Record<string, (typeof JOBS)[number]> = {
  "quality-workload": "quality",
  "test-shard": "vitest",
  build: "build",
  "source-sync-workload": "macos",
  "control-plane-scope": "control-plane-static",
  "control-plane-static": "control-plane-static",
  "control-plane-database": "control-plane-db",
  "ui-smoke": "ui-smoke",
  "secret-scan": "secret-scan",
};
const AGGREGATES = ["quality", "test", "source-sync", "control-plane"] as const;
const RESULTS = ["success", "skipped", "failure", "cancelled", "neutral", ""];
const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-ci-selection-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runStep(step: Step, env: Record<string, string>, cwd = ROOT) {
  expect(step.run).toBeTypeOf("string");
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", step.run!], {
    cwd,
    env: { ...process.env, GITHUB_STEP_SUMMARY: "/dev/null", ...env },
    encoding: "utf8",
  });
}

function scopeStep() {
  const step = ci.jobs.scope?.steps.find(
    (candidate) => candidate.id === "scope",
  );
  expect(step, "the trusted scope step is present").toBeDefined();
  return step!;
}

function selectionStep(id: string) {
  const step = ci.jobs[id]?.steps.find(
    (candidate) => candidate.name === "Verify CI selection",
  );
  expect(step, `${id} validates raw selection and results`).toBeDefined();
  return step!;
}

function needsOf(job: Job) {
  return typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
}

function readOutputs(file: string) {
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const POLICY = loadPolicy(path.join(ROOT, "scripts/ci/scope-rules.json"));
const TRUSTED_POLICY = readFileSync(
  path.join(ROOT, "scripts/ci/scope.mjs"),
  "utf8",
);

function fixtureRepository(policy?: string) {
  const directory = temporaryDirectory();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "CI fixture");
  git("config", "user.email", "ci-fixture@example.invalid");
  if (policy !== undefined) {
    mkdirSync(path.join(directory, "scripts/ci"), { recursive: true });
    writeFileSync(path.join(directory, "scripts/ci/scope.mjs"), policy);
    for (const file of ["scope-rules.json", "control-plane-scope.mjs"]) {
      writeFileSync(
        path.join(directory, "scripts/ci", file),
        readFileSync(path.join(ROOT, "scripts/ci", file)),
      );
    }
  }
  mkdirSync(path.join(directory, "docs"));
  writeFileSync(
    path.join(directory, "docs/personal-settings.md"),
    "Fixture documentation\n",
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "Create fixture base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(
    path.join(directory, "docs/personal-settings.md"),
    "Modified documentation\n",
  );
  git("commit", "--quiet", "-am", "Modify fixture documentation");
  const head = git("rev-parse", "HEAD");
  const runner = temporaryDirectory();
  return {
    directory,
    git,
    env: {
      EVENT_NAME: "pull_request",
      PULL_REQUEST_BASE_SHA: base,
      PULL_REQUEST_HEAD_SHA: head,
      GITHUB_SHA: head,
      LABELS_JSON: "[]",
      RUNNER_TEMP: runner,
      GITHUB_OUTPUT: path.join(runner, "outputs"),
      GITHUB_STEP_SUMMARY: path.join(runner, "summary"),
    },
  };
}

// Fault fixtures exercise only output validation. Selection and label tests
// execute the real classifier with its real registry and relative import.
const OUTPUT_LEDGER = createLedger({
  policy: POLICY,
  decision: decideScope({
    policy: POLICY,
    changes: [{ path: "docs/personal-settings.md", status: "M" }],
  }),
  event: "pull_request",
  mode: "pr",
});
function outputPolicy(patch: Record<string, unknown> = {}) {
  return `
const ledger = ${JSON.stringify({ ...OUTPUT_LEDGER, ...patch })};
ledger.base_sha = process.env.PULL_REQUEST_BASE_SHA;
ledger.source_sha = process.env.PULL_REQUEST_HEAD_SHA;
ledger.tested_sha = process.env.GITHUB_SHA;
console.log("ledger=" + JSON.stringify(ledger));
for (const [id, selected] of Object.entries(ledger.lanes)) console.log(id + "=" + selected);
for (const [id, selected] of Object.entries(ledger.jobs)) console.log("job-" + id + "=" + selected);
`;
}

describe("selective pull-request CI", () => {
  it("reruns for label changes without path filters or elevated permissions", () => {
    expect(ci.on).toEqual({
      pull_request: {
        types: [
          "opened",
          "synchronize",
          "reopened",
          "ready_for_review",
          "labeled",
          "unlabeled",
        ],
      },
    });
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(ci.concurrency).toEqual({
      group: "ci-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
    for (const job of Object.values(ci.jobs)) {
      if (job.permissions)
        expect(job.permissions).toEqual({ contents: "read" });
      for (const step of job.steps) expect(step.run ?? "").not.toContain("${{");
    }
    expect(source).not.toContain("pull_request_target");
  });

  it("loads all policy files from the trusted base with full history", () => {
    const checkout = ci.jobs.scope?.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    const step = scopeStep();
    expect(step.env).toMatchObject({
      EVENT_NAME: "${{ github.event_name }}",
      PULL_REQUEST_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      PULL_REQUEST_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      GITHUB_SHA: "${{ github.sha }}",
      LABELS_JSON: "${{ toJSON(github.event.pull_request.labels.*.name) }}",
    });
    for (const file of [
      "scope.mjs",
      "scope-rules.json",
      "control-plane-scope.mjs",
    ]) {
      expect(step.run).toContain(`git show "$BASE_SHA":scripts/ci/${file}`);
    }
    for (const lane of JOBS)
      expect(ci.jobs.scope.outputs?.[`job-${lane}`]).toBe(
        `\${{ steps.scope.outputs.job-${lane} }}`,
      );
  });

  it("forwards the real classifier ledger and only its job outputs", () => {
    const fixture = fixtureRepository(TRUSTED_POLICY);
    const execution = runStep(scopeStep(), fixture.env, fixture.directory);
    expect(execution.status, execution.stderr).toBe(0);
    const outputs = readOutputs(fixture.env.GITHUB_OUTPUT);
    const classifier = readOutputs(
      path.join(fixture.env.RUNNER_TEMP, "ci-policy/classifier.outputs"),
    );
    expect(Object.keys(outputs).sort()).toEqual(
      ["ledger", ...JOBS.map((id) => `job-${id}`)].sort(),
    );
    expect(outputs.ledger).toBe(classifier.ledger);
    const ledger = JSON.parse(outputs.ledger);
    expect(ledger.schema).toBe("zeros.ci-selection/v1");
    expect(Object.keys(ledger.lanes)).toHaveLength(20);
    expect(ledger.jobs).toEqual(OUTPUT_LEDGER.jobs);
    for (const id of JOBS)
      expect(outputs[`job-${id}`]).toBe(classifier[`job-${id}`]);
    expect(scopeStep().run).not.toMatch(
      /labelLanes|REQUEST_LANES|selectChecks|decideScope/,
    );
  });

  it("executes base policy and relative imports even when the PR replaces them", () => {
    const fixture = fixtureRepository(TRUSTED_POLICY);
    writeFileSync(
      path.join(fixture.directory, "scripts/ci/scope.mjs"),
      "throw new Error('Candidate policy executed');\n",
    );
    writeFileSync(
      path.join(fixture.directory, "scripts/ci/scope-rules.json"),
      "invalid candidate JSON",
    );
    writeFileSync(
      path.join(fixture.directory, "scripts/ci/control-plane-scope.mjs"),
      "throw new Error('Candidate import executed');\n",
    );
    fixture.git("add", ".");
    fixture.git("commit", "--quiet", "-m", "Replace candidate policy");
    fixture.env.PULL_REQUEST_HEAD_SHA = fixture.env.GITHUB_SHA = fixture.git(
      "rev-parse",
      "HEAD",
    );
    const result = runStep(scopeStep(), fixture.env, fixture.directory);
    expect(result.status, result.stderr).toBe(0);
    const outputs = readOutputs(fixture.env.GITHUB_OUTPUT);
    for (const id of JOBS)
      expect(outputs[`job-${id}`]).toBe(id === "ui-smoke" ? "false" : "true");
    const ledger = JSON.parse(outputs.ledger);
    expect(ledger.base_sha).toBe(fixture.env.PULL_REQUEST_BASE_SHA);
    expect(ledger.full).toBe(true);
    expect(ledger.policy_digest).toBe(OUTPUT_LEDGER.policy_digest);
    expect(readFileSync(fixture.env.GITHUB_STEP_SUMMARY, "utf8")).toContain(
      "global-invalidator:",
    );
  });

  it.each(["scope.mjs", "scope-rules.json", "control-plane-scope.mjs"])(
    "falls back when the trusted base lacks %s",
    (file) => {
      const fixture = fixtureRepository(TRUSTED_POLICY);
      fixture.git("rm", `scripts/ci/${file}`);
      fixture.git("commit", "--quiet", "-m", "Remove policy dependency");
      fixture.env.PULL_REQUEST_BASE_SHA =
        fixture.env.PULL_REQUEST_HEAD_SHA =
        fixture.env.GITHUB_SHA =
          fixture.git("rev-parse", "HEAD");
      const result = runStep(scopeStep(), fixture.env, fixture.directory);
      expect(result.status, result.stderr).toBe(0);
      const outputs = readOutputs(fixture.env.GITHUB_OUTPUT);
      for (const id of JOBS)
        expect(outputs[`job-${id}`]).toBe(id === "ui-smoke" ? "false" : "true");
      const ledger = JSON.parse(outputs.ledger);
      expect(ledger.schema).toBe("zeros.ci-selection/v1");
      expect(ledger.policy_digest).toBeNull();
      expect(ledger.lanes).toEqual({});
      expect(ledger.requests).toEqual([]);
      expect(ledger.reasons.join(" ")).toContain("missing-policy:");
      expect(readFileSync(fixture.env.GITHUB_STEP_SUMMARY, "utf8")).toContain(
        outputs.ledger,
      );
    },
  );

  it.each([
    ["ci:ui-smoke", ["ui-smoke"]],
    ["ci:full", JOBS],
    ["ci:macos", ["macos"]],
    ["ci:control-plane-db", ["quality", "vitest", "control-plane-db"]],
    ["ci:packaging", ["quality", "vitest", "build", "macos"]],
    ["ci:web", ["quality", "vitest", "build"]],
  ])("passes the %s request to the real classifier", (label, selected) => {
    const fixture = fixtureRepository(TRUSTED_POLICY);
    const result = runStep(
      scopeStep(),
      { ...fixture.env, LABELS_JSON: JSON.stringify(["reviewed", label]) },
      fixture.directory,
    );
    expect(result.status, result.stderr).toBe(0);
    const outputs = readOutputs(fixture.env.GITHUB_OUTPUT);
    for (const id of JOBS) {
      expect(outputs[`job-${id}`], id).toBe(
        selected.includes(id) ||
          ["control-plane-static", "secret-scan"].includes(id)
          ? "true"
          : "false",
      );
    }
    expect(JSON.parse(outputs.ledger).requests).toEqual([label]);
  });

  it("keeps composer off without a trusted classifier to interpret labels", () => {
    const fixture = fixtureRepository();
    const result = runStep(
      scopeStep(),
      { ...fixture.env, LABELS_JSON: '["ci:ui-smoke"]' },
      fixture.directory,
    );
    expect(result.status, result.stderr).toBe(0);
    const outputs = readOutputs(fixture.env.GITHUB_OUTPUT);
    expect(outputs["job-ui-smoke"]).toBe("false");
    expect(JSON.parse(outputs.ledger).requests).toEqual([]);
  });

  it.each(["", "invalid", "0".repeat(40), "2".repeat(40)])(
    "fails before making selection claims for unavailable base %j",
    (base) => {
      const fixture = fixtureRepository(TRUSTED_POLICY);
      const result = runStep(
        scopeStep(),
        { ...fixture.env, PULL_REQUEST_BASE_SHA: base },
        fixture.directory,
      );
      expect(result.status).not.toBe(0);
      expect(readFileSync(fixture.env.GITHUB_OUTPUT, "utf8")).toBe("");
    },
  );

  it("retains the real path floor when an optional label is removed", () => {
    const fixture = fixtureRepository(TRUSTED_POLICY);
    mkdirSync(path.join(fixture.directory, "apps/desktop/src/renderer"), {
      recursive: true,
    });
    writeFileSync(
      path.join(fixture.directory, "apps/desktop/src/renderer/example.ts"),
      "export const example = true;\n",
    );
    fixture.git("add", ".");
    fixture.git("commit", "--quiet", "-m", "Change renderer source");
    fixture.env.PULL_REQUEST_HEAD_SHA = fixture.env.GITHUB_SHA = fixture.git(
      "rev-parse",
      "HEAD",
    );
    for (const labels of ['["ci:ui-smoke"]', "[]"]) {
      const result = runStep(
        scopeStep(),
        { ...fixture.env, LABELS_JSON: labels },
        fixture.directory,
      );
      expect(result.status, result.stderr).toBe(0);
      const outputs = readOutputs(fixture.env.GITHUB_OUTPUT);
      expect(outputs["job-quality"]).toBe("true");
      expect(outputs["job-ui-smoke"]).toBe(labels === "[]" ? "false" : "true");
    }
  });

  it.each(["ci:unknown", "ci:skip"])(
    "lets the classifier reject %s before publishing outputs",
    (label) => {
      const fixture = fixtureRepository(TRUSTED_POLICY);
      const result = runStep(
        scopeStep(),
        { ...fixture.env, LABELS_JSON: JSON.stringify([label]) },
        fixture.directory,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unknown CI label");
      expect(readFileSync(fixture.env.GITHUB_OUTPUT, "utf8")).toBe("");
    },
  );

  it.each([
    "throw new Error('Classifier failed');",
    "console.log('desktop-renderer=false');",
    outputPolicy({ schema: "zeros.ci-selection/v2" }),
    outputPolicy({ schema_version: 1 }),
    outputPolicy({ mode: "full" }),
    outputPolicy({ policy_digest: "invalid" }),
    outputPolicy({ policy_digest: [OUTPUT_LEDGER.policy_digest] }),
    outputPolicy({ jobs: { ...OUTPUT_LEDGER.jobs, quality: "false" } }),
    outputPolicy({ jobs: { ...OUTPUT_LEDGER.jobs, "secret-scan": false } }),
    outputPolicy({ jobs: { ...OUTPUT_LEDGER.jobs, unknown: false } }),
    outputPolicy({
      lanes: { ...OUTPUT_LEDGER.lanes, "desktop-renderer": "false" },
    }),
    outputPolicy({ reasons: [] }),
    outputPolicy() + 'console.log("job-quality=false");',
    outputPolicy() + 'console.log("unexpected=false");',
    outputPolicy().replace(
      'for (const [id, selected] of Object.entries(ledger.jobs)) console.log("job-" + id + "=" + selected);',
      "",
    ),
    outputPolicy().replace(
      '"job-" + id + "=" + selected',
      '"job-" + id + "=" + (id === "quality" ? true : selected)',
    ),
    outputPolicy().replace(
      "ledger.tested_sha = process.env.GITHUB_SHA;",
      'ledger.tested_sha = "2".repeat(40);',
    ),
  ])("fails scope on invalid policy execution or output %#", (policy) => {
    const fixture = fixtureRepository(policy);
    const result = runStep(scopeStep(), fixture.env, fixture.directory);
    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.env.GITHUB_OUTPUT, "utf8")).toBe("");
  });

  it.each(Object.entries(PRODUCERS))(
    "guards the %s producer before any workload",
    (id, lane) => {
      const job = ci.jobs[id]!;
      expect(needsOf(job)).toContain("scope");
      expect(job.if).toBe(
        id === "control-plane-database"
          ? "always() && (needs.scope.result != 'success' || needs.control-plane-scope.result != 'success' || needs.scope.outputs.job-control-plane-db == 'true' || needs.control-plane-scope.outputs.database == 'true')"
          : `always() && (needs.scope.result != 'success' || needs.scope.outputs.job-${lane} == 'true')`,
      );
      const guard = job.steps[0]!;
      expect(guard.name).toBe("Verify scope result");
      expect(guard.env?.SCOPE_RESULT).toBe("${{ needs.scope.result }}");
      for (const scopeResult of RESULTS) {
        const result = runStep(guard, {
          SCOPE_RESULT: scopeResult,
          DATABASE_SCOPE_RESULT: "success",
          DATABASE_SELECTED: "true",
        });
        expect(result.status === 0, scopeResult).toBe(
          scopeResult === "success",
        );
      }
    },
  );

  it("unions the existing database scope with the trusted path floor", () => {
    const job = ci.jobs["control-plane-scope"]!;
    const step = job.steps.find(
      (candidate) => candidate.name === "Combine database selections",
    )!;
    expect(step).toBeDefined();
    expect(job.outputs?.database).toBe(
      "${{ steps.selection.outputs.database }}",
    );
    for (const floor of ["true", "false"]) {
      for (const legacy of ["true", "false"]) {
        const output = path.join(temporaryDirectory(), "outputs");
        const result = runStep(step, {
          DATABASE_FLOOR: floor,
          LEGACY_DATABASE: legacy,
          GITHUB_OUTPUT: output,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(readOutputs(output).database).toBe(
          String(floor === "true" || legacy === "true"),
        );
      }
    }
    const output = path.join(temporaryDirectory(), "outputs");
    expect(
      runStep(step, {
        DATABASE_FLOOR: "false",
        LEGACY_DATABASE: "",
        GITHUB_OUTPUT: output,
      }).status,
    ).not.toBe(0);
    const database = ci.jobs["control-plane-database"]!;
    expect(database.if).toContain(
      "needs.control-plane-scope.result != 'success'",
    );
    expect(database.if).toContain(
      "needs.control-plane-scope.outputs.database == 'true'",
    );
    expect(
      runStep(database.steps[0]!, {
        SCOPE_RESULT: "success",
        DATABASE_SCOPE_RESULT: "failure",
        DATABASE_SELECTED: "true",
      }).status,
    ).not.toBe(0);
  });

  it.each(AGGREGATES)(
    "enforces the complete selection truth table in %s",
    (id) => {
      const job = ci.jobs[id]!;
      expect(job.if).toBe("always()");
      expect(needsOf(job)).toContain("scope");
      const step = selectionStep(id);
      for (const selected of ["true", "false", "", "TRUE"]) {
        for (const result of RESULTS) {
          const execution = runStep(step, {
            SCOPE_RESULT: "success",
            LANE_SELECTED: selected,
            LANE_RESULT: result,
            DATABASE_SCOPE_RESULT: "success",
            STATIC_RESULT: "success",
            DATABASE_FLOOR: "false",
          });
          const accepted =
            (selected === "true" && result === "success") ||
            (selected === "false" && ["success", "skipped"].includes(result));
          expect(execution.status === 0, `${selected}:${result}`).toBe(
            accepted,
          );
        }
      }
      for (const scopeResult of RESULTS.filter(
        (result) => result !== "success",
      )) {
        expect(
          runStep(step, {
            SCOPE_RESULT: scopeResult,
            LANE_SELECTED: "false",
            LANE_RESULT: "skipped",
            DATABASE_SCOPE_RESULT: "success",
            STATIC_RESULT: "success",
            DATABASE_FLOOR: "false",
          }).status,
        ).not.toBe(0);
      }
    },
  );

  it("runs the incident-marker guard in required quality even for unselected quality work", () => {
    const job = ci.jobs.quality;
    expect(job.name).toBe("quality");
    expect(job.if).toBe("always()");
    expect(needsOf(job)).toEqual(["scope", "quality-workload"]);
    const marker = job.steps.find(
      (step) => step.name === "Reject unresolved CI incident markers",
    )!;
    expect(marker).toBeDefined();
    expect(marker.if).toBe("github.event_name == 'pull_request'");
    expect(marker.run).toBe("node scripts/ci/recovery.mjs guard-markers");
    expect(ci.jobs["quality-workload"].steps).not.toContainEqual(marker);
    expect(selectionStep("quality").if).toBe("always()");
    expect(selectionStep("quality").env).toEqual({
      SCOPE_RESULT: "${{ needs.scope.result }}",
      LANE_SELECTED: "${{ needs.scope.outputs.job-quality }}",
      LANE_RESULT: "${{ needs.quality-workload.result }}",
    });
    expect(job.steps.indexOf(marker)).toBeLessThan(
      job.steps.indexOf(selectionStep("quality")),
    );

    const directory = temporaryDirectory();
    mkdirSync(path.join(directory, "scripts"));
    cpSync(
      path.join(ROOT, "scripts/ci"),
      path.join(directory, "scripts/ci"),
      { recursive: true },
    );
    const clean = runStep(marker, {}, directory);
    expect(clean.status, clean.stderr).toBe(0);
    mkdirSync(path.join(directory, ".github/ci-incidents"), {
      recursive: true,
    });
    const file = path.join(directory, ".github/ci-incidents/unresolved.json");
    writeFileSync(file, "{}\n");
    const unresolved = runStep(marker, {}, directory);
    expect(unresolved.status).not.toBe(0);
    expect(unresolved.stderr).toContain("Unresolved CI incident marker");
    rmSync(file);
    expect(runStep(marker, {}, directory).status).toBe(0);
  });

  it("keeps required aggregates' original enforcing commands behind raw-result validation", () => {
    expect(
      ci.jobs.test.steps.find((step) => step.name === "Enforce the test result")
        ?.env?.TEST_RESULT,
    ).toBe(
      "${{ needs.test-shard.result == 'skipped' && needs.scope.outputs.job-vitest == 'false' && 'success' || needs.test-shard.result }}",
    );
    expect(
      ci.jobs["source-sync"].steps.find(
        (step) => step.name === "Enforce the source-sync result",
      )?.env?.SOURCE_SYNC_RESULT,
    ).toBe(
      "${{ needs.source-sync-workload.result == 'skipped' && needs.scope.outputs.job-macos == 'false' && 'success' || needs.source-sync-workload.result }}",
    );
    const controlPlane = ci.jobs["control-plane"].steps.find(
      (step) => step.name === "Enforce control-plane results",
    )!;
    expect(controlPlane.run).toBe(
      'node scripts/ci/control-plane-results.mjs "$RUNNER_TEMP/control-plane-reports"',
    );
    expect(controlPlane.env?.DATABASE_RESULT).toBe(
      "${{ needs.control-plane-scope.outputs.database == 'false' && needs.control-plane-database.result == 'success' && 'skipped' || needs.control-plane-database.result }}",
    );
  });

  it("runs the real composer suite when explicitly selected", () => {
    expect(ci.jobs["ui-smoke"].name).toBe("ui-smoke (composer)");
    expect(
      ci.jobs["ui-smoke"].steps.some(
        (step) => step.run === "pnpm test:ui-smoke",
      ),
    ).toBe(true);
    expect(
      ci.jobs["ui-smoke"].steps.some((step) =>
        step.run?.includes("playwright install --with-deps chromium"),
      ),
    ).toBe(true);
  });

  it("gates every workflow job directly under the future required context", () => {
    const gate = ci.jobs["ci-gate"];
    expect(gate).toBeDefined();
    expect(gate.name).toBe("zeros/ci-gate");
    expect(gate.if).toBe("always()");
    expect(needsOf(gate).sort()).toEqual(
      Object.keys(ci.jobs)
        .filter((id) => id !== "ci-gate")
        .sort(),
    );
  });
});

describe("the CI gate's executable ledger validation", () => {
  function fixture(labels: string[] = []) {
    const sha = "1".repeat(40);
    const ledger = createLedger({
      policy: POLICY,
      decision: decideScope({
        policy: POLICY,
        changes: [{ path: "docs/personal-settings.md", status: "M" }],
        labels,
      }),
      event: "pull_request",
      mode: "pr",
      baseSha: sha,
      sourceSha: sha,
      testedSha: sha,
    });
    const jobs = ledger.jobs;
    const selected = Object.fromEntries(
      Object.keys(ci.jobs)
        .filter((id) => id !== "ci-gate")
        .map((id) => [id, PRODUCERS[id] ? jobs[PRODUCERS[id]!] : true]),
    );
    const needs: Record<
      string,
      { result: string; outputs: Record<string, string> }
    > = Object.fromEntries(
      Object.entries(selected).map(([id, run]) => [
        id,
        {
          result: run ? "success" : "skipped",
          outputs:
            id === "scope"
              ? {
                  ledger: "",
                  ...Object.fromEntries(
                    JOBS.map((job) => [`job-${job}`, String(jobs[job])]),
                  ),
                }
              : id === "control-plane-scope"
                ? { database: String(jobs["control-plane-db"]) }
                : {},
        },
      ]),
    );
    return {
      jobs,
      needs,
      ledger,
      env: {
        EVENT_NAME: "pull_request",
        PULL_REQUEST_BASE_SHA: sha,
        PULL_REQUEST_HEAD_SHA: sha,
        GITHUB_SHA: sha,
        GITHUB_STEP_SUMMARY: path.join(temporaryDirectory(), "summary"),
      },
    };
  }

  function verdict(
    state: ReturnType<typeof fixture>,
    ledger = JSON.stringify(state.ledger),
  ) {
    if (state.needs.scope?.outputs.ledger === "")
      state.needs.scope.outputs.ledger = JSON.stringify(state.ledger);
    return runStep(selectionStep("ci-gate"), {
      ...state.env,
      LEDGER_JSON: ledger,
      NEEDS_JSON: JSON.stringify(state.needs),
    });
  }

  it("accepts the real classifier schema and proven unselected skips", () => {
    const state = fixture();
    const result = verdict(state);
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts the classifier's ci:full selection when all jobs succeed", () => {
    const state = fixture(["ci:full"]);
    expect(Object.values(state.jobs).every(Boolean)).toBe(true);
    const result = verdict(state);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    "quality-workload",
    "test-shard",
    "build",
    "source-sync-workload",
    "control-plane-database",
    "ui-smoke",
  ])("checks the selection truth table for %s", (id) => {
    for (const selected of [true, false]) {
      for (const result of RESULTS) {
        const state = fixture();
        const job = PRODUCERS[id]!;
        state.jobs[job] = selected;
        state.needs.scope!.outputs[`job-${job}`] = String(selected);
        if (id === "control-plane-database")
          state.needs["control-plane-scope"]!.outputs.database =
            String(selected);
        state.needs[id]!.result = result;
        const execution = verdict(state);
        expect(execution.status === 0, `${selected}:${result}`).toBe(
          result === "success" || (!selected && result === "skipped"),
        );
      }
    }
  });

  it("requires the legacy-selected database even when the trusted job floor is false", () => {
    const state = fixture();
    state.needs["control-plane-scope"]!.outputs.database = "true";
    expect(verdict(state).status).not.toBe(0);
    state.needs["control-plane-database"]!.result = "success";
    expect(verdict(state).status).toBe(0);
  });

  it("accepts the conservative missing-policy ledger and rejects a composer addition", () => {
    const state = fixture();
    state.ledger.policy_digest = null;
    state.ledger.lanes = {};
    state.ledger.full = true;
    state.ledger.reasons = [
      "missing-policy: The trusted base lacks the complete CI policy.",
    ];
    for (const id of JOBS) {
      state.jobs[id] = id !== "ui-smoke";
      state.needs.scope!.outputs[`job-${id}`] = String(state.jobs[id]);
    }
    for (const id of Object.keys(state.needs))
      state.needs[id]!.result = id === "ui-smoke" ? "skipped" : "success";
    state.needs["control-plane-scope"]!.outputs.database = "true";
    expect(verdict(state).status).toBe(0);
    state.jobs["ui-smoke"] = true;
    state.needs.scope!.outputs["job-ui-smoke"] = "true";
    state.needs.scope!.outputs.ledger = "";
    state.needs["ui-smoke"]!.result = "success";
    expect(verdict(state).status).not.toBe(0);
  });

  it.each(["", "null", "{}", "[]", "malformed"])(
    "rejects missing or invalid ledger %j",
    (ledger) => {
      expect(verdict(fixture(), ledger).status).not.toBe(0);
    },
  );

  it("rejects missing, extra, mismatched, or invalid selection evidence", () => {
    const mutations = [
      (s: ReturnType<typeof fixture>) => {
        delete s.needs.quality;
      },
      (s: ReturnType<typeof fixture>) => {
        s.needs.unknown = { result: "success", outputs: {} };
      },
      (s: ReturnType<typeof fixture>) => {
        delete s.jobs.quality;
      },
      (s: ReturnType<typeof fixture>) => {
        s.jobs.unknown = false;
      },
      (s: ReturnType<typeof fixture>) => {
        s.needs.scope!.outputs["job-quality"] = "true";
      },
      (s: ReturnType<typeof fixture>) => {
        delete s.needs.scope!.outputs["job-vitest"];
      },
      (s: ReturnType<typeof fixture>) => {
        delete s.needs.scope!.outputs.ledger;
      },
      (s: ReturnType<typeof fixture>) => {
        s.needs.scope!.outputs.ledger = "different ledger";
      },
      (s: ReturnType<typeof fixture>) => {
        s.jobs.quality = "false";
      },
      (s: ReturnType<typeof fixture>) => {
        s.jobs["secret-scan"] = false;
      },
      (s: ReturnType<typeof fixture>) => {
        s.ledger.source_sha = "2".repeat(40);
      },
      (s: ReturnType<typeof fixture>) => {
        s.ledger.schema = "zeros.ci-selection/v2";
      },
      (s: ReturnType<typeof fixture>) => {
        s.ledger.schema_version = 1;
      },
      (s: ReturnType<typeof fixture>) => {
        s.ledger.mode = "full";
      },
      (s: ReturnType<typeof fixture>) => {
        s.ledger.policy_digest = "invalid";
      },
      (s: ReturnType<typeof fixture>) => {
        s.ledger.policy_digest = [s.ledger.policy_digest];
      },
      (s: ReturnType<typeof fixture>) => {
        s.ledger.lanes.web = "false";
      },
      (s: ReturnType<typeof fixture>) => {
        s.ledger.full = true;
      },
      (s: ReturnType<typeof fixture>) => {
        s.ledger.policy_digest = null;
      },
      (s: ReturnType<typeof fixture>) => {
        s.ledger.requests = ["ci:web", "ci:web"];
      },
      (s: ReturnType<typeof fixture>) => {
        s.needs["control-plane-scope"]!.outputs.database = "";
      },
    ];
    for (const mutate of mutations) {
      const state = fixture();
      mutate(state);
      expect(verdict(state).status).not.toBe(0);
    }
  });

  it("rejects failed scope and any failed or cancelled always-selected job", () => {
    for (const id of [
      "scope",
      ...AGGREGATES,
      "control-plane-scope",
      "control-plane-static",
      "secret-scan",
    ]) {
      for (const result of RESULTS.filter((value) => value !== "success")) {
        const state = fixture();
        state.needs[id]!.result = result;
        expect(verdict(state).status, `${id}:${result}`).not.toBe(0);
      }
    }
  });
});
