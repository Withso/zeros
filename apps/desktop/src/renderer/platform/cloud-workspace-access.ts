import { isCloudWorkspace } from "./bridge/cloud-workspace-key";

// Cloud workspaces do not expose browser, preview or port-forwarding surfaces.
export function workspacePreviewAvailable(folder: string): boolean {
  return !isCloudWorkspace(folder);
}
