import { useSyncExternalStore } from "react";
import {
  readPreferenceCache,
  writePreferenceCache,
  subscribePreferenceCache,
} from "../../platform/personal-preferences";

const STORAGE_KEY = "zeros:dashboard-show-hidden:v1";
const listeners = new Set<() => void>();
let current = readPreferenceCache(STORAGE_KEY) === "true";
function emit(): void {
  for (const listener of listeners) listener();
}
export function setShowHiddenWorkspaces(value: boolean): void {
  if (value === current) return;
  current = value;
  writePreferenceCache(STORAGE_KEY, JSON.stringify(value));
  emit();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useShowHiddenWorkspaces(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}
function reload(): void {
  current = readPreferenceCache(STORAGE_KEY) === "true";
  emit();
}
subscribePreferenceCache(STORAGE_KEY, reload);
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) reload();
  });
