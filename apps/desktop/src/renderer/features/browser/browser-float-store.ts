// ──────────────────────────────────────────────────────────
// Floating Browser previews — session-only registry
// ──────────────────────────────────────────────────────────
//
// A floated Browser tab keeps its single iframe. The tab renders its viewport
// into a detached host element and moves that host between its docked slot and
// a float slot with `moveBefore`, which preserves the browsing context
// (history, scroll, form input, JS heap). `appendChild` would reload the page.
//
// Floats are UI state for this renderer session only: they are keyed by the
// exact workbench scope + tab id, render only for the active scope, and are
// pruned when their tab unmounts.

import { useSyncExternalStore } from "react";

export interface BrowserFloatViewport {
  width: number;
  height: number;
}

export interface BrowserFloatEntry {
  key: string;
  scope: string;
  tabId: string;
  /** Layout size the floated page keeps; the float scales it down. */
  viewport: BrowserFloatViewport;
  /** Scale a user resize chose. Absent until the first resize, while the
   * float fits the picture-in-picture budget. */
  scale?: number;
}

export const MAX_BROWSER_FLOATS_PER_SCOPE = 3;
const FALLBACK_VIEWPORT: BrowserFloatViewport = { width: 1280, height: 800 };
const MAX_VIEWPORT_EDGE = 7680;
const MIN_VIEWPORT_EDGE = 120;

const EMPTY_ENTRIES: readonly BrowserFloatEntry[] = [];

let entries: readonly BrowserFloatEntry[] = EMPTY_ENTRIES;
const entriesByScope = new Map<
  string,
  { source: readonly BrowserFloatEntry[]; value: readonly BrowserFloatEntry[] }
>();
const slots = new Map<string, HTMLElement>();
const slotRemovalListeners = new Map<string, Set<(slot: HTMLElement) => void>>();
let agentPipSurface: HTMLElement | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function browserFloatKey(scope: string, tabId: string): string {
  return JSON.stringify([scope, tabId]);
}

export function normalizeBrowserFloatViewport(
  viewport: BrowserFloatViewport | null | undefined,
): BrowserFloatViewport {
  const edge = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= MIN_VIEWPORT_EDGE
      ? Math.min(MAX_VIEWPORT_EDGE, Math.round(value))
      : fallback;
  return {
    width: edge(viewport?.width, FALLBACK_VIEWPORT.width),
    height: edge(viewport?.height, FALLBACK_VIEWPORT.height),
  };
}

/** Rounds a resized layout into the supported range. Unlike
 * {@link normalizeBrowserFloatViewport}, a small value clamps rather than
 * falling back, so a resize never jumps to the desktop size. */
export function clampBrowserFloatViewport(
  viewport: BrowserFloatViewport,
): BrowserFloatViewport {
  const edge = (value: number, fallback: number) =>
    Number.isFinite(value)
      ? Math.min(MAX_VIEWPORT_EDGE, Math.max(MIN_VIEWPORT_EDGE, Math.round(value)))
      : fallback;
  return {
    width: edge(viewport.width, FALLBACK_VIEWPORT.width),
    height: edge(viewport.height, FALLBACK_VIEWPORT.height),
  };
}

/** Floats a tab, keeping at most {@link MAX_BROWSER_FLOATS_PER_SCOPE} per
 * scope; the oldest float of that scope docks to make room. */
export function floatBrowserTab(input: {
  scope: string;
  tabId: string;
  viewport?: BrowserFloatViewport | null;
}): void {
  const key = browserFloatKey(input.scope, input.tabId);
  const viewport = normalizeBrowserFloatViewport(input.viewport);
  if (entries.some((entry) => entry.key === key)) {
    updateBrowserFloatViewport(key, viewport);
    return;
  }
  const sameScope = entries.filter((entry) => entry.scope === input.scope);
  const evicted = new Set(
    sameScope
      .slice(0, Math.max(0, sameScope.length - MAX_BROWSER_FLOATS_PER_SCOPE + 1))
      .map((entry) => entry.key),
  );
  entries = [
    ...entries.filter((entry) => !evicted.has(entry.key)),
    { key, scope: input.scope, tabId: input.tabId, viewport },
  ];
  emit();
}

export function dockBrowserTab(key: string): void {
  if (!entries.some((entry) => entry.key === key)) return;
  entries = entries.filter((entry) => entry.key !== key);
  emit();
}

export function updateBrowserFloatViewport(
  key: string,
  viewport: BrowserFloatViewport,
): void {
  const next = normalizeBrowserFloatViewport(viewport);
  let changed = false;
  const updated = entries.map((entry) => {
    if (
      entry.key !== key ||
      (entry.viewport.width === next.width &&
        entry.viewport.height === next.height)
    )
      return entry;
    changed = true;
    return { ...entry, viewport: next };
  });
  if (!changed) return;
  entries = updated;
  emit();
}

/** Applies a user resize: the page's layout size and the scale the float
 * draws it at. Omitting the scale returns the float to its automatic fit. */
export function resizeBrowserFloat(
  key: string,
  next: { viewport: BrowserFloatViewport; scale?: number },
): void {
  const viewport = clampBrowserFloatViewport(next.viewport);
  const scale =
    typeof next.scale === "number" && Number.isFinite(next.scale) && next.scale > 0
      ? next.scale
      : undefined;
  let changed = false;
  const updated = entries.map((entry) => {
    if (
      entry.key !== key ||
      (entry.viewport.width === viewport.width &&
        entry.viewport.height === viewport.height &&
        entry.scale === scale)
    )
      return entry;
    changed = true;
    const resized: BrowserFloatEntry = {
      key: entry.key,
      scope: entry.scope,
      tabId: entry.tabId,
      viewport,
    };
    if (scale !== undefined) resized.scale = scale;
    return resized;
  });
  if (!changed) return;
  entries = updated;
  emit();
}

export function browserFloatEntries(): readonly BrowserFloatEntry[] {
  return entries;
}

export function isBrowserTabFloating(key: string): boolean {
  return entries.some((entry) => entry.key === key);
}

export function useBrowserTabFloating(key: string): boolean {
  const read = () => isBrowserTabFloating(key);
  return useSyncExternalStore(subscribe, read, read);
}

function entriesForScope(scope: string): readonly BrowserFloatEntry[] {
  const cached = entriesByScope.get(scope);
  if (cached?.source === entries) return cached.value;
  const value = entries.filter((entry) => entry.scope === scope);
  const stable = value.length ? value : EMPTY_ENTRIES;
  entriesByScope.set(scope, { source: entries, value: stable });
  return stable;
}

export function useBrowserFloatEntries(
  scope: string,
): readonly BrowserFloatEntry[] {
  const read = () => entriesForScope(scope);
  return useSyncExternalStore(subscribe, read, read);
}

// ── Float slots ───────────────────────────────────────────

/** Stable ref target for a float slot. A slot is removed from the DOM together
 * with its children, so a registered rescue moves the tab's viewport host out
 * synchronously while the slot is still connected (React detaches refs before
 * it removes the deleted subtree's top node). */
export function registerBrowserFloatSlot(
  key: string,
  element: HTMLElement | null,
): void {
  if (element) {
    if (slots.get(key) === element) return;
    slots.set(key, element);
    emit();
    return;
  }
  const previous = slots.get(key);
  if (!previous) return;
  slots.delete(key);
  for (const rescue of [...(slotRemovalListeners.get(key) ?? [])]) {
    rescue(previous);
  }
  emit();
}

export function useBrowserFloatSlot(key: string): HTMLElement | null {
  const read = () => slots.get(key) ?? null;
  return useSyncExternalStore(subscribe, read, read);
}

export function onBrowserFloatSlotRemoved(
  key: string,
  rescue: (slot: HTMLElement) => void,
): () => void {
  let set = slotRemovalListeners.get(key);
  if (!set) {
    set = new Set();
    slotRemovalListeners.set(key, set);
  }
  set.add(rescue);
  return () => {
    const current = slotRemovalListeners.get(key);
    if (!current) return;
    current.delete(rescue);
    if (!current.size) slotRemovalListeners.delete(key);
  };
}

// ── Agent browser picture in picture ─────────────────────

/** The agent PiP owns the bottom-right corner while it is shown; floated
 * tabs stack above it. */
export function setBrowserAgentPipSurface(element: HTMLElement | null): void {
  if (agentPipSurface === element) return;
  agentPipSurface = element;
  emit();
}

export function useBrowserAgentPipSurface(): HTMLElement | null {
  const read = () => agentPipSurface;
  return useSyncExternalStore(subscribe, read, read);
}

// ── DOM ──────────────────────────────────────────────────

type StatePreservingParent = Element & {
  moveBefore?: (node: Node, child: Node | null) => void;
};

/** Appends `node` to `parent`, preserving iframe browsing contexts when the
 * platform supports atomic moves. Returns false when it had to fall back to a
 * plain insert (first attach, or a move between connected/disconnected
 * trees), which reloads any iframe inside. */
export function moveNodePreservingState(parent: Element, node: Element): boolean {
  const target = parent as StatePreservingParent;
  if (
    typeof target.moveBefore === "function" &&
    parent.isConnected &&
    node.isConnected &&
    parent.ownerDocument === node.ownerDocument
  ) {
    try {
      target.moveBefore(node, null);
      return true;
    } catch {
      // Fall through: a rejected atomic move still has to land the node.
    }
  }
  parent.appendChild(node);
  return false;
}

export function resetBrowserFloatsForTesting(): void {
  entries = EMPTY_ENTRIES;
  entriesByScope.clear();
  slots.clear();
  slotRemovalListeners.clear();
  agentPipSurface = null;
  emit();
}
