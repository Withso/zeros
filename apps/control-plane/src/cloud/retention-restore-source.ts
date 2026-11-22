// Retention (CLOUD_V2_RETENTION_ENABLED): which machine a lost workspace's restore forks.
import type { CloudV2ReadyCopies } from "./ready-copies.js";
import type { CloudV2LifecycleWorkspace } from "./store.js";

/** The stopped machine of the workspace's project's ready copy, only when that
 * copy is laid out exactly as the workspace is: the same repositories in the same
 * folders. Anything else creates from the Cloud Computer, as before. */
export function readyCopyRestoreSource(copies: Pick<CloudV2ReadyCopies, "forkable" | "workspaceLayout">, now: () => Date = () => new Date()) {
  return async (workspace: Pick<CloudV2LifecycleWorkspace, "id" | "organizationId" | "projectId">): Promise<string | null> => {
    if (!workspace.projectId) return null;
    const ready = await copies.forkable(workspace.organizationId, workspace.projectId, now());
    if (!ready?.machineId || !ready.result) return null;
    const layout = await copies.workspaceLayout(workspace.id);
    return JSON.stringify(ready.result.map(entry => [entry.repositoryId, entry.checkoutFolder ?? null])) === JSON.stringify(layout) ? ready.machineId : null;
  };
}
