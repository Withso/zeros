import { useEffect, useMemo, useRef } from "react";
import { useInternalFeatureActive } from "../../features/settings/internal-features";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { cloudCatalogGeneration, refreshCloudWorkspace } from "../../state/cloud-workspace-catalog";
import { cloudRuntimeUpgradeAvailability, cloudRuntimeUpgradeAvailabilityKey, loadCloudRuntimeUpgradeAvailability } from "../../state/cloud-runtime-upgrade";
import { useCachedRead } from "../../state/use-cached-read";

export function CloudWorkspaceRuntimeControls({ workspace, active, focusRequest = 0 }: { workspace: CloudWorkspaceDocument; active: boolean; focusRequest?: number }) {
  const enabled = useInternalFeatureActive("cloudComputerV2") && workspace.capabilities.canManage;
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
  const current = runtime?.currentRuntimeId;
  return (
    <section ref={row} tabIndex={-1} aria-label="Workspace runtime" className="border-border1 mt-3 space-y-2 border-t pt-3">
      <p className="text-fg2 text-xs" title={current ?? undefined}>Runtime · {current ? current.slice(0, 11) : runtime ? "Legacy" : "Checking…"}</p>
      {pending ? <p role="status" aria-live="polite" className="text-fg3 text-xs">Starting the cloud workspace…</p>
        : runtime?.updateAvailable && <p className="text-fg3 text-xs">Updates automatically the next time this workspace wakes</p>}
      {availability.error && <p className="text-fg3 text-xs" role="status">Couldn’t refresh runtime details. Try reopening workspace details.</p>}
    </section>
  );
}
