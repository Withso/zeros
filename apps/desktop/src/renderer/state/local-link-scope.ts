import type { Workspace } from "../platform/git";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import { isLocalMainWorkspace } from "./local-main-workspace";
import { normalizeProjectRoot, type Project } from "./projects-store";

export function isPersonalLocalLinkWorkspace(
  workspace: Workspace | null | undefined,
): workspace is Workspace {
  return (
    !!workspace &&
    workspace.organizationId == null &&
    workspace.placement !== "cloud" &&
    !isCloudWorkspace(workspace.path) &&
    !isCloudWorkspace(workspace.repoRoot) &&
    workspace.archivedAt == null &&
    workspace.present !== false
  );
}

/** Synthetic renderer ids and the engine's local-main id are never link ids.
 * `projects` must come from project.list, not the renderer's UUID boot cache. */
export function localLinkWorkspaceId(
  workspace: Workspace,
  projects: readonly Project[],
): string | null {
  if (!isPersonalLocalLinkWorkspace(workspace)) return null;
  if (workspace.id.startsWith("ws_")) return workspace.id;
  if (!isLocalMainWorkspace(workspace) && workspace.id !== "local-main")
    return null;
  const project = projects.find(
    (row) =>
      !isCloudWorkspace(row.repoRoot) &&
      normalizeProjectRoot(row.repoRoot) ===
        normalizeProjectRoot(workspace.repoRoot),
  );
  return project ? `folder:${project.id}` : null;
}
