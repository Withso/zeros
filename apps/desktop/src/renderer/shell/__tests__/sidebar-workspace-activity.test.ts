import { describe, expect, it } from "vitest";
import type { Workspace } from "../../platform/git";
import {
  changedSidebarWorkspaceFolders,
  sidebarWorkspaceActivity,
} from "../sidebar-workspace-activity";

function workspace(
  id: string,
  path: string,
  overrides: Partial<Workspace> = {},
): Workspace {
  return {
    id,
    path,
    repoRoot: path,
    repoSlug: id,
    branch: "feature",
    baseBranch: "main",
    createdAt: 1,
    status: "in-progress",
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

describe("sidebar update clocks", () => {
  it.each([
    {
      path: "/var/workspaces/one",
      placement: "local" as const,
      organizationId: null,
    },
    {
      path: "/workspaces/one",
      placement: "local" as const,
      organizationId: "org-a",
    },
    {
      path: "cloud://org-a/one",
      placement: "cloud" as const,
      organizationId: "org-a",
    },
  ])(
    "combines chat and deliberate activity for $placement / $organizationId",
    ({ path, ...owner }) => {
      const row = workspace("one", path, owner);
      const values = sidebarWorkspaceActivity(
        [row],
        [
          { folder: `${path}/packages/app`, updatedAt: 100 },
          { folder: "cloud://org-b/one", updatedAt: 900 },
          { folder: "/other/workspace", updatedAt: 900 },
        ],
        { [path]: 50, [path + "-other"]: 800 },
      );
      expect([...values]).toEqual([["one", 100]]);
    },
  );

  it("normalizes Local aliases and keeps separately nested workspaces independent", () => {
    const outer = workspace("outer", "/var/repos/app");
    const nested = workspace("nested", "/var/repos/app/nested");
    const values = sidebarWorkspaceActivity(
      [outer, nested],
      [{ folder: "/private/var/repos/app/nested/src", updatedAt: 100 }],
      {},
    );
    expect([...values]).toEqual([["nested", 100]]);
  });

  it("does not invent updates from first reads, navigation or unchanged refreshes", () => {
    const row = workspace("one", "/workspace");
    expect(changedSidebarWorkspaceFolders([], [row])).toEqual([]);
    expect(changedSidebarWorkspaceFolders([row], [row])).toEqual([]);
    expect(
      changedSidebarWorkspaceFolders(
        [row],
        [{ ...row, present: true, hasChanges: true }],
      ),
    ).toEqual([]);
    expect(
      sidebarWorkspaceActivity(
        [row],
        [{ folder: row.path, updatedAt: Number.NaN }],
        { [row.path]: Infinity },
      ).size,
    ).toBe(0);
  });

  it.each(["local", "cloud"] as const)(
    "notices confirmed %s status, PR, branch and setup changes",
    (placement) => {
      const row = workspace(
        "one",
        placement === "cloud" ? "cloud://org/one" : "/workspace",
        { placement },
      );
      for (const change of [
        { status: "done" as const },
        { prNumber: 123 },
        { prState: "merged" as const },
        { branch: "renamed" },
        { baseBranch: "develop" },
        { setupState: "passed" as const },
      ]) {
        expect(
          changedSidebarWorkspaceFolders([row], [{ ...row, ...change }]),
        ).toEqual([row.path]);
      }
      expect(
        changedSidebarWorkspaceFolders(
          [row],
          [{ ...row, path: "/replacement", status: "done" }],
        ),
      ).toEqual([]);
      expect(
        changedSidebarWorkspaceFolders(
          [row],
          [{ ...row, organizationId: "other", status: "done" }],
        ),
      ).toEqual([]);
    },
  );
});
