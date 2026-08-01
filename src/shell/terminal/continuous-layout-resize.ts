// ──────────────────────────────────────────────────────────
// Continuous layout-resize coordination
// ──────────────────────────────────────────────────────────
//
// A pane seam can move every animation frame, but expensive descendants such
// as xterm must not rebuild their cell grid on every intermediate pixel. This
// tiny imperative signal lets those descendants hold their last confirmed
// layout during a known drag and perform one exact fit when the gesture ends.

type ContinuousLayoutResizeListener = (active: boolean) => void;

const activeGestures = new Set<symbol>();
const listeners = new Set<ContinuousLayoutResizeListener>();

/** Whether at least one captured pane-resize gesture is currently active. */
export function isContinuousLayoutResizeActive(): boolean {
  return activeGestures.size > 0;
}

/** Listen for the outermost start and final finish transitions. */
export function subscribeContinuousLayoutResize(
  listener: ContinuousLayoutResizeListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Start a resize gesture and return its idempotent completion callback. */
export function beginContinuousLayoutResize(): () => void {
  const token = Symbol("continuous-layout-resize");
  const wasActive = isContinuousLayoutResizeActive();
  activeGestures.add(token);
  if (!wasActive) publish(true);

  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeGestures.delete(token);
    if (!isContinuousLayoutResizeActive()) publish(false);
  };
}

function publish(active: boolean): void {
  for (const listener of listeners) listener(active);
}

/** Restore module state between isolated unit tests. */
export function resetContinuousLayoutResizeForTests(): void {
  const wasActive = isContinuousLayoutResizeActive();
  activeGestures.clear();
  if (wasActive) publish(false);
  listeners.clear();
}
