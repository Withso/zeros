import { isFeatureEnabled } from "../../config/release-channel";
import { getActiveOrganizationIdSnapshot, useActiveOrganization } from "./team-store";
import { PERSONAL_ORGANIZATION_ID } from "./personal-organization";
import { getKnownPersonalOrganizationIds } from "./organization-membership-history";

/** Retained routes can outlive an owner switch or come from a saved selection.
 * Keep their cloud forms unmounted while preserving Local entry points. */
export function useOrganizationCloudPaused(): boolean {
  const organization = useActiveOrganization();
  const owner = organization?.id ?? getActiveOrganizationIdSnapshot();
  return !isFeatureEnabled("cloud-workspaces") && Boolean(owner) &&
    !organization?.isPersonal && owner !== PERSONAL_ORGANIZATION_ID &&
    !getKnownPersonalOrganizationIds().includes(owner!);
}

export function CloudWorkspacePausedNotice() {
  return <p className="text-fg2 text-sm">Cloud workspaces are paused</p>;
}
