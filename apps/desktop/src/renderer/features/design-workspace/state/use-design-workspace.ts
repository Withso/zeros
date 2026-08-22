// React binding for the shared design-workspace aggregate snapshot.

import { useEffect } from "react";

import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";
import { useGitRefreshKey } from "../../../shell/use-git-refresh-key";
import {
  useCachedRead,
  type CachedRead,
} from "../../../state/use-cached-read";
import {
  applyDesignWorkspaceRefreshVersion,
  DESIGN_SNAPSHOT_MAX_AGE_MS,
  designWorkspaceSnapshotCache,
  fetchDesignWorkspaceSnapshot,
} from "./design-workspace-cache";
import { designWorkspaceSnapshotMatchesPath } from "./design-workspace-boot-cache";

/** A persisted snapshot belongs to its confirmed checkout path as well as the
 * stable workspace id. Hide a moved workspace's old pixels, while preserving
 * the replacement read's failure so recovery never degenerates into an
 * endless loading state. */
export function presentDesignWorkspaceSnapshotRead(
  read: CachedRead<DesignWorkspaceSnapshotWire>,
  workspacePath: string | null | undefined,
  active: boolean,
): CachedRead<DesignWorkspaceSnapshotWire> {
  if (designWorkspaceSnapshotMatchesPath(read.data, workspacePath)) return read;
  return {
    ...read,
    data: undefined,
    loading: active && read.error === null,
    refreshing: false,
  };
}

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

  const cached = workspaceId
    ? designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data
    : undefined;
  const exactPath = designWorkspaceSnapshotMatchesPath(cached, workspacePath);
  const read = useCachedRead(
    designWorkspaceSnapshotCache,
    workspaceId ?? null,
    fetchDesignWorkspaceSnapshot,
    {
      // A restored workspace may keep its id while moving to an adapted path.
      // Force that mismatched preview's exact-key replacement immediately.
      maxAgeMs: exactPath ? DESIGN_SNAPSHOT_MAX_AGE_MS : -1,
      enabled: active,
    },
  );
  return presentDesignWorkspaceSnapshotRead(read, workspacePath, active);
}
