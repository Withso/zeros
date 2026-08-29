import { describe, expect, it } from "vitest";

import type { Workspace } from "../../platform/git";
import type { Project } from "../projects-store";
import {
  DEFAULT_WORKSPACE_LIST_FILTER,
  parseWorkspaceListFilter,
  repositoryWorkspaceListFilter,
  workspaceListFilterForOpenedRepo,
  workspaceTabGroups,
} from "../workspace-list-filter";

const projects: Project[] = [
  {
    id: "project-a",
    name: "Alpha",
    repoRoot: "/repos/alpha",
    repoSlug: "alpha",
    originUrl: null,
    addedAt: 1,
  },
  {
    id: "project-b",
    name: "Beta",
    repoRoot: "/repos/beta",
    repoSlug: "beta",
    originUrl: null,
    addedAt: 2,
  },
];

function workspace(
  id: string,
  project: Project,
  overrides: Partial<Workspace> = {},
): Workspace {
  return {
    id,
    repoSlug: project.repoSlug,
    repoRoot: project.repoRoot,
    branch: `zeros/${id}`,
    baseBranch: "main",
    path: `${project.repoRoot}/worktrees/${id}`,
    status: "in-progress",
    createdAt: 100,
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

describe("workspace-list filter persistence", () => {
  it("defaults malformed and empty values to Grouped", () => {
    expect(parseWorkspaceListFilter(undefined)).toBe(
      DEFAULT_WORKSPACE_LIST_FILTER,
    );
    expect(parseWorkspaceListFilter("repo:")).toBe(
      DEFAULT_WORKSPACE_LIST_FILTER,
    );
    expect(parseWorkspaceListFilter("recent")).toBe(
      DEFAULT_WORKSPACE_LIST_FILTER,
    );
  });

  it("round-trips Grouped, Ungrouped, Active, and a repository filter", () => {
    expect(parseWorkspaceListFilter("grouped")).toBe("grouped");
    expect(parseWorkspaceListFilter("ungrouped")).toBe("ungrouped");
    expect(parseWorkspaceListFilter("active")).toBe("active");
    expect(parseWorkspaceListFilter("repo:project-a")).toBe("repo:project-a");
  });
});

describe("opening a workspace through a workspace-list filter", () => {
  it("preserves Grouped, Ungrouped, and Active across cross-repository opens", () => {
    expect(
      workspaceListFilterForOpenedRepo(
        "grouped",
        projects[1].repoRoot,
        projects,
      ),
    ).toBe("grouped");
    expect(
      workspaceListFilterForOpenedRepo(
        "ungrouped",
        projects[1].repoRoot,
        projects,
      ),
    ).toBe("ungrouped");
    expect(
      workspaceListFilterForOpenedRepo(
        "active",
        projects[1].repoRoot,
        projects,
      ),
    ).toBe("active");
  });

  it("retargets a repository filter atomically to the opened workspace owner", () => {
    expect(
      workspaceListFilterForOpenedRepo(
        repositoryWorkspaceListFilter(projects[0].id),
        projects[1].repoRoot,
        projects,
      ),
    ).toBe("repo:project-b");
  });

  it("falls back to Grouped when the opened owner is no longer registered", () => {
    expect(
      workspaceListFilterForOpenedRepo(
        "repo:project-a",
        "/repos/removed",
        projects,
      ),
    ).toBe("grouped");
  });
});

describe("workspace-list projection", () => {
  const aIdle = workspace("a-idle", projects[0], {
    createdAt: 100,
    lastActiveAt: 200,
  });
  const aWorking = workspace("a-working", projects[0], {
    createdAt: 50,
    lastActiveAt: 60,
  });
  const bRecentChat = workspace("b-recent-chat", projects[1], {
    createdAt: 300,
    lastActiveAt: 310,
  });
  const bRecentGit = workspace("b-recent-git", projects[1], {
    createdAt: 400,
    lastActiveAt: 600,
  });
  const rows = [aIdle, bRecentGit, aWorking, bRecentChat];
  const activity = {
    activeAtByWorkspaceId: new Map([
      [aWorking.id, 900],
      [bRecentChat.id, 700],
    ]),
  };

  it("keeps repository groups in static creation order", () => {
    const groups = workspaceTabGroups("grouped", projects, rows, activity);
    expect(groups.map((group) => group.project?.id)).toEqual([
      "project-a",
      "project-b",
    ]);
    expect(groups[0].workspaces.map((row) => row.id)).toEqual([
      "a-idle",
      "a-working",
    ]);
    expect(groups[1].workspaces.map((row) => row.id)).toEqual([
      "b-recent-git",
      "b-recent-chat",
    ]);
  });

  it("mixes repositories by creation in Ungrouped without applying activity ordering", () => {
    const [group] = workspaceTabGroups("ungrouped", projects, rows, activity);
    expect(group.project).toBeNull();
    expect(group.workspaces.map((row) => row.id)).toEqual([
      "b-recent-git",
      "b-recent-chat",
      "a-idle",
      "a-working",
    ]);
  });

  it("limits a repository filter without applying activity ordering", () => {
    const groups = workspaceTabGroups(
      "repo:project-b",
      projects,
      rows,
      activity,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].project?.id).toBe("project-b");
    expect(groups[0].workspaces.map((row) => row.id)).toEqual([
      "b-recent-git",
      "b-recent-chat",
    ]);
  });

  it("applies intentional workspace activity only in Active", () => {
    const [group] = workspaceTabGroups("active", projects, rows, activity);
    expect(group.project).toBeNull();
    expect(group.workspaces.map((row) => row.id)).toEqual([
      "a-working",
      "b-recent-chat",
      "b-recent-git",
      "a-idle",
    ]);
  });

  it("keeps source order stable when Active timestamps tie", () => {
    const tied = [
      workspace("z-source-first", projects[0], { createdAt: 500 }),
      workspace("a-source-second", projects[1], { createdAt: 500 }),
    ];
    const [group] = workspaceTabGroups("active", projects, tied, {
      activeAtByWorkspaceId: new Map([
        ["z-source-first", 900],
        ["a-source-second", 900],
      ]),
    });
    expect(group.workspaces.map((row) => row.id)).toEqual([
      "z-source-first",
      "a-source-second",
    ]);
  });
});
