import { useMemo, useRef } from "react";
import type { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";
import { useCachedRead } from "./use-cached-read";
import { useDocumentActive } from "./use-document-active";
import { useReadRecovery } from "./use-read-recovery";

const namespaces = new WeakMap<object, number>();
let nextNamespace = 0;

/** Passive reads outside a WorkbenchTabFrame. Keep exact-key content, recover
 * once before publishing a failure, and stop observing while hidden. Writes
 * and explicit action outcomes continue to report their own failures. */
export function useRecoveringRead<T>(
  cache: KeyedAsyncCache<T>,
  key: string | null,
  fetcher: (key: string) => Promise<T>,
  options: {
    maxAgeMs?: number;
    enabled?: boolean;
    connected?: boolean;
    folder?: string;
    /** A bounded retry may bypass a read adapter's own failure backoff. It
     * must derive request identity from its key, like the ordinary fetcher. */
    retryFetcher?: (key: string) => Promise<T>;
  } = {},
) {
  const { connected = true, folder, retryFetcher } = options;
  const active = useDocumentActive(options.enabled !== false);
  const namespace = useMemo(() => {
    let id = namespaces.get(cache);
    if (id === undefined) { id = ++nextNamespace; namespaces.set(cache, id); }
    return id;
  }, [cache]);
  const read = useCachedRead(cache, key, fetcher, { maxAgeMs: options.maxAgeMs, enabled: active && connected });
  const retryRef = useRef(retryFetcher);
  retryRef.current = retryFetcher;
  const recovery = useReadRecovery(JSON.stringify([namespace, key]), {
    error: read.error,
    pending: read.loading || read.refreshing,
    hasContent: read.data !== undefined,
    connected,
    active: active && key !== null,
    folder,
    retry: () => key !== null && retryRef.current
      ? cache.load(key, () => retryRef.current!(key), { force: true })
      : read.refresh(),
  });
  return {
    ...read,
    error: recovery.error,
    // Keep unknown distinct from an empty successful result during recovery.
    loading: key !== null && read.data === undefined &&
      (!connected || recovery.pending || !!read.error && !recovery.error),
    // Read safety (e.g. enabling a mutation) must not rely on presentation.
    readError: recovery.readError,
  };
}
