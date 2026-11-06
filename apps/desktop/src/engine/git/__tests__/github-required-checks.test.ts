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
  getPrChecks, rerunFailedPrChecks, setOctokitFactoryForTesting, setTokenStoreForTesting,
} from "../github";

const head = "a".repeat(40);
const run = (name: string, conclusion: string | null, slug = "github-actions") => ({
  name, status: conclusion ? "completed" : "in_progress", conclusion,
  details_url: `https://github.com/fixture/repository/actions/runs/1/job/${name.length}`,
  started_at: "2026-01-01T00:00:00Z", completed_at: conclusion ? "2026-01-01T00:01:00Z" : null,
  app: { slug },
});
function client() {
  return {
    pulls: {
      get: vi.fn(async () => ({ data: { number: 7, base: { ref: "main" }, head: { ref: "topic", sha: head } } })),
    },
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
