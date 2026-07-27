// ──────────────────────────────────────────────────────────
// Row-1 editor dirty registry — which File tabs hold unsaved edits?
// ──────────────────────────────────────────────────────────
//
// SourceEditor's draft stays component-local, but a dirty File tab remains
// mounted while inactive so switching to Terminal/Browser cannot destroy the
// draft. This registry is the small external-store seam that tells Column3
// which otherwise-lazy File tabs must remain alive. It also lets navigation
// avoid replacing a dirty File tab with another path and lets PR auto-focus
// avoid yanking away while ANY editor has unsaved work.

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const EMPTY_DIRTY_EDITORS: ReadonlySet<string> = new Set();
let dirtyEditorIds: ReadonlySet<string> = EMPTY_DIRTY_EDITORS;

/** Set by one SourceEditor whenever its dirty state changes. */
export function setRow1EditorDirty(editorId: string, value: boolean): void {
  if (!editorId || dirtyEditorIds.has(editorId) === value) return;
  const next = new Set(dirtyEditorIds);
  if (value) next.add(editorId);
  else next.delete(editorId);
  dirtyEditorIds = next.size > 0 ? next : EMPTY_DIRTY_EDITORS;
  for (const listener of listeners) listener();
}

/** True for one File tab, or for any File tab when no id is supplied. */
export function isRow1EditorDirty(editorId?: string): boolean {
  return editorId ? dirtyEditorIds.has(editorId) : dirtyEditorIds.size > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ReadonlySet<string> {
  return dirtyEditorIds;
}

/** Reactive dirty-id snapshot for Column3 and file-open navigation. */
export function useRow1DirtyEditorIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY_DIRTY_EDITORS);
}

/** Test-only reset for the module singleton. */
export function resetRow1EditorDirtyForTests(): void {
  if (dirtyEditorIds.size === 0) return;
  dirtyEditorIds = EMPTY_DIRTY_EDITORS;
  for (const listener of listeners) listener();
}
