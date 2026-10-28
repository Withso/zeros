import { describe, expect, it, vi } from "vitest";

import type {
  AuthStatusResult,
  PR,
  PrChecksResult,
  PrCommitSummary,
  PrTimelineItem,
} from "../../../../platform/git";
import type { ReviewProvider } from "../../../pr/review-provider";
import { invalidateCloudGithubPrScope } from "../../../../platform/cloud-github-pr-scope";
import { forgetPrCachesForWorkspace } from "../../../pr/pr-cache-forget";
import {
  peekReviewLiveData,
  prefetchReviewLiveData,
  shouldPollReviewChecks,
  REVIEW_REFRESH_KEY_MIN_INTERVAL_MS,
  refreshKeyRefreshDelay,
  shouldRefreshReviewSnapshot,
  shouldRefreshReviewOnResume,
} from "../review-data";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pr(title: string): PR {
  return {
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    state: "ready",
    title,
    body: "",
    authorLogin: "octocat",
    baseBranch: "main",
    headBranch: "feature",
    mergeableState: "clean",
    isMergeable: true,
    createdAt: 1,
    updatedAt: 2,
    mergedAt: null,
  };
}

const emptyChecks: PrChecksResult = {
  checks: [],
  deployments: [],
  total: 0,
  passed: 0,
  failed: 0,
  pending: 0,
};

async function settleCalls(expected: () => boolean): Promise<void> {
  for (let index = 0; index < 20 && !expected(); index += 1) {
    await Promise.resolve();
  }
  expect(expected()).toBe(true);
}

describe("Review live-data races", () => {
  const cloudWorkspace = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  const cloudProvider = (cacheKey: string, getPr: ReviewProvider["getPr"]): ReviewProvider => ({
    family: "github", hostOrigin: "github.com", cacheKey, hostLabel: "GitHub",
    capabilities: { reviewNoun: "pull request", mergeMethods: [] },
    authStatus: async () => ({ authenticated: true, login: "octocat" }),
    getPr, getChecks: async () => emptyChecks, getCommits: async () => [], getTimeline: async () => [],
    addComment: async () => ({ id: 1, url: "" }), merge: async () => ({ sha: "abc" }), markReady: async () => pr("ready"),
  });

  it("retires cloud review content on connection changes while retaining Local content", async () => {
    const provider = cloudProvider("github:connection-lifetime", async () => pr("confirmed"));
    await prefetchReviewLiveData(provider, cloudWorkspace, 42);
    await prefetchReviewLiveData(provider, "local-workspace", 42);
    invalidateCloudGithubPrScope("11111111-1111-4111-8111-111111111111");
    expect(peekReviewLiveData(provider, cloudWorkspace, 42)).toMatchObject({ pr: null, login: null, authed: null });
    expect(peekReviewLiveData(provider, "local-workspace", 42).pr?.title).toBe("confirmed");
  });

  it("does not resurrect an explicitly retired review from its in-flight read", async () => {
    const pending = deferred<PR>(), getPr = vi.fn(() => pending.promise);
    const provider = cloudProvider("github:retired-flight", getPr);
    const loading = prefetchReviewLiveData(provider, cloudWorkspace, 42);
    await settleCalls(() => getPr.mock.calls.length === 1);
    forgetPrCachesForWorkspace(cloudWorkspace);
    pending.resolve(pr("retired"));
    await loading;
    expect(peekReviewLiveData(provider, cloudWorkspace, 42).pr).toBeNull();
    expect(getPr).toHaveBeenCalledOnce();
  });

  it("keeps the replacement connection's review when its predecessor resolves late", async () => {
    const pending = deferred<PR>(), getPr = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(pr("current"));
    const provider = cloudProvider("github:replaced-flight", getPr);
    const loading = prefetchReviewLiveData(provider, cloudWorkspace, 42);
    await settleCalls(() => getPr.mock.calls.length === 1);
    invalidateCloudGithubPrScope("11111111-1111-4111-8111-111111111111");
    await prefetchReviewLiveData(provider, cloudWorkspace, 42);
    pending.resolve(pr("retired"));
    await loading;
    expect(peekReviewLiveData(provider, cloudWorkspace, 42).pr?.title).toBe("current");
    expect(getPr).toHaveBeenCalledTimes(2);
  });

  it("retains the confirmed PR alongside a failed refresh and clears the failure on recovery", async () => {
    const getPr = vi.fn(async () => pr("confirmed"));
    const provider: ReviewProvider = {
      family: "github",
      hostOrigin: "github.com",
      cacheKey: "github:retained-status",
      hostLabel: "GitHub",
      capabilities: {
        reviewNoun: "pull request",
        mergeMethods: [{ id: "merge", label: "Merge" }],
      },
      authStatus: async () => ({
        authenticated: true,
        login: "octocat",
      }),
      getPr,
      getChecks: async () => emptyChecks,
      getCommits: async () => [],
      getTimeline: async () => [],
      addComment: async () => ({ id: 1, url: "" }),
      merge: async () => ({ sha: "abc" }),
      markReady: async () => pr("ready"),
    };
    await prefetchReviewLiveData(provider, "workspace-retained", 42, {
      force: true,
    });
    const confirmed = peekReviewLiveData(provider, "workspace-retained", 42).pr;
    getPr.mockRejectedValueOnce(new Error("engine disconnected"));
    await prefetchReviewLiveData(provider, "workspace-retained", 42, {
      force: true,
    });
    expect(
      peekReviewLiveData(provider, "workspace-retained", 42),
    ).toMatchObject({ pr: confirmed, error: "engine disconnected" });
    expect(
      peekReviewLiveData(provider, "other-workspace", 42).error,
    ).toBeNull();
    await prefetchReviewLiveData(provider, "workspace-retained", 42, {
      force: true,
    });
    expect(
      peekReviewLiveData(provider, "workspace-retained", 42).error,
    ).toBeNull();
  });
  it("keeps bounded external refreshes live for terminal review resources", () => {
    expect(shouldRefreshReviewSnapshot("merged", "interval")).toBe(true);
    expect(shouldRefreshReviewSnapshot("closed", "resume")).toBe(true);
    expect(shouldRefreshReviewSnapshot("merged", "refresh-key")).toBe(false);
  });

  it("keeps polling pending checks after the PR becomes terminal", () => {
    expect(
      shouldPollReviewChecks({
        active: true,
        pending: true,
        effectiveState: "merged",
      }),
    ).toBe(true);
    expect(
      shouldPollReviewChecks({
        active: true,
        pending: false,
        effectiveState: "merged",
      }),
    ).toBe(false);
  });

  it("refreshes promptly on app resume without refreshing focus thrash", () => {
    expect(
      shouldRefreshReviewOnResume({ loadedAt: 10_000, stale: false }, 11_999),
    ).toBe(false);
    expect(
      shouldRefreshReviewOnResume({ loadedAt: 10_000, stale: false }, 12_000),
    ).toBe(true);
    expect(
      shouldRefreshReviewOnResume({ loadedAt: 11_999, stale: true }, 12_000),
    ).toBe(true);
  });

  it("discards an in-flight generation invalidated by a newer refresh", async () => {
    const prs: ReturnType<typeof deferred<PR>>[] = [];
    const checks: ReturnType<typeof deferred<PrChecksResult>>[] = [];
    const commits: ReturnType<typeof deferred<PrCommitSummary[]>>[] = [];
    const timelines: ReturnType<typeof deferred<PrTimelineItem[]>>[] = [];
    const provider: ReviewProvider = {
      family: "github",
      hostOrigin: "github.com",
      cacheKey: "github:github.com",
      hostLabel: "GitHub",
      capabilities: {
        reviewNoun: "pull request",
        mergeMethods: [{ id: "merge", label: "Merge" }],
      },
      authStatus: async (): Promise<AuthStatusResult> => ({
        authenticated: true,
        login: "octocat",
      }),
      getPr: () => {
        const value = deferred<PR>();
        prs.push(value);
        return value.promise;
      },
      getChecks: () => {
        const value = deferred<PrChecksResult>();
        checks.push(value);
        return value.promise;
      },
      getCommits: () => {
        const value = deferred<PrCommitSummary[]>();
        commits.push(value);
        return value.promise;
      },
      getTimeline: () => {
        const value = deferred<PrTimelineItem[]>();
        timelines.push(value);
        return value.promise;
      },
      addComment: async () => ({ id: 1, url: "" }),
      merge: async () => ({ sha: "abc" }),
      markReady: async () => pr("ready"),
    };

    const first = prefetchReviewLiveData(provider, "workspace-race", 42, {
      force: true,
    });
    await settleCalls(() => prs.length === 1);
    const second = prefetchReviewLiveData(provider, "workspace-race", 42, {
      force: true,
    });

    prs[0].resolve(pr("stale"));
    checks[0].resolve(emptyChecks);
    commits[0].resolve([]);
    timelines[0].resolve([]);
    await settleCalls(() => prs.length === 2);

    // The invalidated response never became a transient visible snapshot.
    expect(peekReviewLiveData(provider, "workspace-race", 42).pr).toBeNull();

    prs[1].resolve(pr("fresh"));
    checks[1].resolve(emptyChecks);
    commits[1].resolve([]);
    timelines[1].resolve([]);
    await Promise.all([first, second]);

    expect(peekReviewLiveData(provider, "workspace-race", 42).pr?.title).toBe(
      "fresh",
    );
  });

  it("spaces local refresh-key reads of an open PR's GitHub resources", () => {
    const window = REVIEW_REFRESH_KEY_MIN_INTERVAL_MS;
    expect(refreshKeyRefreshDelay(0, 10_000)).toBe(0);
    expect(refreshKeyRefreshDelay(10_000, 10_000)).toBe(window);
    expect(refreshKeyRefreshDelay(10_000, 10_000 + window - 1)).toBe(1);
    expect(refreshKeyRefreshDelay(10_000, 10_000 + window)).toBe(0);
    expect(refreshKeyRefreshDelay(10_000, 10_000 + window * 3)).toBe(0);
  });
});
