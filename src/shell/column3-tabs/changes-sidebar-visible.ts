// ──────────────────────────────────────────────────────────
// Changes-tab sidebar visibility — shared, persisted toggle
// ──────────────────────────────────────────────────────────
//
// The row-1 Changes tab's changed-file sidebar can be hidden (the toggle at
// the start of its toolbar) to give the diff the full column. Like the
// sidebar WIDTH (files-sidebar-width), visibility is ONE user preference, not
// per-tab/per-workspace state: every Changes tab reads the same module store,
// and the choice survives reloads via localStorage. Defaults to VISIBLE — the
// sidebar is the tab's primary navigation.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "zeros:changes-sidebar-visible:v1";

function load(): boolean {
  if (typeof window === "undefined") return true;
  try {
    // Anything other than an explicit opt-out reads as visible.
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();
let visible = load();

/** Set (and persist) whether the Changes-tab sidebar is shown. */
export function setChangesSidebarVisible(next: boolean): void {
  if (next === visible) return;
  visible = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* quota errors ignored */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Non-reactive read of the current visibility (tests / event handlers). */
export function getChangesSidebarVisible(): boolean {
  return visible;
}

function snapshot(): boolean {
  return visible;
}

/** Reactive visibility of the Changes-tab sidebar. */
export function useChangesSidebarVisible(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test-only reset for the module singleton. */
export function resetChangesSidebarVisibleForTests(): void {
  visible = true;
  listeners.clear();
}
