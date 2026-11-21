// A workspace of several repositories keeps one current repository, keyed by
// the workspace, persisted, validated against its own repositories on read,
// and removed or moved with the workspace.
import { beforeEach, describe, expect, it } from "vitest";
import type { Workspace, WorkspaceRepository } from "../../platform/git";
import { loadPersistedUiState } from "../persist-ui-state";
import { selectCurrentRepository, useWorkspaceStore } from "../store";
import { combinedPullRequest, repositoryWorkspace, workspaceRepositories } from "../workspace-repositories";

const key = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const entry = (repository: string, folder: string, extra: Partial<WorkspaceRepository> = {}): WorkspaceRepository => ({
  repository, folder, target: `${key}/${folder}`, branch: "zeros/app-1", baseBranch: "main", prNumber: null, prState: null, prUrl: null, ...extra });
const workspace: Workspace = {
  id: key, path: key, repoRoot: key, repoSlug: "cloud-x", branch: "zeros/app-1", baseBranch: "main", status: "in-progress", createdAt: 1,
  archivedAt: null, stashRef: null, prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null, placement: "cloud",
  repositories: [entry("withso/api", "api"), entry("withso/web", "web", { baseBranch: "release", prNumber: 9, prState: "draft", prUrl: "https://github.com/withso/web/pull/9" })],
};
const dispatch = (action: Parameters<ReturnType<typeof useWorkspaceStore.getState>["dispatch"]>[0]) => useWorkspaceStore.getState().dispatch(action);

beforeEach(() => {
  const storage = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k), clear: () => storage.clear() };
  (globalThis as Record<string, unknown>).window ??= globalThis;
  dispatch({ type: "SET_CURRENT_REPOSITORY", workspaceId: key, repository: null });
  dispatch({ type: "SET_CURRENT_REPOSITORY", workspaceId: `${key}-moved`, repository: null });
});

describe("a workspace's current repository", () => {
  it("is its first until one is chosen, and its saved one only while it is one of its repositories", () => {
    expect(selectCurrentRepository(useWorkspaceStore.getState(), workspace).repository).toBe("withso/api");
    dispatch({ type: "SET_CURRENT_REPOSITORY", workspaceId: key, repository: "Withso/Web" });
    expect(useWorkspaceStore.getState().currentRepositoryByWorkspace[key]).toBe("withso/web");
    expect(selectCurrentRepository(useWorkspaceStore.getState(), workspace).repository).toBe("withso/web");
    // The same choice twice keeps the state object (Zustand skips the render).
    const before = useWorkspaceStore.getState().currentRepositoryByWorkspace;
    dispatch({ type: "SET_CURRENT_REPOSITORY", workspaceId: key, repository: "withso/web" });
    expect(useWorkspaceStore.getState().currentRepositoryByWorkspace).toBe(before);
    // A repository removed from the workspace's list falls back to its first.
    expect(selectCurrentRepository(useWorkspaceStore.getState(), { ...workspace, repositories: [workspace.repositories![0]!, entry("withso/docs", "docs")] })
      .repository).toBe("withso/api");
  });

  it("is forgotten with its workspace and follows a moved one", () => {
    dispatch({ type: "SET_CURRENT_REPOSITORY", workspaceId: key, repository: "withso/web" });
    dispatch({ type: "MOVE_WORKSPACE_UI_STATE", fromFolder: key, toFolder: `${key}-moved`, repoRoot: key });
    expect(useWorkspaceStore.getState().currentRepositoryByWorkspace).toMatchObject({ [`${key}-moved`]: "withso/web" });
    expect(useWorkspaceStore.getState().currentRepositoryByWorkspace[key]).toBeUndefined();
    dispatch({ type: "REMOVE_WORKSPACE_UI_STATE", folder: `${key}-moved`, repoRoot: `${key}-moved` });
    expect(useWorkspaceStore.getState().currentRepositoryByWorkspace[`${key}-moved`]).toBeUndefined();
  });

  it("restores only well-formed saved choices", () => {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };
    store.set("zeros:ui-state:v1", JSON.stringify({ currentRepositoryByWorkspace: { [key]: "withso/web", other: "not a repository", bad: 42 } }));
    expect(loadPersistedUiState().currentRepositoryByWorkspace).toEqual({ [key]: "withso/web" });
  });

  it("gives every other workspace its one repository: itself", () => {
    const one: Workspace = { ...workspace, repositories: undefined };
    const [only] = workspaceRepositories(one);
    expect(only).toMatchObject({ target: key, branch: "zeros/app-1" });
    expect(workspaceRepositories(one)).toBe(workspaceRepositories(one));
    expect(repositoryWorkspace(one, only!)).toBe(one);
  });

  it("shows the workspace as its current repository, by that repository's key, branch and pull request, with stable references", () => {
    const web = workspace.repositories![1]!;
    const view = repositoryWorkspace(workspace, web);
    expect(view).toMatchObject({ id: `${key}/web`, path: `${key}/web`, repoRoot: key, baseBranch: "release", prNumber: 9, prState: "draft" });
    // It is one repository: its counts and has-changes are its own, never the workspace's total.
    expect(view.repositories).toBeUndefined();
    expect(workspaceRepositories(view)).toEqual([expect.objectContaining({ target: `${key}/web` })]);
    expect(repositoryWorkspace(workspace, web)).toBe(view);
    expect(repositoryWorkspace(workspace, workspace.repositories![0]!)).not.toBe(view);
  });
});

describe("the one pull request mark of a workspace of several repositories", () => {
  const pr = (prState: WorkspaceRepository["prState"], prNumber: number | null = prState ? 1 : null) =>
    ({ prState, prNumber, prUrl: prNumber ? `https://github.com/withso/r/pull/${prNumber}` : null });
  it("shows an open pull request first, ready over draft, then merged only when every one merged, then closed", () => {
    expect(combinedPullRequest([pr(null), pr(null)])).toEqual({ prNumber: null, prState: null, prUrl: null });
    expect(combinedPullRequest([pr("merged", 4), pr("draft", 5), pr("ready", 6)])).toMatchObject({ prState: "ready", prNumber: 6 });
    expect(combinedPullRequest([pr("closed", 4), pr("draft", 5)])).toMatchObject({ prState: "draft", prNumber: 5 });
    expect(combinedPullRequest([pr("merged", 4), pr(null), pr("merged", 7)])).toMatchObject({ prState: "merged", prNumber: 4 });
    expect(combinedPullRequest([pr("merged", 4), pr("closed", 7)])).toMatchObject({ prState: "closed", prNumber: 7 });
  });
});
