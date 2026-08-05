// ──────────────────────────────────────────────────────────
// useCachedRead — mount a KeyedAsyncCache key as server state
// ──────────────────────────────────────────────────────────
//
// The standard cure for the "clear-then-fetch" dropdown: a surface that opens
// (or mounts) reads its key's snapshot synchronously — previously loaded rows
// paint immediately — and a background load runs only when the snapshot is
// older than `maxAgeMs` (or absent). `loading` is true only before the FIRST
// value for a key; revalidation reports `refreshing` while the stale rows stay
// on screen. See docs/ui-interaction-performance.md.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import {
  type AsyncCacheSnapshot,
  type KeyedAsyncCache,
} from "../shared/lib/keyed-async-cache";

/** Snapshot served while `key` is null (surface closed / not applicable). */
const IDLE_SNAPSHOT: AsyncCacheSnapshot<never> = Object.freeze({
  data: undefined,
  loading: false,
  refreshing: false,
  error: null,
  updatedAt: 0,
  invalidationVersion: 0,
});

export interface CachedRead<T> extends AsyncCacheSnapshot<T> {
  /** Force a bypass-freshness reload; current data stays visible meanwhile. */
  refresh: () => void;
}

/** Subscribe to `cache[key]`, loading it when stale. Pass `key: null` to make
 *  the read inert (e.g. while a popover is closed) — the last snapshot is
 *  still served instantly on the next open. The fetcher is captured in a ref,
 *  so an inline closure is fine; it is only invoked for genuine loads.
 *
 *  It is handed the KEY it is loading. Most callers ignore it — their request
 *  is fixed for the component's lifetime — but the cache can invoke a fetcher
 *  well after it was handed over (a queued follow-up runs only once the
 *  in-flight request settles), and by then the ref holds the LATEST render's
 *  closure. A caller whose request parameters vary with the key must derive
 *  them from this argument, or one key's data lands under another's. */
export function useCachedRead<T>(
  cache: KeyedAsyncCache<T>,
  key: string | null,
  fetcher: (key: string) => Promise<T>,
  options: { maxAgeMs?: number; enabled?: boolean } = {},
): CachedRead<T> {
  const { maxAgeMs, enabled = true } = options;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const subscribe = useCallback(
    (listener: () => void) =>
      key === null || !enabled ? () => {} : cache.subscribe(key, listener),
    [cache, enabled, key],
  );
  const getSnapshot = useCallback(
    () =>
      key === null
        ? (IDLE_SNAPSHOT as AsyncCacheSnapshot<T>)
        : cache.getSnapshot(key),
    [cache, key],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (key === null || !enabled) return;
    void cache
      .load(key, () => fetcherRef.current(key), { maxAgeMs })
      .catch(() => {
        // The snapshot carries the error; cached data stays available.
      });
    // Invalidations keep confirmed data intact and advance only this version,
    // making an OPEN surface revalidate immediately. Load/error snapshots do
    // not retrigger the effect, so an offline fetch cannot spin in a retry loop.
  }, [cache, enabled, key, maxAgeMs, snapshot.invalidationVersion]);

  const refresh = useCallback(() => {
    if (key === null || !enabled) return;
    void cache
      .load(key, () => fetcherRef.current(key), { force: true })
      .catch(() => {});
  }, [cache, enabled, key]);

  return { ...snapshot, refresh };
}
