// ──────────────────────────────────────────────────────────
// Latest-generation in-flight coordinator
// ──────────────────────────────────────────────────────────
//
// Refresh signals may arrive faster than a bridge/Git read can finish. Starting
// one subprocess per signal creates a positive feedback loop under load: old
// reads compete with the one result the UI can still publish. This coordinator
// keeps exact keys independent while bounding each key to:
//
//   • one running request, and
//   • one queued request representing the newest requested generation.
//
// It intentionally retains no settled payload. The feature's exact-key snapshot
// cache remains the owner of usable data; this class owns only in-flight work.

interface RunningRequest<T> {
  readonly generation: number;
  readonly promise: Promise<T>;
}

interface QueuedRequest<T> {
  generation: number;
  fetcher: () => Promise<T>;
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

interface FlightEntry<T> {
  running: RunningRequest<T>;
  queued?: QueuedRequest<T>;
}

export class LatestGenerationFlight<T> {
  private readonly entries = new Map<string, FlightEntry<T>>();

  /** Run the newest read for one semantic key. Generations must come from a
   * monotonic invalidation clock (the renderer Git refresh bus does). */
  public run(
    key: string,
    generation: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const existing = this.entries.get(key);
    if (!existing) {
      const entry = {} as FlightEntry<T>;
      const promise = this.start(key, entry, generation, fetcher);
      this.entries.set(key, entry);
      return promise;
    }

    // An older/same-generation caller can consume the already-newer result. It
    // must never replace a queued current generation with stale work.
    if (generation <= existing.running.generation && !existing.queued) {
      return existing.running.promise;
    }
    if (existing.queued) {
      if (generation > existing.queued.generation) {
        existing.queued.generation = generation;
        existing.queued.fetcher = fetcher;
      }
      return existing.queued.promise;
    }
    if (generation <= existing.running.generation) {
      return existing.running.promise;
    }

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    existing.queued = { generation, fetcher, promise, resolve, reject };
    return promise;
  }

  private start(
    key: string,
    entry: FlightEntry<T>,
    generation: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const promise = Promise.resolve().then(fetcher);
    entry.running = { generation, promise };
    void promise.then(
      () => this.advance(key, entry, promise),
      () => this.advance(key, entry, promise),
    );
    return promise;
  }

  private advance(
    key: string,
    entry: FlightEntry<T>,
    settled: Promise<T>,
  ): void {
    if (entry.running.promise !== settled) return;
    const queued = entry.queued;
    if (!queued) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      return;
    }

    entry.queued = undefined;
    const successor = this.start(key, entry, queued.generation, queued.fetcher);
    void successor.then(queued.resolve, queued.reject);
  }
}
