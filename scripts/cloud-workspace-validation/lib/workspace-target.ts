const PRIMARY_WORKSPACE_ID = "local-main";

/** Select the coordinator-owned primary checkout by opaque workspace identity.
 * Cloud ENGINE_READY deliberately withholds its absolute root before account
 * binding, and validation must never recover or trust a host path from the
 * wire. The same opaque id is accepted by file and PTY requests and is resolved
 * server-side after transport/account authorization. */
export function selectCloudPrimaryWorkspaceId(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !Array.isArray((result as { workspaces?: unknown }).workspaces)
  ) {
    throw new Error("Cloud workspace list response is malformed");
  }
  const workspaces = (result as { workspaces: unknown[] }).workspaces;
  const primary = workspaces.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { id?: unknown }).id === PRIMARY_WORKSPACE_ID,
  );
  if (!primary) {
    throw new Error("The primary cloud workspace is not available");
  }
  return PRIMARY_WORKSPACE_ID;
}
