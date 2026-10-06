import { Button } from "../../shared/ui/primitives/button";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { useWorkspaceStore } from "../../state/store";
import { getActiveOrganizationIdSnapshot } from "../team/team-store";
import { requestProviderSettings } from "../settings/settings-navigation";
import type { CloudAdmissionFailure } from "./cloud-admission-failure";

/** Always route to this cloud organization's provider settings. A retained
 * surface cannot change another owner's settings after an organization switch. */
export function openCloudAdmissionSettings(folder: string | null | undefined, agentId: string | null | undefined): void {
  const target = parseCloudWorkspaceKey(folder);
  if (!target || target.organizationId !== getActiveOrganizationIdSnapshot() || !agentId) return;
  requestProviderSettings(agentId);
  useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
}
export function CloudAdmissionStatus({ folder, agentId, failure, onRetry, readOnly = false }: {
  folder: string | null | undefined;
  agentId?: string | null;
  failure: CloudAdmissionFailure | null | undefined;
  onRetry?: () => void;
  readOnly?: boolean;
}) {
  const target = parseCloudWorkspaceKey(folder);
  if (!target || !failure || failure.kind === "waiting") return null;
  const configure = failure.action === "choose-model" || failure.action === "reconnect";
  return (
    <div role="status" data-cloud-admission-status="" className="text-fg2 mb-2 flex flex-wrap items-center gap-2 text-2xxs">
      <span>{failure.message}</span>
      {!readOnly && configure && <Button variant="ghost" size="compact"
        disabled={target.organizationId !== getActiveOrganizationIdSnapshot() || !agentId}
        onClick={() => openCloudAdmissionSettings(folder, agentId)}>
        {failure.action === "choose-model" ? "Enable models" : "Reconnect"}
      </Button>}
      {failure.action === "choose-model" && <span>Or choose an allowed model.</span>}
      {!readOnly && failure.action === "retry" && onRetry && <Button variant="ghost" size="compact" onClick={onRetry}>Try again</Button>}
    </div>
  );
}
