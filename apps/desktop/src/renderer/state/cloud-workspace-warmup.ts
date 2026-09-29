import { getActiveBridge } from "../platform/bridge/active-bridge";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { canReadCloudWorkspace, cloudWorkspaceDocument } from "./cloud-workspace-catalog";

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
  if (doc && ["ready", "busy"].includes(doc.status))
    return bridge.warmWorkspace(target, { intent });
  return bridge.warmHistoryWorkspace(target, { intent });
}
