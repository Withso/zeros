import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { RotateCw } from "lucide-react";
import { useCloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { cloudWorkspaceExecutionRefusal } from "../../platform/cloud-workspace-execution";
import { canReadCloudWorkspace, cloudCatalogGeneration, cloudWorkspaceDocument, subscribeCloudWorkspaces } from "../../state/cloud-workspace-catalog";
import { cloudWorkspaceRestartVisible, restartCloudWorkspace } from "../../state/cloud-workspace-restart";
import { cloudWorkspaceRestartPhase, subscribeCloudWorkspaceRestarts } from "../../state/cloud-workspace-restart-status";
import { useWorkbenchAvailability } from "../../state/workbench-availability";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Tooltip } from "../../shared/ui/primitives";
import { describeWorkspaceRuntimeStatus } from "../workbench/tab-status-model";
import { cloudWorkspaceHasRunningWork } from "./cloud-workspace-running-work";

export function useCloudWorkspaceRestartAction(folder: string, active: boolean) {
  const target = parseCloudWorkspaceKey(folder);
  const enabled = useCloudWorkspaceAccountAccess(target?.organizationId);
  const cloud = target !== null;
  const subscribe = useCallback((listener: () => void) =>
    enabled && active && cloud ? subscribeCloudWorkspaces(listener) : () => {}, [enabled, active, cloud]);
  const read = () => target ? cloudWorkspaceDocument(target) : undefined;
  const workspace = useSyncExternalStore(subscribe, read, read);
  const subscribeRestart = useCallback((listener: () => void) =>
    enabled && active && cloud ? subscribeCloudWorkspaceRestarts(listener) : () => {}, [enabled, active, cloud]);
  const readRestart = () => cloudWorkspaceRestartPhase(folder);
  const phase = useSyncExternalStore(subscribeRestart, readRestart, readRestart);
  const visible = enabled && !cloudWorkspaceExecutionRefusal(workspace) && cloudWorkspaceRestartVisible(folder, workspace);
  const disabledReason = !workspace?.capabilities.canWrite
    ? "Workspace run access is required to restart."
    : phase ? "This workspace is restarting." : undefined;
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const owner = JSON.stringify([cloudCatalogGeneration(), folder, workspace?.generation.number]);
  const interactive = active && (typeof document === "undefined" || document.visibilityState !== "hidden");
  const run = () => {
    if (!interactive || !visible || disabledReason) return;
    setConfirmation(null);
    // The shared action owns its single failure presentation, even when the
    // header and sidebar both join it or the originating surface unmounts.
    void restartCloudWorkspace(folder).catch(() => {});
  };
  const request = () => {
    if (!interactive || !visible || disabledReason) return;
    if (cloudWorkspaceHasRunningWork(folder)) setConfirmation(owner);
    else run();
  };
  const dialog = (
    <Dialog open={interactive && visible && !disabledReason && confirmation === owner}
      onOpenChange={open => { if (!open) setConfirmation(null); }}>
      <DialogContent className="max-w-sm" onOpenAutoFocus={event => {
        event.preventDefault();
        cancelButton.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>Restart this workspace?</DialogTitle>
          <DialogDescription>Running work will stop.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelButton} variant="secondary" onClick={() => setConfirmation(null)}>Cancel</Button>
          <Button onClick={run}><RotateCw />Restart workspace</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { visible, disabledReason, request, dialog, workspace, enabled };
}

/** The cloud boundary prevents adding observers or controls to Local rows. */
export function CloudWorkspaceStatusRow({ folder, active, inline = false }: { folder: string; active: boolean; inline?: boolean }) {
  return parseCloudWorkspaceKey(folder) ? <CloudWorkspaceStatusRowContent folder={folder} active={active} inline={inline} /> : null;
}

function CloudWorkspaceStatusRowContent({ folder, active, inline }: { folder: string; active: boolean; inline: boolean }) {
  const restart = useCloudWorkspaceRestartAction(folder, active);
  const target = parseCloudWorkspaceKey(folder)!;
  const readable = restart.enabled && restart.workspace?.id === target.workspaceId &&
    restart.workspace.organizationId === target.organizationId && canReadCloudWorkspace(restart.workspace);
  const { availability } = useWorkbenchAvailability(folder, active && readable);
  if (!readable) return null;
  const status = describeWorkspaceRuntimeStatus(availability, Date.now());
  return (
    <>
      <div aria-label="Cloud workspace status" className={inline ? "inline-flex items-center justify-end gap-1 text-xs" : "border-border1 flex shrink-0 items-center gap-2 border-b px-3 py-1 text-xs"}>
        {!inline && <span className="text-fg3">Status</span>}
        {restart.visible && <Tooltip label={restart.disabledReason ?? "Restart workspace"}>
          <span className="inline-flex">
            <Button variant="ghost" size="compact" aria-label="Restart workspace" disabled={!!restart.disabledReason}
              onClick={restart.request}><RotateCw />Restart</Button>
          </span>
        </Tooltip>}
        <span role="status" aria-live={active ? "polite" : "off"} className="text-fg1 inline-flex items-center gap-1.5">
          {status === "Running" && <span className="bg-green-primary size-1.5 rounded-full" aria-hidden />}
          {status}
        </span>
      </div>
      {restart.dialog}
    </>
  );
}
