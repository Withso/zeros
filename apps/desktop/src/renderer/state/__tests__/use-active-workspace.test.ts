import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../platform/git";

const fixture = vi.hoisted(() => ({
  folder: "/repo/.worktrees/history/src",
  project: {
    id: "repo",
    repoRoot: "/repo",
    repoSlug: "repo",
    name: "Repo",
    originUrl: null,
    addedAt: 1,
  },
  live: [] as Workspace[],
  archived: [] as Workspace[],
  liveResolved: false,
  archivedResolved: false,
}));
vi.mock("react", () => ({ useMemo: (fn: () => unknown) => fn() }));
vi.mock("../store", () => ({
  selectActiveFolder: () => fixture.folder,
  useWorkspaceStore: (selector: () => unknown) => selector(),
}));
vi.mock("../use-projects", () => ({
  useProjects: () => ({ projects: [fixture.project] }),
  useProjectForFolder: () => fixture.project,
  useWorkspacesFor: () => ({
    workspaces: fixture.live,
    resolved: fixture.liveResolved,
  }),
  useArchivedWorkspaces: () => ({
    workspaces: fixture.archived,
    resolved: fixture.archivedResolved,
  }),
}));
const { useActiveWorkspace } = await import("../use-active-workspace");
const { workspaceIsReadOnly } = await import("../workspace-history");
const history: Workspace = {
  id: "history",
  repoRoot: "/repo",
  repoSlug: "repo",
  path: "/repo/.worktrees/history",
  branch: "history",
  baseBranch: "main",
  status: "in-progress",
  archivedAt: 100,
  present: false,
  createdAt: 1,
  stashRef: null,
  prNumber: null,
  prState: null,
  prUrl: null,
  agentId: null,
  lastActiveAt: null,
};
beforeEach(() => {
  fixture.folder = `${history.path}/src`;
  fixture.live = [];
  fixture.archived = [];
  fixture.liveResolved = false;
  fixture.archivedResolved = false;
});

describe("active history resolution", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    "does not admit a nested history cwd as local main with resolved lists %s/%s",
    (live, archived) => {
      fixture.liveResolved = live;
      fixture.archivedResolved = archived;
      expect(useActiveWorkspace()).toMatchObject({
        workspace: null,
        loading: true,
      });
      fixture.archived = [history];
      const resolved = useActiveWorkspace();
      expect(resolved.workspace).toBe(history);
      expect(resolved.loading).toBe(false);
      expect(workspaceIsReadOnly(resolved.workspace)).toBe(true);
    },
  );

  it("uses a confirmed missing row immediately without waiting for unrelated archives", () => {
    const missing = { ...history, archivedAt: null };
    fixture.live = [missing];
    fixture.liveResolved = true;
    expect(useActiveWorkspace()).toMatchObject({
      workspace: missing,
      loading: false,
    });
  });

  it("resolves legacy main only after nested ownership has been checked", () => {
    fixture.liveResolved = true;
    fixture.archivedResolved = true;
    expect(useActiveWorkspace()).toMatchObject({
      workspace: { id: "local:repo", path: "/repo" },
      loading: false,
    });
  });
});
