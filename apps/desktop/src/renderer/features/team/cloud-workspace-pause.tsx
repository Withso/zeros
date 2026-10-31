import { isFeatureEnabled } from "../../config/release-channel";
import { getActiveOrganizationIdSnapshot, useActiveOrganization } from "./team-store";
import { PERSONAL_ORGANIZATION_ID } from "./personal-organization";
import { getKnownPersonalOrganizationIds } from "./organization-membership-history";
import { ORGANIZATION_HOLD_MESSAGE } from "./organization-capabilities";

/** Retained routes can outlive an owner switch or come from a saved selection.
 * Keep their cloud forms unmounted while preserving Local entry points. A
 * member on Hold has the organization's cloud paused the same way. */
export function useOrganizationCloudPaused(): boolean {
  const organization = useActiveOrganization();
  const owner = organization?.id ?? getActiveOrganizationIdSnapshot();
  if (organization?.seat === "hold") return true;
  return !isFeatureEnabled("cloud-workspaces") && Boolean(owner) &&
    !organization?.isPersonal && owner !== PERSONAL_ORGANIZATION_ID &&
    !getKnownPersonalOrganizationIds().includes(owner!);
}

export function CloudWorkspacePausedNotice() {
  const held = useActiveOrganization()?.seat === "hold" && isFeatureEnabled("cloud-workspaces");
  return <p className="text-fg2 text-sm">{held ? ORGANIZATION_HOLD_MESSAGE : "Cloud workspaces are paused"}</p>;
}
