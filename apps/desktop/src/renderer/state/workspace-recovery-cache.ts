import { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";
import {
  workspaceRecoveryInfo,
  type Workspace,
  type WorkspaceRecoveryInfo,
} from "../platform/git";

export const workspaceRecoveryCache =
  new KeyedAsyncCache<WorkspaceRecoveryInfo>(64);
export const RECOVERY_MAX_AGE_MS = 30_000;

export function workspaceRecoveryKey(workspace: Workspace): string | null {
  return workspace.archivedAt == null && workspace.present === false
    ? JSON.stringify([
        workspace.id,
        workspace.path,
        workspace.repoRoot,
        workspace.archiveSnapshot ?? null,
      ])
    : null;
}

export function readWorkspaceRecovery(
  key: string,
): Promise<WorkspaceRecoveryInfo> {
  const [workspaceId] = JSON.parse(key) as [string];
  return workspaceRecoveryInfo(workspaceId);
}

export function prefetchWorkspaceRecovery(workspace: Workspace): void {
  const key = workspaceRecoveryKey(workspace);
  if (key)
    void workspaceRecoveryCache
      .load(key, () => readWorkspaceRecovery(key), {
        maxAgeMs: RECOVERY_MAX_AGE_MS,
      })
      .catch(() => {});
}
