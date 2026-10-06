import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// CI (pull requests) runs a copy of Preflight's jobs under the same required
// check names. Until selective lanes replace that copy, the two must not
// drift: a check that changes in one place but not the other would gate pull
// requests differently from the exact-source run releases depend on.

type Step = { name?: string; run?: string; uses?: string; if?: string };
type Job = {
  name?: string;
  needs?: unknown;
  steps?: Step[];
  strategy?: unknown;
};
type Workflow = { jobs: Record<string, Job> };

const ROOT = path.resolve(import.meta.dirname, "../..");
const workflow = (file: string) =>
  load(
    readFileSync(path.join(ROOT, ".github/workflows", file), "utf8"),
  ) as Workflow;

// Pull requests skip the composer UI smoke (it runs after merge in Preflight)
// and add an advisory Prettier pass over their changed files.
const PR_ONLY_STEPS = new Set(["Prettier — changed files only (advisory)"]);
// The browser matrix runs after merge; its required aggregate exists in both.
const PREFLIGHT_ONLY_JOBS = new Set(["ui-smoke-shard"]);
const comparable = (job: Job) => ({
  name: job.name,
  needs: job.needs,
  strategy: job.strategy,
  steps: (job.steps ?? [])
    .filter((step) => !PR_ONLY_STEPS.has(step.name ?? ""))
    .map(({ name, run, uses, if: condition }) => ({
      name,
      run,
      uses,
      if: condition,
    })),
});

describe("CI and Preflight job parity", () => {
  const ci = workflow("ci.yml");
  const preflight = workflow("preflight.yml");

  it("defines the same jobs", () => {
    expect(Object.keys(ci.jobs).sort()).toEqual(
      Object.keys(preflight.jobs)
        .filter((id) => !PREFLIGHT_ONLY_JOBS.has(id))
        .sort(),
    );
  });

  it.each(
    Object.keys(workflow("preflight.yml").jobs).filter(
      (id) => id !== "ui-smoke" && !PREFLIGHT_ONLY_JOBS.has(id),
    ),
  )("keeps the %s job identical apart from pull-request-only steps", (id) => {
    expect(comparable(ci.jobs[id]!)).toEqual(comparable(preflight.jobs[id]!));
  });

  it("skips only the composer UI smoke on pull requests", () => {
    const placeholder = ci.jobs["ui-smoke"]!;
    expect(placeholder.name).toBe("ui-smoke (composer)");
    expect((placeholder as Job & { if?: string }).if).toBe(
      "github.event_name != 'pull_request'",
    );
    expect(preflight.jobs["ui-smoke"]!.name).toBe("ui-smoke (composer)");
    expect((preflight.jobs["ui-smoke"] as Job & { if?: string }).if).toBe(
      "always()",
    );
    expect(preflight.jobs["ui-smoke"]!.needs).toEqual(["ui-smoke-shard"]);
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
  });

  it.each(["success", "failure", "cancelled", "skipped"])(
    "keeps the required composer aggregate red unless the matrix succeeds (%s)",
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
