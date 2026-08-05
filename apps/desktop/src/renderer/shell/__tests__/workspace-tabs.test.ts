import { describe, expect, it } from "vitest";

import type { Workspace } from "../../platform/git";
import type { Project } from "../../state/projects-store";
import {
  CHANGE_COUNT_OVERFLOW_LABEL,
  filterArchivedWorkspaces,
  formatChangeCount,
  horizontalOverflow,
  leftmostLiveWorkspace,
  orderWorkspaceTabs,
  resolveRepoWorkspaceDestination,
  workspaceFadeVisibility,
  workspaceLabel,
  workspacePinSide,
  workspaceScrollLeftForTab,
  workspaceTabDescription,
} from "../workspace-tabs";

const project: Project = {
  id: "project-zeros",
  name: "Zeros",
  repoRoot: "/repo",
  repoSlug: "zeros",
  originUrl: null,
  addedAt: 1,
};

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    repoSlug: "zeros",
    repoRoot: "/repo",
    branch: `zeros/${id}`,
    baseBranch: "main",
    path: `/repo/worktrees/${id}`,
    status: "in-progress",
    createdAt: 100,
    archivedAt: 200,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    ...overrides,
  };
}

describe("top-bar horizontal overflow", () => {
  it("shows only the fades backed by hidden content", () => {
    expect(
      horizontalOverflow({ scrollLeft: 0, scrollWidth: 600, clientWidth: 300 }),
    ).toEqual({ left: false, right: true });
    expect(
      horizontalOverflow({
        scrollLeft: 150,
        scrollWidth: 600,
        clientWidth: 300,
      }),
    ).toEqual({ left: true, right: true });
    expect(
      horizontalOverflow({
        scrollLeft: 299.5,
        scrollWidth: 600,
        clientWidth: 300,
      }),
    ).toEqual({ left: true, right: false });
  });

  it("does not report overflow when content fits", () => {
    expect(
      horizontalOverflow({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }),
    ).toEqual({ left: false, right: false });
  });
});

describe("repository workspace restoration", () => {
  it("preserves a chat rooted in a main-checkout subdirectory", () => {
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: "/repo/packages/app",
        cachedWorkspaces: [],
      }),
    ).toEqual({ path: "/repo/packages/app", repoRoot: "/repo" });
  });

  it("keeps a human-layout worktree path pending while its exact cache key is cold", () => {
    const remembered = "/Users/test/zeros/workspaces/zeros/ws-remembered";
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: remembered,
        cachedWorkspaces: undefined,
      }),
    ).toEqual({
      path: remembered,
      repoRoot: "/repo",
      validationPending: true,
    });
  });

  it("keeps an encoded legacy worktree identity while its exact cache key is cold", () => {
    const remembered =
      "/Users/test/.zeros/worktrees/zeros/ws_legacy-remembered";
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: remembered,
        cachedWorkspaces: undefined,
      }),
    ).toEqual({
      id: "ws_legacy-remembered",
      path: remembered,
      repoRoot: "/repo",
      validationPending: true,
    });
  });

  it("returns the confirmed workspace row when the repository cache is warm", () => {
    const remembered = workspace("remembered", {
      path: "/worktrees/remembered",
      archivedAt: null,
    });
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: remembered.path,
        cachedWorkspaces: [remembered],
      }),
    ).toBe(remembered);
  });

  it("prefers a confirmed nested worktree over the main-checkout prefix", () => {
    const nested = workspace("nested", {
      path: "/repo/.worktrees/nested",
      archivedAt: null,
    });
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: `${nested.path}/packages/app`,
        cachedWorkspaces: [nested],
      }),
    ).toMatchObject({
      id: "nested",
      path: "/repo/.worktrees/nested/packages/app",
    });
  });

  it("falls back to main only after a confirmed list invalidates the memory", () => {
    const resolved = resolveRepoWorkspaceDestination({
      project,
      rememberedFolder: "/worktrees/deleted",
      cachedWorkspaces: [],
    });
    expect(resolved).toMatchObject({
      id: "local:zeros",
      path: "/repo",
      repoRoot: "/repo",
    });
  });

  it("fails closed instead of restoring a cold remembered design path", () => {
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder:
          "/Users/test/zeros/design workspaces/zeros/remembered",
        cachedWorkspaces: undefined,
        allowDesignWorkspaces: false,
      }),
    ).toMatchObject({ id: "local:zeros", path: "/repo" });
  });

  it("never selects a cached design row when design workspaces are disabled", () => {
    const design = workspace("design", {
      kind: "design",
      archivedAt: null,
      createdAt: 50,
    });
    const code = workspace("code", {
      kind: "code",
      archivedAt: null,
      createdAt: 100,
    });
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: design.path,
        cachedWorkspaces: [design, code],
        allowLocalMain: false,
        allowDesignWorkspaces: false,
      }),
    ).toBe(code);
  });
});

// The shared "not the trunk" destination. Exported because BOTH a repo switch
// (resolveRepoWorkspaceDestination) and a repo add (AddProjectProvider's
// openFirstWorkspace fallback) have to agree on where the user lands when the
// primary checkout has no tab — the two drifting is what put an add into an
// untabbed trunk chat.
describe("leftmostLiveWorkspace", () => {
  it("returns the oldest live worktree, matching the tab strip's order", () => {
    // Engine order is newest-first; the strip is creation-ordered.
    const older = workspace("older", { archivedAt: null, createdAt: 100 });
    const newer = workspace("newer", { archivedAt: null, createdAt: 300 });
    expect(leftmostLiveWorkspace([newer, older])).toBe(older);
  });

  it("skips archived rows", () => {
    const archived = workspace("archived", { createdAt: 1 });
    const live = workspace("live", { archivedAt: null, createdAt: 100 });
    expect(leftmostLiveWorkspace([archived, live])).toBe(live);
  });

  it("returns null for an all-archived repo", () => {
    expect(leftmostLiveWorkspace([workspace("archived")])).toBeNull();
  });

  it("returns null for a worktree-less repo", () => {
    expect(leftmostLiveWorkspace([])).toBeNull();
  });

  it("returns null for a cold cache rather than guessing", () => {
    // `undefined` is "not loaded yet", not "no worktrees" — callers fall back
    // to the repo root, which is recoverable; guessing a tab is not.
    expect(leftmostLiveWorkspace(undefined)).toBeNull();
  });
});

// "Work in local main" off — the primary checkout stops being an offered
// destination, so a repo switch has to land on a worktree wherever one exists.
describe("repository workspace restoration without local main", () => {
  const older = workspace("older", {
    path: "/worktrees/older",
    archivedAt: null,
    createdAt: 100,
  });
  const newer = workspace("newer", {
    path: "/worktrees/newer",
    archivedAt: null,
    createdAt: 300,
  });

  it("redirects a remembered main checkout to the leftmost live worktree", () => {
    // Engine order is newest-first; the destination must match the tab strip's
    // creation order so "where the switch lands" is the tab the user sees first.
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: "/repo",
        cachedWorkspaces: [newer, older],
        allowLocalMain: false,
      }),
    ).toBe(older);
  });

  it("redirects a chat rooted in a main-checkout subdirectory too", () => {
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: "/repo/packages/app",
        cachedWorkspaces: [older],
        allowLocalMain: false,
      }),
    ).toBe(older);
  });

  it("redirects a deleted worktree to a live one instead of to main", () => {
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: "/worktrees/deleted",
        cachedWorkspaces: [older],
        allowLocalMain: false,
      }),
    ).toBe(older);
  });

  it("skips archived rows when choosing the redirect target", () => {
    const archived = workspace("archived", {
      path: "/worktrees/archived",
      createdAt: 1,
    });
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: "/repo",
        cachedWorkspaces: [archived, older],
        allowLocalMain: false,
      }),
    ).toBe(older);
  });

  it("still lands on main when the repo has no worktree to offer", () => {
    // Nowhere else to go — a repo whose only checkout is the trunk has to
    // resolve somewhere, and "+" is the top bar's call to action from there.
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: "/repo",
        cachedWorkspaces: [],
        allowLocalMain: false,
      }),
    ).toMatchObject({ id: "local:zeros", path: "/repo" });
  });

  it("does not guess a redirect while the repository cache is cold", () => {
    // A cold list cannot prove a worktree exists; guessing here would bounce
    // the user twice on a cold repo switch.
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: "/repo",
        cachedWorkspaces: undefined,
        allowLocalMain: false,
      }),
    ).toMatchObject({ id: "local:zeros", path: "/repo" });
  });

  it("leaves a confirmed worktree memory untouched", () => {
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: newer.path,
        cachedWorkspaces: [newer, older],
        allowLocalMain: false,
      }),
    ).toBe(newer);
  });
});

describe("active workspace pinning", () => {
  const strip = { scrollWidth: 1_000, clientWidth: 400 };

  it("pins to the edge the natural tab position crossed", () => {
    expect(
      workspacePinSide({
        ...strip,
        scrollLeft: 250,
        tabOffsetLeft: 100,
        tabWidth: 200,
      }),
    ).toBe("left");
    expect(
      workspacePinSide({
        ...strip,
        scrollLeft: 100,
        tabOffsetLeft: 450,
        tabWidth: 200,
      }),
    ).toBe("right");
  });

  it("leaves a visible tab in normal document flow", () => {
    expect(
      workspacePinSide({
        ...strip,
        scrollLeft: 100,
        tabOffsetLeft: 200,
        tabWidth: 200,
      }),
    ).toBeNull();
  });

  it("never pins a strip that does not overflow", () => {
    expect(
      workspacePinSide({
        scrollLeft: 0,
        scrollWidth: 400,
        clientWidth: 400,
        tabOffsetLeft: 0,
        tabWidth: 200,
      }),
    ).toBeNull();
  });
});

describe("active workspace reveal", () => {
  const strip = { scrollWidth: 1_000, clientWidth: 400 };

  it("reveals the natural tab slot rather than its sticky visual box", () => {
    expect(
      workspaceScrollLeftForTab({
        ...strip,
        scrollLeft: 0,
        tabOffsetLeft: 600,
        tabWidth: 160,
      }),
    ).toBe(364);
    expect(
      workspaceScrollLeftForTab({
        ...strip,
        scrollLeft: 500,
        tabOffsetLeft: 100,
        tabWidth: 160,
      }),
    ).toBe(96);
  });

  it("does not move a fully visible tab and clamps at both scroll limits", () => {
    expect(
      workspaceScrollLeftForTab({
        ...strip,
        scrollLeft: 200,
        tabOffsetLeft: 250,
        tabWidth: 160,
      }),
    ).toBe(200);
    expect(
      workspaceScrollLeftForTab({
        ...strip,
        scrollLeft: 500,
        tabOffsetLeft: 0,
        tabWidth: 160,
      }),
    ).toBe(0);
    expect(
      workspaceScrollLeftForTab({
        ...strip,
        scrollLeft: 0,
        tabOffsetLeft: 950,
        tabWidth: 160,
      }),
    ).toBe(600);
  });

  it("moves a newly appended last workspace to the far-right scroll extent", () => {
    for (const scrollLeft of [0, 300, 600]) {
      expect(
        workspaceScrollLeftForTab({
          scrollLeft,
          scrollWidth: 1_000,
          clientWidth: 400,
          // Four pixels of strip padding remain after this 160px tab.
          tabOffsetLeft: 836,
          tabWidth: 160,
          edgeInset: 4,
        }),
      ).toBe(600);
    }
  });
});

describe("workspace fade placement", () => {
  it("moves the obscured edge fade beside a left-pinned active tab", () => {
    expect(
      workspaceFadeVisibility({ left: true, right: true }, "left"),
    ).toEqual({
      outerLeft: false,
      outerRight: true,
      afterPinnedLeft: true,
      beforePinnedRight: false,
    });
  });

  it("moves the obscured edge fade beside a right-pinned active tab", () => {
    expect(
      workspaceFadeVisibility({ left: true, right: true }, "right"),
    ).toEqual({
      outerLeft: true,
      outerRight: false,
      afterPinnedLeft: false,
      beforePinnedRight: true,
    });
  });

  it("uses normal edge fades while the active tab is in natural flow", () => {
    expect(workspaceFadeVisibility({ left: false, right: true }, null)).toEqual(
      {
        outerLeft: false,
        outerRight: true,
        afterPinnedLeft: false,
        beforePinnedRight: false,
      },
    );
  });
});

describe("workspace tab ordering", () => {
  it("places oldest workspaces on the left and newly-created ones on the right", () => {
    const rows = [
      workspace("newest", { createdAt: 300 }),
      workspace("oldest", { createdAt: 100 }),
      workspace("middle", { createdAt: 200 }),
    ];

    expect(orderWorkspaceTabs(rows).map((row) => row.id)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
  });

  it("does not mutate engine order and handles malformed legacy timestamps", () => {
    const rows = [
      workspace("newest", { createdAt: 300 }),
      workspace("legacy", { createdAt: Number.NaN }),
      workspace("oldest", { createdAt: 100 }),
    ];
    const before = rows.map((row) => row.id);

    expect(orderWorkspaceTabs(rows).map((row) => row.id)).toEqual([
      "legacy",
      "oldest",
      "newest",
    ]);
    expect(rows.map((row) => row.id)).toEqual(before);
  });

  it("uses ids as a deterministic tie-breaker", () => {
    const rows = [
      workspace("same-b", { createdAt: 100 }),
      workspace("same-a", { createdAt: 100 }),
    ];

    expect(orderWorkspaceTabs(rows).map((row) => row.id)).toEqual([
      "same-a",
      "same-b",
    ]);
  });
});

describe("archived workspace filtering", () => {
  const rows = [
    workspace("older", { archivedAt: 300 }),
    workspace("Cafe-Search", { archivedAt: 500 }),
    workspace("other-repo", { repoSlug: "other", archivedAt: 900 }),
    workspace("live", { archivedAt: null }),
    workspace("malformed", { archivedAt: Number.NaN }),
    workspace("accent", {
      branch: "zeros/caf\u00e9-layout",
      baseBranch: "release/v2",
      archivedAt: 400,
    }),
  ];

  it("strips the generated branch prefix for display", () => {
    expect(workspaceLabel(rows[0]!)).toBe("older");
    expect(
      workspaceLabel(workspace("plain", { branch: "feature/plain" })),
    ).toBe("feature/plain");
  });

  it("keeps only archived rows from the selected repo, newest first", () => {
    expect(
      filterArchivedWorkspaces(rows, "zeros", "").map((row) => row.id),
    ).toEqual(["Cafe-Search", "accent", "older"]);
  });

  it("searches case/diacritic-insensitively across branch and base branch", () => {
    expect(
      filterArchivedWorkspaces(rows, "zeros", "CAFE layout").map(
        (row) => row.id,
      ),
    ).toEqual(["accent"]);
    expect(
      filterArchivedWorkspaces(rows, "zeros", "release v2").map(
        (row) => row.id,
      ),
    ).toEqual(["accent"]);
  });

  it("does not mutate the bridge-owned order", () => {
    const before = rows.map((row) => row.id);
    filterArchivedWorkspaces(rows, "zeros", "");
    expect(rows.map((row) => row.id)).toEqual(before);
  });
});

describe("top-bar change-count formatting", () => {
  it("prints totals below a thousand exactly", () => {
    expect(formatChangeCount(0)).toBe("0");
    expect(formatChangeCount(1)).toBe("1");
    expect(formatChangeCount(240)).toBe("240");
    expect(formatChangeCount(999)).toBe("999");
  });

  it("compacts thousands to one decimal and drops a bare .0", () => {
    expect(formatChangeCount(1_000)).toBe("1k");
    expect(formatChangeCount(1_500)).toBe("1.5k");
    expect(formatChangeCount(12_345)).toBe("12.3k");
    expect(formatChangeCount(99_000)).toBe("99k");
  });

  it("rounds at each unit boundary rather than truncating", () => {
    expect(formatChangeCount(999.6)).toBe("1k");
    expect(formatChangeCount(1_050)).toBe("1.1k");
    expect(formatChangeCount(9_999)).toBe("10k");
  });

  it("holds the two-digit budget right up to the ceiling", () => {
    // 99_949 still rounds to 99.9k; 99_950 would print "100.0k" — three
    // integer digits — so the label takes over exactly there.
    expect(formatChangeCount(99_949)).toBe("99.9k");
    expect(formatChangeCount(99_950)).toBe(CHANGE_COUNT_OVERFLOW_LABEL);
    expect(formatChangeCount(100_000)).toBe(CHANGE_COUNT_OVERFLOW_LABEL);
    expect(formatChangeCount(4_200_000)).toBe(CHANGE_COUNT_OVERFLOW_LABEL);
  });

  it("never renders NaN or a negative from a malformed total", () => {
    expect(formatChangeCount(Number.NaN)).toBe("0");
    expect(formatChangeCount(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatChangeCount(-12)).toBe("0");
  });
});

describe("workspace tab accessible name", () => {
  const label = "viola-6157";

  it("is just the workspace when there is nothing else to report", () => {
    expect(
      workspaceTabDescription({
        label,
        runActionRunning: false,
        changeLines: { additions: 0, deletions: 0 },
      }),
    ).toBe("Open workspace viola-6157");
  });

  it("spells out the exact totals a screen reader cannot see", () => {
    // Exact, not compacted — "+1.5k" is a width concession, not the truth.
    expect(
      workspaceTabDescription({
        label,
        runActionRunning: false,
        changeLines: { additions: 1_500, deletions: 240 },
      }),
    ).toBe("Open workspace viola-6157, 1500 lines added, 240 lines removed");
  });

  it("names a running action alongside the totals it visually replaces", () => {
    expect(
      workspaceTabDescription({
        label,
        runActionRunning: true,
        changeLines: { additions: 12, deletions: 0 },
      }),
    ).toBe("Open workspace viola-6157, run action running, 12 lines added");
  });

  it("does not read a single line back as plural", () => {
    expect(
      workspaceTabDescription({
        label,
        runActionRunning: false,
        changeLines: { additions: 1, deletions: 1 },
      }),
    ).toBe("Open workspace viola-6157, 1 line added, 1 line removed");
  });
});
