/** Keeps renderer main frames on the display cadence while a camera gesture is
 * live. Input-driven frames otherwise begin wherever a wheel or pointer event
 * lands inside the refresh interval; a late start misses the compositor
 * deadline and Chromium drops every other frame even when each frame's work
 * is small. One empty animation-frame request per refresh lets the browser
 * start each main frame at the interval boundary, where coalesced input is
 * dispatched before the camera paint. The clock owns a single request and
 * retires itself as soon as the gesture ends, so idle canvases request nothing. */
export interface DesignGestureFrameClock {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export function createDesignGestureFrameClock(
  active: () => boolean,
  request: (callback: FrameRequestCallback) => number = (callback) => window.requestAnimationFrame(callback),
  cancel: (id: number) => void = (id) => window.cancelAnimationFrame(id),
): DesignGestureFrameClock {
  let id: number | null = null;
  const beat = () => {
    id = active() ? request(beat) : null;
  };
  return {
    start() {
      if (id === null && active()) id = request(beat);
    },
    stop() {
      if (id !== null) cancel(id);
      id = null;
    },
    get running() {
      return id !== null;
    },
  };
}
