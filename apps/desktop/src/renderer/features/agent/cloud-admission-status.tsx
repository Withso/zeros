import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { useWorkspaceStore } from "../../state/store";
import { getActiveOrganizationIdSnapshot } from "../team/team-store";
import { requestProviderSettings } from "../settings/settings-navigation";

/** Always route to this cloud organization's provider settings. A retained
 * surface cannot change another owner's settings after an organization switch. */
export function openCloudAdmissionSettings(folder: string | null | undefined, agentId: string | null | undefined): void {
  const target = parseCloudWorkspaceKey(folder);
  if (!target || target.organizationId !== getActiveOrganizationIdSnapshot() || !agentId) return;
  requestProviderSettings(agentId);
  useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
}
