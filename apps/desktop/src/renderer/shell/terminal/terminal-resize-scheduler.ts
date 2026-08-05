// ──────────────────────────────────────────────────────────
// Terminal resize scheduler
// ──────────────────────────────────────────────────────────
//
// xterm resize is not a passive measurement: it can reflow the full scrollback
// buffer, rebuild renderer rows, and resize the backing PTY. ResizeObserver can
// fire for every pixel of a pane or native-window drag, so terminal fits use a
// trailing debounce and known pane gestures suspend them completely. The pane
// still tracks the pointer live; its terminal grid catches up once, next frame.

import {
  isContinuousLayoutResizeActive,
  subscribeContinuousLayoutResize,
} from "./continuous-layout-resize";

/** Short enough to feel immediate after release, long enough to identify a
 * continuous native-window resize burst that has no pointer seam signal. */
export const TERMINAL_RESIZE_SETTLE_MS = 80;

interface TerminalResizeSchedulerClock {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(frameId: number): void;
}

interface TerminalResizeScheduler {
  /** Record a geometry change and fit after it settles. */
  request(): void;
  /** Fit on the next frame unless a known drag is active. */
  flush(): void;
  /** Cancel every pending callback and detach the shared gesture listener. */
  dispose(): void;
}

interface TerminalRevealScheduler {
  /** Queue the visibility follow-up after layout is stable. */
  request(): void;
  /** Cancel queued frames and detach the shared gesture listener. */
  dispose(): void;
}

const browserClock: TerminalResizeSchedulerClock = {
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (frameId) => window.cancelAnimationFrame(frameId),
};

export function createTerminalResizeScheduler(
  run: () => void,
  clock: TerminalResizeSchedulerClock = browserClock,
): TerminalResizeScheduler {
  // A dirty scheduler owes the terminal one fit once it is safe to do so.
  let dirty = false;
  let disposed = false;
  let paused = isContinuousLayoutResizeActive();
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let frameId: number | null = null;

  const cancelTimer = () => {
    if (timerId === null) return;
    clearTimeout(timerId);
    timerId = null;
  };

  const cancelFrame = () => {
    if (frameId === null) return;
    clock.cancelFrame(frameId);
    frameId = null;
  };

  const scheduleFrame = () => {
    if (disposed || paused || !dirty || frameId !== null) return;
    frameId = clock.requestFrame(() => {
      frameId = null;
      if (disposed || paused || !dirty) return;
      dirty = false;
      run();
    });
  };

  const unsubscribe = subscribeContinuousLayoutResize((active) => {
    paused = active;
    if (active) {
      // A timer/frame queued just before pointerdown must not sneak a heavy fit
      // into the first drag frame. Keep `dirty` so release still catches up.
      cancelTimer();
      cancelFrame();
      return;
    }
    scheduleFrame();
  });

  return {
    request() {
      if (disposed) return;
      dirty = true;
      if (paused) return;
      cancelTimer();
      cancelFrame();
      timerId = setTimeout(() => {
        timerId = null;
        scheduleFrame();
      }, TERMINAL_RESIZE_SETTLE_MS);
    },

    flush() {
      if (disposed) return;
      dirty = true;
      cancelTimer();
      cancelFrame();
      scheduleFrame();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTimer();
      cancelFrame();
      unsubscribe();
    },
  };
}

/** Schedule a visible terminal's fit, redraw, and focus work after two layout
 * frames. Unlike the normal fit scheduler this never drops work requested
 * during a pane drag: it remains dirty and starts the double-frame sequence
 * when the outermost gesture releases. */
export function createTerminalRevealScheduler(
  run: () => void,
  clock: TerminalResizeSchedulerClock = browserClock,
): TerminalRevealScheduler {
  let dirty = false;
  let disposed = false;
  let paused = isContinuousLayoutResizeActive();
  let settleFrameId: number | null = null;
  let runFrameId: number | null = null;

  const cancelFrames = () => {
    if (settleFrameId !== null) {
      clock.cancelFrame(settleFrameId);
      settleFrameId = null;
    }
    if (runFrameId !== null) {
      clock.cancelFrame(runFrameId);
      runFrameId = null;
    }
  };

  const schedule = () => {
    if (
      disposed ||
      paused ||
      !dirty ||
      settleFrameId !== null ||
      runFrameId !== null
    ) {
      return;
    }
    settleFrameId = clock.requestFrame(() => {
      settleFrameId = null;
      if (disposed || paused || !dirty) return;
      runFrameId = clock.requestFrame(() => {
        runFrameId = null;
        if (disposed || paused || !dirty) return;
        dirty = false;
        run();
      });
    });
  };

  const unsubscribe = subscribeContinuousLayoutResize((active) => {
    paused = active;
    if (active) {
      // A second gesture can begin between the two settle frames. Preserve the
      // request and restart the full sequence after its final geometry lands.
      cancelFrames();
      return;
    }
    schedule();
  });

  return {
    request() {
      if (disposed) return;
      dirty = true;
      schedule();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cancelFrames();
      unsubscribe();
    },
  };
}
