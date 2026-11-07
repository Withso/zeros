import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const { load } = createRequire(import.meta.url)("js-yaml") as { load(value: string): any };
const workflow = (name: string) => {
  const path = new URL(`../../.github/workflows/${name}.yml`, import.meta.url);
  return existsSync(path) ? load(readFileSync(path, "utf8")) : undefined;
};
const allowed = (job: any, needs: any, cancelled = false) => Function("needs", "github", "cancelled", `return (${job.if.replaceAll("needs.runtime-resolve", 'needs["runtime-resolve"]')});`)(
  needs, { event: { repository: { fork: false } } }, () => cancelled);

describe("automatic runtime release graph", () => {
  it("keeps the destination lock on the dispatch wrapper, never its called runner", () => {
    const wrapper = workflow("runtime-release"), runner = workflow("runtime-release-run");
    expect(runner).toBeDefined();
    expect(Object.keys(wrapper.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(runner.on)).toEqual(["workflow_call"]);
    expect(wrapper.concurrency).toEqual({ group: "release-${{ inputs.channel }}", "cancel-in-progress": false });
    expect(runner.concurrency).toBeUndefined();
    expect(wrapper.jobs.runtime.uses).toBe("./.github/workflows/runtime-release-run.yml");
    expect(runner.jobs.release.concurrency).toEqual({ group: "hosted-mutation-${{ inputs.channel }}", "cancel-in-progress": false });
    expect(runner.jobs.approve.environment).toBe("production-approval");
    expect(runner.jobs.release.if).toContain("needs.approve.result == 'success'");
  });
  it("keeps Alpha runtime publication inside the existing complete publication lock", () => {
    const parent = workflow("release-alpha"), transaction = workflow("alpha-publication");
    expect(parent.jobs.publication.concurrency).toEqual({ group: "release-alpha", "cancel-in-progress": false });
    expect(parent.jobs.runtime).toBeUndefined();
    expect(transaction.jobs["runtime-resolve"]).toBeDefined();
    expect(transaction.jobs["runtime-resolve"].needs).toEqual(["entry", "hosted"]);
    expect(transaction.jobs.runtime.uses).toBe("./.github/workflows/runtime-release-run.yml");
    expect(transaction.jobs.runtime.name).toBe("Cloud runtime");
    expect(transaction.jobs.runtime.concurrency).toBeUndefined();
  });
  it.each(["alpha-publication", "release-beta", "release"])("gates %s feed on runtime completion or a verified no-op", name => {
    const release = workflow(name), publish = release.jobs.publish;
    expect(release.jobs["runtime-resolve"].env.RELEASE_CHANNEL).toBe(name === "alpha-publication" ? "alpha" : name === "release-beta" ? "beta" : "production");
    expect(release.jobs["runtime-resolve"].permissions).toEqual({ contents: "read", actions: "read" });
    expect(release.jobs["runtime-resolve"].env.GH_TOKEN).toBe("${{ github.token }}");
    expect(JSON.stringify(release.jobs["runtime-resolve"])).not.toContain("secrets.");
    expect(release.jobs.runtime.permissions).toEqual({ contents: "read", actions: "read" });
    expect(publish.needs).toEqual(expect.arrayContaining(["runtime-resolve", "runtime"]));
    const needs = Object.fromEntries(publish.needs.map((id: string) => [id, { result: "success", outputs: { action: "publish" } }]));
    expect(allowed(publish, needs)).toBe(true);
    expect(allowed(publish, needs, true)).toBe(false);
    needs.runtime.result = "skipped";
    expect(allowed(publish, needs)).toBe(false);
    needs["runtime-resolve"].outputs.action = "skip";
    expect(allowed(publish, needs)).toBe(true);
    for (const id of publish.needs) {
      for (const result of ["failure", "cancelled"]) {
        expect(allowed(publish, { ...needs, [id]: { ...needs[id], result } })).toBe(false);
      }
    }
  });
  it("waits for full runtime CI separately from Alpha's optional fast admission", () => {
    const runner = workflow("runtime-release-run");
    expect(runner).toBeDefined();
    expect(runner.jobs.build.needs).toBe("ci");
    expect(runner.jobs.ci["timeout-minutes"]).toBeGreaterThanOrEqual(115);
    expect(runner.jobs.ci.steps.some((step: any) => step.run === "pnpm exec tsx scripts/release/runtime-auto-cli.ts --wait-ci")).toBe(true);
    expect(JSON.stringify(runner.jobs.ci)).not.toMatch(/secrets\.|ZEROS_ALPHA_CI_FAST_PATH/);
  });
});
