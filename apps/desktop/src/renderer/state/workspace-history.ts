import type { Workspace, WorkspaceRecoveryInfo } from "../platform/git";
import type { Project } from "./projects-store";
import {
  findProjectForFolder,
  folderIsOwnedByProject,
  folderIsWithinRoot,
} from "./workspace-resolution";

/** Resolve the most specific owner before testing its lifecycle. Filtering to
 * missing rows first would absorb a separately registered live descendant. */
export function readOnlyWorkspaceForFolder(
  folder: string,
  workspaces: readonly Workspace[],
  projects: Project[],
): Workspace | null {
  let workspace: Workspace | null = null;
  for (const candidate of workspaces) {
    if (
      folderIsWithinRoot(folder, candidate.path) &&
      (!workspace || folderIsWithinRoot(candidate.path, workspace.path))
    ) {
      workspace = candidate;
    }
  }
  if (!workspace || !workspaceIsReadOnly(workspace)) return null;
  const project = findProjectForFolder(workspace.repoRoot, projects);
  if (
    project &&
    !folderIsOwnedByProject(folder, project.id, projects, [workspace.path])
  )
    return null;
  return workspace;
}

/** Archived and absent checkouts share a history surface, but retain their
 * distinct durable lifecycle states. Unknown presence is not proof of loss. */
export function workspaceIsReadOnly(
  workspace:
    | Partial<Pick<Workspace, "archivedAt" | "present">>
    | null
    | undefined,
): boolean {
  return workspace?.archivedAt != null || workspace?.present === false;
}

export function selectWorkspaceHistory(
  live: readonly Workspace[],
  archived: readonly Workspace[],
): Workspace[] {
  const rows = new Map(archived.map((row) => [row.id, row]));
  for (const row of live) {
    // The latest live snapshot also disproves a stale archive response.
    if (row.present === false) rows.set(row.id, row);
    else rows.delete(row.id);
  }
  return Array.from(rows.values());
}

export function workspaceHistoryBanner(
  workspace: Pick<Workspace, "archivedAt" | "present">,
  recovery?: WorkspaceRecoveryInfo,
): { message: string; action: "Unarchive" | "Restore" | "Locate" | null } {
  if (workspace.archivedAt != null) {
    return { message: "This workspace is archived.", action: "Unarchive" };
  }
  switch (recovery?.action) {
    case "restore":
      return { message: "Workspace folder missing", action: "Restore" };
    case "locate":
      return {
        message: "Workspace folder missing. Reconnect the original folder",
        action: "Locate",
      };
    case "none":
      return { message: "Workspace folder missing. No recovery", action: null };
    default:
      return { message: "Workspace folder missing", action: null };
  }
}
