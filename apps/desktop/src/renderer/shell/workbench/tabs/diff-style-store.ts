// Unified/split is one app-wide presentation preference. An external store
// keeps every retained FileViewer synchronized without routing a global value
// through each workspace/tab slice.

import { useSyncExternalStore } from "react";

export type DiffStyle = "unified" | "split";

const STORAGE_KEY = "zeros:diff-style:v1";
const listeners = new Set<() => void>();

function readPersisted(): DiffStyle {
  if (typeof window === "undefined") return "unified";
  try {
    return localStorage.getItem(STORAGE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

let snapshot: DiffStyle = readPersisted();

export function subscribeDiffStyle(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDiffStyle(): DiffStyle {
  return snapshot;
}

export function useDiffStyle(): DiffStyle {
  return useSyncExternalStore(subscribeDiffStyle, getDiffStyle, getDiffStyle);
}

export function setDiffStyle(next: DiffStyle): void {
  if (snapshot === next) return;
  snapshot = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* quota / private mode */
  }
  for (const listener of listeners) listener();
}

/** Test-only reset; also useful after replacing localStorage in a test realm. */
export function _resetDiffStyleForTests(): void {
  snapshot = readPersisted();
  listeners.clear();
}
