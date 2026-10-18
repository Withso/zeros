import { documentIsForeground, observeElementActivity } from "@/renderer/shared/lib/element-activity";

/** A presentation clock wakes at the next text boundary, never at a faster
 * cadence than its label. Hidden/off-screen owners keep only activity watches. */
export function startElapsedDisplay<T>({ host, startedAt, precision, format, changed, activity }: {
  host: Element;
  startedAt: number;
  precision: (elapsed: number) => number;
  format: (elapsed: number) => T;
  changed: (value: T) => void;
  activity?: (active: boolean) => void;
}): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false, disposed = false;
  let previous: T | undefined;
  const stop = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const update = () => {
    timer = undefined;
    if (disposed || !active || !documentIsForeground()) return;
    const now = Date.now(), elapsed = Math.max(0, now - startedAt);
    const value = format(elapsed);
    if (value !== previous) { previous = value; changed(value); }
    if (disposed || !active) return;
    const step = precision(elapsed);
    const deadline = startedAt + (Math.floor(elapsed / step) + 1) * step;
    timer = setTimeout(update, Math.max(1, deadline - now));
  };
  const unwatch = observeElementActivity(host, next => {
    stop(); active = next; activity?.(next);
    if (active) update();
  });
  return () => { disposed = true; stop(); unwatch(); };
}
