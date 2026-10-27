import { useLayoutEffect, useMemo } from "react";
import { designFramePreparation, designWorkspaceSnapshotCache } from "./design-workspace-cache";

export function useDesignFramePreparation(workspaceId: string | null, files: readonly string[], active: boolean, epoch?: number) {
  const token = useMemo(() => ({ workspaceId }), [workspaceId]);
  const membership = JSON.stringify(files);
  useLayoutEffect(() => {
    if (!active || !workspaceId) return;
    // A same-epoch revalidation can pause a batch without changing any of the
    // demand dependencies below. Resume on the exact owner's read completion;
    // the coordinator still fences pending reads, edits and stale replies.
    return designWorkspaceSnapshotCache.subscribe(workspaceId, () => designFramePreparation.resume());
  }, [active, workspaceId]);
  useLayoutEffect(() => {
    designFramePreparation.setDemand(token, active && workspaceId ? { workspaceId, files: JSON.parse(membership) as string[] } : null);
  }, [workspaceId, active, token, membership, epoch]);
  useLayoutEffect(() => () => designFramePreparation.setDemand(token, null), [token]);
}
