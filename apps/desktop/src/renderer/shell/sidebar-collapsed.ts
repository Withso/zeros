// ──────────────────────────────────────────────────────────
// App sidebar collapse — one persisted, app-wide preference
// ──────────────────────────────────────────────────────────
//
// The sidebar's panel-left toggle hides the whole sidebar. It is a single
// presentation preference (not per-workspace state), read synchronously so
// the first paint after a reload already has the right layout.

import { useSyncExternalStore } from "react";
import { getSetting, setSetting } from "../platform/settings";

const KEY = "app-sidebar-collapsed";
const listeners = new Set<() => void>();
let collapsed: boolean | null = null;

function current(): boolean {
  collapsed ??= getSetting<unknown>(KEY, false) === true;
  return collapsed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function sidebarCollapsed(): boolean {
  return current();
}

export function setSidebarCollapsed(next: boolean): void {
  if (current() === next) return;
  collapsed = next;
  setSetting(KEY, next);
  for (const listener of listeners) listener();
}

export function toggleSidebarCollapsed(): void {
  setSidebarCollapsed(!current());
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, current, () => false);
}

/** Test-only reset for the module snapshot. */
export function resetSidebarCollapsedForTests(): void {
  collapsed = null;
  listeners.clear();
}
