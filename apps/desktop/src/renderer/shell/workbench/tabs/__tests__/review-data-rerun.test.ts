// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PR, PrChecksResult } from "../../../../platform/git";
import type { ReviewProvider } from "../../../pr/review-provider";
import { forgetPrCachesForWorkspace } from "../../../pr/pr-cache-forget";
import { prefetchReviewLiveData, useReviewLiveData, type ReviewLiveData } from "../review-data";

const LOCAL = "local-rerun-workspace";
const CLOUD = "cloud://11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
const HEAD = "a".repeat(40);
const pr: PR = {
  number: 42, url: "https://github.com/owner/repo/pull/42", state: "ready", title: "Re-run",
  body: "", authorLogin: "octocat", baseBranch: "main", headBranch: "feature", headSha: HEAD,
  mergeableState: "clean", isMergeable: true, createdAt: 1, updatedAt: 2, mergedAt: null,
};
const checks: PrChecksResult = { checks: [], deployments: [], total: 0, passed: 0, failed: 0, pending: 0 };

function provider(cacheKey: string, overrides: Partial<ReviewProvider> = {}): ReviewProvider {
  return {
    family: "github", hostOrigin: "github.com", cacheKey, hostLabel: "GitHub",
    capabilities: { reviewNoun: "pull request", mergeMethods: [] },
    authStatus: async () => ({ authenticated: true, login: "octocat" }),
    getPr: async () => pr, getChecks: vi.fn(async () => checks), getCommits: async () => [], getTimeline: async () => [],
    addComment: async () => ({ id: 1, url: "" }), merge: async () => ({ sha: "abc" }), markReady: async () => pr,
    rerunFailedChecks: vi.fn(async () => ({ rerun: 2 })),
    ...overrides,
  };
}

let root: Root;
let host: HTMLDivElement;
let live: ReviewLiveData | null;
function Probe(props: { provider: ReviewProvider; workspaceId: string }) {
  live = useReviewLiveData({ ...props, prNumber: 42, refreshKey: 0, active: false });
  return null;
}
beforeEach(() => {
  live = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  for (const workspace of [LOCAL, CLOUD]) forgetPrCachesForWorkspace(workspace);
});

describe("Re-run failed", () => {
  it.each([["Local", LOCAL], ["cloud", CLOUD]])("re-runs the head the %s reader saw and rereads its checks", async (_label, workspaceId) => {
    const review = provider(`github:rerun-${workspaceId}`);
    await prefetchReviewLiveData(review, workspaceId, 42);
    await act(async () => root.render(createElement(Probe, { provider: review, workspaceId })));
    const reads = vi.mocked(review.getChecks).mock.calls.length;
    let rerun = 0;
    await act(async () => { rerun = await live!.rerunFailedChecks!(); });
    expect(rerun).toBe(2);
    expect(review.rerunFailedChecks).toHaveBeenCalledWith(
      { workspaceId, hostOrigin: "github.com", reviewRef: "42" },
      HEAD,
    );
    expect(vi.mocked(review.getChecks).mock.calls.length).toBe(reads + 1);
  });

  it("reads the checks again once GitHub has queued the restarted runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const review = provider("github:rerun-reread");
      await prefetchReviewLiveData(review, LOCAL, 42);
      await act(async () => root.render(createElement(Probe, { provider: review, workspaceId: LOCAL })));
      await act(async () => { await live!.rerunFailedChecks!(); });
      const reads = vi.mocked(review.getChecks).mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(3_999); });
      expect(vi.mocked(review.getChecks).mock.calls.length).toBe(reads);
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(vi.mocked(review.getChecks).mock.calls.length).toBe(reads + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses before the pull request's head is known", async () => {
    const review = provider("github:rerun-no-head", { getPr: async () => ({ ...pr, headSha: undefined }) });
    await prefetchReviewLiveData(review, LOCAL, 42);
    await act(async () => root.render(createElement(Probe, { provider: review, workspaceId: LOCAL })));
    await expect(live!.rerunFailedChecks!()).rejects.toThrow("Refresh the pull request before re-running its checks.");
    expect(review.rerunFailedChecks).not.toHaveBeenCalled();
  });

  it("is absent for a provider that can't re-run checks", async () => {
    const review = provider("github:rerun-absent", { rerunFailedChecks: undefined });
    await act(async () => root.render(createElement(Probe, { provider: review, workspaceId: LOCAL })));
    expect(live!.rerunFailedChecks).toBeNull();
  });
});
