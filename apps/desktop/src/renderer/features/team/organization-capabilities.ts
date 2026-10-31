import type { OrganizationSummary } from "./control-plane";
import { getKnownPersonalOrganizationIds } from "./organization-membership-history";
import { PERSONAL_ORGANIZATION_ID } from "./personal-organization";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { isFeatureEnabled } from "../../config/release-channel";

/** Repository choices follow their runtime owner, even before any workspace
 * rows are loaded. Never hand a cloud URI to the Local branch picker. */
export function filterProjectsForOrganization<T extends { repoRoot: string }>(
  projects: readonly T[], organization: OrganizationSummary | null, confirmedOrganizationId: string | null = null,
): T[] {
  const owner = organization?.isPersonal ? null : organization?.id ?? confirmedOrganizationId;
  const local = !owner || owner === PERSONAL_ORGANIZATION_ID || getKnownPersonalOrganizationIds().includes(owner);
  const filtered = projects.filter(project => {
    if (!isCloudWorkspace(project.repoRoot)) return local;
    if (local || !isFeatureEnabled("cloud-workspaces")) return false;
    try { return parseCloudWorkspaceKey(project.repoRoot)?.organizationId === owner?.toLowerCase(); }
    catch { return false; }
  });
  return filtered.length === projects.length ? projects as T[] : filtered;
}

export type WorkspacePlacement = "local" | "cloud";

export const ORGANIZATION_HOLD_MESSAGE =
  "You're on Hold in this organization. Get Pro, or ask an owner to free a seat.";

/** Why this member can't create in an organization that allows cloud. Members
 * without Pro use existing cloud workspaces but never create them. */
export function cloudCreateSeatReason(organization: OrganizationSummary | null): string | null {
  if (organization?.seat === "hold") return ORGANIZATION_HOLD_MESSAGE;
  if (organization?.seat === "free") return "Creating a cloud workspace requires Pro.";
  return null;
}

/** One policy function for every create affordance. Server entitlements still
 * authorize provisioning; this prevents the desktop from offering an invalid
 * ownership/placement combination in the first place. */
export function canCreateWorkspaceIn(
  organization: OrganizationSummary | null,
  placement: WorkspacePlacement,
): boolean {
  if (placement === "local") return !organization || organization.isPersonal;
  return Boolean(
    isFeatureEnabled("cloud-workspaces") &&
    organization &&
    !organization.isPersonal &&
    organization.workspaceCapabilities.cloud &&
    !cloudCreateSeatReason(organization),
  );
}

export function localWorkspaceOwner(organization: OrganizationSummary | null): {
  organizationId: string | null;
  placement: "local";
};
export function localWorkspaceOwner(
  organization: OrganizationSummary | null,
  confirmedOrganizationId: string | null,
): {
  organizationId: string | null;
  placement: "local";
};
export function localWorkspaceOwner(
  organization: OrganizationSummary | null,
  confirmedOrganizationId: string | null = null,
): {
  organizationId: string | null;
  placement: "local";
} {
  const ownerId = organization?.id ?? confirmedOrganizationId;
  const isPersonal =
    ownerId === PERSONAL_ORGANIZATION_ID ||
    (organization
      ? organization.isPersonal
      : ownerId != null && getKnownPersonalOrganizationIds().includes(ownerId));
  if (ownerId && !isPersonal) {
    throw new Error("Organization workspaces run in the cloud. Select Personal to create a local workspace.");
  }
  return {
    organizationId: null,
    placement: "local",
  };
}

type OrganizationOwned = {
  /** Missing and null are the durable compatibility representation for
   * device-local Personal workspaces, including pre-ownership workspaces. */
  organizationId?: string | null;
  placement?: WorkspacePlacement;
};

/** Select rows for the active semantic owner without allocating when every row
 * is visible. A null organization is a mixed-version/loading state, so it must
 * fail open: hiding local data while `/v1/me` revalidates would create a data
 * waterfall and a misleading empty screen. */
export function filterRowsForOrganization<T extends OrganizationOwned>(
  rows: readonly T[],
  organization: OrganizationSummary | null,
): T[] {
  if (!isFeatureEnabled("cloud-workspaces") && rows.some(row => row.placement === "cloud"))
    rows = rows.filter(row => row.placement !== "cloud");
  if (!organization) return rows as T[];
  const personalIds = organization.isPersonal
    ? new Set(
        organization.legacyPersonalOrganizationIds ??
          getKnownPersonalOrganizationIds(),
      )
    : null;
  const filtered = rows.filter((row) =>
    organization.isPersonal
      ? row.placement !== "cloud" &&
        (row.organizationId == null ||
          row.organizationId === organization.id ||
          personalIds!.has(row.organizationId))
      : organization.legacyFlat
        ? row.organizationId == null || row.organizationId === organization.id
        : row.organizationId === organization.id,
  );
  return filtered.length === rows.length ? (rows as T[]) : filtered;
}
