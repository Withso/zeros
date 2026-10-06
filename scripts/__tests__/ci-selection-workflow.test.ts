import { execFileSync, spawnSync } from "node:child_process";
import {
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

type Step = {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
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
const LANES = [
  "quality",
  "vitest",
  "build",
  "macos",
  "control-plane-db",
  "ui-smoke",
  "control-plane-static",
  "secret-scan",
] as const;
const PRODUCERS: Record<string, (typeof LANES)[number]> = {
  quality: "quality",
  "test-shard": "vitest",
  build: "build",
  "source-sync-workload": "macos",
  "control-plane-scope": "control-plane-static",
  "control-plane-static": "control-plane-static",
  "control-plane-database": "control-plane-db",
  "ui-smoke": "ui-smoke",
  "secret-scan": "secret-scan",
};
const AGGREGATES = ["test", "source-sync", "control-plane"] as const;
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
    writeFileSync(
      path.join(directory, "scripts/ci/scope-rules.json"),
      JSON.stringify({ quality: false }),
    );
    writeFileSync(
      path.join(directory, "scripts/ci/control-plane-scope.mjs"),
      "export const database = false;\n",
    );
  }
  writeFileSync(path.join(directory, "README.md"), "Fixture\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Create fixture base");
  const base = git("rev-parse", "HEAD");
  const runner = temporaryDirectory();
  return {
    directory,
    git,
    env: {
      EVENT_NAME: "pull_request",
      PULL_REQUEST_BASE_SHA: base,
      PULL_REQUEST_HEAD_SHA: base,
      GITHUB_SHA: base,
      LABELS_JSON: "[]",
      RUNNER_TEMP: runner,
      GITHUB_OUTPUT: path.join(runner, "outputs"),
      GITHUB_STEP_SUMMARY: path.join(runner, "summary"),
    },
  };
}

// This fixture supplies the classifier's output contract. Path classification
// itself belongs to the trusted policy; these tests exercise the workflow's
// trust boundary, fallback, output validation, and additive label handling.
const TRUSTED_POLICY = `
import { readFileSync } from "node:fs";
import { database } from "./control-plane-scope.mjs";
const rules = JSON.parse(readFileSync(new URL("./scope-rules.json", import.meta.url), "utf8"));
if (process.argv.slice(2).join(" ") !== "--mode pr") process.exit(1);
const lanes = {
  quality: rules.quality, vitest: false, build: false, macos: false,
  "control-plane-db": database, "ui-smoke": false,
};
console.log("ledger=" + JSON.stringify({ schema_version: 1, lanes, reasons: ["Trusted fixture policy."] }));
for (const [lane, selected] of Object.entries(lanes)) console.log(lane + "=" + selected);
`;

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
    for (const lane of LANES)
      expect(ci.jobs.scope.outputs?.[lane]).toBe(
        `\${{ steps.scope.outputs.${lane} }}`,
      );
  });

  it("executes the base policy and relative imports even when the PR replaces them", () => {
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
    expect(outputs.quality).toBe("false");
    expect(outputs["control-plane-db"]).toBe("false");
    expect(JSON.parse(outputs.ledger).policy_sha).toBe(
      fixture.env.PULL_REQUEST_BASE_SHA,
    );
    expect(readFileSync(fixture.env.GITHUB_STEP_SUMMARY, "utf8")).toContain(
      "Trusted fixture policy.",
    );
  });

  it("falls back to every PR lane except composer when any policy file is missing", () => {
    const fixture = fixtureRepository(TRUSTED_POLICY);
    fixture.git("rm", "scripts/ci/control-plane-scope.mjs");
    fixture.git("commit", "--quiet", "-m", "Remove policy dependency");
    fixture.env.PULL_REQUEST_BASE_SHA =
      fixture.env.PULL_REQUEST_HEAD_SHA =
      fixture.env.GITHUB_SHA =
        fixture.git("rev-parse", "HEAD");
    const result = runStep(scopeStep(), fixture.env, fixture.directory);
    expect(result.status, result.stderr).toBe(0);
    const outputs = readOutputs(fixture.env.GITHUB_OUTPUT);
    for (const lane of LANES)
      expect(outputs[lane]).toBe(lane === "ui-smoke" ? "false" : "true");
    const ledger = JSON.parse(outputs.ledger);
    expect(ledger.fallback).toBe(true);
    expect(ledger.reasons.join(" ")).toContain("trusted base");
    expect(readFileSync(fixture.env.GITHUB_STEP_SUMMARY, "utf8")).toContain(
      outputs.ledger,
    );
  });

  it.each([
    ["ci:ui-smoke", ["ui-smoke"]],
    ["ci:full", LANES],
    ["ci:macos", ["macos"]],
    ["ci:control-plane-db", ["control-plane-db"]],
    ["ci:packaging", ["quality", "vitest", "build", "macos"]],
    ["ci:web", ["quality", "vitest", "build"]],
  ])("adds the authorized %s label lanes", (label, selected) => {
    const fixture = fixtureRepository(TRUSTED_POLICY);
    const result = runStep(
      scopeStep(),
      { ...fixture.env, LABELS_JSON: JSON.stringify(["reviewed", label]) },
      fixture.directory,
    );
    expect(result.status, result.stderr).toBe(0);
    const outputs = readOutputs(fixture.env.GITHUB_OUTPUT);
    for (const lane of LANES) {
      expect(outputs[lane], lane).toBe(
        selected.includes(lane) ||
          ["control-plane-static", "secret-scan"].includes(lane)
          ? "true"
          : "false",
      );
    }
  });

  it("honors explicit composer labels during missing-policy fallback", () => {
    const fixture = fixtureRepository();
    const result = runStep(
      scopeStep(),
      { ...fixture.env, LABELS_JSON: '["ci:ui-smoke"]' },
      fixture.directory,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readOutputs(fixture.env.GITHUB_OUTPUT)["ui-smoke"]).toBe("true");
  });

  it("retains the path floor when optional labels are removed", () => {
    const fixture = fixtureRepository(
      TRUSTED_POLICY.replace("quality: rules.quality", "quality: true"),
    );
    for (const labels of ['["ci:macos"]', "[]"]) {
      const result = runStep(
        scopeStep(),
        { ...fixture.env, LABELS_JSON: labels },
        fixture.directory,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readOutputs(fixture.env.GITHUB_OUTPUT).quality).toBe("true");
    }
  });

  it.each(["ci:unknown", "ci:skip"])(
    "rejects the unknown %s request",
    (label) => {
      const fixture = fixtureRepository();
      const result = runStep(
        scopeStep(),
        { ...fixture.env, LABELS_JSON: JSON.stringify([label]) },
        fixture.directory,
      );
      expect(result.status).not.toBe(0);
    },
  );

  it.each([
    "throw new Error('Classifier failed');",
    "console.log('quality=false');",
    TRUSTED_POLICY.replace("schema_version: 1", "schema_version: 2"),
    TRUSTED_POLICY.replace("quality: rules.quality", "quality: 'false'"),
    TRUSTED_POLICY.replace('"ui-smoke": false', '"ui-smoke": true'),
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
          ? "always() && (needs.scope.result != 'success' || needs.control-plane-scope.result != 'success' || needs.scope.outputs.control-plane-db == 'true' || needs.control-plane-scope.outputs.database == 'true')"
          : `always() && (needs.scope.result != 'success' || needs.scope.outputs.${lane} == 'true')`,
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

  it("keeps required aggregates' original enforcing commands behind raw-result validation", () => {
    expect(
      ci.jobs.test.steps.find((step) => step.name === "Enforce the test result")
        ?.env?.TEST_RESULT,
    ).toBe(
      "${{ needs.test-shard.result == 'skipped' && needs.scope.outputs.vitest == 'false' && 'success' || needs.test-shard.result }}",
    );
    expect(
      ci.jobs["source-sync"].steps.find(
        (step) => step.name === "Enforce the source-sync result",
      )?.env?.SOURCE_SYNC_RESULT,
    ).toBe(
      "${{ needs.source-sync-workload.result == 'skipped' && needs.scope.outputs.macos == 'false' && 'success' || needs.source-sync-workload.result }}",
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
  function fixture() {
    const lanes = Object.fromEntries(
      LANES.map((lane) => [
        lane,
        ["control-plane-static", "secret-scan"].includes(lane),
      ]),
    );
    const jobs = Object.fromEntries(
      Object.keys(ci.jobs)
        .filter((id) => id !== "ci-gate")
        .map((id) => [id, PRODUCERS[id] ? lanes[PRODUCERS[id]!] : true]),
    );
    const needs: Record<
      string,
      { result: string; outputs: Record<string, string> }
    > = Object.fromEntries(
      Object.entries(jobs).map(([id, selected]) => [
        id,
        {
          result: selected ? "success" : "skipped",
          outputs:
            id === "scope"
              ? Object.fromEntries(
                  LANES.map((lane) => [lane, String(lanes[lane])]),
                )
              : id === "control-plane-scope"
                ? { database: "false" }
                : {},
        },
      ]),
    );
    const sha = "1".repeat(40);
    const ledger = {
      schema_version: 1,
      event_name: "pull_request",
      base_sha: sha,
      source_sha: sha,
      tested_sha: sha,
      policy_sha: sha,
      lanes,
      jobs,
      reasons: ["Gate fixture."],
      requests: [] as string[],
      fallback: false,
    };
    return {
      lanes,
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
    return runStep(selectionStep("ci-gate"), {
      ...state.env,
      LEDGER_JSON: ledger,
      NEEDS_JSON: JSON.stringify(state.needs),
    });
  }

  it("accepts a complete ledger with proven unselected skips", () => {
    const state = fixture();
    const result = verdict(state);
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts ci:full only when every producer is selected and successful", () => {
    const state = fixture();
    state.ledger.requests = ["ci:full"];
    for (const lane of LANES) {
      state.lanes[lane] = true;
      state.needs.scope!.outputs[lane] = "true";
    }
    for (const id of Object.keys(state.jobs)) {
      state.jobs[id] = true;
      state.needs[id]!.result = "success";
    }
    state.needs["control-plane-scope"]!.outputs.database = "true";
    const result = verdict(state);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    "quality",
    "test-shard",
    "build",
    "source-sync-workload",
    "control-plane-database",
    "ui-smoke",
  ])("checks the selection truth table for %s", (id) => {
    for (const selected of [true, false]) {
      for (const result of RESULTS) {
        const state = fixture();
        const lane = PRODUCERS[id]!;
        state.lanes[lane] = selected;
        state.jobs[id] = selected;
        state.needs.scope!.outputs[lane] = String(selected);
        if (id === "control-plane-database")
          state.needs["control-plane-scope"]!.outputs.database =
            String(selected);
        if (id === "ui-smoke" && selected)
          state.ledger.requests = ["ci:ui-smoke"];
        state.needs[id]!.result = result;
        const execution = verdict(state);
        expect(execution.status === 0, `${selected}:${result}`).toBe(
          result === "success" || (!selected && result === "skipped"),
        );
      }
    }
  });

  it("requires a legacy-selected database workload even when its policy lane is false", () => {
    const state = fixture();
    state.needs["control-plane-scope"]!.outputs.database = "true";
    expect(verdict(state).status).not.toBe(0);
    state.needs["control-plane-database"]!.result = "success";
    expect(verdict(state).status).toBe(0);
  });

  it.each(["", "null", "{}", "[]", "malformed"])(
    "rejects missing or invalid ledger %j",
    (ledger) => {
      expect(verdict(fixture(), ledger).status).not.toBe(0);
    },
  );

  it("rejects missing, extra, mismatched, or invalid selection evidence", () => {
    const mutations = [
      (state: ReturnType<typeof fixture>) => {
        delete state.needs.quality;
      },
      (state: ReturnType<typeof fixture>) => {
        state.needs.unknown = { result: "success", outputs: {} };
      },
      (state: ReturnType<typeof fixture>) => {
        delete state.lanes.quality;
      },
      (state: ReturnType<typeof fixture>) => {
        state.needs.scope!.outputs.quality = "true";
      },
      (state: ReturnType<typeof fixture>) => {
        state.jobs.quality = true;
      },
      (state: ReturnType<typeof fixture>) => {
        state.jobs.test = false;
      },
      (state: ReturnType<typeof fixture>) => {
        state.ledger.policy_sha = "2".repeat(40);
      },
      (state: ReturnType<typeof fixture>) => {
        state.ledger.schema_version = 2;
      },
      (state: ReturnType<typeof fixture>) => {
        state.ledger.requests = ["ci:full"];
      },
      (state: ReturnType<typeof fixture>) => {
        state.ledger.fallback = true;
      },
      (state: ReturnType<typeof fixture>) => {
        state.needs["control-plane-scope"]!.outputs.database = "";
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
