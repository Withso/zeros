import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

type Concurrency = {
  group: string;
  queue?: string;
  "cancel-in-progress"?: string | boolean;
};
type Job = {
  concurrency?: Concurrency;
  strategy?: { "max-parallel"?: number; [key: string]: unknown };
  steps?: { name?: string; run?: string }[];
  [key: string]: unknown;
};
type Workflow = {
  on: Record<string, unknown>;
  concurrency: Concurrency;
  jobs: Record<string, Job>;
};
type GitHub = {
  event_name: string;
  ref: string;
  run_id: number;
  run_number: number;
  run_attempt: number;
};

const ROOT = path.resolve(import.meta.dirname, "../..");
const readWorkflow = (file: string) =>
  load(
    readFileSync(path.join(ROOT, ".github/workflows", file), "utf8"),
  ) as Workflow;
const preflight = readWorkflow("preflight.yml");
const ci = readWorkflow("ci.yml");
const cloudRunner = readWorkflow("cloud-runner-qualification.yml");
const workflowChecks = readWorkflow("lint-ci.yml");
const main = (run: number): GitHub => ({
  event_name: "push",
  ref: "refs/heads/main",
  run_id: 10_000 + run,
  run_number: run,
  run_attempt: 1,
});

// Evaluate the trusted workflow's expression using the operators shared by
// GitHub and JavaScript. Pinned actionlint separately validates GitHub syntax
// and types; this exercises the resulting group identity across real contexts.
function evaluate(
  expression: string | boolean,
  github: GitHub,
  shard?: number,
): unknown {
  if (typeof expression === "boolean") return expression;
  const body = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(expression)?.[1];
  if (!body) throw new Error(`Expected a GitHub expression: ${expression}`);
  const format = (template: string, ...values: unknown[]) =>
    template.replace(/\{(\d+)\}/g, (_, index: string) =>
      String(values[Number(index)]),
    );
  const endsWith = (value: unknown, suffix: string) =>
    String(value).toLowerCase().endsWith(suffix.toLowerCase());
  return new Function(
    "github",
    "matrix",
    "format",
    "endsWith",
    `return (${body});`,
  )(github, { shard }, format, endsWith);
}

const workflowGroup = (github: GitHub, workflow = preflight) =>
  workflow.concurrency.group.replace(/\$\{\{[\s\S]*?\}\}/g, (expression) =>
    String(evaluate(expression, github)),
  );
const cancels = (github: GitHub, workflow = preflight) =>
  evaluate(workflow.concurrency["cancel-in-progress"]!, github);

describe("independent main Preflight runs", () => {
  it("gives every main push its own group without cancelling older runs", () => {
    const groups = new Set<string>();
    for (let run = 1; run <= 50; run++) {
      groups.add(workflowGroup(main(run)));
      expect(cancels(main(run))).toBe(false);
    }
    // Distinct groups retain every pending run as well as every active run.
    expect(groups.size).toBe(50);
    expect(preflight.concurrency.queue).toBeUndefined();
  });

  it("keys main groups by run ID and keeps that identity across rerun attempts", () => {
    const github = main(1);
    expect(workflowGroup(github)).toBe(`preflight-main-${github.run_id}`);
    expect(workflowGroup({ ...github, run_id: github.run_id + 1 })).not.toBe(
      workflowGroup(github),
    );
    expect(workflowGroup({ ...github, run_attempt: 2 })).toBe(
      workflowGroup(github),
    );
    expect(cancels({ ...github, run_attempt: 2 })).toBe(false);
  });

  it.each([
    { event_name: "push", ref: "refs/heads/release/1.0.0" },
    { event_name: "push", ref: "refs/heads/release/2.0.0" },
    {
      event_name: "merge_group",
      ref: "refs/heads/gh-readonly-queue/main/pr-42",
    },
    { event_name: "merge_group", ref: "refs/heads/main" },
  ])(
    "keeps $event_name on $ref in its per-ref group and cancels its own superseded runs",
    (context) => {
      const github = { ...main(1), ...context };
      const newer = { ...main(2), ...context };
      expect(workflowGroup(github)).not.toBe(workflowGroup(main(1)));
      expect(workflowGroup(github)).toBe(`preflight-${context.ref}`);
      expect(workflowGroup(newer)).toBe(workflowGroup(github));
      expect(cancels(github)).toBe(true);
      expect(cancels(newer)).toBe(true);
    },
  );

  it("keeps release branches independent of each other", () => {
    expect(
      workflowGroup({ ...main(1), ref: "refs/heads/release/1.0.0" }),
    ).not.toBe(workflowGroup({ ...main(1), ref: "refs/heads/release/2.0.0" }));
  });

  it.each([
    ["Preflight", preflight],
    ["CI", ci],
  ])(
    "keeps every %s job free of concurrency and matrix caps",
    (_, workflow) => {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        expect(job.concurrency, id).toBeUndefined();
        expect(job.strategy?.["max-parallel"], id).toBeUndefined();
      }
    },
  );

  // Step parity between CI and Preflight is owned by ci-workflow-parity.test.ts.
  it("retains the full job inventory and every workload shard matrix", () => {
    expect(Object.keys(preflight.jobs).sort()).toEqual([
      "alpha-gate",
      "build",
      "control-plane",
      "control-plane-database",
      "control-plane-scope",
      "control-plane-static",
      "quality",
      "secret-scan",
      "source-sync",
      "source-sync-workload",
      "test",
      "test-shard",
      "ui-smoke",
      "ui-smoke-shard",
    ]);
    expect(preflight.jobs["test-shard"].strategy).toEqual({
      "fail-fast": false,
      matrix: { part: [1, 2] },
    });
    expect(preflight.jobs["control-plane-database"].strategy).toEqual({
      "fail-fast": false,
      matrix: { shard: [1, 2, 3, 4] },
    });
    expect(preflight.jobs["ui-smoke-shard"].strategy).toEqual({
      "fail-fast": false,
      matrix: { shard: [1, 2, 3] },
    });
  });
});

describe("independent main Cloud Runner Qualification runs", () => {
  it("retains every main push in a distinct non-cancelling group", () => {
    const groups = new Set<string>();
    for (let run = 1; run <= 50; run++) {
      groups.add(workflowGroup(main(run), cloudRunner));
      expect(cancels(main(run), cloudRunner)).toBe(false);
    }
    expect(groups.size).toBe(50);
    expect(cloudRunner.concurrency.queue).toBeUndefined();
  });

  it("keys main groups by run ID and retains that group for reruns", () => {
    const github = main(1);
    expect(workflowGroup(github, cloudRunner)).toBe(
      `cloud-runner-main-${github.run_id}`,
    );
    expect(
      workflowGroup({ ...github, run_id: github.run_id + 1 }, cloudRunner),
    ).not.toBe(workflowGroup(github, cloudRunner));
    expect(workflowGroup({ ...github, run_attempt: 2 }, cloudRunner)).toBe(
      workflowGroup(github, cloudRunner),
    );
    expect(cancels({ ...github, run_attempt: 2 }, cloudRunner)).toBe(false);
  });

  it.each([
    { event_name: "pull_request", ref: "refs/pull/42/merge" },
    { event_name: "pull_request", ref: "refs/heads/main" },
    {
      event_name: "merge_group",
      ref: "refs/heads/gh-readonly-queue/main/pr-42",
    },
    { event_name: "merge_group", ref: "refs/heads/main" },
  ])("preserves per-ref cancellation for $event_name on $ref", (context) => {
    const github = { ...main(1), ...context };
    const newer = { ...main(2), ...context };
    expect(workflowGroup(github, cloudRunner)).toBe(
      `cloud-runner-${context.ref}`,
    );
    expect(workflowGroup(newer, cloudRunner)).toBe(
      workflowGroup(github, cloudRunner),
    );
    expect(workflowGroup(github, cloudRunner)).not.toBe(
      workflowGroup(main(1), cloudRunner),
    );
    expect(cancels(github, cloudRunner)).toBe(true);
    expect(cancels(newer, cloudRunner)).toBe(true);
  });

  it("retains full qualification triggers and the isolated BuildKit resource limits", () => {
    expect(cloudRunner.on).toEqual({
      pull_request: null,
      merge_group: null,
      push: { branches: ["main"] },
    });
    const buildkit = cloudRunner.jobs.qualify.steps?.find(
      (step) =>
        step.name ===
        "Exercise the publication BuildKit toolchain without publishing",
    )?.run;
    expect(buildkit).toBeDefined();
    for (const limit of [
      "max-parallelism = 2",
      "--driver-opt memory=4g",
      "--driver-opt memory-swap=4g",
      "--driver-opt cpu-quota=200000",
      "--driver-opt cpu-period=100000",
      "--driver-opt restart-policy=no",
    ]) {
      expect(buildkit).toContain(limit);
    }
  });
});

describe("Workflow Checks main coverage", () => {
  it("runs actionlint on every main push while retaining unfiltered PR and merge-group triggers", () => {
    expect(workflowChecks.on).toEqual({
      pull_request: null,
      merge_group: null,
      push: { branches: ["main"] },
    });
  });
});
