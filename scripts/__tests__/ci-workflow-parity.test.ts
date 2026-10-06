import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// CI (pull requests) runs a copy of Preflight's jobs under the same required
// check names. Until selective lanes replace that copy, the two must not
// drift: a check that changes in one place but not the other would gate pull
// requests differently from the exact-source run releases depend on.

type Step = { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string> };
type Job = { name?: string; needs?: unknown; steps?: Step[]; strategy?: unknown; if?: string };
type Workflow = { jobs: Record<string, Job> };

const ROOT = path.resolve(import.meta.dirname, "../..");
const workflow = (file: string) =>
  load(readFileSync(path.join(ROOT, ".github/workflows", file), "utf8")) as Workflow;

// Pull requests skip the composer UI smoke (it runs after merge in Preflight)
// and add an advisory Prettier pass over their changed files.
const PR_ONLY_STEPS = new Set(["Prettier — changed files only (advisory)"]);
const PREFLIGHT_ONLY_JOBS = new Set(["alpha-gate"]);
const comparable = (job: Job) => ({
  name: job.name,
  needs: job.needs,
  strategy: job.strategy,
  steps: (job.steps ?? [])
    .filter((step) => !PR_ONLY_STEPS.has(step.name ?? ""))
    .map(({ name, run, uses, if: condition }) => ({ name, run, uses, if: condition })),
});

describe("CI and Preflight job parity", () => {
  const ci = workflow("ci.yml");
  const preflight = workflow("preflight.yml");

  it("defines the same jobs", () => {
    expect(Object.keys(ci.jobs).sort()).toEqual(Object.keys(preflight.jobs).filter(id => !PREFLIGHT_ONLY_JOBS.has(id)).sort());
  });

  it.each(Object.keys(workflow("preflight.yml").jobs).filter((id) => id !== "ui-smoke" && !PREFLIGHT_ONLY_JOBS.has(id)))(
    "keeps the %s job identical apart from pull-request-only steps",
    (id) => {
      expect(comparable(ci.jobs[id]!)).toEqual(comparable(preflight.jobs[id]!));
    },
  );

  it("admits Alpha only through all five successful critical aggregates", () => {
    const gate = preflight.jobs["alpha-gate"];
    expect(gate).toBeDefined();
    expect(gate!.name).toBe("alpha-gate");
    expect(gate!.if).toBe("always()");
    expect(gate!.needs).toEqual(["quality", "test", "build", "control-plane", "secret-scan"]);
    expect(ci.jobs["alpha-gate"]).toBeUndefined();
    const step = gate!.steps![0]!;
    expect(step.env).toEqual({
      QUALITY_RESULT: "${{ needs.quality.result }}",
      TEST_RESULT: "${{ needs.test.result }}",
      BUILD_RESULT: "${{ needs.build.result }}",
      CONTROL_PLANE_RESULT: "${{ needs.control-plane.result }}",
      SECRET_SCAN_RESULT: "${{ needs.secret-scan.result }}",
    });
    const success = Object.fromEntries(Object.keys(step.env!).map(key => [key, "success"]));
    const run = (env: Record<string, string>) => spawnSync("bash", ["-c", step.run!], { env: { ...process.env, ...env }, encoding: "utf8" });
    expect(run(success).status).toBe(0);
    for (const key of Object.keys(success)) {
      for (const result of ["failure", "cancelled", "skipped", ""]) {
        const rejected = run({ ...success, [key]: result });
        expect(rejected.status, `${key}=${result}`).toBe(1);
        expect(rejected.stdout).toContain("::error::");
      }
    }
  });

  it("skips only the composer UI smoke on pull requests", () => {
    const placeholder = ci.jobs["ui-smoke"]!;
    expect(placeholder.name).toBe("ui-smoke (composer)");
    expect((placeholder as Job & { if?: string }).if).toBe("github.event_name != 'pull_request'");
    expect(preflight.jobs["ui-smoke"]!.name).toBe("ui-smoke (composer)");
    expect((preflight.jobs["ui-smoke"] as Job & { if?: string }).if).toBeUndefined();
  });
});
