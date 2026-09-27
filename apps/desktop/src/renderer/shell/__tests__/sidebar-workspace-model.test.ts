import { describe, expect, it } from "vitest";

import type { Workspace } from "../../platform/git";
import type { PendingWorkspaceCreate } from "../../state/pending-workspaces";
import type { Project } from "../../state/projects-store";
import {
  buildSidebarWorkspaceEntries,
  sidebarItemSelectionKey,
  sidebarScrollTopToReveal,
  sidebarWorkspaceItems,
  sidebarWorkspaceListFilter,
  visibleRepositoryItems,
  type SidebarWorkspaceEntry,
} from "../sidebar-workspace-model";

function project(slug: string, overrides: Partial<Project> = {}): Project {
  return {
    id: `project-${slug}`,
    name: slug,
    repoRoot: `/repos/${slug}`,
    repoSlug: slug,
    originUrl: null,
    isGitRepository: true,
    addedAt: 1,
    ...overrides,
  };
}

function workspace(
  slug: string,
  id: string,
  createdAt: number,
  overrides: Partial<Workspace> = {},
): Workspace {
  return {
    id,
    repoSlug: slug,
    repoRoot: `/repos/${slug}`,
    branch: `zeros/${id}`,
    baseBranch: "main",
    path: `/workspaces/${slug}/${id}`,
    status: "in-progress",
    createdAt,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    ...overrides,
  };
}

function pending(
  slug: string,
  token: string,
  startedAt: number,
): PendingWorkspaceCreate {
  return {
    token,
    repoRoot: `/repos/${slug}`,
    repoSlug: slug,
    path: `/workspaces/${slug}/${token}`,
    branch: `zeros/${token}`,
    startedAt,
  };
}

/** A readable outline: `#repo` for a header, then its row keys. */
function outline(entries: readonly SidebarWorkspaceEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.kind === "repository"
      ? [
          `#${entry.project.repoSlug}`,
          ...entry.items.map(sidebarItemSelectionKey),
        ]
      : entry.kind === "folder"
        ? [entry.key]
        : [sidebarItemSelectionKey(entry.item)],
  );
}

const alpha = project("alpha");
const beta = project("beta");
const empty = project("empty");
const folder = project("folder", { isGitRepository: false });
const projects = [alpha, beta, empty, folder];
const workspaces = [
  workspace("beta", "b-old", 10),
  workspace("alpha", "a-old", 20),
  workspace("alpha", "a-new", 50),
  workspace("beta", "b-new", 40),
  workspace("folder", "local:folder", 5, {
    repoRoot: "/repos/folder",
    path: "/repos/folder",
  }),
];

describe("sidebar workspace list", () => {
  it.each(["grouped", "ungrouped"] as const)(
    "keeps unopened plain folders reachable in %s without synthesizing a workspace",
    (filter) => {
      const entries = buildSidebarWorkspaceEntries({
        filter,
        projects: [folder],
        workspaces: [],
        pending: [],
      });

      expect(entries).toEqual([
        { kind: "folder", key: `project:${folder.id}`, project: folder },
      ]);
      expect(sidebarWorkspaceItems(entries)).toEqual([]);
    },
  );

  it.each(["grouped", "ungrouped"] as const)(
    "uses an existing folder workspace or pending create instead of a duplicate folder entry in %s",
    (filter) => {
      for (const input of [
        { workspaces: [workspaces[4]], pending: [] },
        { workspaces: [], pending: [pending("folder", "creating", 60)] },
      ]) {
        const entries = buildSidebarWorkspaceEntries({
          filter,
          projects: [folder],
          ...input,
        });
        expect(entries).toHaveLength(1);
        expect(entries[0].kind).toBe("row");
      }
    },
  );

  it("groups every Git repository in registry order, newest workspace first", () => {
    const entries = buildSidebarWorkspaceEntries({
      filter: "grouped",
      projects,
      workspaces,
      pending: [pending("alpha", "a-pending", 60)],
    });

    expect(outline(entries)).toEqual([
      "#alpha",
      "a-pending",
      "a-new",
      "a-old",
      "#beta",
      "b-new",
      "b-old",
      // A repository with no workspaces keeps its header, so its + remains.
      "#empty",
      // A plain folder is its own row: no header names it a second time.
      "local:folder",
    ]);
  });

  it("orders in-flight creates newest first inside their repository", () => {
    const entries = buildSidebarWorkspaceEntries({
      filter: "grouped",
      projects: [alpha],
      workspaces: [],
      pending: [pending("alpha", "first", 1), pending("alpha", "second", 2)],
    });

    expect(outline(entries)).toEqual(["#alpha", "second", "first"]);
  });

  it("lists Ungrouped as one mixed newest-first list after in-flight creates", () => {
    const entries = buildSidebarWorkspaceEntries({
      filter: "ungrouped",
      projects,
      workspaces,
      pending: [
        pending("beta", "b-pending", 1),
        pending("alpha", "a-pending", 2),
      ],
    });

    expect(entries.every((entry) => entry.kind === "row")).toBe(true);
    expect(outline(entries)).toEqual([
      "a-pending",
      "b-pending",
      "a-new",
      "b-new",
      "a-old",
      "b-old",
      "local:folder",
    ]);
    const owners = sidebarWorkspaceItems(entries).map(
      (item) => item.project.repoSlug,
    );
    expect(owners).toEqual([
      "alpha",
      "beta",
      "alpha",
      "beta",
      "alpha",
      "beta",
      "folder",
    ]);
  });

  it("drops rows and creates that no registered repository owns", () => {
    const entries = buildSidebarWorkspaceEntries({
      filter: "grouped",
      projects: [alpha],
      workspaces: [workspace("ghost", "g-1", 1), workspace("alpha", "a-1", 1)],
      pending: [pending("ghost", "g-pending", 1)],
    });

    expect(outline(entries)).toEqual(["#alpha", "a-1"]);
  });

  it("never mutates the bridge-owned arrays it projects", () => {
    const rows = [...workspaces];
    const creates = [pending("alpha", "p-1", 1), pending("alpha", "p-2", 2)];
    const snapshot = [
      rows.map((row) => row.id),
      creates.map((row) => row.token),
    ];

    buildSidebarWorkspaceEntries({
      filter: "grouped",
      projects,
      workspaces: rows,
      pending: creates,
    });
    buildSidebarWorkspaceEntries({
      filter: "ungrouped",
      projects,
      workspaces: rows,
      pending: creates,
    });

    expect([
      rows.map((row) => row.id),
      creates.map((row) => row.token),
    ]).toEqual(snapshot);
  });
});

describe("sidebar presentation migration", () => {
  it("keeps Grouped and Ungrouped as they are", () => {
    expect(sidebarWorkspaceListFilter("grouped")).toBe("grouped");
    expect(sidebarWorkspaceListFilter("ungrouped")).toBe("ungrouped");
  });

  it("folds the retired Active list into the mixed Ungrouped list", () => {
    expect(sidebarWorkspaceListFilter("active")).toBe("ungrouped");
  });

  it("folds a repository-only filter back into the default grouping", () => {
    expect(sidebarWorkspaceListFilter("repo:project-alpha")).toBe("grouped");
  });
});

describe("collapsed repository groups", () => {
  const [group] = buildSidebarWorkspaceEntries({
    filter: "grouped",
    projects: [alpha],
    workspaces,
    pending: [pending("alpha", "a-pending", 60)],
  });
  if (!group || group.kind !== "repository") throw new Error("no group");

  it("returns the same rows while expanded", () => {
    expect(visibleRepositoryItems(group.items, false, "a-old")).toBe(
      group.items,
    );
  });

  it("keeps only the selected workspace while collapsed", () => {
    expect(
      visibleRepositoryItems(group.items, true, "a-old").map(
        sidebarItemSelectionKey,
      ),
    ).toEqual(["a-old"]);
  });

  it("keeps a selected in-flight create by its optimistic token", () => {
    expect(
      visibleRepositoryItems(group.items, true, "a-pending").map(
        sidebarItemSelectionKey,
      ),
    ).toEqual(["a-pending"]);
  });

  it("paints nothing under a collapsed repository that owns no selection", () => {
    expect(visibleRepositoryItems(group.items, true, null)).toEqual([]);
    expect(visibleRepositoryItems(group.items, true, "b-new")).toEqual([]);
  });
});

describe("sidebar reveal scrolling", () => {
  const viewport = { viewportTop: 100, viewportBottom: 400 };

  it("leaves a fully visible row where it is", () => {
    expect(
      sidebarScrollTopToReveal({
        ...viewport,
        scrollTop: 50,
        itemTop: 150,
        itemBottom: 182,
      }),
    ).toBe(50);
  });

  it("scrolls up just enough for a row above the viewport", () => {
    expect(
      sidebarScrollTopToReveal({
        ...viewport,
        scrollTop: 200,
        itemTop: 60,
        itemBottom: 92,
      }),
    ).toBe(160);
  });

  it("scrolls down just enough for a row below the viewport", () => {
    expect(
      sidebarScrollTopToReveal({
        ...viewport,
        scrollTop: 0,
        itemTop: 420,
        itemBottom: 452,
      }),
    ).toBe(52);
  });

  it("never scrolls above the top of the list", () => {
    expect(
      sidebarScrollTopToReveal({
        ...viewport,
        scrollTop: 10,
        itemTop: 20,
        itemBottom: 52,
      }),
    ).toBe(0);
  });

  it("aligns the top of a row taller than the viewport", () => {
    expect(
      sidebarScrollTopToReveal({
        ...viewport,
        scrollTop: 0,
        itemTop: 380,
        itemBottom: 900,
      }),
    ).toBe(280);
  });
});
