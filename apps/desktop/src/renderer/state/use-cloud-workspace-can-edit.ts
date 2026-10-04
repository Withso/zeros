import { useCallback, useSyncExternalStore } from "react";
import {
  cloudWorkspaceKey,
  isCloudWorkspace,
  parseCloudWorkspaceKey,
} from "../platform/bridge/cloud-workspace-key";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { cloudWorkspaceDetails } from "./cloud-workspace-catalog";

function workspaceKey(folder: string | undefined): string | null {
  try {
    const target = parseCloudWorkspaceKey(folder);
    return target ? cloudWorkspaceKey(target) : null;
  } catch {
    return null;
  }
}

/** Exact cached authority only. Missing metadata never grants editing access. */
export function cloudWorkspaceCanEdit(folder: string | undefined): boolean {
  if (!isCloudWorkspace(folder)) return true;
  const key = workspaceKey(folder);
  const doc = key ? cloudWorkspaceDetails.peekSnapshot(key).data : undefined;
  return (
    !!doc &&
    cloudWorkspaceKey({
      organizationId: doc.organizationId,
      workspaceId: doc.id,
    }) === key &&
    doc.capabilities.canEdit === true
  );
}

export function useCloudWorkspaceCanEdit(folder: string | undefined): boolean {
  const key = workspaceKey(folder),
    epoch = getOrganizationStoreGeneration();
  const subscribe = useCallback(
    (listener: () => void) =>
      key && epoch === getOrganizationStoreGeneration()
        ? cloudWorkspaceDetails.subscribe(key, listener)
        : () => {},
    [key, epoch],
  );
  const read = useCallback(
    () =>
      epoch === getOrganizationStoreGeneration() &&
      cloudWorkspaceCanEdit(folder),
    [folder, epoch],
  );
  return useSyncExternalStore(subscribe, read, read);
}
