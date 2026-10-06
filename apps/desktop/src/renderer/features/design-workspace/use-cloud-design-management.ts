import { useCallback, useSyncExternalStore } from "react";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import {
  cloudWorkspaceDocument,
  subscribeCloudWorkspaces,
} from "../../state/cloud-workspace-catalog";
import { useInternalFeatureActive } from "../settings/internal-features";

/** UI admission follows the same role split as the worker. Missing role or
 * capabilities fail closed; the engine independently checks every request. */
export function useCloudDesignManagement(
  workspaceId: string,
  active: boolean,
): boolean {
  const enabled = useInternalFeatureActive("cloudComputerV2");
  const target = parseCloudWorkspaceKey(workspaceId);
  const cloud = target !== null;
  const subscribe = useCallback(
    (listener: () => void) =>
      active && enabled && cloud
        ? subscribeCloudWorkspaces(listener)
        : () => {},
    [active, enabled, cloud],
  );
  const snapshot = () => {
    const doc =
      active && enabled && target ? cloudWorkspaceDocument(target) : undefined;
    return (
      !!doc?.capabilities.canManage &&
      (doc.actorRole === "manager" || doc.actorRole === "owner")
    );
  };
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
