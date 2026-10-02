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

describe("tab strip horizontal overflow", () => {
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
  it("never invents a root workspace for a fresh project, including a cold list", () => {
    for (const cachedWorkspaces of [undefined, []]) {
      expect(
        resolveRepoWorkspaceDestination({
          project,
          rememberedFolder: null,
          cachedWorkspaces,
        }),
      ).toBeNull();
    }
  });

  it.each([true, undefined])(
    "leaves a repository empty for saved local main with Git capability %s",
    (isGitRepository) => {
      for (const rememberedFolder of ["/repo", "/repo/packages/app"]) {
        expect(
          resolveRepoWorkspaceDestination({
            project: { ...project, isGitRepository },
            rememberedFolder,
            cachedWorkspaces: [],
          }),
        ).toBeNull();
      }
    },
  );

  it("never restores the primary checkout itself while its workspace list is cold", () => {
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: project.repoRoot,
        cachedWorkspaces: undefined,
      }),
    ).toBeNull();
  });

  it("keeps a cold nested path pending until its managed ownership resolves", () => {
    const path = "/repo/.worktrees/nested/src";
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: path,
        cachedWorkspaces: undefined,
      }),
    ).toEqual({ path, repoRoot: "/repo", validationPending: true });
  });

  it("restores an available worktree instead of a saved primary checkout", () => {
    const managed = workspace("managed", { archivedAt: null });
    for (const rememberedFolder of ["/repo", "/repo/packages/app"]) {
      expect(
        resolveRepoWorkspaceDestination({
          project,
          rememberedFolder,
          cachedWorkspaces: [managed],
        }),
      ).toBe(managed);
    }
  });

  it("preserves a chat rooted in a plain-folder subdirectory", () => {
    expect(
      resolveRepoWorkspaceDestination({
        project: { ...project, isGitRepository: false },
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

  it("returns to the project when the confirmed list invalidates the only workspace", () => {
    const resolved = resolveRepoWorkspaceDestination({
      project,
      rememberedFolder: "/worktrees/deleted",
      cachedWorkspaces: [],
    });
    expect(resolved).toBeNull();
  });

  it.each([
    { archivedAt: null, present: false },
    { archivedAt: 200, present: true },
  ])(
    "does not reopen a remembered history row on repository switch: %j",
    (state) => {
      const history = workspace("history", {
        ...state,
        path: "/repo/.worktrees/history",
      });
      const available = workspace("available", { archivedAt: null });
      for (const rememberedFolder of [history.path, `${history.path}/src`]) {
        expect(
          resolveRepoWorkspaceDestination({
            project,
            rememberedFolder,
            cachedWorkspaces: [history],
          }),
        ).toBeNull();
        expect(
          resolveRepoWorkspaceDestination({
            project,
            rememberedFolder,
            cachedWorkspaces: [history, available],
          }),
        ).toBe(available);
      }
    },
  );

  it("preserves a cold remembered design path like any other folder (mode model)", () => {
    // Design-MODE rows are ordinary public destinations. The cold remembered
    // identity is kept pending validation exactly as for a code folder.
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder:
          "/Users/test/zeros/design workspaces/zeros/remembered",
        cachedWorkspaces: undefined,
      }),
    ).toMatchObject({
      path: "/Users/test/zeros/design workspaces/zeros/remembered",
      validationPending: true,
    });
  });

  it("selects a remembered design row like any other workspace", () => {
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
      }),
    ).toBe(design);
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

  it("skips missing folders when a repository is re-added", () => {
    const missing = workspace("missing", {
      archivedAt: null,
      present: false,
      createdAt: 1,
    });
    const live = workspace("live", {
      archivedAt: null,
      present: true,
      createdAt: 100,
    });
    expect(leftmostLiveWorkspace([missing, live])).toBe(live);
    expect(leftmostLiveWorkspace([missing])).toBeNull();
  });

  it("returns null for an all-archived repo", () => {
    expect(leftmostLiveWorkspace([workspace("archived")])).toBeNull();
  });

  it("returns null for a worktree-less repo", () => {
    expect(leftmostLiveWorkspace([])).toBeNull();
  });

  it("returns null for a cold cache rather than guessing", () => {
    // `undefined` is "not loaded yet", not "no worktrees".
    expect(leftmostLiveWorkspace(undefined)).toBeNull();
  });
});

// Old root memories cannot restore the retired Local main destination.
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
      }),
    ).toBe(older);
  });

  it("redirects a chat rooted in a main-checkout subdirectory too", () => {
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: "/repo/packages/app",
        cachedWorkspaces: [older],
      }),
    ).toBe(older);
  });

  it("redirects a deleted worktree to a live one instead of to main", () => {
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: "/worktrees/deleted",
        cachedWorkspaces: [older],
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
      }),
    ).toBe(older);
  });

  it("returns to the empty repository for an explicit legacy root memory", () => {
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: "/repo",
        cachedWorkspaces: [],
      }),
    ).toBeNull();
  });

  it("does not guess a redirect while the repository cache is cold", () => {
    // A cold list cannot prove a worktree exists; guessing here would bounce
    // the user twice on a cold repo switch.
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: "/repo",
        cachedWorkspaces: undefined,
      }),
    ).toBeNull();
  });

  it("leaves a confirmed worktree memory untouched", () => {
    expect(
      resolveRepoWorkspaceDestination({
        project,
        rememberedFolder: newer.path,
        cachedWorkspaces: [newer, older],
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

  it("treats a pinned repository lead as a pinned edge on its own", () => {
    // The lead reaches the leading edge before a selection deeper in its own
    // repository does. The outer fade would then sit UNDER the opaque lead and
    // the content emerging beside it would have a hard cut.
    expect(
      workspaceFadeVisibility({ left: true, right: true }, null, "left"),
    ).toEqual({
      outerLeft: false,
      outerRight: true,
      afterPinnedLeft: true,
      beforePinnedRight: false,
    });
  });

  it("does not invent a pinned edge the lead has not reached", () => {
    expect(
      workspaceFadeVisibility({ left: true, right: true }, null, null),
    ).toEqual({
      outerLeft: true,
      outerRight: true,
      afterPinnedLeft: false,
      beforePinnedRight: false,
    });
  });

  it("keeps a hidden edge unfaded when nothing is hidden there", () => {
    // Both pinned at the trailing edge, but nothing is hidden to the left.
    expect(
      workspaceFadeVisibility({ left: false, right: true }, "right", "right"),
    ).toEqual({
      outerLeft: false,
      outerRight: false,
      afterPinnedLeft: false,
      beforePinnedRight: true,
    });
  });
});

describe("asymmetric sticky insets", () => {
  it("keeps the symmetric shorthand behaving exactly as before", () => {
    const symmetric = {
      scrollLeft: 500,
      scrollWidth: 940,
      clientWidth: 360,
      tabOffsetLeft: 100,
      tabWidth: 120,
      edgeInset: 4,
    };
    expect(workspacePinSide(symmetric)).toBe("left");
    expect(workspaceScrollLeftForTab(symmetric)).toBe(100 - 4);
    expect(workspacePinSide({ ...symmetric, leadingInset: 4 })).toBe(
      workspacePinSide(symmetric),
    );
  });

  it("reveals onto a wider leading inset and lands flush at the trailing edge", () => {
    const shared = { scrollWidth: 940, clientWidth: 360, tabWidth: 120 };
    expect(
      workspaceScrollLeftForTab({
        ...shared,
        scrollLeft: 600,
        tabOffsetLeft: 300,
        edgeInset: 4,
        leadingInset: 36,
      }),
    ).toBe(300 - 36);
    expect(
      workspaceScrollLeftForTab({
        ...shared,
        scrollLeft: 0,
        tabOffsetLeft: 692,
        edgeInset: 4,
        leadingInset: 36,
      }),
    ).toBe(692 + 120 - 360 + 4);
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

  it("includes missing workspaces in archive search without changing their lifecycle", () => {
    const missing = workspace("missing", { archivedAt: null, present: false });
    expect(
      filterArchivedWorkspaces([...rows, missing], "zeros", "missing"),
    ).toEqual([missing]);
    expect(missing.archivedAt).toBeNull();
  });

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

describe("workspace change-count formatting", () => {
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

  it("says when an agent finished there while its chat was off screen", () => {
    expect(
      workspaceTabDescription({
        label,
        runActionRunning: false,
        changeLines: { additions: 0, deletions: 0 },
        hasDraft: true,
        unread: true,
      }),
    ).toBe("Open workspace viola-6157, unread, unsent draft");
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
