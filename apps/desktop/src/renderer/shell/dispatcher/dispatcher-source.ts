import type { Branch, RepoBranchCatalog, RepoRemote } from "../../platform/git";
import type { Project } from "../../state/projects-store";

/** Ephemeral Create intent. Full refs distinguish local and remote namesakes. */
export interface DispatcherBase {
  kind: "branch" | "pr";
  branch: string;
  label: string;
  source: "local" | "github" | "remote";
  prNumber?: number;
  prUrl?: string;
}

type SourceOwner = Pick<Project, "id" | "repoRoot" | "repoSlug" | "originUrl">;
export interface DispatcherSourceSelection {
  owner: SourceOwner;
  base: DispatcherBase;
}

export function sourceForProject(
  selection: DispatcherSourceSelection | null,
  project: SourceOwner | null,
): DispatcherBase | null {
  const owner = selection?.owner;
  return owner &&
    project &&
    owner.id === project.id &&
    owner.repoRoot === project.repoRoot &&
    owner.repoSlug === project.repoSlug &&
    owner.originUrl === project.originUrl
    ? selection.base
    : null;
}

export function branchBase(name: string, remote?: RepoRemote): DispatcherBase {
  return {
    kind: "branch",
    branch: remote
      ? `refs/remotes/${remote.name}/${name}`
      : `refs/heads/${name}`,
    label: name,
    source: remote ? (remote.isGitHub ? "github" : "remote") : "local",
  };
}

/** Mirrors the engine's remote default → local default → root HEAD fallback.
 * Unknown data stays unknown; never invent a main branch for an unread repo. */
export function defaultDispatcherBase(
  catalog: RepoBranchCatalog | undefined,
  localBranches: Branch[],
  repoRoot: string,
): DispatcherBase | null {
  if (!catalog) return null;
  const name = catalog.effectiveBase;
  const remote = catalog.remotes.find((r) => r.name === catalog.listedRemote);
  if (remote && catalog.branches.some((b) => b.name === name)) {
    return branchBase(name, remote);
  }
  const localDefault = localBranches.find((b) => b.name === name);
  const head = localBranches.find((b) => b.worktreePath === repoRoot);
  const fallback = localDefault ?? head;
  return fallback ? branchBase(fallback.name) : null;
}
