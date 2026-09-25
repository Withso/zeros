import { describe, expect, it } from "vitest";
import {
  selectWorkspaceHistory,
  readOnlyWorkspaceForFolder,
  workspaceHistoryBanner,
  workspaceIsReadOnly,
} from "../workspace-history";
import type { Workspace } from "../../platform/git";
import type { Project } from "../projects-store";

const workspace = (id: string, patch: Partial<Workspace> = {}) =>
  ({ id, archivedAt: null, present: true, ...patch }) as Workspace;

describe("workspace history", () => {
  it("keeps read-only ownership exact across nested available workspaces and registered repositories", () => {
    const outer = workspace("outer", {
      path: "/repo/worktree",
      repoRoot: "/repo",
      present: false,
    });
    const nested = workspace("nested", {
      path: "/repo/worktree/child",
      repoRoot: "/repo",
    });
    const project = {
      id: "repo",
      repoRoot: "/repo",
      repoSlug: "repo",
    } as Project;
    const childProject = {
      id: "child",
      repoRoot: nested.path,
      repoSlug: "child",
    } as Project;
    expect(
      readOnlyWorkspaceForFolder(
        "/repo/worktree/src",
        [outer, nested],
        [project],
      ),
    ).toBe(outer);
    expect(
      readOnlyWorkspaceForFolder(
        "/repo/worktree/child/src",
        [outer, nested],
        [project],
      ),
    ).toBeNull();
    expect(
      readOnlyWorkspaceForFolder(
        "/repo/worktree/child/src",
        [outer],
        [project, childProject],
      ),
    ).toBeNull();
    expect(
      readOnlyWorkspaceForFolder(
        "/repo/worktree-other/src",
        [outer],
        [project],
      ),
    ).toBeNull();
    expect(
      readOnlyWorkspaceForFolder(
        "/repo/worktree/src",
        [{ ...outer, present: true }],
        [project],
      ),
    ).toBeNull();
  });
  it("keeps missing and archived owners distinct, and removes stale archives on restore", () => {
    const missing = workspace("missing", { present: false });
    const archived = workspace("archived", { archivedAt: 10 });
    const restored = workspace("restored");
    expect(
      selectWorkspaceHistory(
        [missing, restored],
        [archived, workspace("restored", { archivedAt: 5 })],
      ),
    ).toEqual([archived, missing]);
    expect(missing.archivedAt).toBeNull();
  });

  it("never treats unknown presence as confirmed loss", () => {
    expect(workspaceIsReadOnly(null)).toBe(false);
    expect(workspaceIsReadOnly({})).toBe(false);
    expect(workspaceIsReadOnly({ present: false })).toBe(true);
    expect(workspaceIsReadOnly({ archivedAt: 0 })).toBe(true);
  });

  it.each([
    ["restore", "Workspace folder missing", "Restore"],
    [
      "locate",
      "Workspace folder missing. Reconnect the original folder",
      "Locate",
    ],
    ["none", "Workspace folder missing. No recovery", null],
  ] as const)(
    "uses verified %s recovery copy and action",
    (action, message, button) => {
      expect(
        workspaceHistoryBanner(workspace("missing", { present: false }), {
          action,
          snapshotAt: null,
        }),
      ).toEqual({ message, action: button });
    },
  );

  it("does not promise recovery before the source check completes", () => {
    expect(
      workspaceHistoryBanner(workspace("missing", { present: false })),
    ).toEqual({ message: "Workspace folder missing", action: null });
    expect(
      workspaceHistoryBanner(
        workspace("archived", { archivedAt: 100, present: false }),
      ),
    ).toEqual({ message: "This workspace is archived.", action: "Unarchive" });
  });
});
