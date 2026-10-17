import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../platform/git";
import type { WorkspaceState } from "../store";
import type { Project } from "../projects-store";

const fixture = vi.hoisted(() => ({
  folder: "/repo/.worktrees/history/src",
  project: {
    id: "repo",
    repoRoot: "/repo",
    repoSlug: "repo",
    name: "Repo",
    originUrl: null,
    addedAt: 1,
    isGitRepository: undefined as boolean | undefined,
  },
  live: [] as Workspace[],
  archived: [] as Workspace[],
  liveResolved: false,
  archivedResolved: false,
  projectResolved: true,
  inferredProject: null as Project | null,
  linked: undefined as WorkspaceState["localLinkNavigation"],
}));
vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useMemo: (fn: () => unknown) => fn() }));
vi.mock("../store", () => ({
  selectActiveFolder: () => fixture.folder,
  useWorkspaceStore: (selector: (state: Partial<WorkspaceState>) => unknown) =>
    selector({ localLinkNavigation: fixture.linked }),
}));
vi.mock("../use-projects", () => ({
  useProjects: () => ({ projects: [fixture.project] }),
  useProjectForFolder: () => fixture.projectResolved
    ? fixture.inferredProject ?? fixture.project
    : null,
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
  fixture.project.isGitRepository = undefined;
  fixture.projectResolved = true;
  fixture.inferredProject = null;
  fixture.linked = undefined;
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

  it.each([
    { isGitRepository: true, folder: "/repo" },
    { isGitRepository: true, folder: "/repo/packages/app" },
    { isGitRepository: undefined, folder: "/repo" },
    { isGitRepository: undefined, folder: "/repo/packages/app" },
  ])(
    "never resolves saved local main at $folder with Git capability $isGitRepository",
    ({ isGitRepository, folder }) => {
      fixture.project.isGitRepository = isGitRepository;
      fixture.folder = folder;
      fixture.liveResolved = true;
      fixture.archivedResolved = true;
      expect(useActiveWorkspace()).toMatchObject({
        workspace: null,
        loading: false,
      });
    },
  );

  it("resolves a saved plain folder only after nested ownership has been checked", () => {
    fixture.project.isGitRepository = false;
    fixture.liveResolved = true;
    fixture.archivedResolved = true;
    expect(useActiveWorkspace()).toMatchObject({
      workspace: { id: "local:repo", path: "/repo" },
      loading: false,
    });
  });

  it("keeps a managed nested worktree even when its branch is main", () => {
    const managed = {
      ...history,
      branch: "main",
      archivedAt: null,
      present: true,
    };
    fixture.project.isGitRepository = true;
    fixture.live = [managed];
    expect(useActiveWorkspace().workspace).toBe(managed);
  });

  it("resolves an adopted worktree from the verified link before path hints exist", () => {
    const managed = { ...history, id: "ws_adopted", path: "/external/tree", archivedAt: null, present: true };
    fixture.folder = managed.path;
    fixture.projectResolved = false;
    fixture.live = [managed];
    fixture.liveResolved = true;
    fixture.linked = { workspace: managed, folder: managed.path, passive: true };
    expect(useActiveWorkspace()).toMatchObject({
      project: fixture.project,
      workspace: managed,
      loading: false,
    });
  });

  it("does not resurrect a linked managed worktree after a confirmed deletion", () => {
    const managed = { ...history, id: "ws_deleted", path: "/external/deleted", archivedAt: null, present: true };
    fixture.folder = managed.path;
    fixture.projectResolved = false;
    fixture.liveResolved = true;
    fixture.archivedResolved = true;
    fixture.linked = { workspace: managed, folder: managed.path, passive: true };
    expect(useActiveWorkspace().workspace).toBeNull();
  });

  it("uses verified workspace ownership over an older containing-project hint", () => {
    const managed = { ...history, id: "ws_nested", path: "/external/tree", archivedAt: null, present: true };
    fixture.folder = managed.path;
    fixture.inferredProject = { ...fixture.project, id: "other", repoRoot: "/external", repoSlug: "other" };
    fixture.live = [managed];
    fixture.liveResolved = true;
    fixture.linked = { workspace: managed, folder: managed.path, passive: true };
    expect(useActiveWorkspace().project).toBe(fixture.project);
  });
});
