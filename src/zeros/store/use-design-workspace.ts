// React binding for the shared design-workspace aggregate snapshot.

import { useEffect } from "react";

import { useGitRefreshKey } from "../../shell/use-git-refresh-key";
import { useCachedRead } from "./use-cached-read";
import {
  applyDesignWorkspaceRefreshVersion,
  DESIGN_SNAPSHOT_MAX_AGE_MS,
  designWorkspaceSnapshotCache,
  fetchDesignWorkspaceSnapshot,
} from "./design-workspace-cache";

export function useDesignWorkspaceSnapshot(
  workspaceId: string | null | undefined,
  workspacePath: string | null | undefined,
  active = true,
) {
  const refreshVersion = useGitRefreshKey(workspacePath, workspaceId, active);

  useEffect(() => {
    if (!workspaceId) return;
    applyDesignWorkspaceRefreshVersion(workspaceId, refreshVersion);
  }, [refreshVersion, workspaceId]);

  return useCachedRead(
    designWorkspaceSnapshotCache,
    workspaceId ?? null,
    fetchDesignWorkspaceSnapshot,
    { maxAgeMs: DESIGN_SNAPSHOT_MAX_AGE_MS, enabled: active },
  );
}
