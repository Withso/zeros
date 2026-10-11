// Registered Local workspace folders (project checkouts and worktrees), read
// synchronously when a dev-server probe starts. Kept apart from the dev-server
// store so that store stays free of the workspace caches.

import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { peekLiveWorkspaceUnion, peekProjects } from "../../state/use-projects";

export function registeredLocalWorkspaceFolders(): string[] {
  const folders: string[] = [];
  for (const project of peekProjects())
    if (!isCloudWorkspace(project.repoRoot)) folders.push(project.repoRoot);
  for (const workspace of peekLiveWorkspaceUnion()) {
    if (workspace.placement === "cloud") continue;
    folders.push(workspace.path, workspace.repoRoot);
  }
  return folders;
}
