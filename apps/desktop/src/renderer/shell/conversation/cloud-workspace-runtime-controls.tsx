import { useEffect, useMemo, useRef } from "react";
import { useCloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { cloudWorkspaceExecutionRefusal } from "../../platform/cloud-workspace-execution";
import { cloudCatalogGeneration, refreshCloudWorkspace } from "../../state/cloud-workspace-catalog";
import { cloudRuntimeUpgradeAvailability, cloudRuntimeUpgradeAvailabilityKey, loadCloudRuntimeUpgradeAvailability } from "../../state/cloud-runtime-upgrade";
import { useCachedRead } from "../../state/use-cached-read";

export function CloudWorkspaceRuntimeControls({ workspace, active, focusRequest = 0 }: { workspace: CloudWorkspaceDocument; active: boolean; focusRequest?: number }) {
  const enabled = useCloudWorkspaceAccountAccess(workspace.organizationId) && workspace.placement === "cloud" &&
    workspace.capabilities.canManage && !cloudWorkspaceExecutionRefusal(workspace);
  const target = useMemo(() => ({ organizationId: workspace.organizationId, workspaceId: workspace.id }), [workspace.organizationId, workspace.id]);
  const readKey = enabled ? cloudRuntimeUpgradeAvailabilityKey(target, workspace.generation.number) : null;
  const availability = useCachedRead(cloudRuntimeUpgradeAvailability, readKey, loadCloudRuntimeUpgradeAvailability,
    { enabled: enabled && active, maxAgeMs: 10_000 });
  const runtime = availability.data;
  const pending = runtime?.transition && ["draining", "provisioning", "setting_up", "rolling_back"].includes(runtime.transition.state);
  const starting = ["waking", "provisioning", "setting_up"].includes(workspace.status);
  const row = useRef<HTMLElement>(null), focusedRequest = useRef(0);
  const catalog = cloudCatalogGeneration();
  useEffect(() => {
    if (!enabled || !active || !readKey) return;
    const timer = setInterval(() => {
      const reads: Promise<unknown>[] = [cloudRuntimeUpgradeAvailability.load(readKey, () => loadCloudRuntimeUpgradeAvailability(readKey), { force: true })];
      if (pending || starting) reads.push(refreshCloudWorkspace(target));
      void Promise.allSettled(reads);
    }, pending ? 2_000 : 5_000);
    return () => clearInterval(timer);
  }, [enabled, active, readKey, pending, starting, target, catalog]);
  useEffect(() => {
    if (!enabled || !active || !runtime || !focusRequest || focusedRequest.current === focusRequest) return;
    focusedRequest.current = focusRequest;
    row.current?.scrollIntoView({ block: "nearest" });
    row.current?.focus();
  }, [enabled, active, runtime, focusRequest]);
  if (!enabled) return null;
  return (
    <section ref={row} tabIndex={-1} aria-label="Runtime updates" className="space-y-2">
      <h3 className="text-fg1 text-xs font-medium">Runtime updates</h3>
      {pending ? <p role="status" aria-live="polite" className="text-fg3 text-xs">Starting the cloud workspace…</p>
        : <p className="text-fg3 text-xs">{runtime?.updateAvailable ? "Updates automatically the next time this workspace wakes" : runtime ? "Runtime is up to date" : "Checking runtime…"}</p>}
      {availability.error && <p className="text-fg3 text-xs" role="status">Couldn’t refresh runtime details. Try reopening workspace details.</p>}
    </section>
  );
}
