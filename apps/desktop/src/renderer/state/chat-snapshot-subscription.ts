import {
  bridgeChatSnapshot,
  type ChatSnapshotWire,
} from "../platform/bridge/workspace-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import { WorkspaceRuntimeClient, type ChatSnapshotRefresh } from "../platform/bridge/workspace-runtime-client";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";

/** The persistence controller's read-before-write subscription. */
export function subscribeChatSnapshots(options: {
  bridge: RuntimeClient;
  onSnapshot: (snapshot: ChatSnapshotWire) => void;
  onLocalReadinessChange: () => void;
  onError: (error: unknown) => void;
}): () => void {
  let cancelled = false;
  let pullId = 0;
  let localPullId = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let localRetry: ReturnType<typeof setTimeout> | undefined;
  const retryLocal = () => {
    clearTimeout(localRetry);
    if (options.bridge.status === "connected")
      localRetry = setTimeout(() => void reconcile("local"), 2_000);
  };
  const reconcile = async (refresh: ChatSnapshotRefresh = "all") => {
    if (
      !(options.bridge instanceof WorkspaceRuntimeClient) &&
      options.bridge.status !== "connected"
    )
      return;
    const id = ++pullId;
    const refreshLocal = refresh === "all" || refresh === "local";
    const localId = refreshLocal ? ++localPullId : localPullId;
    if (refreshLocal) clearTimeout(localRetry);
    else if (refresh !== "retained") clearTimeout(retry);
    try {
      const snapshot = await bridgeChatSnapshot(options.bridge, refresh);
      if (cancelled) return;
      // A cloud publication must not cancel Local's recovery. Partial results
      // can publish confirmed cloud data, but cannot complete the Local pull.
      if (refreshLocal && localId === localPullId && snapshot.confirmedLocalChats === false)
        retryLocal();
      if (id === pullId && snapshot.confirmedLocalChats !== false) clearTimeout(localRetry);
      if (!cancelled && id === pullId) options.onSnapshot(snapshot);
    } catch (error) {
      if (cancelled || (refreshLocal ? localId !== localPullId : id !== pullId)) return;
      options.onError(error);
      if (refreshLocal) retryLocal();
      else if (refresh !== "retained") retry = setTimeout(() => void reconcile(refresh), 2_000);
    }
  };
  const offChanged = options.bridge.on("DB_CHANGED", (raw) => {
    const { kinds, cloudWorkspace, workspaceId, workspaceIds, snapshotPublication } = raw as unknown as Record<string, unknown>;
    if (!Array.isArray(kinds) || !kinds.includes("chats")) return;
    if (snapshotPublication === true) { void reconcile("retained"); return; }
    const ids = [cloudWorkspace, workspaceId, ...(Array.isArray(workspaceIds) ? workspaceIds : [])];
    const owners = [...new Set(ids.filter((id): id is string => typeof id === "string" && !!parseCloudWorkspaceKey(id)))];
    // A malformed cloud owner must not turn into a Local/global refresh.
    if (cloudWorkspace !== undefined && !owners.length) return;
    if (!owners.length) options.onLocalReadinessChange();
    void reconcile(owners.length ? owners : "local");
  });
  const offStatus = options.bridge.onStatusChange((status) => {
    options.onLocalReadinessChange();
    localPullId++;
    clearTimeout(localRetry);
    if (status === "connected") void reconcile("local");
  });
  void reconcile();
  return () => {
    cancelled = true;
    pullId++;
    clearTimeout(retry);
    clearTimeout(localRetry);
    offChanged();
    offStatus();
  };
}
