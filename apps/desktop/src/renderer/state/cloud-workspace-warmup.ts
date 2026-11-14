import { getActiveBridge } from "../platform/bridge/active-bridge";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { canReadCloudWorkspace, cloudWorkspaceDocument } from "./cloud-workspace-catalog";
import { selectActiveFolder, useWorkspaceStore } from "./store";

/** One read-only intent path shared with selection. Neither metadata nor a
 * history read grants execution authority; runtime open still gets admission. */
export function warmCloudWorkspaceDestination(folder: string, intent = false): Promise<void> {
  const target = parseCloudWorkspaceKey(folder);
  if (!target || (typeof document !== "undefined" && document.visibilityState === "hidden"))
    return Promise.resolve();
  const doc = cloudWorkspaceDocument(target);
  const bridge = getActiveBridge();
  if (!canReadCloudWorkspace(doc) || !(bridge instanceof WorkspaceRuntimeClient))
    return Promise.resolve();
  // A Team sharing reader never connects: its history comes from the mirror. Only the active workspace connects ahead
  // of a click; intent for any other workspace warms its history read (one connection per launch, not per hover).
  if (doc && !doc.sharing?.readOnly && ["ready", "busy"].includes(doc.status) && folder === selectActiveFolder(useWorkspaceStore.getState()))
    return bridge.warmWorkspace(target, { intent });
  return bridge.warmHistoryWorkspace(target, { intent });
}
