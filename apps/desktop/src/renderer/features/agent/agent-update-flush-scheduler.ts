// ──────────────────────────────────────────────────────────
// Bridge-notification flush scheduling for <AgentSessionsProvider>
// ──────────────────────────────────────────────────────────
//
// Ordinary transcript content drains in one frame-aligned flush, so a token
// burst is applied together, aligned with paint (each notification still
// updates the store). Animation frames stop while the window is minimized,
// hidden or occluded, so a deadline timer bounds how long a buffered
// notification can wait. Chromium still clamps
// hidden-page timers to about once a second, which is the intended background
// cadence: background agents keep their transcript current without retaining
// a backlog that the next reveal would apply as one long task.
//
// Control events (permissions, questions, agent exits) and turn boundaries
// cannot wait for paint; the provider drains them with `flushNow`. A drain
// requested while a flush is running runs right after it, so delivery order
// is preserved and nothing is applied re-entrantly.
// ──────────────────────────────────────────────────────────

/** Longest an ordinary buffered notification waits when no frame arrives.
 *  Above a frame at any refresh rate, so visible windows stay frame-aligned. */
export const AGENT_UPDATE_FLUSH_DEADLINE_MS = 250;

/** Buffered content notifications that force an immediate drain. A hard
 *  bound for queues that would otherwise wait for a throttled timer. */
export const AGENT_UPDATE_BACKLOG_LIMIT = 512;

export interface AgentUpdateFlushScheduler {
  /** Request a frame-aligned flush, bounded by the deadline timer. */
  schedule(): void;
  /** Drain synchronously; inside a running flush, drain right after it. */
  flushNow(): void;
  /** Cancel pending callbacks, draining anything they would have applied.
   *  Later requests drain synchronously so a late event is never parked. */
  dispose(): void;
}

export interface AgentUpdateFlushSchedulerOptions {
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  deadlineMs?: number;
}

export function createAgentUpdateFlushScheduler(
  flush: () => void,
  options: AgentUpdateFlushSchedulerOptions = {},
): AgentUpdateFlushScheduler {
  // Resolve platform callbacks at call time so the renderer's own globals
  // (and test doubles installed after import) are the ones used.
  const requestFrame =
    options.requestFrame ?? ((callback: () => void) => requestAnimationFrame(callback));
  const cancelFrame =
    options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
  const setTimer =
    options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const deadlineMs = options.deadlineMs ?? AGENT_UPDATE_FLUSH_DEADLINE_MS;

  let frame: number | null = null;
  let timer: unknown = null;
  let timerArmed = false;
  let running = false;
  let again = false;
  let disposed = false;

  const disarm = () => {
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
    if (timerArmed) {
      clearTimer(timer);
      timer = null;
      timerArmed = false;
    }
  };

  const arm = () => {
    if (frame !== null || timerArmed) return;
    frame = requestFrame(() => {
      frame = null;
      run();
    });
    timerArmed = true;
    timer = setTimer(() => {
      timer = null;
      timerArmed = false;
      run();
    }, deadlineMs);
  };

  const run = () => {
    disarm();
    if (running) {
      again = true;
      return;
    }
    running = true;
    let completed = false;
    try {
      do {
        again = false;
        // A follow-up pass drains everything buffered so far, including work
        // that armed a frame or timer during the previous pass.
        disarm();
        flush();
      } while (again);
      completed = true;
    } finally {
      running = false;
      // A drain requested before a failed flush still owns buffered events.
      if (!completed && again) {
        again = false;
        if (disposed) queueMicrotask(run);
        else arm();
      }
    }
  };

  return {
    schedule() {
      if (disposed) {
        run();
        return;
      }
      arm();
    },
    flushNow: run,
    dispose() {
      const pending = frame !== null || timerArmed;
      disposed = true;
      disarm();
      if (pending) run();
    },
  };
}
