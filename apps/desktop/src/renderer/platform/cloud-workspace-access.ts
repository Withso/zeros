import { isCloudWorkspace } from "./bridge/cloud-workspace-key";

/** Cloud workspaces have no Browser, previews or port forwarding for now. */
export function workspacePreviewAvailable(folder: string): boolean {
  return !isCloudWorkspace(folder);
}
