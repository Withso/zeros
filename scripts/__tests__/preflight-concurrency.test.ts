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
  strategy?: unknown;
  [key: string]: unknown;
};
type Workflow = { concurrency: Concurrency; jobs: Record<string, Job> };
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
function evaluate(expression: string, github: GitHub, shard?: number): unknown {
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

const workflowGroup = (github: GitHub) =>
  String(evaluate(preflight.concurrency.group, github));
const cancels = (github: GitHub) =>
  evaluate(String(preflight.concurrency["cancel-in-progress"]), github);

describe("Preflight main coalescing", () => {
  it("coalesces every main push into one group that never cancels a run in progress", () => {
    for (let run = 1; run <= 50; run++) {
      // One shared group with cancellation off: GitHub keeps the run in
      // progress and a single pending run, which a newer push replaces.
      expect(workflowGroup(main(run))).toBe("preflight-main");
      expect(cancels(main(run))).toBe(false);
    }
    expect(preflight.concurrency.queue).toBeUndefined();
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
    "keeps $event_name on $ref out of the main group and cancels its own superseded runs",
    (context) => {
      const github = { ...main(1), ...context };
      expect(workflowGroup(github)).not.toBe("preflight-main");
      expect(workflowGroup(github)).toBe(`preflight-${context.ref}`);
      expect(cancels(github)).toBe(true);
    },
  );

  it("keeps release branches independent of each other", () => {
    expect(
      workflowGroup({ ...main(1), ref: "refs/heads/release/1.0.0" }),
    ).not.toBe(workflowGroup({ ...main(1), ref: "refs/heads/release/2.0.0" }));
  });

  it("has no job-level concurrency left in Preflight or CI", () => {
    expect(
      Object.entries(preflight.jobs)
        .filter(([, job]) => job.concurrency)
        .map(([id]) => id),
    ).toEqual([]);
    expect(Object.values(ci.jobs).every((job) => !job.concurrency)).toBe(true);
  });

  // Step parity between CI and Preflight is owned by ci-workflow-parity.test.ts.
  it("retains the full job inventory and the composer shard matrix", () => {
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
    expect(preflight.jobs["ui-smoke-shard"].strategy).toEqual({
      "fail-fast": false,
      matrix: { shard: [1, 2, 3] },
    });
  });
});
