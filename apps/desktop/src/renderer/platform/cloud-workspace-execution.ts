import type { CloudWorkspaceDocument } from "./cloud-workspaces";

export const CLOUD_WORKSPACE_V2_REQUIRED = "cloud_workspace_v2_required" as const;
export const CLOUD_WORKSPACE_V2_REQUIRED_MESSAGE =
  "This workspace uses a retired cloud runtime — create a new workspace.";

/** Cloud-only admission metadata. Retained documents/history keep their normal
 * read identity; execution actions cannot imply a legacy runtime migration. */
export function cloudWorkspaceExecutionRefusal(
  workspace: Pick<CloudWorkspaceDocument, "error" | "setupFailure" | "capabilities"> | undefined,
) {
  return workspace && (workspace.error?.code === CLOUD_WORKSPACE_V2_REQUIRED ||
    workspace.setupFailure?.code === CLOUD_WORKSPACE_V2_REQUIRED ||
    workspace.capabilities.startUnavailableReason === CLOUD_WORKSPACE_V2_REQUIRED)
    ? { code: CLOUD_WORKSPACE_V2_REQUIRED, message: CLOUD_WORKSPACE_V2_REQUIRED_MESSAGE } : null;
}
