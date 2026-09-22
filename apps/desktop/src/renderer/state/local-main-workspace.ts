// ──────────────────────────────────────────────────────────
// Synthetic "Local main" workspace per project
// ──────────────────────────────────────────────────────────
//
// Compatibility destination for conversations and files saved in a project's
// original checkout before worktrees became the only new-work flow. The row
// is synthesized (never stored in state.db) and cannot be archived/deleted as
// a managed worktree. Presentation lists include it only for opened roots.
//
// The id format `local:<repoSlug>` is intentionally not a valid
// engine workspace id (no `ws_` prefix). Any IPC call that receives
// this id will fail — callers should branch on `isLocalMainWorkspace()`
// first and fall back to "no engine workspace exists for this row".
//
// Original-folder rows exist only to recover previously opened chats/files.
// New project opens always use managed worktrees. Keep the serialized local:
// identity so existing conversations remain reachable after this change.

import type { Workspace } from "../platform/git";
import { deriveProjectName, type Project } from "./projects-store";
import {
  findProjectForFolder,
  findWorkspaceForFolder,
  folderIsWithinRoot,
  isWorktreePath,
} from "./workspace-resolution";

/** Prefix on the synthetic Local-main workspace id. */
export const LOCAL_MAIN_ID_PREFIX = "local:";

/** Build the synthetic id for a given project's Local main row. */
export function localMainWorkspaceId(repoSlug: string): string {
  return `${LOCAL_MAIN_ID_PREFIX}${repoSlug}`;
}

/** Display label shown in the sidebar + tab strip + breadcrumb.
 *  2026-05-28: shortened from "Local main" to "main" per design pass.
 *  The row is still differentiated from real branches by its
 *  `laptop-minimal` icon (rendered in WorkspaceRow), not the label. */
export const LOCAL_MAIN_LABEL = "main";

export function localMainWorkspaceLabel(project: Project): string {
  return project.isGitRepository === false
    ? deriveProjectName(project.repoRoot)
    : LOCAL_MAIN_LABEL;
}

/** Test whether a workspace id (or full Workspace) refers to the
 *  synthetic Local main row. Use this before sending the workspace id
 *  to any engine IPC — synthetic ids will fail with WORKSPACE_NOT_FOUND. */
export function isLocalMainWorkspace(
  idOrWorkspace: string | Workspace,
): boolean {
  const id =
    typeof idOrWorkspace === "string" ? idOrWorkspace : idOrWorkspace.id;
  return id.startsWith(LOCAL_MAIN_ID_PREFIX);
}

/** Synthesize the Local main workspace record from a Project. The
 *  resulting object has the same shape as an engine-managed Workspace
 *  so the sidebar + tab strip can render it uniformly. */
export function buildLocalMainWorkspace(project: Project): Workspace {
  return {
    id: localMainWorkspaceId(project.repoSlug),
    repoSlug: project.repoSlug,
    repoRoot: project.repoRoot,
    // This synthetic row uses branch as its display name. Plain folders keep
    // their basename; Git roots preserve the existing "main" label.
    branch: localMainWorkspaceLabel(project),
    baseBranch: "main",
    path: project.repoRoot,
    status: "in-progress",
    createdAt: project.addedAt,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    // Local main mirrors the project repo root, which is verified at
    // project-add time. We don't re-stat per render (the project list
    // itself drops projects whose root has gone away). Treat as
    // always-present so the "Worktree missing" placeholder never
    // fires here — that surface is worktree-only.
    present: true,
  };
}

/** Merge the synthetic Local main row with the engine-managed
 *  workspace list, always placing Local main first. Filters archived
 *  rows so they don't show in the sidebar by default. */
export function withLocalMainWorkspace(
  project: Project,
  engineWorkspaces: Workspace[],
): Workspace[] {
  const live = engineWorkspaces.filter((w) => w.archivedAt == null);
  return [buildLocalMainWorkspace(project), ...live];
}

/** Compatibility projection for previously opened checkout directories. Keep
 * the repository's stable local: identity but navigate to the saved exact cwd.
 * Managed worktrees and separately registered nested repositories keep ownership. */
export function withFolderWorkspaces(
  projects: readonly Project[],
  workspaces: Workspace[],
  openedFolders: ReadonlySet<string> = new Set(),
  lastWorkspaceByRepoRoot: Readonly<Record<string, string>> = {},
): Workspace[] {
  const foldersByProject = new Map<string, Set<string>>();
  for (const cwd of openedFolders) {
    if (isWorktreePath(cwd) || findWorkspaceForFolder(cwd, workspaces)) continue;
    const project = findProjectForFolder(cwd, projects);
    if (!project || !folderIsWithinRoot(cwd, project.repoRoot)) continue;
    let folders = foldersByProject.get(project.id);
    if (!folders) {
      folders = new Set();
      foldersByProject.set(project.id, folders);
    }
    folders.add(cwd);
  }
  const folders: Workspace[] = [];
  for (const project of projects) {
    const saved = foldersByProject.get(project.id);
    if (
      !saved?.size ||
      workspaces.some((w) => w.id === localMainWorkspaceId(project.repoSlug))
    )
      continue;
    const remembered = lastWorkspaceByRepoRoot[project.repoRoot];
    const path =
      remembered && saved.has(remembered)
        ? remembered
        : saved.has(project.repoRoot)
          ? project.repoRoot
          : saved.values().next().value!;
    folders.push({ ...buildLocalMainWorkspace(project), path });
  }
  if (folders.length === 0) return workspaces;
  return [...folders, ...workspaces];
}
