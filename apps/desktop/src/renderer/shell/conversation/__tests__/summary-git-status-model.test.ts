import { describe, expect, it } from "vitest";
import type { PR, Workspace } from "../../../platform/git";
import {
  summaryGitRows,
  summaryGitPrompt,
  supportsSummaryGitStatus,
  type SummaryGitFacts,
} from "../summary-git-status-model";

const facts: SummaryGitFacts = {
  all: 1,
  uncommitted: 0,
  conflicted: 0,
  operation: null,
  ahead: 0,
  behind: 0,
  upstream: "origin/feature",
  branch: "feature",
  base: { ref: "origin/main", behind: 0 },
};
const pr = {
  number: 7,
  state: "draft",
  baseBranch: "main",
  mergeableState: "draft",
  mergedAt: null,
} as PR;
const rows = (
  overrides: Partial<SummaryGitFacts> = {},
  metadata: Partial<Parameters<typeof summaryGitRows>[0]> = {},
) =>
  summaryGitRows({
    facts: { ...facts, ...overrides },
    prNumber: null,
    prState: null,
    pr: null,
    baseBranch: "main",
    ...metadata,
  });

describe("Summary Git status", () => {
  it("has no no-PR placeholder and keeps net uncommitted counts independent of All Changes", () => {
    expect(rows()).toEqual([]);
    expect(rows({ uncommitted: 5, all: 0 })).toMatchObject([
      { name: "5 uncommitted changes", label: "Commit and push" },
    ]);
    expect(rows({ uncommitted: 1 })).toMatchObject([
      { name: "1 uncommitted change" },
    ]);
    // A staged add deleted on disk has zero HEAD-vs-worktree changes.
    expect(rows({ uncommitted: 0, all: 0 })).toEqual([]);
  });
  it("shows concurrent draft, ahead, behind, conflict and divergence rows", () => {
    const result = rows(
      { ahead: 10, behind: 1, conflicted: 2 },
      { prNumber: 7, prState: "draft", pr },
    );
    expect(result.map((row) => row.name)).toEqual([
      "PR is in draft",
      "1 commit behind remote",
      "10 commits ahead of remote",
      "Merge conflicts detected",
      "Incompatible with remote",
    ]);
    expect(result.find((row) => row.action === "push")?.disabledReason).toMatch(
      /conflicts/,
    );
    expect(
      result.find((row) => row.action === "resolve-conflicts")?.disabledReason,
    ).toBeUndefined();
  });
  it("compares the selected base before creation and during draft without conflating the upstream", () => {
    expect(rows({ base: { ref: "origin/main", behind: 23 } })).toMatchObject([
      {
        name: "23 commits behind main",
        label: "Pull",
        action: "pull-base",
        baseRef: "origin/main",
      },
    ]);
    const result = rows(
      { behind: 1, base: { ref: "origin/release/v2", behind: 4 } },
      { baseBranch: "release/v2", prNumber: 7, pr },
    );
    expect(result.map((row) => row.name)).toEqual([
      "PR is in draft",
      "1 commit behind remote",
      "4 commits behind release/v2",
    ]);
    expect(
      rows({
        behind: 1,
        upstream: "origin/main",
        base: { ref: "origin/main", behind: 1 },
      }),
    ).toHaveLength(1);
  });
  it.each(["unstable", "blocked", "unknown", "clean", "has_hooks"])(
    "does not invent a Git problem from GitHub %s",
    (mergeableState) => {
      expect(
        rows(
          {},
          { prNumber: 7, pr: { ...pr, state: "ready", mergeableState } },
        ),
      ).toMatchObject([{ name: "PR is open", action: "view-pr" }]);
    },
  );
  it("preserves local work after a PR closes or merges, without suggesting base integration", () => {
    for (const state of ["closed", "merged"] as const) {
      expect(
        rows(
          { uncommitted: 1, base: { ref: "origin/main", behind: 4 } },
          { prNumber: 7, prState: state },
        ).map((row) => row.id),
      ).toEqual(["pr", "uncommitted"]);
    }
  });
  it("does not mistake a normal rebase's detached HEAD for a separate branch problem", () => {
    const result = rows({ branch: null, operation: "rebase" });
    expect(result).toMatchObject([
      { name: "Rebase in progress", label: "Continue" },
    ]);
    expect(
      summaryGitPrompt(
        result[0]!,
        { ...facts, operation: "rebase" },
        "main",
        "origin",
      ),
    ).toContain("Do not start another merge or rebase");
    expect(rows({ branch: null })).toMatchObject([
      { name: "Detached HEAD", label: "Resolve" },
    ]);
  });
  it("disables pushes until remote divergence is reconciled and forbids destructive recovery", () => {
    const result = rows({ ahead: 2, behind: 3 });
    expect(
      result.find((row) => row.action === "push")?.disabledReason,
    ).toContain("Pull");
    const resolve = result.find((row) => row.action === "resolve-divergence")!;
    expect(resolve.disabledReason).toBeUndefined();
    expect(summaryGitPrompt(resolve, facts, "main", "origin")).toContain(
      "Do not reset, discard work, or force-push",
    );
  });
  it("handles older engines and unavailable facts without claiming a clean tree", () => {
    expect(
      summaryGitRows({
        prNumber: null,
        prState: null,
        pr: null,
        baseBranch: "main",
      }),
    ).toEqual([]);
    expect(
      rows({
        branch: undefined,
        base: undefined,
        ahead: null,
        behind: null,
        upstream: null,
      }),
    ).toEqual([]);
    expect(
      rows(
        { base: undefined },
        { prNumber: 7, pr: { ...pr, behindBy: 2 } },
      ).map((row) => row.id),
    ).toEqual(["draft", "behind-base"]);
  });
  it("only enables managed local Git workspaces for either owner", () => {
    const local = {
      id: "ws_local",
      path: "/local/worktree",
      placement: "local",
    } as Workspace;
    expect(supportsSummaryGitStatus(local)).toBe(true);
    expect(
      supportsSummaryGitStatus({ ...local, organizationId: "organization" }),
    ).toBe(true);
    expect(supportsSummaryGitStatus({ ...local, placement: "cloud" })).toBe(
      false,
    );
    expect(
      supportsSummaryGitStatus({ ...local, path: "cloud://org/workspace" }),
    ).toBe(false);
    expect(
      supportsSummaryGitStatus({ ...local, id: "cloud://org/workspace" }),
    ).toBe(false);
    expect(supportsSummaryGitStatus({ ...local, id: "local:repo" })).toBe(
      false,
    );
    expect(supportsSummaryGitStatus(null)).toBe(false);
  });
});
