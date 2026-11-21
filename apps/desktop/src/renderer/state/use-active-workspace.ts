// ──────────────────────────────────────────────────────────
// useActiveWorkspace — resolve the workspace for the active chat
// ──────────────────────────────────────────────────────────
//
// The active workspace is derived (not stored directly) — Conversation pane's
// tab strip and topbar both compute it identically. This hook moves
// that resolution into one place so consumers like ConversationPane,
// ChatTabs, and read-only workspace history all see the
// same truth.
//
// Resolution chain (matches ChatTabs.resolveWorkspaceForFolder):
//   1. Active chat's `folder`, else `state.newAgentFolder`.
//   2. Project that owns that folder (via findProjectForFolder).
//   3. The matching managed workspace, including archived or missing rows.
//   4. After those lists resolve, allow legacy plain folders and cloud trunks.
//
// Returns `{ workspace, folder, project }`. Any of these may be null
// when there's no active chat / no project / no matching workspace.
// ──────────────────────────────────────────────────────────

import { useMemo } from "react";

import type { Workspace, WorkspaceRepository } from "../platform/git";
import { repositoryWorkspace, selectedRepository } from "./workspace-repositories";
import { findWorkspaceForFolder } from "./workspace-resolution";
import {
  buildLocalMainWorkspace,
  canRestoreFolderWorkspace,
} from "./local-main-workspace";
import { normalizeProjectRoot, type Project } from "./projects-store";
import { selectActiveFolder, useWorkspaceStore } from "./store";
import {
  useProjectForFolder,
  useWorkspacesFor,
  useArchivedWorkspaces,
  useProjects,
} from "./use-projects";

export interface ActiveWorkspaceResolution {
  workspace: Workspace | null;
  folder: string | null;
  project: Project | null;
  loading: boolean;
  /** The workspace's current repository (its only one unless it holds several). */
  repository: WorkspaceRepository | null;
  /** The workspace as its current repository: what Changes, the branch pickers,
   * the pull request row and review use. The workspace itself with one repository. */
  repositoryWorkspace: Workspace | null;
}

export function useActiveWorkspace(): ActiveWorkspaceResolution {
  // Resolve `folder` inside the selector so this returns a primitive
  // string|null — downstream consumers (ConversationPane, ChatTabs, the
  // worktree placeholder) re-render only when the resolved folder changes,
  // not on every unrelated `chats` mutation. `selectActiveFolder` adds the
  // persisted `lastWorkspaceFolder` fallback so a fresh boot resolves the
  // workspace the user left even before chats hydrate.
  const folder = useWorkspaceStore(selectActiveFolder);
  const linked = useWorkspaceStore((state) => state.localLinkNavigation);

  // Resolve the owning project from the same list the sidebar uses.
  const inferredProject = useProjectForFolder(folder);
  const { projects } = useProjects();
  const archives = useArchivedWorkspaces();
  const archived = folder
    ? findWorkspaceForFolder(folder, archives.workspaces)
    : null;
  const project =
    (linked?.folder === folder
      ? projects.find(
          (row) =>
            normalizeProjectRoot(row.repoRoot) ===
            normalizeProjectRoot(linked.workspace.repoRoot),
        )
      : null) ??
    inferredProject ??
    (archived
      ? (projects.find((row) => row.repoSlug === archived.repoSlug) ?? null)
      : null);

  const { workspaces, resolved } = useWorkspacesFor(project?.repoSlug ?? null);

  const workspace = useMemo<Workspace | null>(() => {
    if (!folder || !project) return null;
    const managed = findWorkspaceForFolder(folder, workspaces);
    if (managed) return managed;
    if (archived) return archived;
    if (
      linked?.folder === folder &&
      normalizeProjectRoot(linked.workspace.repoRoot) ===
        normalizeProjectRoot(project.repoRoot) &&
      (!resolved || linked.workspace.id.startsWith("local:"))
    )
      return linked.workspace;
    // A nested checkout can belong to history even beneath the repo root.
    // Do not briefly mount live agent/workbench effects as "local main" while
    // the exact live or archived ownership snapshot is still loading.
    if (!resolved || !archives.resolved) return null;
    if (!canRestoreFolderWorkspace(project)) return null;
    const main = buildLocalMainWorkspace(project);
    if (findWorkspaceForFolder(folder, [main])) return main;
    return null;
  }, [folder, project, workspaces, archived, resolved, archives.resolved, linked]);

  const saved = useWorkspaceStore(state => workspace ? state.currentRepositoryByWorkspace[workspace.id] : undefined);
  const repository = workspace ? selectedRepository(workspace, saved) : null;
  return {
    workspace,
    folder,
    project,
    repository,
    repositoryWorkspace: workspace && repository ? repositoryWorkspace(workspace, repository) : null,
    loading:
      !!folder &&
      !workspace &&
      ((!!project && !resolved) || !archives.resolved),
  };
}
