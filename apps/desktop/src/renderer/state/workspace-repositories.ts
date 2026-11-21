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
