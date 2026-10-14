import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { useCallback, useSyncExternalStore } from "react";
import { CircleAlert } from "lucide-react";
import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { useCloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";
import { canReadCloudWorkspace, cloudCatalogGeneration, cloudWorkspaceDocument, subscribeCloudWorkspaces } from "../../state/cloud-workspace-catalog";
import { useWorkbenchAvailability } from "../../state/workbench-availability";
import { cloudHistoryRecoveryDismissed, dismissCloudHistoryRecovery, subscribeCloudHistoryRecoveryDismissals } from "../../state/cloud-history-recovery-dismissal";
import { Button } from "../../shared/ui/primitives";

export function CloudHistoryRecoveryNoticeView({ folder, active, connected, workspace, dismissed, onDismiss }: {
  folder: string; active: boolean; connected: boolean; workspace?: CloudWorkspaceDocument;
  dismissed: boolean; onDismiss(): void;
}) {
  const target = parseCloudWorkspaceKey(folder), receipt = workspace?.historyRecovery, binding = workspace?.agentCredentials;
  if (!target || !active || !connected || dismissed || !workspace || !receipt || !binding ||
      workspace.id !== target.workspaceId || workspace.organizationId !== target.organizationId ||
      !canReadCloudWorkspace(workspace) || !["ready", "busy"].includes(workspace.status) ||
      binding.status !== "current" || binding.generation !== workspace.generation.number ||
      receipt.generation > workspace.generation.number) return null;
  return <div className="bg-yellow-bg text-yellow-fg flex shrink-0 items-start gap-2 px-3 py-2 text-xs" data-history-recovery-notice="">
    <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
    <div className="min-w-0 flex-1" role="status" aria-live="polite" aria-atomic="true">
      <p className="font-medium">Recent history may be incomplete</p>
      <p>The workspace recovered after an interrupted stop. Check recent messages and work before retrying a request.</p>
    </div>
    <Button variant="ghost" size="compact" className="shrink-0 text-inherit hover:text-inherit"
      aria-label="Dismiss history recovery warning" onClick={onDismiss}>Dismiss</Button>
  </div>;
}

/** Local placements do not subscribe to cloud state. No fetch, wake or send. */
export function CloudHistoryRecoveryNotice({ folder, active }: { folder: string; active: boolean }) {
  const target = parseCloudWorkspaceKey(folder);
  return target ? <CloudHistoryRecoveryNoticeContent key={cloudWorkspaceKey(target)} folder={folder} active={active} /> : null;
}
function CloudHistoryRecoveryNoticeContent({ folder, active }: { folder: string; active: boolean }) {
  const { organizationId, workspaceId } = parseCloudWorkspaceKey(folder)!, enabled = useCloudWorkspaceAccountAccess(organizationId);
  const { availability, visible } = useWorkbenchAvailability(folder, active && enabled);
  const epoch = cloudCatalogGeneration();
  const subscribe = useCallback((listener: () => void) => visible ? subscribeCloudWorkspaces(listener) : () => {}, [visible]);
  const read = useCallback(() => cloudWorkspaceDocument({ organizationId, workspaceId }), [organizationId, workspaceId]);
  const workspace = useSyncExternalStore(subscribe, read, read), receipt = workspace?.historyRecovery?.recoveryId ?? "";
  const subscribeDismissal = useCallback((listener: () => void) => visible ? subscribeCloudHistoryRecoveryDismissals(listener) : () => {}, [visible]);
  const dismissed = useSyncExternalStore(subscribeDismissal, () => cloudHistoryRecoveryDismissed(folder, receipt), () => false);
  const dismiss = () => {
    if (!visible || epoch !== cloudCatalogGeneration() || cloudWorkspaceDocument({ organizationId, workspaceId })?.historyRecovery?.recoveryId !== receipt) return;
    dismissCloudHistoryRecovery(folder, receipt);
  };
  return <CloudHistoryRecoveryNoticeView folder={folder} active={visible} connected={availability.connection === "connected"}
    workspace={workspace} dismissed={dismissed} onDismiss={dismiss} />;
}
