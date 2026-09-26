/** Customer errors never reuse infrastructure diagnostic text. Internal
 * records retain the original code/message for the operator's investigation. */
const messages: Record<string, string> = {
  not_found: "Cloud workspace not found",
  cloud_workspace_not_found: "Cloud workspace access is unavailable",
  cloud_account_entitlement_required: "An active Pro subscription is required",
  cloud_workspace_capability_required:
    "Your workspace role does not allow this operation",
  cloud_workspace_writer_limit:
    "This workspace already has 10 writers. Remove or change a writer to Read-only first.",
  cloud_workspace_owner_required: "This operation requires the workspace owner",
  cloud_workspace_runtime_connection_required:
    "Connect using the workspace runtime connection",
  cloud_workspaces_not_allowed:
    "Cloud workspaces are unavailable in this Organization",
  cloud_workspaces_not_configured:
    "Cloud workspaces are temporarily unavailable",
  cloud_workspace_scope_not_found: "Cloud workspace access is unavailable",
  invalid_input: "The cloud workspace request is invalid",
  invalid_cursor: "The page cursor is invalid",
  idempotency_key_required: "A valid request identifier is required",
  idempotency_key_reused:
    "This request identifier was already used with different parameters",
  cloud_workspace_access_conflict:
    "Workspace sharing changed. Refresh and try again.",
  cloud_workspace_invitation_conflict:
    "This invitation request is no longer reusable",
  cloud_workspace_invitation_delivery_unavailable:
    "Workspace invitations are temporarily unavailable",
  cloud_workspace_sharing_required:
    "Enable workspace sharing before inviting collaborators",
  cloud_compute_allowance_exhausted:
    "This workspace's monthly compute allowance is exhausted",
  cloud_compute_allowance_unavailable:
    "This workspace's compute allowance is unavailable",
  compute_usage_unavailable: "Compute usage is temporarily unavailable",
  cloud_workspace_unavailable: "The cloud workspace is temporarily unavailable",
};
export function publicCloudError(code: string): {
  code: string;
  message: string;
} {
  let publicCode = code;
  if (code === "compute_credit_exhausted")
    publicCode = "cloud_compute_allowance_exhausted";
  else if (
    code.startsWith("compute_allowance_") ||
    code.startsWith("compute_credit_")
  )
    publicCode = "cloud_compute_allowance_unavailable";
  else if (
    !/^[a-z][a-z0-9_]{0,127}$/.test(code) ||
    /(?:boat|daytona|provider|snapshot|image|sandbox|railway|cloudflare)/i.test(
      code,
    )
  )
    publicCode = "cloud_workspace_unavailable";
  return {
    code: publicCode,
    message:
      messages[publicCode] ??
      "The cloud workspace request could not be completed",
  };
}
export function isCustomerCloudPath(path: string): boolean {
  return (
    /^\/v1\/(?:cloud-workspaces(?:\/|$)|cloud-workspace-|cloud-compute-)/.test(
      path,
    ) ||
    /^\/v1\/organizations\/[^/]+\/cloud-(?:workspaces|workspace-management|compute-credits)(?:\/|$)/.test(
      path,
    )
  );
}
