import { describe, expect, it, vi } from "vitest";
import { pushCoveredByMergeGroup } from "./merge-group-evidence-cli";

const sha = "a".repeat(40), repository = "example/zeros";
const env = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, GITHUB_REPOSITORY: repository };
const queue = `gh-readonly-queue/main/pr-9-${"c".repeat(40)}`;
const group = { id: 90, run_attempt: 1, name: "Preflight", path: ".github/workflows/preflight.yml", head_sha: sha, head_branch: queue,
  event: "merge_group", status: "completed", conclusion: "success", repository: { full_name: repository }, head_repository: { full_name: repository } };
const jobs = ["alpha-gate", "quality", "test", "build", "control plane", "secret scan (PR commit range)", "source-sync workload (macOS)"]
  .map((name, id) => ({ id, run_id: 90, run_attempt: 1, head_sha: sha, head_branch: queue, name, status: "completed", conclusion: "success" }));
const reader = (run: any = group) => vi.fn(async (route: string) => route.includes("event=merge_group")
  ? { total_count: run ? 1 : 0, workflow_runs: run ? [run] : [] }
  : route.includes("/jobs") ? { total_count: jobs.length, jobs } : route === "/actions/runs/90" ? run : null);

describe("push Preflight merge-group shortcut", () => {
  it("skips duplicated workloads only for a push of exactly a green merge-group commit", async () => {
    await expect(pushCoveredByMergeGroup(env, reader())).resolves.toEqual({ runId: 90, attempt: 1 });
  });

  it.each([
    ["a direct push without a merge group (admin or bot)", env, null],
    ["a failed merge group", env, { ...group, conclusion: "failure" }],
    ["a merge group for another commit", env, { ...group, head_sha: "b".repeat(40) }],
    ["a release-branch push", { ...env, GITHUB_REF: "refs/heads/release/1.2.3" }, group],
    ["a merge-group event itself", { ...env, GITHUB_EVENT_NAME: "merge_group" }, group],
    ["a pull request call", { ...env, GITHUB_EVENT_NAME: "pull_request" }, group],
  ])("runs everything for %s", async (_label, environment, run) => {
    await expect(pushCoveredByMergeGroup(environment, reader(run))).resolves.toBeNull();
  });

  it("runs everything when the evidence read fails", async () => {
    await expect(pushCoveredByMergeGroup(env, vi.fn(async () => { throw new Error("network"); }))).resolves.toBeNull();
  });
});
