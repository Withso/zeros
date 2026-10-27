import { useSyncExternalStore } from "react";

export interface FileEditorPreferences {
  autoSave: boolean;
  diffView: boolean;
}
const KEY = "zeros:file-editor:v1";
const DEFAULTS: FileEditorPreferences = { autoSave: true, diffView: false };
const listeners = new Set<() => void>();
function read(): FileEditorPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (value && typeof value === "object") {
      const stored = value as Partial<FileEditorPreferences>;
      return {
        autoSave: typeof stored.autoSave === "boolean" ? stored.autoSave : true,
        diffView:
          typeof stored.diffView === "boolean" ? stored.diffView : false,
      };
    }
  } catch {
    /* private mode or malformed preferences */
  }
  return DEFAULTS;
}
let snapshot = read();
const getSnapshot = () => snapshot;
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useFileEditorPreferences(): FileEditorPreferences {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
export function setFileEditorPreferences(
  update: Partial<FileEditorPreferences>,
): void {
  const next = { ...snapshot, ...update };
  if (
    next.autoSave === snapshot.autoSave &&
    next.diffView === snapshot.diffView
  )
    return;
  snapshot = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    /* private mode */
  }
  for (const listener of listeners) listener();
}
