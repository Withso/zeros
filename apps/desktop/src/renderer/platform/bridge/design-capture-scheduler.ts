import { DESIGN_CAPTURE_TEMP_BYTES, DesignCaptureCleanupUnconfirmedError } from "@zeros/protocol/design-capture";
export { DESIGN_CAPTURE_TEMP_BYTES, DesignCaptureCleanupUnconfirmedError } from "@zeros/protocol/design-capture";

export type DesignCapturePriority = "explicit" | "visible" | "detail" | "nearby";
const PRIORITY: Record<DesignCapturePriority, number> = { explicit: 0, visible: 1, detail: 2, nearby: 3 };

interface CaptureTask {
  key: string;
  priority: DesignCapturePriority;
  controller: AbortController;
  run(): Promise<void>;
  retire(): void;
  stop(): void;
}

/** Canvas native previews and iframe captures share this lane. Cancellation
 * never frees a running slot: work must settle after actual cleanup. Native
 * exports and iframe captures additionally acquire main's shared reservation. */
export class DesignCaptureScheduler {
  private pending = new Map<string, CaptureTask>();
  private running: CaptureTask | null = null;
  private paused = 0;
  private quietUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unconfirmed = false;

  /** Fail closed after losing terminal proof. Keep one reservation, but no
   * queued image/source closures. Only app disposal proves the lost host gone. */
  quarantine(): void {
    this.unconfirmed = true;
    for (const task of this.pending.values()) task.controller.abort(new DesignCaptureCleanupUnconfirmedError());
  }

  usage() {
    return { running: this.running ? 1 : 0, queued: this.pending.size,
      cancelling: this.running?.controller.signal.aborted ? 1 : 0,
      ...(this.unconfirmed ? { unconfirmed: 1 } : {}),
      reservedBytes: this.running || this.unconfirmed ? DESIGN_CAPTURE_TEMP_BYTES : 0 };
  }

  pause(): () => void {
    this.paused++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.paused--;
      this.touch();
    };
  }

  touch(): void {
    this.quietUntil = Date.now() + 150;
    this.pump();
  }

  schedule<T>(key: string, priority: DesignCapturePriority, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.unconfirmed) return Promise.reject(new DesignCaptureCleanupUnconfirmedError());
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      this.pending.get(key)?.controller.abort(new Error("Design capture superseded."));
      if (this.pending.size >= 32) {
        const victim = [...this.pending.values()].reverse().find((task) => PRIORITY[task.priority] >= PRIORITY[priority]);
        if (!victim) { reject(new Error("Design capture queue is full.")); return; }
        victim.controller.abort(new Error("Design capture superseded."));
      }
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      const task: CaptureTask = {
        key, priority, controller,
        run: async () => {
          try {
            controller.signal.throwIfAborted();
            const value = await work(controller.signal);
            controller.signal.throwIfAborted();
            resolve(value);
          } catch (error) {
            if (error instanceof DesignCaptureCleanupUnconfirmedError) this.quarantine();
            reject(error);
          }
        },
        retire: () => {
          if (this.pending.get(key) !== task) return;
          this.pending.delete(key);
          task.stop();
          reject(controller.signal.reason);
          this.pump();
        },
        stop: () => {
          signal?.removeEventListener("abort", abort);
          controller.signal.removeEventListener("abort", task.retire);
        },
      };
      this.pending.set(key, task);
      controller.signal.addEventListener("abort", task.retire, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.unconfirmed || this.running || !this.pending.size) return;
    const task = [...this.pending.values()].sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority])[0]!;
    if (task.priority !== "explicit") {
      if (this.paused) return;
      const delay = this.quietUntil - Date.now();
      if (delay > 0) { this.timer = setTimeout(() => { this.timer = null; this.pump(); }, delay); return; }
    }
    this.pending.delete(task.key);
    this.running = task;
    void task.run().finally(() => {
      task.stop();
      this.running = null;
      this.pump();
    });
  }
}

export const designCaptureScheduler = new DesignCaptureScheduler();
