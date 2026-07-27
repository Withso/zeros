// ──────────────────────────────────────────────────────────
// Keyed async snapshot cache
// ──────────────────────────────────────────────────────────
//
// Bridge reads are server state: several renderer surfaces can ask for the
// same key, and switching a surface must not turn a previously resolved value
// back into an empty loading state. This small cache gives those reads the same
// semantics throughout the app:
//
//   • one immutable snapshot per key (safe for useSyncExternalStore),
//   • one in-flight request per key,
//   • stale-while-revalidate (resolved data stays visible during refresh),
//   • generation guards so an old request cannot overwrite an optimistic write,
//   • bounded retention for keys that no longer have subscribers.
//
// It deliberately owns no React hooks and no transport. Feature hooks choose
// their key, fetcher, freshness window, and invalidation events.
// ──────────────────────────────────────────────────────────

export interface AsyncCacheSnapshot<T> {
  /** Last successfully resolved value; undefined only before the first success. */
  data: T | undefined;
  /** Initial load is blocking only when no usable snapshot exists yet. */
  loading: boolean;
  /** Background refresh never replaces already-rendered data with a fallback. */
  refreshing: boolean;
  /** The most recent read failure; cached data remains available when present. */
  error: Error | null;
  /** Completion time of the last successful read or optimistic write. */
  updatedAt: number;
  /** Advances only on explicit invalidation. React consumers key background
   * revalidation to this—not to load/error snapshots, which avoids retry loops. */
  invalidationVersion: number;
}

interface CacheEntry<T> {
  snapshot: AsyncCacheSnapshot<T>;
  listeners: Set<() => void>;
  /** Invalidations make the next non-forced load bypass its freshness window. */
  stale: boolean;
  /** Monotonic token rejects responses that began before a newer mutation. */
  generation: number;
  /** Recency is used only to evict inactive entries when the bound is reached. */
  accessOrder: number;
}

interface PendingRequest<T> {
  generation: number;
  promise: Promise<T>;
}

export interface AsyncCacheLoadOptions {
  /** Bypass freshness, while retaining the current value during the request. */
  force?: boolean;
  /** Skip a non-forced request while a successful snapshot is this fresh. */
  maxAgeMs?: number;
}

const INITIAL_SNAPSHOT: AsyncCacheSnapshot<never> = Object.freeze({
  data: undefined,
  loading: true,
  refreshing: false,
  error: null,
  updatedAt: 0,
  invalidationVersion: 0,
});

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class KeyedAsyncCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly pending = new Map<string, PendingRequest<T>>();
  private readonly queuedRefreshes = new Map<string, Promise<T>>();
  /** A logical clock keeps LRU order deterministic inside one millisecond. */
  private accessOrder = 0;

  public constructor(private readonly maxEntries = 64) {}

  /** Return the stable snapshot for `key`, creating its initial record once. */
  public getSnapshot = (key: string): AsyncCacheSnapshot<T> => {
    return this.getOrCreate(key).snapshot;
  };

  /** Read `key`'s snapshot WITHOUT creating/retaining an entry or touching LRU
   *  order. Safe to call during render across many keys (the cross-repo live
   *  union iterates every repo slug each render); getSnapshot's getOrCreate
   *  would mutate accessOrder and could evict the active key at the bound.
   *  Returns the shared INITIAL_SNAPSHOT for a key with no record yet. */
  public peekSnapshot = (key: string): AsyncCacheSnapshot<T> => {
    return (
      this.entries.get(key)?.snapshot ??
      (INITIAL_SNAPSHOT as AsyncCacheSnapshot<T>)
    );
  };

  /** Subscribe to one key so unrelated cache writes cannot re-render a caller. */
  public subscribe = (key: string, listener: () => void): (() => void) => {
    const entry = this.getOrCreate(key);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      this.pruneInactiveEntries();
    };
  };

  /** Read or refresh a key. Concurrent callers share the same request. */
  public load(
    key: string,
    fetcher: () => Promise<T>,
    options: AsyncCacheLoadOptions = {},
  ): Promise<T> {
    const entry = this.getOrCreate(key);
    const current = this.pending.get(key);
    if (current) {
      // A concurrent caller shares the active generation. Only an explicit
      // invalidation that landed *after* that generation began warrants a
      // follow-up read; this prevents N mounted subscribers from turning one
      // broadcast into two requests merely because each asked to refresh.
      if (!entry.stale) return current.promise;
      const queued = this.queuedRefreshes.get(key);
      if (queued) return queued;
      // Run exactly one follow-up after the current request settles so
      // deduplication cannot swallow a DB/file invalidation. If an
      // authoritative write clears `stale` in the meantime, keep that value
      // and cancel the queued network/bridge work.
      const followUp = current.promise
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          // Release this queue slot *before* starting the follow-up. A second
          // invalidation that lands during that request can then queue the next
          // generation instead of being swallowed by this outer promise.
          if (this.queuedRefreshes.get(key) === followUp) {
            this.queuedRefreshes.delete(key);
          }
          const replacement = this.pending.get(key);
          if (replacement && replacement !== current) {
            return replacement.promise;
          }
          if (!entry.stale) {
            if (entry.snapshot.data !== undefined) return entry.snapshot.data;
            throw entry.snapshot.error ?? new Error("Cache refresh cancelled");
          }
          return this.load(key, fetcher, { ...options, force: true });
        })
        .finally(() => {
          if (this.queuedRefreshes.get(key) === followUp) {
            this.queuedRefreshes.delete(key);
          }
        });
      this.queuedRefreshes.set(key, followUp);
      return followUp;
    }

    const maxAgeMs = options.maxAgeMs ?? 0;
    const fresh =
      entry.snapshot.data !== undefined &&
      !entry.stale &&
      Date.now() - entry.snapshot.updatedAt <= maxAgeMs;
    if (!options.force && fresh) {
      return Promise.resolve(entry.snapshot.data as T);
    }

    const generation = ++entry.generation;
    entry.stale = false;
    const pendingSnapshot: AsyncCacheSnapshot<T> = {
      ...entry.snapshot,
      loading: entry.snapshot.data === undefined,
      refreshing: entry.snapshot.data !== undefined,
      error: null,
    };

    const promise = Promise.resolve()
      .then(fetcher)
      .then((data) => {
        if (entry.generation === generation) {
          this.replaceSnapshot(key, entry, {
            data,
            loading: false,
            refreshing: false,
            error: null,
            updatedAt: Date.now(),
            invalidationVersion: entry.snapshot.invalidationVersion,
          });
        }
        return data;
      })
      .catch((error: unknown) => {
        if (entry.generation === generation) {
          this.replaceSnapshot(key, entry, {
            ...entry.snapshot,
            loading: false,
            refreshing: false,
            error: asError(error),
          });
        }
        throw error;
      })
      .finally(() => {
        const active = this.pending.get(key);
        if (active?.generation === generation) {
          this.pending.delete(key);
          // A burst can temporarily exceed the retention bound while every
          // candidate is request-owned. Return to the hard bound as soon as a
          // request releases ownership, even if no later cache call occurs.
          this.pruneInactiveEntries();
        }
      });

    // Establish request ownership before publishing. replaceSnapshot may prune
    // an inactive key at the retention bound or synchronously wake a subscriber
    // that calls load again; both paths must observe this generation as pending.
    this.pending.set(key, { generation, promise });
    this.replaceSnapshot(key, entry, pendingSnapshot);
    return promise;
  }

  /** Publish an authoritative local value and supersede older async reads. */
  public setData(key: string, data: T): void {
    const entry = this.getOrCreate(key);
    entry.generation += 1;
    entry.stale = false;
    this.pending.delete(key);
    this.replaceSnapshot(key, entry, {
      data,
      loading: false,
      refreshing: false,
      error: null,
      updatedAt: Date.now(),
      invalidationVersion: entry.snapshot.invalidationVersion,
    });
  }

  /** Surface an unavailable transport without discarding a resolved snapshot. */
  public setError(key: string, error: unknown): void {
    const entry = this.getOrCreate(key);
    entry.generation += 1;
    entry.stale = false;
    this.pending.delete(key);
    this.replaceSnapshot(key, entry, {
      ...entry.snapshot,
      loading: false,
      refreshing: false,
      error: asError(error),
    });
  }

  /** Make a key stale without clearing its usable value. */
  public invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.stale = true;
      // A response that began before this invalidation is not authoritative.
      // It may resolve for its original caller, but it must never be published.
      entry.generation += 1;
      // Publish a new snapshot identity even though the usable data is
      // unchanged. Mounted useCachedRead consumers use this notification to
      // begin their silent replacement read; closed surfaces remain inert.
      this.replaceSnapshot(key, entry, {
        ...entry.snapshot,
        invalidationVersion: entry.snapshot.invalidationVersion + 1,
      });
    }
  }

  /** Make every retained key stale without forcing inactive work immediately. */
  public invalidateAll(): void {
    for (const [key, entry] of this.entries) {
      entry.stale = true;
      entry.generation += 1;
      this.replaceSnapshot(key, entry, {
        ...entry.snapshot,
        invalidationVersion: entry.snapshot.invalidationVersion + 1,
      });
    }
  }

  /** Exposed for scoped invalidation and intentional background prefetch. */
  public keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Drop every retained snapshot. Intended for deterministic test isolation;
   * production invalidation should preserve usable data via invalidate(All). */
  public clear(): void {
    this.entries.clear();
    this.pending.clear();
    this.queuedRefreshes.clear();
    this.accessOrder = 0;
  }

  private getOrCreate(key: string): CacheEntry<T> {
    const existing = this.entries.get(key);
    if (existing) {
      existing.accessOrder = ++this.accessOrder;
      return existing;
    }
    const entry: CacheEntry<T> = {
      snapshot: INITIAL_SNAPSHOT as AsyncCacheSnapshot<T>,
      listeners: new Set(),
      stale: true,
      generation: 0,
      accessOrder: ++this.accessOrder,
    };
    this.entries.set(key, entry);
    // The caller may be about to subscribe or start a request. Never evict the
    // just-created handshake entry before it can establish that ownership.
    this.pruneInactiveEntries(key);
    return entry;
  }

  private replaceSnapshot(
    key: string,
    entry: CacheEntry<T>,
    snapshot: AsyncCacheSnapshot<T>,
  ): void {
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) {
      try {
        listener();
      } catch {
        // One renderer subscriber must never prevent the remaining fan-out.
      }
    }
    // Keep the key alive while a request or subscriber owns it; otherwise the
    // bounded cache can discard the oldest inactive snapshot after this write.
    if (!this.pending.has(key)) this.pruneInactiveEntries();
  }

  private pruneInactiveEntries(protectedKey?: string): void {
    if (this.entries.size <= this.maxEntries) return;
    const candidates = [...this.entries.entries()]
      .filter(
        ([key, entry]) =>
          key !== protectedKey &&
          entry.listeners.size === 0 &&
          !this.pending.has(key),
      )
      .sort((a, b) => a[1].accessOrder - b[1].accessOrder);
    while (this.entries.size > this.maxEntries && candidates.length > 0) {
      const [key, entry] = candidates.shift() as [string, CacheEntry<T>];
      // A newer request may settle first. Do not evict that newer snapshot just
      // because the true LRU key is temporarily request-owned; its completion
      // will run pruning again. Subscribers are different: they are retained
      // indefinitely, so an inactive candidate may still be discarded.
      const olderRequestPending = [...this.pending.entries()].some(
        ([pendingKey]) => {
          const pendingEntry = this.entries.get(pendingKey);
          return pendingEntry && pendingEntry.accessOrder < entry.accessOrder;
        },
      );
      if (olderRequestPending) break;
      this.entries.delete(key);
    }
  }
}
