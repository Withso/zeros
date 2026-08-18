// ──────────────────────────────────────────────────────────
// admission-gate.ts — how many boundaries may be built at once
// ──────────────────────────────────────────────────────────
//
// An admission is expensive in machine terms, not just wall-clock: it copies a
// provider HOME tree file by file, spawns ~20 `git` processes for the private
// repository view, and spawns a real contained child for the live canary. Run
// several at once and they do not merely queue — they starve each other.
//
// Measured on a real Mac (2026-08-17 engine log), one burst of seven
// overlapping admissions inflated EVERY stage, including the ones that hold no
// lock at all:
//
//     solo                        contended
//     discover        17 ms       2,265 ms
//     policy           2 ms       2,132 ms
//     provider-state 1.4 s       28.8 s
//     total          ~2.1 s      16-33 s
//
// So the fix is not more parallelism, it is less: a small cap makes each
// admission run at its solo cost and turns an unpredictable 30 s tail into a
// predictable short queue. Total wall-clock for a burst goes DOWN.
//
// Priority exists because not every admission is a person waiting. Chat-title
// generation, provider probes and `listSessions` each prepare and retire a
// full boundary; in that same log they were roughly a third of all admissions.
// Those must never sit in front of a chat the user is trying to start, and
// they must never occupy every slot — hence the separate background cap, which
// keeps at least one slot reachable by interactive work at all times.
//
// This is a machine-wide resource, so the shared instance below is what the
// boundary factory uses regardless of how many factories exist in a process.
// ──────────────────────────────────────────────────────────

/** Interactive = a person is waiting on this admission (session create, load,
 *  fork, a repository task they started). Background = engine-initiated work
 *  whose latency nobody observes. */
export type AdmissionPriority = "interactive" | "background";

/** Thrown when an admission is cancelled while still queued. Nothing has been
 *  built at that point — no overlay, no shadow git, no canary — so there is
 *  nothing to tear down and no proof obligation. Once a slot is granted the
 *  admission always runs to completion; cancellation after start is a no-op
 *  because a half-built world with live resources must go through the normal
 *  proven-teardown path, never an abort. */
export class AdmissionCancelledError extends Error {
  constructor(message = "admission cancelled while queued") {
    super(message);
    this.name = "AdmissionCancelledError";
  }
}

/** Two lets a second provider admit while the first is working — the promotion
 *  lock already serializes same-provider admissions, so more than this buys
 *  contention rather than throughput. */
const DEFAULT_ADMISSION_LIMIT = 2;

interface Waiter {
  readonly priority: AdmissionPriority;
  readonly start: () => void;
}

/** What the caller needs in order to report honestly. Without the wait, an
 *  admission log measures only post-slot work and a queued session looks fast
 *  while the user watches a spinner. */
export interface AdmissionSlot {
  /** Milliseconds spent queued before this admission began. */
  readonly waitedMs: number;
  /** Admissions already running when this one was granted its slot. */
  readonly runningOnEntry: number;
  /** Admissions still queued when this one was granted its slot. */
  readonly queuedOnEntry: number;
}

export class AdmissionGate {
  private readonly limit: number;
  private readonly backgroundLimit: number;
  private running = 0;
  private runningBackground = 0;
  private readonly queue: Waiter[] = [];

  constructor(options: { limit?: number; backgroundLimit?: number } = {}) {
    const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_ADMISSION_LIMIT));
    this.limit = limit;
    // Reserve a slot for interactive work by default: a slow background
    // admission must not be able to hold every slot at once.
    this.backgroundLimit = Math.min(
      limit,
      Math.max(1, Math.floor(options.backgroundLimit ?? limit - 1)),
    );
  }

  /** Diagnostics for tests and future instrumentation. */
  snapshot(): {
    readonly running: number;
    readonly runningBackground: number;
    readonly queued: number;
  } {
    return {
      running: this.running,
      runningBackground: this.runningBackground,
      queued: this.queue.length,
    };
  }

  /** Run `work` once a slot is free. Rejections propagate unchanged and still
   *  release the slot — a refused admission must not shrink the gate.
   *
   *  `signal` cancels the admission only while it is queued (rejecting with
   *  AdmissionCancelledError, without ever holding a slot). A close that lands
   *  after the slot was granted changes nothing here: the boundary finishes
   *  building and the caller's own stale-bind check retires it through the
   *  proven-teardown path. */
  run<T>(
    priority: AdmissionPriority,
    work: (slot: AdmissionSlot) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const { signal } = options;
    if (signal?.aborted) {
      return Promise.reject(new AdmissionCancelledError());
    }
    const queuedAt = Date.now();
    return new Promise<T>((resolve, reject) => {
      const onAbort = signal
        ? () => {
            const index = this.queue.indexOf(waiter);
            if (index < 0) return; // already started — runs to completion
            this.queue.splice(index, 1);
            reject(new AdmissionCancelledError());
          }
        : undefined;
      const waiter: Waiter = {
        priority,
        start: () => {
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          const slot: AdmissionSlot = {
            waitedMs: Date.now() - queuedAt,
            runningOnEntry: this.running,
            queuedOnEntry: this.queue.length,
          };
          this.running += 1;
          if (priority === "background") this.runningBackground += 1;
          void (async () => {
            try {
              resolve(await work(slot));
            } catch (error) {
              reject(error);
            } finally {
              this.running -= 1;
              if (priority === "background") this.runningBackground -= 1;
              this.drain();
            }
          })();
        },
      };
      this.queue.push(waiter);
      if (signal && onAbort) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.drain();
    });
  }

  private drain(): void {
    while (this.running < this.limit) {
      const index = this.nextRunnableIndex();
      if (index < 0) return;
      // `start` increments `running` synchronously, so the loop condition is
      // still accurate on the next iteration.
      this.queue.splice(index, 1)[0]!.start();
    }
  }

  /** Interactive work always wins, wherever it sits in the queue. A background
   *  waiter is only runnable while background slots remain. Returns -1 when
   *  nothing may start right now. */
  private nextRunnableIndex(): number {
    let background = -1;
    for (let index = 0; index < this.queue.length; index += 1) {
      const waiter = this.queue[index]!;
      if (waiter.priority === "interactive") return index;
      if (background < 0 && this.runningBackground < this.backgroundLimit) {
        background = index;
      }
    }
    return background;
  }
}

/** The process-wide gate. Admission cost is a property of the machine, not of
 *  a particular boundary factory. */
export const sharedAdmissionGate = new AdmissionGate();
