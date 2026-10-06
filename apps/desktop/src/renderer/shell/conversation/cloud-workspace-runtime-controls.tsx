import { useEffect, useMemo, useRef, useState } from "react";
import type { CloudRuntimeUpgradeResponse } from "@zeros/protocol/cloud-runtime-lifecycle";
import { useInternalFeatureActive } from "../../features/settings/internal-features";
import { useAnyChatAgentWorking } from "../../features/agent/sessions-store";
import { getOrganizationStoreGeneration } from "../../features/team/team-store";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { Button } from "../../shared/ui/primitives/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../shared/ui/primitives/dialog";
import { toast } from "../../shared/ui/primitives/elements";
import { cloudCatalogGeneration, refreshCloudWorkspace } from "../../state/cloud-workspace-catalog";
import { cloudRuntimeUpgradeAvailability, cloudRuntimeUpgradeAvailabilityKey, loadCloudRuntimeUpgradeAvailability,
  requestCloudRuntimeUpgrade, settleCloudRuntimeUpgrade, cloudRuntimeUpgradeOutcome } from "../../state/cloud-runtime-upgrade";
import { useCachedRead } from "../../state/use-cached-read";
import { useWorkspaceStore } from "../../state/workspace-store";

const pendingStates = ["draining", "provisioning", "setting_up", "rolling_back"];
const progressLabels: Record<string, string> = {
  draining: "Saving checkpoint…", provisioning: "Restarting workspace…", setting_up: "Setting up workspace…",
  rolling_back: "Restoring previous runtime…",
};
const blockedLabels: Record<string, string> = {
  cloud_workspace_busy: "Stop running agents and active workspace work before updating.",
  cloud_workspace_not_stable: "Wait for the workspace to finish its current operation.",
  cloud_generation_transition_active: "A workspace restart is already in progress.",
  cloud_workspace_lifecycle_active: "Wait for the workspace to finish its current operation.",
  cloud_runtime_unavailable: "A compatible runtime update is currently unavailable.",
  cloud_runtime_upgrade_not_supported: "Runtime updates require a newer workspace environment.",
};

export function CloudWorkspaceRuntimeControls({ workspace, active, focusRequest = 0 }: { workspace: CloudWorkspaceDocument; active: boolean; focusRequest?: number }) {
  const enabled = useInternalFeatureActive("cloudComputerV2") && workspace.capabilities.canManage;
  const target = useMemo(() => ({ organizationId: workspace.organizationId, workspaceId: workspace.id }), [workspace.organizationId, workspace.id]);
  const folder = cloudWorkspaceKey(target);
  const chats = useWorkspaceStore(state => state.chats);
  const chatIds = useMemo(() => chats.filter(chat => chat.folder === folder).map(chat => chat.id), [chats, folder]);
  const working = useAnyChatAgentWorking(chatIds);
  const account = getOrganizationStoreGeneration(), catalog = cloudCatalogGeneration();
  const readKey = enabled ? cloudRuntimeUpgradeAvailabilityKey(target, workspace.generation.number) : null;
  const availability = useCachedRead(cloudRuntimeUpgradeAvailability, readKey, loadCloudRuntimeUpgradeAvailability,
    { enabled: enabled && active, maxAgeMs: 10_000 });
  const runtime = availability.data;
  const [confirmation, setConfirmation] = useState<{ generation: number; runtimeId: string } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [accepted, setAccepted] = useState<CloudRuntimeUpgradeResponse | null>(null);
  const updateTrigger = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLElement>(null);
  const focusedRequest = useRef(0);
  const cancel = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const transition = runtime?.transition;
  const unavailableReason = working ? "cloud_workspace_busy" : runtime?.unavailableReason;
  const pending = requesting || accepted !== null || !!transition && (pendingStates.includes(transition.state) ||
    transition.state === "succeeded" && workspace.generation.number < transition.generation);
  const disabled = pending || !runtime?.updateAvailable || runtime.generation !== workspace.generation.number ||
    !!unavailableReason || !!availability.error || workspace.status === "busy";

  // A closed details popover and a retained hidden workspace do no polling.
  // The server transition survives either UI's lifetime and client disconnects.
  useEffect(() => {
    if (!enabled || !active || !readKey) return;
    const timer = setInterval(() => {
      void Promise.allSettled([
        cloudRuntimeUpgradeAvailability.load(readKey, () => loadCloudRuntimeUpgradeAvailability(readKey), { force: true }),
        refreshCloudWorkspace({ organizationId: workspace.organizationId, workspaceId: workspace.id }),
      ]);
    }, pending ? 2_000 : 5_000);
    return () => clearInterval(timer);
  }, [enabled, active, readKey, pending, workspace.organizationId, workspace.id]);

  useEffect(() => {
    if (!enabled || !active || !accepted || !runtime) return;
    const outcome = cloudRuntimeUpgradeOutcome(workspace, runtime, accepted);
    if (!outcome) return;
    settleCloudRuntimeUpgrade(target, accepted);
    setAccepted(null);
    if (outcome === "failed") toast.error("Couldn't update cloud runtime", { description: transition?.error?.message ?? "The previous workspace generation was preserved. Try again." });
    else toast.success(outcome === "superseded" ? "Cloud runtime updated on another device" : "Cloud runtime updated");
  }, [enabled, active, accepted, runtime, transition, workspace, target]);

  useEffect(() => {
    if (!enabled || !active || !runtime || !focusRequest || focusRequest === focusedRequest.current) return;
    focusedRequest.current = focusRequest;
    row.current?.scrollIntoView({ block: "nearest" });
    if (updateTrigger.current && !updateTrigger.current.disabled) updateTrigger.current.focus();
    else row.current?.focus();
  }, [enabled, active, runtime, focusRequest]);

  if (!enabled) return null;
  const confirmOpen = active && confirmation !== null && confirmation.generation === workspace.generation.number;
  const current = runtime?.currentRuntimeId;
  const update = () => {
    if (disabled || !confirmation || !active || confirmation.runtimeId !== runtime?.latestRuntimeId) return;
    setConfirmation(null);
    setRequesting(true);
    void requestCloudRuntimeUpgrade(target, confirmation.generation).then(receipt => {
      if (!mounted.current || account !== getOrganizationStoreGeneration() || catalog !== cloudCatalogGeneration()) return;
      if (receipt.unchanged) {
        settleCloudRuntimeUpgrade(target, receipt);
        toast.success("Cloud runtime is up to date");
      } else setAccepted(receipt);
      if (readKey) cloudRuntimeUpgradeAvailability.invalidate(readKey);
      void refreshCloudWorkspace(target).catch(() => {});
    }).catch(error => {
      if (!mounted.current || account !== getOrganizationStoreGeneration() || catalog !== cloudCatalogGeneration()) return;
      toast.error("Couldn't update cloud runtime", { description: error instanceof Error ? error.message : "Try again." });
      if (readKey) cloudRuntimeUpgradeAvailability.invalidate(readKey);
      void refreshCloudWorkspace(target).catch(() => {});
    }).finally(() => { if (mounted.current) setRequesting(false); });
  };

  return (
    <section ref={row} tabIndex={-1} aria-label="Workspace runtime" className="border-border1 mt-3 space-y-2 border-t pt-3">
      <p className="text-fg2 text-xs" title={current ?? undefined}>Runtime · {current ? current.slice(0, 11) : runtime ? "Legacy" : "Checking…"}</p>
      {pending ? (
        <div role="status" aria-live="polite" className="space-y-1">
          <p className="text-fg1 text-xs">Updating runtime…</p>
          <p className="text-fg3 text-xs">{progressLabels[transition?.state ?? ""] ?? "Waiting for the updated workspace to be ready…"}</p>
        </div>
      ) : runtime?.updateAvailable && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-fg3 text-xs">Update available</span>
          <Button ref={updateTrigger} size="compact" disabled={disabled} onClick={() => setConfirmation({ generation: workspace.generation.number, runtimeId: runtime.latestRuntimeId! })}>
            Update runtime
          </Button>
        </div>
      )}
      {!pending && unavailableReason && <p className="text-fg3 text-xs">{blockedLabels[unavailableReason]}</p>}
      {availability.error && <p className="text-fg3 text-xs" role="status">Couldn’t refresh runtime details. Try reopening workspace details.</p>}
      <Dialog open={confirmOpen} onOpenChange={open => { if (!open) setConfirmation(null); }}>
        <DialogContent onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus(); }}
          onCloseAutoFocus={event => { if (updateTrigger.current && !updateTrigger.current.disabled) { event.preventDefault(); updateTrigger.current.focus(); } }}>
          <DialogHeader>
            <DialogTitle>Update cloud runtime?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3">
                <p>The workspace will save a checkpoint and restart.</p>
                <p>Checkpointed files, Git changes and history, chats, transcripts, and saved agent session history are preserved.
                  Ignored and secret files are excluded from checkpoints. Paused queued messages stay paused.</p>
                <p>Terminals and setup or preview processes stop; reopen terminals and restart previews afterward.
                  Setup runs again using the saved configuration. Running agents and active workspace work must finish before updating.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={cancel} onClick={() => setConfirmation(null)}>Cancel</Button>
            <Button variant="default" disabled={disabled || confirmation?.runtimeId !== runtime?.latestRuntimeId} onClick={update}>Update runtime</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
