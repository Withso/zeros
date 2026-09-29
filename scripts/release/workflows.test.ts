import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
const workflow = (name: string) => readFileSync(`.github/workflows/${name}.yml`, "utf8");
function job(text: string, name: string) {
  return text.split(`\n  ${name}:\n`)[1]?.split(/\n {2}[a-z][a-z_-]+:\n/)[0] ?? "";
}
describe("release dependency and authority contracts", () => {
  it("includes the release controller source in normal Git discovery", () => {
    expect(spawnSync("git", ["check-ignore", "--no-index", "--quiet", "scripts/release/cli.ts"]).status).toBe(1);
  });
  it.each([["release-alpha", "alpha"], ["release-beta", "beta"], ["release", "production"]])("serializes %s through desktop publication after hosted success", (name, channel) => {
    const text = workflow(name);
    expect(text).toContain(`group: release-${channel}\n  cancel-in-progress: false`);
    const hosted = job(text, "hosted");
    expect(hosted).toContain("needs: test"); expect(hosted).toContain("uses: ./.github/workflows/hosted-promotion.yml");
    expect(hosted).toContain("source_sha: ${{ github.sha }}");
    expect(job(text, channel === "production" ? "build" : channel)).toContain("needs: [test, hosted]");
    if (channel === "production") { expect(job(text, "build")).toContain("environment: production"); expect(job(text, "notarize")).toContain("needs: build"); }
  });
  it("has a non-cancelling mutation lock, exact checkout, and success-only receipt", () => {
    const text = workflow("hosted-promotion"), promote = job(text, "promote");
    expect(text).toContain("workflow_call:");
    expect(job(text, "guard")).toContain("GH_TOKEN: ${{ github.token }}");
    expect(promote).toContain("needs.guard.outputs.enabled == 'true'");
    expect(promote).toContain("group: hosted-mutation-${{ inputs.channel }}\n      cancel-in-progress: false");
    expect(promote).toContain("ref: ${{ inputs.source_sha }}");
    expect(promote).toContain("cli.ts --plan\n          pnpm exec tsx scripts/release/cli.ts --execute");
    expect(promote.split("- name: Save success receipt")[1]).not.toContain("always()");
    expect(promote).toContain("include-hidden-files: true");
  });
  it("labels the worker artifact a plan and shares the mutation lock", () => {
    const text = workflow("cloud-worker-promotion");
    expect(text).toContain("workflow_dispatch:"); expect(text).toContain("workflow_call:");
    expect(text).toContain("group: hosted-mutation-${{ inputs.channel }}");
    expect(text).toContain("name: worker-plan-"); expect(text).not.toContain("name: worker-promotion-");
    expect(text).toContain("ZEROS_WORKER_PROMOTION: ${{ vars.ZEROS_WORKER_PROMOTION }}");
  });
  it("V6: revalidates publication in all desktop writers, including notarization-only retries", () => {
    for (const [name, channel, publish] of [["release-alpha", "alpha", 'Publish rolling "alpha" prerelease'], ["release-beta", "beta", 'Publish rolling "beta" prerelease'], ["release", "notarize", "Publish GitHub release"]]) {
      const text = job(workflow(name), channel), step = text.split(`- name: ${publish}`)[1]?.split(/\n {6}- name:/)[0] ?? "";
      expect(step).toContain("pnpm exec tsx scripts/release/publication-cli.ts");
      expect(text).toContain("actions: read");
    }
    expect(job(workflow("release"), "notarize")).toContain("ref: ${{ github.sha }}");
    expect(job(workflow("hosted-promotion"), "guard")).toContain("fetch-tags: true");
  });
  it("V6: advances rolling Git tag refs after their assets are published", () => {
    for (const name of ["release-alpha", "release-beta"]) {
      const text = workflow(name);
      expect(text).toContain('git/refs/tags/$TAG');
      expect(text.indexOf('git/refs/tags/$TAG')).toBeGreaterThan(text.indexOf('gh release upload "$TAG"'));
    }
  });
});
