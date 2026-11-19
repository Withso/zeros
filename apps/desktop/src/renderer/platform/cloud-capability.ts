import { isFeatureEnabled } from "../config/release-channel";
import { nativeInvoke } from "./runtime";

export function cloudWorkspaceCapability(): Promise<{ enabled: boolean }> {
  if (!isFeatureEnabled("cloud-workspaces")) return Promise.resolve({ enabled: false });
  return nativeInvoke("cloud_workspace_capability", {});
}
