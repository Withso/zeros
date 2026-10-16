import { parseCloudWorkspaceKey, type CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";
import type { CloudWorkspaceWakeIntent } from "./cloud-workspace-wake";

type OpenListener = (target: CloudWorkspaceTarget, wakeIntent: CloudWorkspaceWakeIntent) => void;
const listeners = new Set<OpenListener>();

/** Ephemeral user intent, deliberately separate from persisted selection and
 * metadata warming. Restoring a tab or polling its catalog never emits it. */
export function requestCloudWorkspaceOpen(folder: string): void {
  const target = parseCloudWorkspaceKey(folder);
  if (!target) return;
  const wakeIntent = { id: crypto.randomUUID() };
  for (const listener of listeners) listener({ organizationId: target.organizationId, workspaceId: target.workspaceId }, wakeIntent);
}

export function subscribeCloudWorkspaceOpens(listener: OpenListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
