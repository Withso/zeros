import { GitError } from "./errors";

/** New organization workspaces are provisioned by the control plane. Existing
 * local rows and recovery seeds retain their serialized ownership unchanged. */
export function localWorkspaceCreationError(input: {
  organizationId?: string | null;
  placement?: "local" | "cloud";
}): GitError | null {
  return input.organizationId?.trim() || input.placement === "cloud"
    ? new GitError({
        code: "VALIDATION_FAILED",
        message: "Organization workspaces must be created in the cloud. Select Personal for a local workspace.",
      })
    : null;
}
