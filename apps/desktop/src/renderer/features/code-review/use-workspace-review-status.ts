import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { StatusResult } from "@/renderer/platform/git";
import {
  KeyedAsyncCache,
  type AsyncCacheSnapshot,
} from "@/renderer/shared/lib/keyed-async-cache";
import {
  beginReviewCacheRequest,
  registerReviewCacheForget,
} from "./review-cache-forget";

type ReadReviewStatus = (
  workspaceId: string,
  refreshKey: number,
  cwd: string,
) => Promise<StatusResult>;
const IDLE: AsyncCacheSnapshot<StatusResult> = Object.freeze({
  data: undefined,
  loading: false,
  refreshing: false,
  error: null,
  updatedAt: 0,
  invalidationVersion: 0,
});

/** File viewers consume one aggregate per owner and join the Changes status
 * generation, retaining confirmed conflict metadata during revalidation. */
export class WorkspaceReviewStatusStore {
  readonly cache = new KeyedAsyncCache<StatusResult>(64);
  private readonly generations = new Map<string, number>();

  load(
    key: string,
    workspaceId: string,
    generation: number,
    read: ReadReviewStatus,
  ): Promise<StatusResult> {
    const [cwd] = JSON.parse(key) as [string, string];
    const request = beginReviewCacheRequest(cwd);
    const previous = this.generations.get(key);
    if (previous === undefined || generation > previous) {
      this.generations.set(key, generation);
      this.cache.invalidate(key);
    }
    return this.cache
      .load(
        key,
        () => {
          request.assertCurrent();
          return read(
            workspaceId,
            this.generations.get(key) ?? generation,
            cwd,
          );
        },
        { maxAgeMs: 15_000 },
      )
      .finally(() => {
        request.finish();
        const retained = new Set(this.cache.keys());
        for (const owner of this.generations.keys())
          if (!retained.has(owner)) this.generations.delete(owner);
      });
  }

  forgetForFolders(ownsFolder: (folder: string) => boolean): void {
    for (const key of new Set([
      ...this.cache.keys(),
      ...this.generations.keys(),
    ])) {
      const [cwd] = JSON.parse(key) as [string, string];
      if (!ownsFolder(cwd)) continue;
      this.generations.delete(key);
      this.cache.forget(key);
    }
  }
}

const store = new WorkspaceReviewStatusStore();
export { store as workspaceReviewStatusStore };
registerReviewCacheForget((ownsFolder) => store.forgetForFolders(ownsFolder));
export function useWorkspaceReviewStatus({
  cwd,
  workspaceId,
  active,
  refreshKey,
  read,
}: {
  cwd: string | undefined;
  workspaceId: string | null | undefined;
  active: boolean;
  refreshKey: number;
  read: ReadReviewStatus;
}): AsyncCacheSnapshot<StatusResult> {
  const key =
    cwd && workspaceId
      ? JSON.stringify([cwd.replace(/\/+$/, "") || "/", workspaceId])
      : null;
  const subscribe = useCallback(
    (listener: () => void) =>
      key ? store.cache.subscribe(key, listener) : () => {},
    [key],
  );
  const getSnapshot = useCallback(
    () => (key ? store.cache.getSnapshot(key) : IDLE),
    [key],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (active && key && workspaceId)
      void store.load(key, workspaceId, refreshKey, read).catch(() => {});
  }, [
    active,
    key,
    workspaceId,
    refreshKey,
    read,
    snapshot.invalidationVersion,
  ]);
  return snapshot;
}
