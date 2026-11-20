import { showsWorkspaceApiAccess } from "./workspace-api-access-setting";

export type OrganizationGeneralSection = "workspace-api-access" | "computer-use" | "always-allow-local-commands";

// The local-commands row changes this Mac's preference, not the organization's server policy.
export function organizationGeneralSections(organization: Parameters<typeof showsWorkspaceApiAccess>[0], cloudAccess: boolean): OrganizationGeneralSection[] {
  const cloud = showsWorkspaceApiAccess(organization, cloudAccess);
  return [...(cloud ? ["workspace-api-access" as const] : []), "computer-use", ...(cloud ? ["always-allow-local-commands" as const] : [])];
}

/** In the unified rail Computer use is a Personal page; the organization's General keeps only its own rows. */
export function unifiedOrganizationGeneralSections(organization: Parameters<typeof showsWorkspaceApiAccess>[0], cloudAccess: boolean): OrganizationGeneralSection[] {
  return organizationGeneralSections(organization, cloudAccess).filter((section) => section !== "computer-use");
}
