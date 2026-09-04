import type { OrganizationSummary } from "./control-plane";
import { getKnownPersonalOrganizationIds } from "./organization-membership-history";
import { PERSONAL_ORGANIZATION_ID } from "./personal-organization";

export type WorkspacePlacement = "local" | "cloud";

/** One policy function for every create affordance. Server entitlements still
 * authorize provisioning; this prevents the desktop from offering an invalid
 * Personal/cloud combination in the first place. */
export function canCreateWorkspaceIn(
  organization: OrganizationSummary | null,
  placement: WorkspacePlacement,
): boolean {
  if (placement === "local") return true;
  return Boolean(
    organization &&
    !organization.isPersonal &&
    organization.workspaceCapabilities.cloud,
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
  return {
    organizationId: isPersonal ? null : ownerId,
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
