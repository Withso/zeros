import { isElementActuallyVisible } from "./element-visibility";

/** Display work belongs to a visible, focused window. Request deadlines and
 * native lifecycle work must not use this presentation-only gate. */
export function documentIsForeground(): boolean {
  return typeof document === "undefined" || (document.visibilityState !== "hidden" &&
    (typeof document.hasFocus !== "function" || document.hasFocus()));
}

export function observeForeground(changed: () => void): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};
  const page = document, host = window;
  page.addEventListener("visibilitychange", changed);
  host.addEventListener("focus", changed);
  host.addEventListener("blur", changed);
  return () => {
    page.removeEventListener("visibilitychange", changed);
    host.removeEventListener("focus", changed);
    host.removeEventListener("blur", changed);
  };
}

type Entry = { listeners: Set<(active: boolean) => void>; intersects: boolean; active?: boolean };
const entries = new Map<Element, Entry>();
let intersection: IntersectionObserver | undefined;
let mutations: MutationObserver | undefined;
let unwatch: (() => void) | undefined;

function refresh(force = false) {
  const foreground = documentIsForeground();
  for (const [element, entry] of entries) {
    const active = foreground && entry.intersects && isElementActuallyVisible(element);
    if (!force && entry.active === active) continue;
    entry.active = active;
    for (const changed of [...entry.listeners]) changed(active);
  }
}

function watchAncestors() {
  if (!mutations) return;
  mutations.disconnect();
  const ancestors = new Set<Element>();
  for (const element of entries.keys()) {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (ancestors.has(node)) break;
      ancestors.add(node);
      // Watch visibility owners, never descendant text or animated tiles.
      mutations.observe(node, { attributes: true, attributeFilter: ["class", "style", "hidden", "inert"] });
    }
  }
}

/** Shared event-driven visibility for opted-in Local surfaces. No polling and
 * no per-frame layout reads. The first visible paint never waits for an IO
 * delivery; off-screen and retained-hidden transitions disarm ongoing work. */
export function observeElementActivity(element: Element, changed: (active: boolean) => void): () => void {
  if (!entries.size) {
    unwatch = observeForeground(() => refresh(true));
    if (typeof IntersectionObserver !== "undefined") intersection = new IntersectionObserver(records => {
      for (const record of records) {
        const entry = entries.get(record.target);
        if (entry) entry.intersects = record.isIntersecting;
      }
      refresh();
    });
    if (typeof MutationObserver !== "undefined") mutations = new MutationObserver(() => refresh());
  }
  let entry = entries.get(element);
  if (!entry) {
    entry = { listeners: new Set(), intersects: true };
    entries.set(element, entry);
    intersection?.observe(element);
    watchAncestors();
  }
  entry.listeners.add(changed);
  if (entry.active === undefined) refresh();
  else changed(entry.active);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    entry.listeners.delete(changed);
    if (!entry.listeners.size) {
      entries.delete(element);
      intersection?.unobserve(element);
      watchAncestors();
    }
    if (entries.size) return;
    intersection?.disconnect(); intersection = undefined;
    mutations?.disconnect(); mutations = undefined;
    unwatch?.(); unwatch = undefined;
  };
}
