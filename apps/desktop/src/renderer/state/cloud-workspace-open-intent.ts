import { parseCloudWorkspaceKey, type CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";

const listeners = new Set<(target: CloudWorkspaceTarget) => void>();

/** Ephemeral user intent, deliberately separate from persisted selection and
 * metadata warming. Restoring a tab or polling its catalog never emits it. */
export function requestCloudWorkspaceOpen(folder: string): void {
  const target = parseCloudWorkspaceKey(folder);
  if (target) for (const listener of listeners) listener({ organizationId: target.organizationId, workspaceId: target.workspaceId });
}

export function subscribeCloudWorkspaceOpens(listener: (target: CloudWorkspaceTarget) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
