import { useEffect, useMemo, useRef } from "react";
import { useCloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { cloudWorkspaceExecutionRefusal } from "../../platform/cloud-workspace-execution";
import { cloudRuntimeUpgradeAvailability, cloudRuntimeUpgradeAvailabilityKey, loadCloudRuntimeUpgradeAvailability } from "../../state/cloud-runtime-upgrade";
import { useCachedRead } from "../../state/use-cached-read";
import { observeCloudRuntimeUpgradeAvailability, useRuntimeUpgradeDocumentVisible } from "../../state/cloud-runtime-upgrade-polling";

export function CloudWorkspaceRuntimeControls({ workspace, active, focusRequest = 0 }: { workspace: CloudWorkspaceDocument; active: boolean; focusRequest?: number }) {
  const enabled = useCloudWorkspaceAccountAccess(workspace.organizationId) && workspace.placement === "cloud" &&
    workspace.capabilities.canManage && !cloudWorkspaceExecutionRefusal(workspace);
  const target = useMemo(() => ({ organizationId: workspace.organizationId, workspaceId: workspace.id }), [workspace.organizationId, workspace.id]);
  const readKey = enabled ? cloudRuntimeUpgradeAvailabilityKey(target, workspace.generation.number) : null;
  const visible = useRuntimeUpgradeDocumentVisible(enabled && active);
  const availability = useCachedRead(cloudRuntimeUpgradeAvailability, readKey, loadCloudRuntimeUpgradeAvailability,
    { enabled: enabled && active && visible, maxAgeMs: 10_000 });
  const runtime = availability.data;
  const pending = runtime?.transition && ["draining", "provisioning", "setting_up", "rolling_back"].includes(runtime.transition.state);
  const row = useRef<HTMLElement>(null), focusedRequest = useRef(0);
  useEffect(() => {
    if (!enabled || !active || !visible || !readKey) return;
    return observeCloudRuntimeUpgradeAvailability(readKey, true);
  }, [enabled, active, visible, readKey]);
  useEffect(() => {
    if (!enabled || !active || !visible || !runtime || !focusRequest || focusedRequest.current === focusRequest) return;
    focusedRequest.current = focusRequest;
    row.current?.scrollIntoView({ block: "nearest" });
    row.current?.focus();
  }, [enabled, active, visible, runtime, focusRequest]);
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
