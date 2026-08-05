// forgetPrCachesForWorkspace — the confirmed-deletion purge. Each PR-cache
// module registers its forget function at load time, so merely importing the
// modules below enrolls them; the assertions then go through each module's
// public read API to prove the purge is exact (deleted workspace only, the
// `#` delimiter guarding against prefix-id collisions).
//
// pr-status-island.tsx also registers (its last-known batch cache), but the
// component module pulls in the full renderer surface and stays out of this
// node suite — its forgetter is the same three-line prefix sweep as the ones
// covered here, and the registry mechanism itself is asserted directly.

import { beforeEach, describe, expect, it } from "vitest";

import type {
  AuthStatusResult,
  PR,
  PrChecksResult,
} from "../../../platform/git";
import type { ReviewProvider } from "../review-provider";
import {
  peekReviewLiveData,
  prefetchReviewLiveData,
} from "../../workbench/tabs/review-data";
import {
  forgetPrCachesForWorkspace,
  registerPrWorkspaceCacheForget,
} from "../pr-cache-forget";
import {
  getPrIslandKind,
  publishPrIslandKind,
  resetPrIslandKindsForTesting,
} from "../pr-island-state-store";
import {
  getPrIslandLastState,
  rememberPrIslandLastState,
  resetPrIslandLastStatesForTesting,
} from "../pr-island-last-state";
import {
  resetPrIslandStabilityForTesting,
  stabilizePrIslandState,
} from "../pr-status-stability";
import type { PrIslandState } from "../pr-status";
import {
  peekWorkspacePrProbeForTests,
  recordWorkspacePrProbeForTests,
} from "../use-workspace-pr-sync";

const READY: PrIslandState = {
  kind: "ready-to-merge",
  label: "Ready to merge",
  tone: "success",
  actions: [],
};
const CHECKING: PrIslandState = {
  kind: "checking",
  label: "Checking mergeability…",
  tone: "neutral",
  actions: [],
};

beforeEach(() => {
  resetPrIslandKindsForTesting();
  resetPrIslandLastStatesForTesting();
  resetPrIslandStabilityForTesting();
});

describe("forgetPrCachesForWorkspace", () => {
  it("invokes every registered forgetter with the workspace id", () => {
    const seen: string[] = [];
    registerPrWorkspaceCacheForget((id) => seen.push(id));
    forgetPrCachesForWorkspace("ws-registry");
    expect(seen).toEqual(["ws-registry"]);
  });

  it("purges published island kinds for the deleted workspace only", () => {
    publishPrIslandKind("ws-a", 1, "merged");
    publishPrIslandKind("ws-a", 2, "closed");
    // "ws-ab" shares the "ws-a" character prefix — the `#` delimiter must
    // keep it alive.
    publishPrIslandKind("ws-ab", 1, "ready-to-merge");

    forgetPrCachesForWorkspace("ws-a");

    expect(getPrIslandKind("ws-a", 1)).toBeNull();
    expect(getPrIslandKind("ws-a", 2)).toBeNull();
    expect(getPrIslandKind("ws-ab", 1)).toBe("ready-to-merge");
  });

  it("purges persisted last states for the deleted workspace only", () => {
    rememberPrIslandLastState("ws-a#7", "ws-a#7@main:sha1", READY);
    rememberPrIslandLastState("ws-ab#7", "ws-ab#7@main:sha1", READY);

    forgetPrCachesForWorkspace("ws-a");

    expect(getPrIslandLastState("ws-a#7")).toBeNull();
    expect(getPrIslandLastState("ws-ab#7")).toEqual(READY);
  });

  it("drops the stability mask so a later 'checking' is no longer masked", () => {
    // Arm both masks with a definitive state.
    stabilizePrIslandState("ws-a#7@main:sha1", READY);
    stabilizePrIslandState("ws-b#7@main:sha1", READY);

    forgetPrCachesForWorkspace("ws-a");

    // ws-a's anchor is gone → the transient renders verbatim; ws-b keeps its
    // mask.
    expect(stabilizePrIslandState("ws-a#7@main:sha1", CHECKING)).toEqual(
      CHECKING,
    );
    expect(stabilizePrIslandState("ws-b#7@main:sha1", CHECKING)).toEqual(READY);
  });

  it("purges the PR-sync probe bookkeeping for the deleted workspace", () => {
    recordWorkspacePrProbeForTests("ws-a", { refreshKey: 3, at: 1_000 });
    recordWorkspacePrProbeForTests("ws-b", { refreshKey: 3, at: 1_000 });

    forgetPrCachesForWorkspace("ws-a");

    expect(peekWorkspacePrProbeForTests("ws-a")).toBeNull();
    expect(peekWorkspacePrProbeForTests("ws-b")).toEqual({
      refreshKey: 3,
      at: 1_000,
    });
  });

  it("purges settled Review snapshots for the deleted workspace", async () => {
    const prRow: PR = {
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      state: "merged",
      title: "t",
      body: "",
      authorLogin: "octocat",
      baseBranch: "main",
      headBranch: "feature",
      mergeableState: "clean",
      isMergeable: true,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: 3,
    };
    const emptyChecks: PrChecksResult = {
      checks: [],
      deployments: [],
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
    };
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
      getPr: async () => prRow,
      getChecks: async () => emptyChecks,
      getCommits: async () => [],
      getTimeline: async () => [],
      addComment: async () => ({ id: 1, url: "" }),
      merge: async () => ({ sha: "abc" }),
      markReady: async () => prRow,
    };

    await prefetchReviewLiveData(provider, "ws-review-del", 42, {
      force: true,
    });
    expect(peekReviewLiveData(provider, "ws-review-del", 42).pr?.number).toBe(
      42,
    );

    forgetPrCachesForWorkspace("ws-review-del");

    const snap = peekReviewLiveData(provider, "ws-review-del", 42);
    expect(snap.pr).toBeNull();
    expect(snap.loadedAt).toBe(0);
  });
});
