// ──────────────────────────────────────────────────────────
// Loader loop — one frame loop for the loaders stepped from script
// ──────────────────────────────────────────────────────────
//
// The agent Puzzle (puzzle-square.tsx) and the transcript's glass square
// (glass-square.tsx) step their tiles from script, and the agent's working
// timer (WorkingDuration, live-duration.tsx) counts its tenths. Every one of
// them shares this requestAnimationFrame loop. Hidden retained surfaces stay
// inert: a run whose surface is hidden (a background chat, a collapsed
// panel) keeps its place in the loop but skips its turns until it is visible
// again.
// ──────────────────────────────────────────────────────────

import { isElementActuallyVisible } from "@/renderer/shared/lib/element-visibility";
import { observeElementActivity } from "@/renderer/shared/lib/element-activity";

export interface LoaderRun {
  /** The element whose visibility gates this run's turns. */
  host: Element;
  tick: (now: number) => void;
  /** Local owners opt into event-driven foreground/viewport observation. */
  local?: boolean;
  /** Land finite animations when hidden and restart their model on reveal. */
  onActivity?: (active: boolean) => void;
}

const loaderRuns = new Set<LoaderRun>();
let loaderFrameId = 0;

function runLoaders(now: number) {
  loaderFrameId = 0;
  loaderRuns.forEach((run) => {
    if (!run.local && !isElementActuallyVisible(run.host)) return;
    run.tick(now);
  });
  if (loaderRuns.size) loaderFrameId = window.requestAnimationFrame(runLoaders);
}

/** Add a run to the shared loop; the returned function takes it out. */
export function startLoaderRun(run: LoaderRun): () => void {
  const remove = () => {
    loaderRuns.delete(run);
    if (!loaderRuns.size && loaderFrameId) {
      window.cancelAnimationFrame(loaderFrameId);
      loaderFrameId = 0;
    }
  };
  const add = () => {
    loaderRuns.add(run);
    if (!loaderFrameId) loaderFrameId = window.requestAnimationFrame(runLoaders);
  };
  if (!run.local) { add(); return remove; }
  const stop = observeElementActivity(run.host, active => {
    run.onActivity?.(active);
    if (active) add(); else remove();
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    stop(); remove(); run.onActivity?.(false);
  };
}
