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
const heavyJobs = ["source-sync-workload", "ui-smoke-shard"];
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

function group(job: string, github: GitHub, shard?: number): string {
  const concurrency = preflight.jobs[job].concurrency;
  if (!concurrency) throw new Error(`Missing heavy concurrency for ${job}`);
  return String(evaluate(concurrency.group, github, shard));
}

describe("Preflight heavy concurrency", () => {
  it("queues only composer shards and the macOS workload, retaining Alpha producer capacity", () => {
    expect(
      Object.entries(preflight.jobs)
        .filter(([, job]) => job.concurrency)
        .map(([id]) => id)
        .sort(),
    ).toEqual(heavyJobs);
    for (const id of heavyJobs) {
      expect(preflight.jobs[id].concurrency).toMatchObject({ queue: "max" });
      expect(
        preflight.jobs[id].concurrency?.["cancel-in-progress"],
      ).toBeUndefined();
    }
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

  it("bounds a burst to three composer groups and two balanced macOS groups", () => {
    const composer = new Set<string>();
    const macOS = new Set<string>();
    const bucketCounts = new Map<string, number>();
    for (let run = 1; run <= 200; run++) {
      for (const shard of [1, 2, 3]) {
        composer.add(group("ui-smoke-shard", main(run), shard));
      }
      const bucket = group("source-sync-workload", main(run));
      macOS.add(bucket);
      bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
    }
    expect(composer.size).toBe(3);
    expect(macOS.size).toBe(2);
    expect([...bucketCounts.values()]).toEqual([100, 100]);
    expect(new Set([...composer, ...macOS]).size).toBe(5);
  });

  it.each([
    { event_name: "push", ref: "refs/heads/release/1.0.0" },
    { event_name: "push", ref: "refs/heads/release/2.0.0" },
    {
      event_name: "merge_group",
      ref: "refs/heads/gh-readonly-queue/main/pr-42",
    },
    { event_name: "merge_group", ref: "refs/heads/main" },
    { event_name: "workflow_dispatch", ref: "refs/heads/main" },
  ])(
    "isolates $event_name on $ref from main and from another run",
    (context) => {
      for (const [job, shard] of [
        ["source-sync-workload", undefined],
        ["ui-smoke-shard", 1],
        ["ui-smoke-shard", 2],
        ["ui-smoke-shard", 3],
      ] as const) {
        const mainGroups = [
          group(job, main(1), shard),
          group(job, main(2), shard),
        ];
        const first = group(job, { ...main(1), ...context }, shard);
        const second = group(job, { ...main(2), ...context }, shard);
        expect(mainGroups).not.toContain(first);
        expect(mainGroups).not.toContain(second);
        expect(first).not.toBe(second);
        expect(
          group(job, { ...main(1), ...context, run_attempt: 2 }, shard),
        ).not.toBe(first);
      }
    },
  );

  it("keeps distinct event and release-branch identities even with the same run context", () => {
    for (const job of heavyJobs) {
      const contexts = [
        main(1),
        { ...main(1), ref: "refs/heads/release/1.0.0" },
        { ...main(1), ref: "refs/heads/release/2.0.0" },
        { ...main(1), event_name: "merge_group" },
        { ...main(1), event_name: "workflow_dispatch" },
      ];
      expect(
        new Set(contexts.map((context) => group(job, context, 1))).size,
      ).toBe(contexts.length);
    }
  });

  it("retains a unique workflow group and never cancels or replaces another main SHA", () => {
    const groups = new Set<string>();
    for (let run = 1; run <= 200; run++) {
      groups.add(String(evaluate(preflight.concurrency.group, main(run))));
      expect(
        evaluate(
          String(preflight.concurrency["cancel-in-progress"]),
          main(run),
        ),
      ).toBe(false);
    }
    expect(groups.size).toBe(200);
    expect(preflight.concurrency.queue).toBeUndefined();
  });
});
