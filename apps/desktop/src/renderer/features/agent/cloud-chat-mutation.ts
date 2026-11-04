import { cloudWorkspaceKey, isCloudWorkspace, parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import { cloudCatalogGeneration, cloudWorkspaceOwnerGeneration, cloudWorkspaceStopVersion } from "../../state/cloud-workspace-catalog";
import { useSessionsStore } from "./sessions-store";
import { getActiveBridge, onActiveBridgeChange } from "../../platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";

export function trackCloudChatMutation(chatId: string, folder?: string | null): { isCurrent: () => boolean; dispose: () => void } {
  const target = parseCloudScopedId(chatId);
  if (!target) return { isCurrent: () => !isCloudWorkspace(folder), dispose: () => {} };
  const cwd = cloudWorkspaceKey(target), account = cloudCatalogGeneration(), owner = cloudWorkspaceOwnerGeneration(target);
  const stop = cloudWorkspaceStopVersion(target), agent = useSessionsStore.getState().sessions[chatId]?.agentId;
  let cancelled = useSessionsStore.getState().cancellingChats.has(chatId);
  const bridge = getActiveBridge(), router = bridge instanceof WorkspaceRuntimeClient ? bridge : undefined;
  let connected = router?.statusForWorkspace(cwd) === "connected";
  const stopStatus = router?.onWorkspaceStatusChange(cwd, () => {
    const next = router.statusForWorkspace(cwd) === "connected";
    if (connected && !next) cancelled = true;
    connected ||= next;
  });
  const stopBridge = onActiveBridgeChange(next => { if (next !== bridge) cancelled = true; });
  const stopSession = useSessionsStore.subscribe((state, previous) => {
    const slot = state.sessions[chatId], before = previous.sessions[chatId];
    if (!slot || slot.cwd !== cwd || slot.agentId !== agent || state.cancellingChats.has(chatId) ||
        slot.cloudStop && slot.cloudStop.operationId !== before?.cloudStop?.operationId) cancelled = true;
  });
  return { dispose: () => { stopSession(); stopBridge(); stopStatus?.(); }, isCurrent: () => !cancelled && owner !== undefined && account === cloudCatalogGeneration() &&
    owner === cloudWorkspaceOwnerGeneration(target) && stop === cloudWorkspaceStopVersion(target) &&
    useSessionsStore.getState().sessions[chatId]?.cwd === cwd };
}
