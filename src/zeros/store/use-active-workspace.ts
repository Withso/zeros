// ──────────────────────────────────────────────────────────
// useActiveWorkspace — resolve the workspace for the active chat
// ──────────────────────────────────────────────────────────
//
// The active workspace is derived (not stored directly) — Column 2's
// tab strip and topbar both compute it identically. This hook moves
// that resolution into one place so consumers like Column2Workspace,
// Column2ChatTabs, and the worktree-missing placeholder all see the
// same truth.
//
// Resolution chain (matches Column2ChatTabs.resolveWorkspaceForFolder):
//   1. Active chat's `folder`, else `state.newAgentFolder`.
//   2. Project that owns that folder (via findProjectForFolder).
//   3. If `folder` is the project checkout or a subdirectory → Local main.
//      Else → the engine-managed workspace whose `path` matches.
//
// Returns `{ workspace, folder, project }`. Any of these may be null
// when there's no active chat / no project / no matching workspace.
// ──────────────────────────────────────────────────────────

import { useMemo } from "react";

import type { Workspace } from "../../native/git";
import { findWorkspaceForFolder } from "./workspace-resolution";
import { buildLocalMainWorkspace } from "./local-main-workspace";
import { type Project } from "./projects-store";
import { selectActiveFolder, useWorkspaceStore } from "./store";
import { useProjectForFolder, useWorkspacesFor } from "./use-projects";

export interface ActiveWorkspaceResolution {
  workspace: Workspace | null;
  folder: string | null;
  project: Project | null;
}

export function useActiveWorkspace(): ActiveWorkspaceResolution {
  // Resolve `folder` inside the selector so this returns a primitive
  // string|null — downstream consumers (Column2Workspace, ChatTabs, the
  // worktree placeholder) re-render only when the resolved folder changes,
  // not on every unrelated `chats` mutation. `selectActiveFolder` adds the
  // persisted `lastWorkspaceFolder` fallback so a fresh boot resolves the
  // workspace the user left even before chats hydrate.
  const folder = useWorkspaceStore(selectActiveFolder);

  // Resolve the owning project from the same list the sidebar uses.
  const project = useProjectForFolder(folder);

  const { workspaces } = useWorkspacesFor(project?.repoSlug ?? null);

  const workspace = useMemo<Workspace | null>(() => {
    if (!folder || !project) return null;
    const managed = findWorkspaceForFolder(folder, workspaces);
    if (managed) return managed;
    const main = buildLocalMainWorkspace(project);
    if (findWorkspaceForFolder(folder, [main])) return main;
    return null;
  }, [folder, project, workspaces]);

  return { workspace, folder, project };
}
