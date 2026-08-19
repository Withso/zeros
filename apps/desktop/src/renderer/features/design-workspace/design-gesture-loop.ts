/** One shared clock for every direct-manipulation gesture on the design canvas.
 *
 * A gesture has two authorities for the same geometry: the pointer (which the
 * host paints from immediately) and the real element inside the sandboxed
 * runtime (which only layout can answer, one round trip later). Left
 * unsynchronised those two disagree — the overlay races ahead, a late
 * measurement paints a position the pointer has already left, and the selection
 * appears to shiver around the element it describes.
 *
 * This loop owns that synchronisation, once, for all of them:
 *
 * - at most one runtime request is in flight, and the newest authored styles
 *   always win the next slot (a coalesced latest-wins queue, never a backlog);
 * - because of that, a measurement can never be stale: the runtime holds
 *   exactly the styles of the request that just answered, so what it reports IS
 *   the element as it is now, and painting it is always safe;
 * - teardown is total: after `stop()` no callback of any kind fires.
 *
 * That second property is what lets an overlay stop leading the element it
 * describes. Each gesture paints its own prediction on the pointer event — the
 * frame's instant feedback — and then the measurement lands in the same frame
 * and settles it onto the truth, so the two can never drift apart.
 */

/** Whether two authored style sets leave the element in the same state.
 *
 * A gesture writes whole pixels. At high zoom many consecutive pointer samples
 * round to the values the runtime is already holding, and re-sending those buys
 * nothing: the element is already there and the canvas is already painted from
 * the measurement that said so. */
export function sameDesignGestureStyles(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

export interface DesignGestureLoopStats {
  /** Authored style revisions this gesture has produced. */
  readonly revisions: number;
  /** Runtime requests actually dispatched (coalesced, so ≤ revisions). */
  readonly requests: number;
  /** Pointer samples merged into a request that was already queued. */
  readonly coalesced: number;
}

export interface DesignGestureLoop {
  /** Author the styles this pointer sample wants previewed. Repeated calls
   * before the in-flight request settles keep only the newest. */
  author(styles: Record<string, string>): void;
  /** Release the loop. No request is dispatched and no callback fires after. */
  stop(): void;
  readonly stats: DesignGestureLoopStats;
  /** Resolves once nothing is in flight and nothing is queued. Tests only. */
  settled(): Promise<void>;
}

export interface DesignGestureLoopOptions<Measurement> {
  /** Apply one authored style set inside the runtime and measure the result. */
  request(styles: Record<string, string>): Promise<Measurement>;
  /** Settle the canvas onto what the element actually became. */
  measured?(measurement: Measurement): void;
  /** A request that failed. Gesture previews are speculative: the commit is
   * what reports an actionable error, so this defaults to swallowing. */
  failed?(error: unknown): void;
}

export function createDesignGestureLoop<Measurement>(
  options: DesignGestureLoopOptions<Measurement>,
): DesignGestureLoop {
  let stopped = false;
  let inFlight = false;
  let queued: Record<string, string> | null = null;
  let idle: (() => void) | null = null;
  const stats = { revisions: 0, requests: 0, coalesced: 0 };

  const settle = () => {
    if (inFlight || queued || !idle) return;
    const resolveIdle = idle;
    idle = null;
    resolveIdle();
  };

  const dispatch = () => {
    if (stopped || inFlight || !queued) {
      settle();
      return;
    }
    const sent = queued;
    queued = null;
    inFlight = true;
    stats.requests += 1;
    options
      .request(sent)
      .then((measurement) => {
        if (stopped) return;
        // Nothing else has written to the element since this request applied
        // its styles — single flight guarantees it — so this measurement is the
        // element as it stands, not a position the pointer has left behind.
        options.measured?.(measurement);
      })
      .catch((error: unknown) => {
        if (!stopped) options.failed?.(error);
      })
      .finally(() => {
        inFlight = false;
        if (stopped) {
          settle();
          return;
        }
        dispatch();
      });
  };

  return {
    author(styles) {
      if (stopped) return;
      stats.revisions += 1;
      if (queued) stats.coalesced += 1;
      queued = styles;
      dispatch();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      queued = null;
      settle();
    },
    stats,
    settled() {
      if (!inFlight && !queued) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idle = resolve;
      });
    },
  };
}
