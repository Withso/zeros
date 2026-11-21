// A workspace's repositories. A cloud workspace of several repositories lists
// them in its document; every other workspace (Local always) has exactly one:
// itself. Each repository's `target` is what Git, pull request and file
// requests for it are sent to, and the key its retained snapshots use.
import type { Workspace, WorkspaceRepository } from "../platform/git";

const single = new WeakMap<Workspace, readonly WorkspaceRepository[]>();

/** The workspace's repositories, the first being its own; stable per row. */
export function workspaceRepositories(workspace: Workspace): readonly WorkspaceRepository[] {
  if (workspace.repositories && workspace.repositories.length > 1) return workspace.repositories;
  let list = single.get(workspace);
  if (!list) {
    const folder = workspace.repoRoot.replace(/\/+$/, "").split("/").pop() || workspace.repoSlug;
    list = Object.freeze([Object.freeze({
      repository: workspace.repoSlug, folder, target: workspace.id, branch: workspace.branch, baseBranch: workspace.baseBranch,
      prNumber: workspace.prNumber, prState: workspace.prState, prUrl: workspace.prUrl,
    })]);
    single.set(workspace, list);
  }
  return list;
}

/** The repository a saved selection names, or the first when it names none of this workspace's. */
export function selectedRepository(workspace: Workspace, repository: string | null | undefined): WorkspaceRepository {
  const list = workspaceRepositories(workspace);
  const name = repository?.toLowerCase();
  return (name ? list.find(entry => entry.repository.toLowerCase() === name) : undefined) ?? list[0]!;
}

const views = new WeakMap<Workspace, Map<WorkspaceRepository, Workspace>>();

/** The workspace as one of its repositories: its key, branch, base branch and
 * pull request, so Changes, the branch pickers, the pull request row and review
 * follow that repository. The workspace itself for its only repository. */
export function repositoryWorkspace(workspace: Workspace, repository: WorkspaceRepository): Workspace {
  if (repository.target === workspace.id) return workspace;
  let byRepository = views.get(workspace);
  if (!byRepository) views.set(workspace, byRepository = new Map());
  let view = byRepository.get(repository);
  if (!view) {
    // One repository: without the workspace's list, so totals never count the others as its own.
    const { repositories: _repositories, ...one } = workspace;
    view = { ...one, id: repository.target, path: repository.target, branch: repository.branch, baseBranch: repository.baseBranch,
      prNumber: repository.prNumber, prState: repository.prState, prUrl: repository.prUrl };
    byRepository.set(repository, view);
  }
  return view;
}

/**
 * The one pull request mark a workspace of several repositories shows (its
 * sidebar glyph and dashboard card), from each repository's own:
 *   1. any open pull request wins: "ready" if any open one is ready, else "draft";
 *   2. else, every repository that has one merged: "merged";
 *   3. else, any closed (some merged, some closed, or all closed): "closed";
 *   4. no repository has one: none.
 * The number and URL are the first repository's (in order) that has that state,
 * so opening the mark opens a pull request in that state.
 */
export function combinedPullRequest(repositories: readonly Pick<WorkspaceRepository, "prNumber" | "prState" | "prUrl">[]):
  Pick<WorkspaceRepository, "prNumber" | "prState" | "prUrl"> {
  const withPr = repositories.filter(entry => entry.prNumber != null && entry.prState);
  const open = withPr.filter(entry => entry.prState === "ready" || entry.prState === "draft");
  const state = open.some(entry => entry.prState === "ready") ? "ready" : open.length ? "draft"
    : withPr.length && withPr.every(entry => entry.prState === "merged") ? "merged" : withPr.length ? "closed" : null;
  const chosen = state ? withPr.find(entry => entry.prState === state) : undefined;
  return chosen ? { prNumber: chosen.prNumber, prState: state, prUrl: chosen.prUrl } : { prNumber: null, prState: null, prUrl: null };
}

/** The repository holding a project-folder path (`<folder>/…`) of a workspace
 * of several, or the only repository of every other workspace; undefined for a
 * path outside every repository folder. */
export function repositoryForPath(workspace: Workspace, path: string): WorkspaceRepository | undefined {
  const list = workspaceRepositories(workspace);
  if (list.length < 2) return list[0];
  const folder = path.replace(/^\/+/, "").split("/")[0];
  return list.find(entry => entry.folder === folder);
}

/** Where the workspace's pull request mark (its number and state) is read and
 * acted on: the key of the repository that mark comes from in a workspace of
 * several (see combinedPullRequest), the workspace itself otherwise. The bare
 * key of a workspace of several names no repository's pull request. */
export function pullRequestTarget(workspace: Workspace): string {
  const list = workspaceRepositories(workspace);
  if (list.length < 2 || workspace.prNumber == null) return workspace.id;
  return list.find(entry => entry.prNumber === workspace.prNumber && entry.prState === workspace.prState)?.target ?? workspace.id;
}
