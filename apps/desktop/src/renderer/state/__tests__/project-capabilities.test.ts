import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { loadProjects, removeProject, upsertProject } from "../projects-store";
import { refreshProjectCapabilities } from "../project-capabilities";
import {
  workspaceInspectFolder,
  type InspectFolderResult,
} from "../../platform/git";

vi.mock("../../platform/git", () => ({ workspaceInspectFolder: vi.fn() }));
const inspect = vi.mocked(workspaceInspectFolder);
const result = (
  isRepo: boolean,
  originUrl: string | null = null,
): InspectFolderResult => ({
  isRepo,
  originUrl,
  hasCommits: false,
  isWorktree: false,
  branch: null,
  mainRoot: null,
  sourceTool: "unknown",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
  inspect.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("project capabilities on app resume", () => {
  it("refreshes Git and replaces or removes an origin without renaming the project", async () => {
    const project = upsertProject({
      repoRoot: "/projects/folder",
      isGitRepository: false,
    });
    inspect.mockResolvedValueOnce(
      result(true, "git@github.com:example/first.git"),
    );
    await refreshProjectCapabilities(project);
    expect(loadProjects()[0]).toEqual({
      ...project,
      isGitRepository: true,
      originUrl: "git@github.com:example/first.git",
    });
    inspect.mockResolvedValueOnce(
      result(true, "git@github.com:example/second.git"),
    );
    await refreshProjectCapabilities(loadProjects()[0]);
    expect(loadProjects()[0].originUrl).toBe(
      "git@github.com:example/second.git",
    );
    inspect.mockResolvedValueOnce(result(false));
    await refreshProjectCapabilities(loadProjects()[0]);
    expect(loadProjects()[0]).toEqual(project);
  });

  it("deduplicates in-flight reads and retains the last confirmed state on failure", async () => {
    const project = upsertProject({
      repoRoot: "/projects/folder",
      isGitRepository: true,
    });
    const pending = deferred<InspectFolderResult>();
    inspect.mockReturnValueOnce(pending.promise);
    const first = refreshProjectCapabilities(project);
    const second = refreshProjectCapabilities(project);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(loadProjects()[0]).toEqual(project);
    pending.resolve(result(false));
    await Promise.all([first, second]);
    const confirmed = loadProjects()[0];
    inspect.mockRejectedValueOnce(new Error("Permission denied"));
    await refreshProjectCapabilities(confirmed);
    expect(loadProjects()[0]).toEqual(confirmed);
  });

  it("rejects a late response after an explicit Git change, including A → B → A", async () => {
    const project = upsertProject({
      repoRoot: "/projects/folder",
      isGitRepository: false,
    });
    const pending = deferred<InspectFolderResult>();
    inspect.mockReturnValueOnce(pending.promise);
    const refresh = refreshProjectCapabilities(project);
    upsertProject({ repoRoot: project.repoRoot, isGitRepository: true });
    upsertProject({ repoRoot: project.repoRoot, isGitRepository: false });
    pending.resolve(result(true));
    await refresh;
    expect(loadProjects()[0].isGitRepository).toBe(false);
  });

  it("does not resurrect a removed owner or change its replacement at the same path", async () => {
    const project = upsertProject({
      repoRoot: "/projects/folder",
      isGitRepository: false,
    });
    const pending = deferred<InspectFolderResult>();
    inspect.mockReturnValueOnce(pending.promise);
    const refresh = refreshProjectCapabilities(project);
    removeProject(project.id);
    const replacement = upsertProject({
      repoRoot: project.repoRoot,
      isGitRepository: false,
    });
    pending.resolve(result(true));
    await refresh;
    expect(loadProjects()).toEqual([replacement]);
  });

  it("keeps simultaneous inspections isolated by exact owner", async () => {
    const first = upsertProject({
      repoRoot: "/projects/one",
      isGitRepository: false,
    });
    const second = upsertProject({
      repoRoot: "/projects/two",
      isGitRepository: true,
    });
    inspect.mockImplementation(async (root) => result(root === first.repoRoot));
    await Promise.all([
      refreshProjectCapabilities(first),
      refreshProjectCapabilities(second),
    ]);
    expect(loadProjects().find((p) => p.id === first.id)?.isGitRepository).toBe(
      true,
    );
    expect(
      loadProjects().find((p) => p.id === second.id)?.isGitRepository,
    ).toBe(false);
  });
});
