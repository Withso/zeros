import { beforeEach, describe, expect, it } from "vitest";

import type { Workspace } from "../../../native/git";
import {
  forgetPersistedWorkspaceList,
  loadPersistedWorkspaceLists,
  persistWorkspaceList,
  sanitizePersistedWorkspace,
  workspaceListPersistenceLimits,
} from "../workspace-list-persistence";

function installStorage(): void {
  const values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
}

function workspace(repoSlug: string, id = "workspace-1"): Workspace {
  return {
    id,
    repoSlug,
    repoRoot: `/repos/${repoSlug}`,
    branch: `branch-${id}`,
    baseBranch: "main",
    path: `/workspaces/${repoSlug}/${id}`,
    status: "in-progress",
    createdAt: 100,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: 200,
    setupState: "passed",
    present: true,
  };
}

beforeEach(installStorage);

describe("workspace-list persistence", () => {
  it("round-trips complete rows under their exact repository key", () => {
    const row = workspace("owner/repo");
    persistWorkspaceList("owner/repo", [row]);

    expect(loadPersistedWorkspaceLists().get("owner/repo")).toEqual([row]);
    expect(loadPersistedWorkspaceLists().get("other/repo")).toBeUndefined();
  });

  it("rejects a row whose embedded owner differs from the storage key", () => {
    expect(
      sanitizePersistedWorkspace(workspace("owner/repo"), "other/repo"),
    ).toBeNull();

    localStorage.setItem(
      "zeros-workspace-lists:v1",
      JSON.stringify({
        version: 1,
        entries: [
          {
            repoSlug: "other/repo",
            savedAt: 1,
            rows: [workspace("owner/repo")],
          },
        ],
      }),
    );
    expect(loadPersistedWorkspaceLists().size).toBe(0);
  });

  it("never replaces a complete snapshot with a truncated oversized list", () => {
    persistWorkspaceList("owner/repo", [workspace("owner/repo")]);
    const oversized = Array.from(
      { length: workspaceListPersistenceLimits.rowsPerRepository + 1 },
      (_, index) => workspace("owner/repo", `workspace-${index}`),
    );
    persistWorkspaceList("owner/repo", oversized);

    expect(loadPersistedWorkspaceLists().get("owner/repo")).toHaveLength(1);
  });

  it("bounds repository owners and evicts the oldest snapshot", () => {
    for (
      let index = 0;
      index < workspaceListPersistenceLimits.repositories + 3;
      index += 1
    ) {
      const slug = `owner/repo-${index}`;
      persistWorkspaceList(slug, [workspace(slug)]);
    }
    const restored = loadPersistedWorkspaceLists();
    expect(restored.size).toBe(workspaceListPersistenceLimits.repositories);
    expect(restored.has("owner/repo-0")).toBe(false);
    expect(
      restored.has(
        `owner/repo-${workspaceListPersistenceLimits.repositories + 2}`,
      ),
    ).toBe(true);
  });

  it("prunes a deleted repository owner", () => {
    persistWorkspaceList("owner/a", [workspace("owner/a")]);
    persistWorkspaceList("owner/b", [workspace("owner/b")]);
    forgetPersistedWorkspaceList("owner/a");

    const restored = loadPersistedWorkspaceLists();
    expect(restored.has("owner/a")).toBe(false);
    expect(restored.has("owner/b")).toBe(true);
  });
});
