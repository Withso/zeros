import { useSyncExternalStore } from "react";

// A display clock only: authority, request and task deadlines keep their own
// timers. Active consumers in this renderer share one wake each second.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setTimeout> | undefined;
let observedDocument: Document | undefined;
const snapshot = () => now;
const inert = () => () => {};
const visible = () => observedDocument?.visibilityState !== "hidden";

function stop() {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
}

function reconcile() {
  if (!listeners.size || !visible()) {
    stop();
    return;
  }
  const next = Date.now();
  if (next !== now) {
    now = next;
    for (const changed of [...listeners]) {
      if (!listeners.has(changed)) continue;
      changed();
    }
  }
  // A subscriber can unmount while publication runs. The live visibility check
  // also handles hiding before delivery of the document's visibility event.
  if (listeners.size && visible() && timer === undefined)
    timer = setTimeout(() => {
      timer = undefined;
      reconcile();
    }, 1_000);
}

function subscribe(changed: () => void) {
  if (typeof document === "undefined") return () => {};
  listeners.add(changed);
  if (!observedDocument) {
    observedDocument = document;
    observedDocument.addEventListener("visibilitychange", reconcile);
  }
  // useSyncExternalStore checks the snapshot after subscribing, so the first
  // paint after a mount/reveal uses wall time without awaiting a timer tick.
  reconcile();
  return () => {
    listeners.delete(changed);
    if (listeners.size) return;
    stop();
    observedDocument?.removeEventListener("visibilitychange", reconcile);
    observedDocument = undefined;
  };
}

/** Keep retained inactive surfaces unsubscribed. Hidden documents retain only
 * their visibility listener, and a snapshot read never starts or steals a tick. */
export function useVisibleClock(active = true): number {
  return useSyncExternalStore(active ? subscribe : inert, snapshot, snapshot);
}
