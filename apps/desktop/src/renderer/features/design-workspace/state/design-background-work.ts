interface BackgroundTask {
  key: string;
  latest: boolean;
  run: () => Promise<void>;
  cancel: () => void;
}

/** Optional document audits and raster captures share one bounded lane. Input
 * always wins; queued work is replaced by its newest exact owner request. */
export class DesignBackgroundWorkQueue {
  private pending = new Map<string, BackgroundTask>();
  private running: BackgroundTask | null = null;
  private active = 0;
  private quietUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelIdle: (() => void) | null = null;
  private generation = 0;

  constructor(
    private readonly limit = 32,
    private readonly quietMs = 150,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) {
      throw new RangeError(
        "Design background queue limit must be 1 through 32.",
      );
    }
    if (!Number.isFinite(quietMs) || quietMs < 0 || quietMs > 60_000) {
      throw new RangeError("Design background quiet period is invalid.");
    }
  }

  touch(): void {
    this.quietUntil = Date.now() + this.quietMs;
  }

  pause(): () => void {
    this.active++;
    const generation = this.generation;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (generation !== this.generation) return;
      this.active = Math.max(0, this.active - 1);
      this.touch();
      this.pump();
    };
  }

  schedule<T>(
    key: string,
    work: () => Promise<T>,
    options: { latest?: boolean } = {},
  ): Promise<T | null> {
    return new Promise((resolve, reject) => {
      if (
        this.running?.key === key &&
        this.running.latest &&
        options.latest === true
      )
        this.running.cancel();
      this.pending.get(key)?.cancel();
      this.pending.delete(key);
      let retired = false;
      this.pending.set(key, {
        key,
        latest: options.latest === true,
        run: async () => {
          try {
            const result = await work();
            if (!retired) resolve(result);
          } catch (error) {
            if (!retired) reject(error);
          }
        },
        cancel: () => {
          if (retired) return;
          retired = true;
          resolve(null);
        },
      });
      while (this.pending.size > this.limit) {
        const oldest = this.pending.keys().next().value!;
        this.pending.get(oldest)!.cancel();
        this.pending.delete(oldest);
      }
      this.pump();
    });
  }

  private pump(): void {
    if (
      this.running ||
      this.active ||
      this.timer !== null ||
      this.cancelIdle ||
      !this.pending.size
    )
      return;
    const generation = this.generation;
    const start = () => {
      if (generation !== this.generation) return;
      this.cancelIdle = null;
      if (this.running || this.active || Date.now() < this.quietUntil) {
        this.pump();
        return;
      }
      const key = this.pending.keys().next().value;
      if (key === undefined) return;
      const task = this.pending.get(key)!;
      this.pending.delete(key);
      this.running = task;
      void task.run().finally(() => {
        if (this.running !== task) return;
        this.running = null;
        this.pump();
      });
    };
    this.timer = setTimeout(
      () => {
        if (generation !== this.generation) return;
        this.timer = null;
        if (typeof window !== "undefined" && window.requestIdleCallback) {
          // Chromium need not offer an idle period under sustained rendering.
          // Bound starvation while retaining the gesture/quiet checks in start
          // and the single running task. No timer remains when the queue is empty.
          const id = window.requestIdleCallback(start, { timeout: 1000 });
          this.cancelIdle = () => window.cancelIdleCallback(id);
        } else start();
      },
      Math.max(0, this.quietUntil - Date.now()),
    );
  }

  reset(): void {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.timer = null;
    for (const task of this.pending.values()) task.cancel();
    this.pending.clear();
    this.running?.cancel();
    this.active = 0;
    this.quietUntil = 0;
  }
}

export const designBackgroundWork = new DesignBackgroundWorkQueue();
