import { describe, expect, it } from "vitest";

import type { Workspace } from "../../platform/git";
import type { PendingWorkspaceCreate } from "../pending-workspaces";
import {
  countLiveVisibleBySlug,
  dedupePendingCreates,
  filterPendingCreatesForDesignAccess,
  filterWorkspacesForDesignAccess,
  selectLiveVisible,
} from "../live-workspace-selectors";

function ws(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_1",
    repoSlug: "acme/app",
    repoRoot: "/repo",
    branch: "zeros/moonflower",
    baseBranch: "main",
    path: "/repo/.worktrees/moonflower",
    status: "in-progress",
    createdAt: 0,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    present: true,
    ...overrides,
  };
}

function pending(
  overrides: Partial<PendingWorkspaceCreate> = {},
): PendingWorkspaceCreate {
  return {
    token: "pwc-1",
    repoRoot: "/repo",
    repoSlug: "acme/app",
    path: "/repo/.worktrees/newbie",
    branch: "zeros/newbie",
    startedAt: 0,
    ...overrides,
  };
}

describe("selectLiveVisible", () => {
  it("drops confirmed archived rows but retains a live row until confirmation", () => {
    const live = ws({ id: "a" });
    const archived = ws({ id: "b", archivedAt: 123 });
    const archiving = ws({ id: "c" });
    const out = selectLiveVisible([live, archived, archiving]);
    expect(out.map((w) => w.id)).toEqual(["a", "c"]);
  });

  it("KEEPS present === false (orphaned) so counts stay consistent", () => {
    const orphan = ws({ id: "o", present: false });
    const out = selectLiveVisible([orphan]);
    expect(out.map((w) => w.id)).toEqual(["o"]);
  });

  it("returns the SAME array reference when nothing is filtered", () => {
    const rows = [ws({ id: "a" }), ws({ id: "b", present: false })];
    expect(selectLiveVisible(rows)).toBe(rows);
  });
});

describe("design-mode workspace visibility", () => {
  it("keeps design-MODE rows and pending creates visible regardless of the flag", () => {
    // One workspace, two modes: hiding a design-mode row when the Internal
    // flag is off would strand a real worktree (no archive, no way back to
    // code mode). The flag gates the design SURFACE, never list membership.
    const code = ws({ id: "code", kind: "code" });
    const design = ws({ id: "design", kind: "design" });
    const codePending = pending({ token: "code-pending", kind: "code" });
    const designPending = pending({
      token: "design-pending",
      kind: "design",
    });

    expect(
      filterWorkspacesForDesignAccess([code, design], false).map(
        (row) => row.id,
      ),
    ).toEqual(["code", "design"]);
    expect(
      filterPendingCreatesForDesignAccess(
        [codePending, designPending],
        false,
      ).map((row) => row.token),
    ).toEqual(["code-pending", "design-pending"]);
  });

  it("returns the original references untouched in both flag states", () => {
    const rows = [
      ws({ id: "code", kind: "code" }),
      ws({ id: "design", kind: "design" }),
    ];
    const pendingRows = [pending({ token: "design-pending", kind: "design" })];
    expect(filterWorkspacesForDesignAccess(rows, false)).toBe(rows);
    expect(filterWorkspacesForDesignAccess(rows, true)).toBe(rows);
    expect(filterPendingCreatesForDesignAccess(pendingRows, false)).toBe(
      pendingRows,
    );
    expect(filterPendingCreatesForDesignAccess(pendingRows, true)).toBe(
      pendingRows,
    );
  });
});

describe("dedupePendingCreates", () => {
  it("drops a pending whose branch matches a real row", () => {
    const real = [ws({ branch: "zeros/newbie" })];
    expect(
      dedupePendingCreates([pending({ branch: "zeros/newbie" })], real),
    ).toEqual([]);
  });

  it("drops a pending whose path matches a real row (no branch match)", () => {
    const real = [ws({ branch: "other", path: "/repo/.worktrees/newbie" })];
    expect(
      dedupePendingCreates(
        [pending({ branch: undefined, path: "/repo/.worktrees/newbie" })],
        real,
      ),
    ).toEqual([]);
  });

  it("keeps a pending that matches no real row", () => {
    const real = [ws({ branch: "zeros/existing", path: "/x" })];
    const p = pending({ branch: "zeros/newbie", path: "/y" });
    expect(dedupePendingCreates([p], real)).toEqual([p]);
  });

  // Workspace names come from a per-repository free set of colour words, so the
  // same branch in two repositories is ordinary — not the pending create's own
  // row landing. Cross-repository callers (top bar, Dashboard, archive
  // repoint) pass the live union, and a global branch match silently deleted
  // the new workspace's "Setting up…" placeholder.
  it("keeps a pending whose branch matches a row in ANOTHER repository", () => {
    const otherRepo = [
      ws({
        id: "ws_other",
        repoSlug: "acme/other",
        repoRoot: "/other",
        branch: "zeros/newbie",
        path: "/other/.worktrees/newbie",
      }),
    ];
    const p = pending({ branch: "zeros/newbie" });
    expect(dedupePendingCreates([p], otherRepo)).toEqual([p]);
  });

  it("still drops it once the row lands in its OWN repository", () => {
    const union = [
      ws({
        id: "ws_other",
        repoSlug: "acme/other",
        repoRoot: "/other",
        branch: "zeros/newbie",
        path: "/other/.worktrees/newbie",
      }),
      ws({ id: "ws_own", branch: "zeros/newbie", path: "/repo/w/newbie" }),
    ];
    expect(
      dedupePendingCreates([pending({ branch: "zeros/newbie" })], union),
    ).toEqual([]);
  });

  it("drops it on an exact path match even across a slug mismatch", () => {
    const real = [
      ws({ repoSlug: "acme/renamed", path: "/repo/.worktrees/newbie" }),
    ];
    expect(
      dedupePendingCreates(
        [pending({ branch: undefined, path: "/repo/.worktrees/newbie" })],
        real,
      ),
    ).toEqual([]);
  });

  it("returns a stable empty array for no pending", () => {
    expect(dedupePendingCreates([], [ws()])).toEqual([]);
  });
});

describe("countLiveVisibleBySlug", () => {
  it("counts live-visible rows plus deduped pending, per slug", () => {
    const rows = [
      ws({ id: "a", repoSlug: "acme/app" }),
      ws({ id: "b", repoSlug: "acme/app", archivedAt: 1 }), // excluded
      ws({ id: "c", repoSlug: "acme/app" }), // in-flight archive, retained
      ws({ id: "d", repoSlug: "other/repo" }),
    ];
    const pendings = [
      pending({ token: "p1", repoSlug: "acme/app", branch: "zeros/new1" }),
      // deduped: its branch matches a real row → not counted
      pending({
        token: "p2",
        repoSlug: "acme/app",
        branch: "zeros/moonflower",
      }),
      pending({ token: "p3", repoSlug: "other/repo", branch: "zeros/new3" }),
    ];
    const counts = countLiveVisibleBySlug(rows, pendings);
    // acme/app: live a+c = 2 + pending p1 (p2 deduped) = 3.
    expect(counts.get("acme/app")).toBe(3);
    // other/repo: live-visible d = 1 + pending p3 = 2
    expect(counts.get("other/repo")).toBe(2);
  });

  it("counts a slug that only has a pending create", () => {
    const counts = countLiveVisibleBySlug(
      [],
      [pending({ repoSlug: "fresh/repo", branch: "zeros/x", path: "/z" })],
    );
    expect(counts.get("fresh/repo")).toBe(1);
  });
});
