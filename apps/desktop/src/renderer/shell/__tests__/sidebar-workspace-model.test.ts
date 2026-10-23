import { describe, expect, it } from "vitest";

import type { Workspace } from "../../platform/git";
import type { PendingWorkspaceCreate } from "../../state/pending-workspaces";
import type { Project } from "../../state/projects-store";
import { acceptCloudWorkspaceDocument, clearCloudWorkspaceCatalog, getCloudProjects, getCloudWorkspaceRows } from "../../state/cloud-workspace-catalog";
import {
  buildSidebarWorkspaceEntries,
  sidebarItemSelectionKey,
  sidebarScrollTopToReveal,
  sidebarWorkspaceItems,
  sidebarNeighborAfterRemoval,
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
    entry.kind === "status" ? [`#${entry.status.value}`, ...entry.items.map(sidebarItemSelectionKey)] : entry.kind === "repository"
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
  it.each(["grouped", "status", "ungrouped"] as const)("filters cloud repositories by stable project id in %s", filter => {
    const organizationId = "11111111-1111-4111-8111-111111111111";
    try {
      for (const [id, name] of [["22222222-2222-4222-8222-222222222222", "alpha"], ["33333333-3333-4333-8333-333333333333", "beta"]]) {
        acceptCloudWorkspaceDocument({ id, organizationId, teamId: organizationId, createdBy: organizationId,
          name, placement: "cloud", status: "stopped", version: 1, error: null, deletedAt: null,
          createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z",
          capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
          repository: { forge: "github.com", owner: "example", name, revision: "refs/heads/main" },
          generation: { number: 1, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "stopped", lastObservedAt: null } });
      }
      const cloudProjects = getCloudProjects();
      const entries = buildSidebarWorkspaceEntries({ filter, projects: cloudProjects, workspaces: getCloudWorkspaceRows(), pending: [], repositoryIds: [cloudProjects[0].id] });
      expect(sidebarWorkspaceItems(entries).map(item => item.project.name)).toEqual(["alpha"]);
    } finally { clearCloudWorkspaceCatalog(); }
  });

  it("groups by Home's lifecycle statuses, including empty groups and pending creates", () => {
    const entries = buildSidebarWorkspaceEntries({ filter: "status", projects: [alpha, beta, folder],
      workspaces: [workspace("alpha", "done", 10, { status: "done" }),
        workspace("beta", "review", 20, { status: "in-review" }),
        workspace("alpha", "unknown", 30, { status: "future-status" as Workspace["status"] })],
      pending: [pending("beta", "creating", 40)],
    });
    expect(outline(entries)).toEqual(["#backlog", "#in-progress", "creating", "unknown", "#in-review", "review", "#done", "done", "#cancelled", "project:project-folder"]);
    expect(sidebarWorkspaceItems(entries).map(sidebarItemSelectionKey)).toEqual(["creating", "unknown", "review", "done"]);
  });

  it.each(["grouped", "status", "ungrouped"] as const)("uses real activity in %s while preserving Created ordering", filter => {
    const args = { filter, projects: [alpha], workspaces: [workspace("alpha", "old", 1), workspace("alpha", "new", 5)], pending: [],
      activity: { activeAtByWorkspaceId: new Map([["old", 100]]) } };
    expect(sidebarWorkspaceItems(buildSidebarWorkspaceEntries(args)).map(sidebarItemSelectionKey)).toEqual(["old", "new"]);
    expect(sidebarWorkspaceItems(buildSidebarWorkspaceEntries({ ...args, sort: "created" })).map(sidebarItemSelectionKey)).toEqual(["new", "old"]);
  });

  it("keeps stable ties and ignores malformed update timestamps", () => {
    const entries = buildSidebarWorkspaceEntries({ filter: "ungrouped", projects: [alpha], pending: [],
      workspaces: [workspace("alpha", "first", 5, { lastActiveAt: Number.NaN }), workspace("alpha", "second", 5, { lastActiveAt: Infinity })],
      activity: { activeAtByWorkspaceId: new Map([["second", -10]]) },
    });
    expect(outline(entries)).toEqual(["first", "second"]);
  });

  it("does not leak a filtered-out cloud create as an unregistered repository", () => {
    const create = { ...pending("beta", "cloud-create", 100), placement: "cloud" as const, organizationId: "org",
      repository: { name: "beta", originUrl: "https://github.com/example/beta.git" } };
    const entries = buildSidebarWorkspaceEntries({ filter: "ungrouped", projects: [alpha, beta],
      workspaces, pending: [create], repositoryIds: [alpha.id] });
    expect(outline(entries)).toEqual(["a-new", "a-old"]);
  });

  it.each(["local", "cloud"] as const)(
    "sorts %s workspaces by their latest update by default, with Created remaining fixed",
    (placement) => {
      const updated = workspace("alpha", "updated", 10, { placement, lastActiveAt: 100 });
      const newer = workspace("alpha", "newer", 50, { placement });
      const args = { filter: "ungrouped" as const, projects: [alpha], workspaces: [newer, updated], pending: [] };
      expect(outline(buildSidebarWorkspaceEntries(args))).toEqual(["updated", "newer"]);
      expect(outline(buildSidebarWorkspaceEntries({ ...args, sort: "created" }))).toEqual(["newer", "updated"]);
    },
  );

  it("filters repository groups, workspace rows and pending creates together", () => {
    const entries = buildSidebarWorkspaceEntries({
      filter: "grouped", projects, workspaces,
      pending: [pending("alpha", "a-pending", 60), pending("beta", "b-pending", 70)],
      repositoryIds: [alpha.id],
    });
    expect(outline(entries)).toEqual(["#alpha", "a-pending", "a-new", "a-old"]);
  });

  it("never projects archived or missing workspaces in any grouping", () => {
    for (const filter of ["grouped", "status", "ungrouped"] as const) {
      const entries = buildSidebarWorkspaceEntries({ filter, projects: [alpha], pending: [], workspaces: [
        workspace("alpha", "archived", 100, { archivedAt: 0 }),
        workspace("alpha", "missing", 101, { present: false }),
        workspace("alpha", "live", 1),
      ] });
      expect(sidebarWorkspaceItems(entries).map(sidebarItemSelectionKey)).toEqual(["live"]);
    }
  });

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

  it.each(["grouped", "ungrouped"] as const)(
    "shows the first cloud create in %s before its repository is confirmed",
    filter => {
      const create = { ...pending("cloud-repository", "cloud-request", 60), placement: "cloud" as const,
        organizationId: "organization", path: undefined, branch: undefined,
        repository: { name: "first-repository", originUrl: "https://github.com/example/first-repository.git" } };
      const entries = buildSidebarWorkspaceEntries({ filter, projects: [], workspaces: [], pending: [create] });
      expect(outline(entries)).toEqual(["cloud-request"]);
      expect(entries[0].kind).toBe("row");
      expect(sidebarWorkspaceItems(entries)[0].project.name).toBe("first-repository");
      expect(create.path).toBeUndefined();
    },
  );

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

describe("sidebar archive navigation", () => {
  it.each(["grouped", "status", "ungrouped"] as const)("uses the filtered %s display order after removal", filter => {
    const leaving = workspace("alpha", "leaving", 20, { status: "in-review" });
    const before = workspace("alpha", "before", 30, { status: "in-review", lastActiveAt: 70 });
    const after = workspace("alpha", "after", 10, { status: "in-review" });
    const hidden = workspace("beta", "hidden", 1, { lastActiveAt: 90 });
    const entries = buildSidebarWorkspaceEntries({ filter, projects: [alpha, beta], workspaces: [hidden, after, leaving, before], pending: [], repositoryIds: [alpha.id] });
    expect(sidebarNeighborAfterRemoval(entries, leaving, {})).toMatchObject({ kind: "workspace", workspace: before });
    expect(sidebarNeighborAfterRemoval(entries, leaving, { before: 1 })).toMatchObject({ kind: "workspace", workspace: after });
    expect(sidebarNeighborAfterRemoval(entries, hidden, {})).toMatchObject({ kind: "workspace", workspace: before });
  });

  it("can choose a visible pending create but never a pathless cloud create", () => {
    const leaving = workspace("alpha", "leaving", 10);
    const creating = pending("alpha", "creating", 20);
    const entries = buildSidebarWorkspaceEntries({ filter: "ungrouped", projects: [alpha], workspaces: [leaving], pending: [creating] });
    expect(sidebarNeighborAfterRemoval(entries, leaving, {})).toMatchObject({ kind: "pending", pending: creating });
    const pathless = buildSidebarWorkspaceEntries({ filter: "ungrouped", projects: [alpha], workspaces: [leaving], pending: [{ ...creating, path: undefined, placement: "cloud" }] });
    expect(sidebarNeighborAfterRemoval(pathless, leaving, {})).toBeNull();
  });
});

describe("sidebar presentation migration", () => {
  it("keeps Grouped and Ungrouped as they are", () => {
    expect(sidebarWorkspaceListFilter("grouped")).toBe("grouped");
    expect(sidebarWorkspaceListFilter("ungrouped")).toBe("ungrouped");
    expect(sidebarWorkspaceListFilter("status")).toBe("status");
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
