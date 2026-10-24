import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PR, Workspace } from "../../../platform/git";
import {
  loadSummaryGit,
  loadSummaryPr,
  resetSummaryGitForTesting,
  summaryGitSnapshotForTesting,
  summaryGitKey,
  invalidateSummaryGit,
} from "../summary-git-status-data";
import { forgetPrCachesForWorkspace } from "../../pr/pr-cache-forget";

const reads = vi.hoisted(() => ({
  status: vi.fn(),
  counts: vi.fn(),
  pr: vi.fn(),
}));
vi.mock("../../git-status-reads", () => ({
  statusForGeneration: reads.status,
  changeCountsForGeneration: reads.counts,
}));
vi.mock("../../../platform/git", () => ({ ghPrGet: reads.pr }));
const workspace = {
  id: "ws_a",
  path: "/a",
  repoRoot: "/repo",
  baseBranch: "main",
  prNumber: null,
  prState: null,
} as Workspace;
const status = {
  conflicted: [],
  conflictState: null,
  ahead: 3,
  behind: 0,
  upstream: "origin/feature",
  summary: { branch: "feature", base: { ref: "origin/main", behind: 4 } },
};
const counts = { all: 7, uncommitted: 5, staged: 2, unstaged: 3 };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  resetSummaryGitForTesting();
  vi.clearAllMocks();
  reads.status.mockResolvedValue(status);
  reads.counts.mockResolvedValue(counts);
  reads.pr.mockResolvedValue({ number: 7, state: "draft" } as PR);
});
afterEach(() => vi.useRealTimers());

describe("Summary Git observations", () => {
  it("shares concurrent and warm observations, keeping net counts and selected-base facts", async () => {
    const [one, two] = await Promise.all([
      loadSummaryGit(workspace, 1),
      loadSummaryGit(workspace, 1),
    ]);
    expect(one).toBe(two);
    expect(one).toMatchObject({
      all: 7,
      uncommitted: 5,
      base: { ref: "origin/main", behind: 4 },
    });
    expect(await loadSummaryGit(workspace, 1)).toBe(one);
    expect(reads.status).toHaveBeenCalledOnce();
    expect(reads.counts).toHaveBeenCalledOnce();
  });
  it("retains confirmed facts after a failed refresh and never fabricates a clean first read", async () => {
    const confirmed = await loadSummaryGit(workspace, 1);
    reads.status.mockRejectedValue(new Error("offline"));
    await expect(loadSummaryGit(workspace, 2)).rejects.toThrow("offline");
    expect(summaryGitSnapshotForTesting(workspace).data).toBe(confirmed);
    const other = { ...workspace, id: "ws_b", path: "/b" };
    await expect(loadSummaryGit(other, 2)).rejects.toThrow("offline");
    expect(summaryGitSnapshotForTesting(other).data).toBeUndefined();
  });
  it("fences a stale read after invalidation and publishes only the replacement generation", async () => {
    const old = deferred<typeof status>();
    reads.status.mockReturnValueOnce(old.promise);
    const first = loadSummaryGit(workspace, 1);
    await vi.waitFor(() => expect(reads.status).toHaveBeenCalledOnce());
    const next = loadSummaryGit(workspace, 2);
    old.resolve({ ...status, ahead: 99 });
    await first;
    expect(summaryGitSnapshotForTesting(workspace).data?.ahead).not.toBe(99);
    await next;
    expect(summaryGitSnapshotForTesting(workspace).data?.ahead).toBe(3);
    expect(reads.status).toHaveBeenCalledTimes(2);
  });
  it("isolates owner, path, base and PR identities, preserving A → B → A", async () => {
    const a = await loadSummaryGit(workspace, 1);
    const b = { ...workspace, id: "ws_b", path: "/b", organizationId: "org" };
    reads.counts.mockResolvedValueOnce({ ...counts, uncommitted: 1 });
    expect((await loadSummaryGit(b, 1)).uncommitted).toBe(1);
    expect(await loadSummaryGit(workspace, 1)).toBe(a);
    const keys = [
      workspace,
      b,
      { ...workspace, baseBranch: "release" },
      { ...workspace, prNumber: 7 },
      { ...workspace, organizationId: "org" },
    ].map(summaryGitKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("keeps GitHub reads independent and coalesced without reading checks", async () => {
    const owner = { ...workspace, prNumber: 7, prState: "draft" as const };
    const pending = deferred<PR>();
    reads.pr.mockReturnValueOnce(pending.promise);
    const first = loadSummaryPr(owner),
      second = loadSummaryPr(owner);
    expect(await loadSummaryGit(owner, 1)).toMatchObject({ uncommitted: 5 });
    pending.resolve({ number: 7, state: "draft" } as PR);
    expect(await first).toBe(await second);
    await loadSummaryGit(owner, 2);
    await loadSummaryPr(owner);
    expect(reads.pr).toHaveBeenCalledOnce();
    expect(await loadSummaryPr(workspace)).toBeNull();
  });
  it("bounds failed PR reads across Git refreshes and pointer warming, with an explicit retry escape", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const owner = { ...workspace, prNumber: 7, prState: "draft" as const };
    reads.pr.mockRejectedValue(new Error("GitHub unavailable"));
    await expect(loadSummaryPr(owner)).rejects.toThrow("GitHub unavailable");
    for (let generation = 1; generation <= 5; generation++) {
      vi.setSystemTime(Date.now() + 1_000);
      await loadSummaryGit(owner, generation);
      await loadSummaryPr(owner).catch(() => {});
    }
    expect(reads.pr).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 60_000);
    await expect(loadSummaryPr(owner)).rejects.toThrow("GitHub unavailable");
    expect(reads.pr).toHaveBeenCalledTimes(2);
    invalidateSummaryGit(owner);
    reads.pr.mockResolvedValue({ number: 7, state: "ready" } as PR);
    expect(await loadSummaryPr(owner)).toMatchObject({ state: "ready" });
    expect(reads.pr).toHaveBeenCalledTimes(3);
  });
  it("retains the confirmed PR through failures without retrying on every edit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const owner = { ...workspace, prNumber: 7, prState: "draft" as const };
    const confirmed = await loadSummaryPr(owner);
    vi.setSystemTime(Date.now() + 60_001);
    reads.pr.mockRejectedValue(new Error("GitHub unavailable"));
    await expect(loadSummaryPr(owner)).rejects.toThrow("GitHub unavailable");
    expect(await loadSummaryPr(owner)).toBe(confirmed);
    expect(reads.pr).toHaveBeenCalledTimes(2);
  });
  it("retires pending data when the workspace is deleted", async () => {
    const held = deferred<typeof status>();
    reads.status.mockReturnValueOnce(held.promise);
    const request = loadSummaryGit(workspace, 1);
    await vi.waitFor(() => expect(reads.status).toHaveBeenCalledOnce());
    forgetPrCachesForWorkspace(workspace.id);
    held.resolve(status);
    await request;
    expect(summaryGitSnapshotForTesting(workspace).data).toBeUndefined();
  });
  it("bounds inactive snapshots and refuses cloud before any read", async () => {
    await loadSummaryGit(workspace, 1);
    for (let i = 0; i < 70; i++)
      await loadSummaryGit(
        { ...workspace, id: `ws_${i}`, path: `/worktree/${i}` },
        1,
      );
    expect(summaryGitSnapshotForTesting(workspace).data).toBeUndefined();
    reads.status.mockClear();
    reads.pr.mockClear();
    const cloud = { ...workspace, placement: "cloud" as const, prNumber: 7 };
    await expect(loadSummaryGit(cloud, 1)).rejects.toThrow("local only");
    expect(await loadSummaryPr(cloud)).toBeNull();
    expect(reads.status).not.toHaveBeenCalled();
    expect(reads.pr).not.toHaveBeenCalled();
  });
});
