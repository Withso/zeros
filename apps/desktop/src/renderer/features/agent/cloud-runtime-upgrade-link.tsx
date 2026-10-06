import { useEffect } from "react";
import { useInternalFeatureActive } from "../settings/internal-features";
import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { cloudWorkspaceDetails, refreshCloudWorkspace } from "../../state/cloud-workspace-catalog";
import { cloudRuntimeUpgradeAvailability, cloudRuntimeUpgradeAvailabilityKey, loadCloudRuntimeUpgradeAvailability } from "../../state/cloud-runtime-upgrade";
import { useCachedRead } from "../../state/use-cached-read";

/** Local composers retain their existing props, including visibility policy. */
export function cloudRuntimeUpgradeComposerContext(folder: string, active: boolean): { workspaceFolder?: string; active?: boolean } {
  return parseCloudWorkspaceKey(folder) ? { workspaceFolder: folder, active } : {};
}

/** The discovery workstream can supply its stable reason without sharing its
 * transport. Qualified newer runtimes supply the fallback independently. */
export function useCloudRuntimeUpgradeLink(folder: string | undefined, active: boolean, runtimeUpgradeRequiredForAgents = false) {
  const internal = useInternalFeatureActive("cloudComputerV2");
  const target = parseCloudWorkspaceKey(folder);
  const enabled = internal && active && target !== null;
  const details = useCachedRead(cloudWorkspaceDetails, enabled ? cloudWorkspaceKey(target!) : null,
    key => refreshCloudWorkspace(parseCloudWorkspaceKey(key)!), { enabled, maxAgeMs: 10_000 });
  const allowed = enabled && details.data?.capabilities.canManage === true;
  const key = allowed ? cloudRuntimeUpgradeAvailabilityKey(target!, details.data!.generation.number) : null;
  const availability = useCachedRead(cloudRuntimeUpgradeAvailability, key, loadCloudRuntimeUpgradeAvailability,
    { enabled: allowed, maxAgeMs: 10_000 });
  useEffect(() => {
    if (!allowed || !key) return;
    const timer = setInterval(() => {
      void cloudRuntimeUpgradeAvailability.load(key, () => loadCloudRuntimeUpgradeAvailability(key), { force: true }).catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, [allowed, key]);
  if (!allowed || !runtimeUpgradeRequiredForAgents && !availability.data?.updateAvailable) return null;
  return (
    <div className="border-border1 mt-2 space-y-2 border-t px-3 pt-3 pb-2">
      <p className="text-fg2 text-xs">{runtimeUpgradeRequiredForAgents ? "Agents need a runtime update. It installs the next time this workspace wakes." : "Updates automatically the next time this workspace wakes."}</p>
    </div>
  );
}
