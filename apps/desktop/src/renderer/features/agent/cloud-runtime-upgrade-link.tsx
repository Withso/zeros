import { useEffect } from "react";
import { useCloudWorkspaceAccountAccess } from "../team/cloud-workspace-account-access";
import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { cloudWorkspaceDetails, refreshCloudWorkspace } from "../../state/cloud-workspace-catalog";
import { cloudRuntimeUpgradeAvailability, cloudRuntimeUpgradeAvailabilityKey, loadCloudRuntimeUpgradeAvailability } from "../../state/cloud-runtime-upgrade";
import { useCachedRead } from "../../state/use-cached-read";
import { observeCloudRuntimeUpgradeAvailability, useRuntimeUpgradeDocumentVisible } from "../../state/cloud-runtime-upgrade-polling";

/** Local composers retain their existing props, including visibility policy. */
export function cloudRuntimeUpgradeComposerContext(folder: string, active: boolean): { workspaceFolder?: string; active?: boolean } {
  return parseCloudWorkspaceKey(folder) ? { workspaceFolder: folder, active } : {};
}

/** The discovery workstream can supply its stable reason without sharing its
 * transport. Qualified newer runtimes supply the fallback independently. */
export function useCloudRuntimeUpgradeLink(folder: string | undefined, active: boolean, runtimeUpgradeRequiredForAgents = false) {
  const target = parseCloudWorkspaceKey(folder);
  const internal = useCloudWorkspaceAccountAccess(target?.organizationId);
  const enabled = internal && active && target !== null;
  const visible = useRuntimeUpgradeDocumentVisible(enabled);
  const details = useCachedRead(cloudWorkspaceDetails, enabled ? cloudWorkspaceKey(target!) : null,
    key => refreshCloudWorkspace(parseCloudWorkspaceKey(key)!), { enabled: enabled && visible, maxAgeMs: 10_000 });
  const allowed = enabled && details.data?.capabilities.canManage === true;
  const key = allowed ? cloudRuntimeUpgradeAvailabilityKey(target!, details.data!.generation.number) : null;
  const availability = useCachedRead(cloudRuntimeUpgradeAvailability, key, loadCloudRuntimeUpgradeAvailability,
    { enabled: allowed && visible, maxAgeMs: 10_000 });
  useEffect(() => {
    if (!allowed || !visible || !key) return;
    return observeCloudRuntimeUpgradeAvailability(key);
  }, [allowed, visible, key]);
  // The model's required update is informational for every admitted actor.
  // Generic update discovery retains its manager-only reads and visibility.
  if (!enabled || !runtimeUpgradeRequiredForAgents && (!allowed || !availability.data?.updateAvailable)) return null;
  return (
    <div data-cloud-runtime-update-note="" className="border-border1 mt-2 space-y-2 border-t px-3 pt-3 pb-2">
      <p className="text-fg2 text-xs">{runtimeUpgradeRequiredForAgents ? "Agents need a runtime update. It installs the next time this workspace wakes." : "Updates automatically the next time this workspace wakes."}</p>
    </div>
  );
}
