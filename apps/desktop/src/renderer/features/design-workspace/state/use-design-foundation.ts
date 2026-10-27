// React binding for one exact authored Design Foundation generation.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  designFoundationCache,
  designFoundationKey,
  fetchDesignFoundation,
} from "./design-workspace-cache";

/** Consumers read only the exact-key document, so they subscribe to it alone:
 * the cache's loading/refreshing flags would otherwise re-render the canvas,
 * inspector and theme editor on every selection of an unread frame. */
export function useDesignFoundation(
  workspaceId: string | null | undefined,
  frame: string | null | undefined,
  sourceVersion: string | null | undefined,
  active = true,
) {
  const key =
    workspaceId && frame && sourceVersion
      ? designFoundationKey(workspaceId, frame, sourceVersion)
      : null;
  const subscribe = useCallback(
    (listener: () => void) =>
      key === null || !active
        ? () => {}
        : designFoundationCache.subscribe(key, listener),
    [active, key],
  );
  const readData = useCallback(
    () => (key === null ? undefined : designFoundationCache.getSnapshot(key).data),
    [key],
  );
  const readInvalidation = useCallback(
    () => (key === null ? 0 : designFoundationCache.getSnapshot(key).invalidationVersion),
    [key],
  );
  const data = useSyncExternalStore(subscribe, readData, readData);
  const invalidationVersion = useSyncExternalStore(subscribe, readInvalidation, readInvalidation);
  useEffect(() => {
    if (key === null || !active) return;
    // The renderer source generation is part of the key. An exact-key result
    // remains valid indefinitely; code/Git edits produce a different key.
    void designFoundationCache
      .load(key, () => fetchDesignFoundation(key), { maxAgeMs: Number.POSITIVE_INFINITY })
      .catch(() => {
        // The cache keeps the error; consumers retry through their next edit.
      });
  }, [active, invalidationVersion, key]);
  return { data };
}
