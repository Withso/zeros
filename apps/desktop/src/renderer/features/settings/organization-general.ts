import { showsWorkspaceApiAccess } from "./workspace-api-access-setting";

export type OrganizationGeneralSection = "workspace-api-access" | "computer-use" | "always-allow-local-commands";

/** An organization's General holds only this Mac's controls. Local commands
 * have one: Always allow (the organization setting stays on the server, on by
 * default, with no switch in the app). */
export function organizationGeneralSections(organization: Parameters<typeof showsWorkspaceApiAccess>[0], cloudAccess: boolean): OrganizationGeneralSection[] {
  const cloud = showsWorkspaceApiAccess(organization, cloudAccess);
  return [...(cloud ? ["workspace-api-access" as const] : []), "computer-use", ...(cloud ? ["always-allow-local-commands" as const] : [])];
}
