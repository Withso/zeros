import { useCallback, useSyncExternalStore } from "react";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import {
  cloudWorkspaceDocument,
  subscribeCloudWorkspaces,
} from "../../state/cloud-workspace-catalog";
import { useCloudWorkspaceAccountAccess } from "../team/cloud-workspace-account-access";

/** UI admission follows the same role split as the worker. Missing role or
 * capabilities fail closed; the engine independently checks every request. */
export function useCloudDesignManagement(
  workspaceId: string,
  active: boolean,
): boolean {
  const target = parseCloudWorkspaceKey(workspaceId);
  const enabled = useCloudWorkspaceAccountAccess(target?.organizationId);
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
