import { describe, expect, it } from "vitest";

import type {
  PR,
  PrChecksResult,
  StatusResult,
} from "../../../native/git";
import { optimisticPushGeneration } from "../pr-status-optimistic";

describe("optimisticPushGeneration", () => {
  it("never mixes a pushed local head with the preceding GitHub generation", () => {
    const status: StatusResult = {
      staged: [],
      unstaged: [],
      untracked: [],
      ahead: 2,
      behind: 0,
      conflicted: [],
      conflictState: null,
      upstream: "origin/zeros/test",
    };
    const pr: PR = {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      state: "ready",
      title: "Test",
      body: "",
      authorLogin: "octocat",
      baseBranch: "main",
      headBranch: "zeros/test",
      headSha: "a".repeat(40),
      mergeableState: "clean",
      isMergeable: true,
      behindBy: 0,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: null,
      mergeCommitSha: null,
    };
    const checks: PrChecksResult = {
      checks: [],
      deployments: [],
      pending: 0,
      passed: 3,
      failed: 0,
      total: 3,
    };

    const next = optimisticPushGeneration(
      { status, pr, checks },
      { ahead: 0, behind: 0 },
      123,
    );

    expect(next.status).toMatchObject({ ahead: 0, behind: 0 });
    expect(next.pr).toMatchObject({
      mergeableState: "unknown",
      isMergeable: null,
      behindBy: null,
    });
    expect(next.checks).toBeNull();
    expect(next.at).toBe(123);
    expect(pr.mergeableState).toBe("clean");
  });
});
