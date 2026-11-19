import { useCallback, useSyncExternalStore } from "react";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import { useBridge } from "../platform/bridge/use-bridge";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { cloudFileListAccess, subscribeCloudFileListAccess } from "../state/cloud-file-list-presentation";
import { workspaceCacheKey } from "./workspace-files-cache";

export function useWorkspaceFileListScope(folder: string | null | undefined, active: boolean) {
  const bridge = useBridge();
  const subscribe = useCallback((listener: () => void) => {
    if (!active || !folder || !isCloudWorkspace(folder)) return () => {};
    const offAccess = subscribeCloudFileListAccess(listener);
    const offBridge = bridge instanceof WorkspaceRuntimeClient
      ? bridge.onWorkspaceStatusChange(folder, listener)
      : bridge?.onStatusChange(listener);
    return () => { offAccess(); offBridge?.(); };
  }, [active, bridge, folder]);
  const read = useCallback(() => {
    if (!folder || !isCloudWorkspace(folder)) return "1local";
    const access = cloudFileListAccess(workspaceCacheKey(folder));
    if (!access) return "";
    const status = bridge instanceof WorkspaceRuntimeClient
      ? bridge.statusForWorkspace(folder)
      : bridge?.status;
    return `${access.ready && status === "connected" ? "1" : "0"}${access.key}`;
  }, [bridge, folder]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return {
    key: snapshot.slice(1),
    live: snapshot.startsWith("1"),
    canLoad: () => read().startsWith("1"),
  };
}
