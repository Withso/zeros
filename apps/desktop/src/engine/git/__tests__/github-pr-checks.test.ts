import type { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }));
vi.mock("../git-exec", async (original) => ({
  ...await original<typeof import("../git-exec")>(),
  runFile: mocks.runFile,
}));
vi.mock("../worktree", async (original) => ({
  ...await original<typeof import("../worktree")>(),
  getWorkspace: (id: string) => ({
    id, repoRoot: `/fixtures/${id}`, branch: "topic", prNumber: 7,
    prState: "ready", prUrl: "https://github.com/fixture/repository/pull/7",
  }),
}));
vi.mock("../state", async (original) => ({
  ...await original<typeof import("../state")>(),
  advanceLifecycle: vi.fn(), updateWorkspace: vi.fn(),
}));
vi.mock("../../settings/repo-git", () => ({ resolveRepoGit: () => ({ remote: "origin" }) }));

import {
  commitChecksFromRollup, getPrChecks, getPrCommits, rerunFailedPrChecks, setOctokitFactoryForTesting, setTokenStoreForTesting,
} from "../github";

const head = "a".repeat(40);
const run = (name: string, conclusion: string | null, slug = "github-actions") => ({
  name, status: conclusion ? "completed" : "in_progress", conclusion,
  details_url: `https://github.com/fixture/repository/actions/runs/1/job/${name.length}`,
  started_at: "2026-01-01T00:00:00Z", completed_at: conclusion ? "2026-01-01T00:01:00Z" : null,
  app: { slug },
});
const commit = (sha: string) => ({
  sha, author: { login: "octocat", avatar_url: null },
  commit: { message: `Commit ${sha.slice(0, 7)}`, author: { name: "Octo Cat", date: "2026-01-01T00:00:00Z" } },
});
function client() {
  return {
    pulls: {
      get: vi.fn(async () => ({ data: { number: 7, base: { ref: "main" }, head: { ref: "topic", sha: head } } })),
      listCommits: vi.fn(async () => ({ data: ["1", "2", "3"].map((ch) => commit(ch.repeat(40))) })),
    },
    graphql: vi.fn(async () => ({
      repository: { pullRequest: { commits: { nodes: [
        { commit: { oid: "1".repeat(40), additions: 1, deletions: 0, changedFilesIfAvailable: 1, statusCheckRollup: { state: "FAILURE" }, authors: { nodes: [] } } },
        { commit: { oid: "2".repeat(40), additions: 2, deletions: 1, changedFilesIfAvailable: 1, statusCheckRollup: { state: "SUCCESS" }, authors: { nodes: [] } } },
        { commit: { oid: "3".repeat(40), additions: 0, deletions: 4, changedFilesIfAvailable: 2, statusCheckRollup: null, authors: { nodes: [] } } },
      ] } } },
    })),
    checks: {
      listForRef: vi.fn(async () => ({
        data: { check_runs: [run("test", "failure"), run("lint", "success"), run("CodeRabbit", "failure", "coderabbitai")] },
      })),
    },
    repos: {
      listCommitStatusesForRef: vi.fn(async () => ({ data: [] })),
      getBranch: vi.fn(async () => ({
        data: { protection: { required_status_checks: { contexts: ["lint"], checks: [{ context: "test" }] } } },
      })),
    },
    request: vi.fn(async () => ({
      data: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "Preview deployment" }] } }],
    })),
    actions: {
      listWorkflowRunsForRepo: vi.fn(async () => ({
        data: {
          workflow_runs: [
            { id: 11, status: "completed", conclusion: "failure", head_sha: head },
            { id: 12, status: "completed", conclusion: "success", head_sha: head },
            { id: 13, status: "completed", conclusion: "timed_out", head_sha: head },
            { id: 14, status: "in_progress", conclusion: null, head_sha: head },
          ],
        },
      })),
      reRunWorkflowFailedJobs: vi.fn(async (_args: { run_id: number }) => ({ status: 201 })),
    },
  };
}
let oct: ReturnType<typeof client>;
beforeEach(() => {
  mocks.runFile.mockReset().mockResolvedValue({ stdout: "https://github.com/fixture/repository.git\n", stderr: "" });
  oct = client();
  setTokenStoreForTesting({ get: async () => "fixture", set: async () => {}, clear: async () => {} });
  setOctokitFactoryForTesting(() => oct as unknown as Octokit);
});
afterEach(() => { setTokenStoreForTesting(null); setOctokitFactoryForTesting(null); vi.restoreAllMocks(); });

describe("Local pull request checks", () => {
  it("marks required checks, lists the ones not reported and names the re-runnable ones", async () => {
    const result = await getPrChecks({ workspaceId: "ws-required", prNumber: 7 });
    expect(oct.repos.getBranch).toHaveBeenCalledWith({ owner: "fixture", repo: "repository", branch: "main" });
    expect(result.checks.map(({ name, required, rerunnable }) => ({ name, required, rerunnable }))).toEqual([
      { name: "test", required: true, rerunnable: true },
      { name: "lint", required: true, rerunnable: true },
      { name: "CodeRabbit", required: false, rerunnable: false },
    ]);
    expect(result.expected).toEqual([{ name: "Preview deployment" }]);
  });

  it("keeps the checks when branch protection and rules cannot be read", async () => {
    oct.repos.getBranch.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    oct.request.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    const result = await getPrChecks({ workspaceId: "ws-unknown", prNumber: 7 });
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every((check) => check.required === undefined)).toBe(true);
    expect(result).not.toHaveProperty("expected");
  });

  it("re-runs the failed workflow runs of the head it was asked about", async () => {
    await expect(rerunFailedPrChecks({ workspaceId: "ws-rerun", prNumber: 7, headSha: head })).resolves.toEqual({ rerun: 2 });
    expect(oct.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(expect.objectContaining({ owner: "fixture", repo: "repository", head_sha: head }));
    expect(oct.actions.reRunWorkflowFailedJobs.mock.calls.map(([args]) => args.run_id)).toEqual([11, 13]);
  });

  it("counts the runs that restarted when GitHub refuses one, and fails only when it refuses all", async () => {
    const refused = Object.assign(new Error("This workflow run cannot be rerun"), { status: 403 });
    oct.actions.reRunWorkflowFailedJobs.mockImplementation(async ({ run_id }) => {
      if (run_id === 11) throw refused;
      return { status: 201 };
    });
    await expect(rerunFailedPrChecks({ workspaceId: "ws-partial", prNumber: 7, headSha: head })).resolves.toEqual({ rerun: 1 });
    oct.actions.reRunWorkflowFailedJobs.mockRejectedValue(refused);
    await expect(rerunFailedPrChecks({ workspaceId: "ws-refused", prNumber: 7, headSha: head })).rejects.toBeTruthy();
  });

  it("refuses to re-run when the pull request moved to another head", async () => {
    await expect(rerunFailedPrChecks({ workspaceId: "ws-moved", prNumber: 7, headSha: "b".repeat(40) }))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(oct.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  });
});

describe("Local pull request commits", () => {
  it("names each commit's combined check result", async () => {
    const commits = await getPrCommits({ workspaceId: "ws-commits", prNumber: 7 });
    expect(commits.map(({ sha, checks }) => [sha[0], checks])).toEqual([["1", "failed"], ["2", "passed"], ["3", null]]);
  });

  it("keeps the commits when their stats and checks cannot be read", async () => {
    oct.graphql.mockRejectedValue(new Error("GraphQL unavailable"));
    const commits = await getPrCommits({ workspaceId: "ws-commits-down", prNumber: 7 });
    expect(commits).toHaveLength(3);
    expect(commits.every((c) => c.checks === null && c.additions === null)).toBe(true);
  });

  it.each([
    ["SUCCESS", "passed"], ["FAILURE", "failed"], ["ERROR", "failed"],
    ["PENDING", "pending"], ["EXPECTED", "pending"], [undefined, null], ["SOMETHING_NEW", null],
  ])("reads GitHub's %s rollup as %s", (state, checks) => {
    expect(commitChecksFromRollup(state)).toBe(checks);
  });
});
