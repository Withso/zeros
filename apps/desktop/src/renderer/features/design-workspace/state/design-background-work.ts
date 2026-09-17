interface BackgroundTask {
  run: () => Promise<void>;
  cancel: () => void;
}

/** Optional document audits and raster captures share one bounded lane. Input
 * always wins; queued work is replaced by its newest exact owner request. */
export class DesignBackgroundWorkQueue {
  private pending = new Map<string, BackgroundTask>();
  private running = false;
  private active = 0;
  private quietUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelIdle: (() => void) | null = null;
  private generation = 0;

  constructor(
    private readonly limit = 32,
    private readonly quietMs = 150,
  ) {}

  touch(): void {
    this.quietUntil = Date.now() + this.quietMs;
  }

  pause(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.touch();
      this.pump();
    };
  }

  schedule<T>(key: string, work: () => Promise<T>): Promise<T | null> {
    return new Promise((resolve, reject) => {
      this.pending.get(key)?.cancel();
      this.pending.delete(key);
      this.pending.set(key, {
        run: async () => {
          try {
            resolve(await work());
          } catch (error) {
            reject(error);
          }
        },
        cancel: () => resolve(null),
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
    const start = () => {
      this.cancelIdle = null;
      if (this.active || Date.now() < this.quietUntil) {
        this.pump();
        return;
      }
      const key = this.pending.keys().next().value;
      if (key === undefined) return;
      const task = this.pending.get(key)!;
      this.pending.delete(key);
      this.running = true;
      const generation = this.generation;
      void task.run().finally(() => {
        if (generation !== this.generation) return;
        this.running = false;
        this.pump();
      });
    };
    this.timer = setTimeout(
      () => {
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
    this.running = false;
    this.active = 0;
    this.quietUntil = 0;
  }
}

export const designBackgroundWork = new DesignBackgroundWorkQueue();
