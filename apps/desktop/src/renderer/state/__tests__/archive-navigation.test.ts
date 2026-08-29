import { describe, expect, it } from "vitest";

import type { Workspace } from "../../platform/git";
import type { Project } from "../projects-store";
import {
  pendingWorkspaceNeighborAfterArchive,
  workspaceNeighborAfterArchive,
} from "../archive-navigation";
import type { PendingWorkspaceCreate } from "../pending-workspaces";

function workspace(
  id: string,
  createdAt: number,
  overrides: Partial<Workspace> = {},
): Workspace {
  return {
    id,
    repoSlug: "acme-app",
    repoRoot: "/repo",
    branch: `zeros/${id}`,
    baseBranch: "main",
    path: `/worktrees/${id}`,
    status: "in-progress",
    createdAt,
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

describe("workspaceNeighborAfterArchive", () => {
  const projectA: Project = {
    id: "project-a",
    name: "Alpha",
    repoRoot: "/repo-a",
    repoSlug: "alpha",
    originUrl: null,
    addedAt: 1,
  };
  const projectB: Project = {
    id: "project-b",
    name: "Beta",
    repoRoot: "/repo-b",
    repoSlug: "beta",
    originUrl: null,
    addedAt: 2,
  };
  const projects = [projectA, projectB];
  const row = (id: string, project: Project, lastActiveAt: number): Workspace =>
    workspace(id, lastActiveAt, {
      repoRoot: project.repoRoot,
      repoSlug: project.repoSlug,
      path: `${project.repoRoot}/worktrees/${id}`,
      lastActiveAt,
    });

  it("prefers the workspace immediately to the left in Ungrouped", () => {
    const newest = row("newest", projectA, 300);
    const leaving = row("leaving", projectB, 200);
    const oldest = row("oldest", projectA, 100);
    expect(
      workspaceNeighborAfterArchive({
        leaving,
        rows: [newest, leaving, oldest],
        projects,
        filter: "ungrouped",
        busyIds: { leaving: 1 },
      }),
    ).toBe(newest);
  });

  it("uses the right neighbor when the archived workspace had no left neighbor", () => {
    const leaving = row("leaving", projectA, 300);
    const next = row("next", projectB, 200);
    expect(
      workspaceNeighborAfterArchive({
        leaving,
        rows: [leaving, next],
        projects,
        filter: "ungrouped",
        busyIds: { leaving: 1 },
      }),
    ).toBe(next);
  });

  it("returns null for the last workspace visible in a repository filter", () => {
    const leaving = row("leaving", projectA, 300);
    const otherRepo = row("other", projectB, 200);
    expect(
      workspaceNeighborAfterArchive({
        leaving,
        rows: [leaving, otherRepo],
        projects,
        filter: "repo:project-a",
        busyIds: { leaving: 1 },
      }),
    ).toBeNull();
  });

  it("crosses a repository-group boundary when that is the nearest left workspace", () => {
    const left = row("left", projectA, 100);
    const leaving = row("leaving", projectB, 300);
    const right = row("right", projectB, 200);
    expect(
      workspaceNeighborAfterArchive({
        leaving,
        rows: [leaving, right, left],
        projects,
        filter: "grouped",
        busyIds: { leaving: 1 },
      }),
    ).toBe(left);
  });

  it("uses the dedicated action order when Active is selected", () => {
    const newestAction = row("newest-action", projectA, 100);
    const leaving = row("leaving-active", projectB, 300);
    const oldestAction = row("oldest-action", projectA, 200);
    expect(
      workspaceNeighborAfterArchive({
        leaving,
        rows: [oldestAction, leaving, newestAction],
        projects,
        filter: "active",
        busyIds: { [leaving.id]: 1 },
        activity: {
          activeAtByWorkspaceId: new Map([
            [newestAction.id, 900],
            [leaving.id, 800],
            [oldestAction.id, 700],
          ]),
        },
      }),
    ).toBe(newestAction);
  });

  it("selects a Design neighbor like any other public workspace", () => {
    const design = workspace("design", 100, {
      kind: "design",
      repoRoot: projectA.repoRoot,
      repoSlug: projectA.repoSlug,
      path: `${projectA.repoRoot}/worktrees/design`,
    });
    const leaving = row("leaving", projectA, 200);
    expect(
      workspaceNeighborAfterArchive({
        leaving,
        rows: [leaving, design],
        projects,
        filter: "grouped",
        busyIds: { leaving: 1 },
      }),
    ).toBe(design);
  });

  it("uses an archiving neighbor only when it is the last still-visible row", () => {
    const stable = row("stable", projectA, 300);
    const busy = row("busy", projectA, 200);
    const leaving = row("leaving", projectA, 100);
    expect(
      workspaceNeighborAfterArchive({
        leaving,
        rows: [leaving, busy, stable],
        projects,
        filter: "ungrouped",
        busyIds: { leaving: 1, busy: 1 },
      }),
    ).toBe(stable);
    expect(
      workspaceNeighborAfterArchive({
        leaving,
        rows: [leaving, busy],
        projects,
        filter: "ungrouped",
        busyIds: { leaving: 1, busy: 1 },
      }),
    ).toBe(busy);
  });
});

describe("pendingWorkspaceNeighborAfterArchive", () => {
  const projectA: Project = {
    id: "project-a",
    name: "Alpha",
    repoRoot: "/repo-a",
    repoSlug: "alpha",
    originUrl: null,
    addedAt: 1,
  };
  const projectB: Project = {
    id: "project-b",
    name: "Beta",
    repoRoot: "/repo-b",
    repoSlug: "beta",
    originUrl: null,
    addedAt: 2,
  };
  const projects = [projectA, projectB];
  const pending = (
    token: string,
    project: Project,
    startedAt: number,
  ): PendingWorkspaceCreate => ({
    token,
    repoRoot: project.repoRoot,
    repoSlug: project.repoSlug,
    path: `${project.repoRoot}/worktrees/${token}`,
    branch: `zeros/${token}`,
    startedAt,
  });
  const leaving = workspace("leaving", 500, {
    repoRoot: projectB.repoRoot,
    repoSlug: projectB.repoSlug,
    path: `${projectB.repoRoot}/worktrees/leaving`,
  });

  it("keeps a visible provisioning workspace ahead of the Create fallback", () => {
    const newest = pending("newest", projectA, 300);
    const nearestLeft = pending("nearest-left", projectB, 200);
    expect(
      pendingWorkspaceNeighborAfterArchive({
        leaving,
        pending: [nearestLeft, newest],
        projects,
        filter: "ungrouped",
      }),
    ).toBe(nearestLeft);
  });

  it("uses the same dedicated clock for pending rows in Active", () => {
    const left = pending("active-left", projectA, 100);
    const right = pending("active-right", projectB, 50);
    expect(
      pendingWorkspaceNeighborAfterArchive({
        leaving,
        pending: [right, left],
        projects,
        filter: "active",
        activity: {
          activeAtByWorkspaceId: new Map([[leaving.id, 800]]),
        },
        activeAtByFolder: new Map([
          [left.path!, 900],
          [right.path!, 700],
        ]),
      }),
    ).toBe(left);
  });

  it("does not cross outside a repository-only filter", () => {
    const otherRepo = pending("other-repo", projectA, 300);
    expect(
      pendingWorkspaceNeighborAfterArchive({
        leaving,
        pending: [otherRepo],
        projects,
        filter: "repo:project-b",
      }),
    ).toBeNull();
  });
});
