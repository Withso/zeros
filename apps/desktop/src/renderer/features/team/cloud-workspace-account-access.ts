import type { Me } from "./control-plane";
import { getTeamStoreState, useTeams } from "./team-store";

/** Account admission, independent of staff roles and retired preferences.
 * A known organization's Cloud entitlement must remain enabled. Guests can
 * have a server-granted workspace without organization membership; callers
 * still require its exact cloud target and confirmed document capabilities. */
export function cloudWorkspaceAccountAccess(
  me: Me | null,
  organizationId?: string,
): boolean {
  if (!me?.user.id) return false;
  if (!organizationId) return true;
  const organization = (me.organizations ?? me.teams ?? []).find(
    candidate => candidate.id === organizationId,
  );
  return !organization ||
    !organization.isPersonal && organization.workspaceCapabilities.cloud;
}

export function hasCloudWorkspaceAccountAccess(organizationId?: string): boolean {
  return cloudWorkspaceAccountAccess(getTeamStoreState().me, organizationId);
}

export function useCloudWorkspaceAccountAccess(organizationId?: string): boolean {
  const { me } = useTeams();
  return cloudWorkspaceAccountAccess(me, organizationId);
}
