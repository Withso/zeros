import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import {
  workspaceRunInfo,
  type Workspace,
  type WorkspaceRunActionStatus,
} from "../../platform/git";
import { useBridge } from "../../platform/bridge/use-bridge";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";

type Listener = () => void;
type RunActivityTarget = Pick<Workspace, "id" | "path">;

// Only live folders are retained, and the bound prevents abandoned engine
// events from growing this cross-surface signal forever.
const MAX_RUNNING_FOLDERS = 64;
const RUN_ACTIVITY_MAX_AGE_MS = 2_000;
const runningFolders = new Map<string, true>();
const listenersByFolder = new Map<string, Set<Listener>>();
const runActivitySnapshotCache = new KeyedAsyncCache<boolean>(
  MAX_RUNNING_FOLDERS,
);

function commitRunActivity(folderKey: string, running: boolean): void {
  const wasRunning = runningFolders.has(folderKey);
  if (wasRunning === running) return;

  if (running) {
    runningFolders.delete(folderKey);
    runningFolders.set(folderKey, true);
    while (runningFolders.size > MAX_RUNNING_FOLDERS) {
      let removable: string | undefined;
      for (const key of runningFolders.keys()) {
        if (key !== folderKey && !listenersByFolder.has(key)) {
          removable = key;
          break;
        }
      }
      if (!removable) break;
      runningFolders.delete(removable);
    }
  } else {
    runningFolders.delete(folderKey);
  }

  for (const listener of listenersByFolder.get(folderKey) ?? []) listener();
}

export function publishRunActivity(folderKey: string, running: boolean): void {
  if (!folderKey) return;
  // Even a same-value publication is authoritative: it must advance the
  // generation so an older background response cannot overwrite live state.
  runActivitySnapshotCache.setData(folderKey, running);
  commitRunActivity(folderKey, running);
}

export function getRunActivitySnapshot(folderKey: string): boolean {
  return !!folderKey && runningFolders.has(folderKey);
}

export function invalidateRunActivitySnapshot(folderKey: string): void {
  if (folderKey) runActivitySnapshotCache.invalidate(folderKey);
}

/** Reconcile one exact workspace folder without allowing an older response to
 * overwrite a newer run transition. Confirmed activity stays visible while a
 * replacement read is in flight. */
export async function refreshRunActivitySnapshot(
  folderKey: string,
  fetcher: () => Promise<boolean>,
): Promise<void> {
  if (!folderKey) return;
  const resolved = await runActivitySnapshotCache.load(folderKey, fetcher, {
    maxAgeMs: RUN_ACTIVITY_MAX_AGE_MS,
  });
  const snapshot = runActivitySnapshotCache.peekSnapshot(folderKey);
  // A request invalidated while in flight still resolves to its original
  // caller, but KeyedAsyncCache refuses to publish it. Mirror only the value
  // that actually won the exact-key generation.
  if (snapshot.data === resolved) commitRunActivity(folderKey, resolved);
}

export function useAnyRunActionRunning(folderKey: string): boolean {
  const subscribe = useCallback(
    (listener: Listener) => {
      if (!folderKey) return () => {};
      const listeners = listenersByFolder.get(folderKey) ?? new Set<Listener>();
      listeners.add(listener);
      listenersByFolder.set(folderKey, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) listenersByFolder.delete(folderKey);
      };
    },
    [folderKey],
  );
  const getSnapshot = useCallback(
    () => getRunActivitySnapshot(folderKey),
    [folderKey],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

function hasRunningAction(
  actions: Record<string, WorkspaceRunActionStatus>,
): boolean {
  return Object.values(actions).some((status) => status.state === "running");
}

/** Keep every visible workspace tab's exact run signal current. This owns one
 * bridge listener for the whole strip; DB_CHANGED workspace ids refresh only
 * their matching keys, including tabs that are not currently active. */
export function useWorkspaceRunActivitySync(
  workspaces: readonly RunActivityTarget[],
): void {
  const bridge = useBridge();
  const targetsRef = useRef<RunActivityTarget[]>([]);
  targetsRef.current = workspaces.map(({ id, path }) => ({ id, path }));
  const targetsKey = JSON.stringify(
    workspaces.map(({ id, path }) => [id, path]),
  );

  useEffect(() => {
    const refresh = (target: RunActivityTarget) => {
      void refreshRunActivitySnapshot(target.path, async () => {
        const result = await workspaceRunInfo({
          workspaceId: target.id,
          sessionIds: [],
        });
        return hasRunningAction(result.actions);
      }).catch(() => {
        // A transient bridge failure must retain the last confirmed signal.
      });
    };

    for (const target of targetsRef.current) refresh(target);

    const off = bridge?.on("DB_CHANGED", (message) => {
      const change = message as { kinds?: unknown; workspaceIds?: unknown };
      if (
        !Array.isArray(change.kinds) ||
        !change.kinds.includes("workspaces")
      ) {
        return;
      }
      const changedIds = Array.isArray(change.workspaceIds)
        ? new Set(
            change.workspaceIds.filter(
              (id): id is string => typeof id === "string",
            ),
          )
        : new Set<string>();

      for (const target of targetsRef.current) {
        if (changedIds.size > 0 && !changedIds.has(target.id)) continue;
        invalidateRunActivitySnapshot(target.path);
        refresh(target);
      }
    });

    return () => off?.();
  }, [bridge, targetsKey]);
}
