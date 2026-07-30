import { describe, expect, it } from "vitest";

import type {
  AuthStatusResult,
  PR,
  PrChecksResult,
  PrCommitSummary,
  PrTimelineItem,
} from "../../../native/git";
import type { ReviewProvider } from "../../pr/review-provider";
import {
  peekReviewLiveData,
  prefetchReviewLiveData,
  shouldPollReviewChecks,
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
});
