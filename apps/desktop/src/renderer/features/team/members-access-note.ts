import type { OrganizationRole } from "./control-plane";

/** §16 (owner decision 2026-11-13): once the control plane lets every member open the organization's cloud workspaces,
 * owners and admins are told plainly that members can read the code without GitHub access. An older control plane
 * (no `workspaceAccess`) still hides those workspaces, so nothing is shown. Final copy approved by the master. */
export function membershipAccessNote(organization: { role: OrganizationRole; workspaceAccess?: "membership" }): string | null {
  if (organization.workspaceAccess !== "membership" || (organization.role !== "owner" && organization.role !== "admin")) return null;
  return "Members can open every cloud workspace in this organization and read its code. Their own GitHub access is needed only to push or open pull requests.";
}
