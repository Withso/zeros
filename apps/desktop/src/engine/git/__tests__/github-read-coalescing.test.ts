import type { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runFile: vi.fn(), remote: "origin" }));
vi.mock("../git-exec", async (original) => ({
  ...await original<typeof import("../git-exec")>(),
  runFile: mocks.runFile,
}));
vi.mock("../worktree", async (original) => ({
  ...await original<typeof import("../worktree")>(),
  getWorkspace: (id: string) => ({
    id, repoRoot: `/fixtures/${id}`, branch: "topic", prNumber: null,
    prState: "ready", prUrl: "https://github.com/fixture/repository/pull/1",
  }),
}));
vi.mock("../state", async (original) => ({
  ...await original<typeof import("../state")>(),
  advanceLifecycle: vi.fn(), updateWorkspace: vi.fn(),
}));
vi.mock("../../settings/repo-git", () => ({ resolveRepoGit: () => ({ remote: mocks.remote }) }));

import {
  getPr, getPrChecks, getPrReviews, resolveGithubWorkspaceRepository,
  setOctokitFactoryForTesting, setTokenStoreForTesting, syncWorkspacePr,
} from "../github";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function pr(number = 1) {
  return {
    number, html_url: `https://github.com/fixture/repository/pull/${number}`,
    state: "open", title: "Fixture", body: "", user: { login: "fixture" },
    base: { ref: "main" }, head: { ref: "topic", sha: "a".repeat(40), repo: { id: 123 } },
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}
function client() {
  return {
    pulls: {
      get: vi.fn(async ({ pull_number }: { pull_number: number }) => ({ data: pr(pull_number) })),
      list: vi.fn(async () => ({ data: [pr()] })),
      listReviews: vi.fn(async () => ({ data: [] })),
    },
    checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
    repos: {
      get: vi.fn(async () => ({ data: { id: 123, name: "repository", owner: { login: "fixture" } } })),
      listCommitStatusesForRef: vi.fn(async () => ({ data: [] })),
    },
    issues: { listComments: vi.fn(async () => ({ data: [] })) },
  };
}
let token: string | null;
let oct: ReturnType<typeof client>;
beforeEach(() => {
  token = "fixture-a";
  mocks.remote = "origin";
  mocks.runFile.mockReset().mockResolvedValue({ stdout: "https://github.com/fixture/repository.git\n", stderr: "" });
  oct = client();
  setTokenStoreForTesting({ get: async () => token, set: async (value) => { token = value; }, clear: async () => { token = null; } });
  setOctokitFactoryForTesting(() => oct as unknown as Octokit);
});
afterEach(() => { setTokenStoreForTesting(null); setOctokitFactoryForTesting(null); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Local GitHub observation sharing", () => {
  it("shares one refresh generation without retaining results across explicit refreshes", async () => {
    vi.useFakeTimers();
    oct.pulls.get.mockImplementation(async ({ pull_number }) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { data: pr(pull_number) };
    });
    const gate = deferred();
    mocks.runFile.mockImplementation(async () => { await gate.promise; return { stdout: "https://github.com/fixture/repository.git\n", stderr: "" }; });
    const requests = [getPr({ workspaceId: "one", prNumber: 1 }),
      ...Array.from({ length: 2 }, () => getPrChecks({ workspaceId: "one", prNumber: 1 })),
      ...Array.from({ length: 2 }, () => getPrReviews({ workspaceId: "one", prNumber: 1 })),
      ...Array.from({ length: 2 }, () => syncWorkspacePr("one"))];
    const remoteCalls = mocks.runFile.mock.calls.length;
    gate.resolve();
    await vi.runAllTimersAsync();
    await Promise.all(requests);
    const apiCounts = [oct.pulls.get, oct.pulls.list, oct.pulls.listReviews,
      oct.checks.listForRef, oct.repos.listCommitStatusesForRef, oct.issues.listComments, oct.repos.get]
      .map((method) => method.mock.calls.length);
    console.info("Local PR synthetic refresh", JSON.stringify({ remoteCalls, apiCalls: apiCounts.reduce((a, b) => a + b, 0) }));
    expect(remoteCalls).toBe(1);
    expect(apiCounts).toEqual([1, 1, 1, 1, 1, 1, 1]);
    // Discovery coalesces a second remote read before publishing its result.
    expect(mocks.runFile).toHaveBeenCalledTimes(2);
    const fresh = getPrChecks({ workspaceId: "one", prNumber: 1 });
    await vi.runAllTimersAsync();
    await fresh;
    expect(mocks.runFile).toHaveBeenCalledTimes(3);
    expect(oct.pulls.get).toHaveBeenCalledTimes(2);
    expect(oct.checks.listForRef).toHaveBeenCalledTimes(2);
  });

  it("creates only one client for concurrent reads of the current credential", async () => {
    const gate = deferred();
    const entered = deferred();
    const factory = vi.fn(async () => { entered.resolve(); await gate.promise; return oct as unknown as Octokit; });
    setOctokitFactoryForTesting(factory);
    const requests = Array.from({ length: 4 }, () => getPr({ workspaceId: "one", prNumber: 1 }, { owner: "fixture", repo: "repository" }));
    await entered.promise;
    gate.resolve();
    await Promise.all(requests);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(oct.pulls.get).toHaveBeenCalledTimes(1);
  });

  it("shares canonical repository resolution without caching a transfer across refreshes", async () => {
    const gate = deferred();
    const entered = deferred();
    oct.repos.get.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return { data: { id: 123, owner: { login: "new-owner" }, name: "renamed" } };
    });
    const requests = [resolveGithubWorkspaceRepository("one"), resolveGithubWorkspaceRepository("one")];
    // A resolver that skips the API must fail an assertion, not hang waiting
    // for a request it never starts when this regression is replayed.
    await Promise.race([entered.promise, Promise.all(requests)]);
    expect(oct.repos.get).toHaveBeenCalledExactlyOnceWith({ owner: "fixture", repo: "repository" });
    gate.resolve();
    expect(await Promise.all(requests)).toEqual([
      { owner: "new-owner", repo: "renamed", remote: "origin" },
      { owner: "new-owner", repo: "renamed", remote: "origin" },
    ]);
    oct.repos.get.mockResolvedValueOnce({ data: { id: 123, owner: { login: "successor" }, name: "renamed-again" } });
    await expect(resolveGithubWorkspaceRepository("one")).resolves.toEqual({ owner: "successor", repo: "renamed-again", remote: "origin" });
    expect(oct.repos.get).toHaveBeenCalledTimes(2);
  });

  it("separates repositories, remotes, PRs and credential replacements, and rejects sign-out", async () => {
    const gate = deferred();
    const entered = deferred();
    const othersEntered = deferred();
    const replacement = client();
    setOctokitFactoryForTesting((selected) => (selected === "fixture-a" ? oct : replacement) as unknown as Octokit);
    oct.pulls.get.mockImplementation(async ({ pull_number }) => {
      entered.resolve();
      if (oct.pulls.get.mock.calls.length === 3) othersEntered.resolve();
      await gate.promise;
      return { data: pr(pull_number) };
    });
    const first = getPr({ workspaceId: "one", prNumber: 1 });
    await entered.promise;
    const otherPr = getPr({ workspaceId: "one", prNumber: 2 });
    const otherRepository = getPr({ workspaceId: "two", prNumber: 1 }, { owner: "fixture", repo: "other" });
    await othersEntered.promise;
    token = "fixture-b";
    const switched = await getPr({ workspaceId: "one", prNumber: 1 });
    expect(switched.number).toBe(1);
    expect(replacement.pulls.get).toHaveBeenCalledTimes(1);
    token = null;
    await expect(getPr({ workspaceId: "one", prNumber: 1 })).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
    gate.resolve(); await Promise.all([first, otherPr, otherRepository]);
    mocks.runFile.mockClear();
    token = "fixture-b";
    const originalRemote = resolveGithubWorkspaceRepository("one");
    mocks.remote = "upstream";
    const nextRemote = resolveGithubWorkspaceRepository("one");
    await Promise.all([originalRemote, nextRemote]);
    expect(mocks.runFile).toHaveBeenCalledTimes(2);
  });

  it("retires failures so the next explicit read can recover", async () => {
    vi.useFakeTimers();
    oct.pulls.get.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw Object.assign(new Error("unavailable"), { status: 503 });
    });
    const pending = Promise.allSettled(Array.from({ length: 2 }, () => getPr({ workspaceId: "one", prNumber: 1 })));
    await vi.runAllTimersAsync();
    const results = await pending;
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(oct.pulls.get).toHaveBeenCalledTimes(1);
    await expect(getPr({ workspaceId: "one", prNumber: 1 })).resolves.toMatchObject({ number: 1 });
    expect(oct.pulls.get).toHaveBeenCalledTimes(2);
  });

});
