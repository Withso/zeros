import { useSyncExternalStore } from "react";
import { PERSONAL_PREFERENCE_STORAGE } from "@zeros/protocol/personal-preferences";
import {
  readPreferenceCache,
  subscribePreferenceCache,
  writePreferenceCache,
} from "../../platform/personal-preferences";

const storageKey = PERSONAL_PREFERENCE_STORAGE.restart_automatically_on_update;
const listeners = new Set<() => void>();

/** Automatic restarts require an explicit opt-in, including in older files. */
export function getRestartAutomaticallyOnUpdate(): boolean {
  return readPreferenceCache(storageKey) === "true";
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function setRestartAutomaticallyOnUpdate(value: boolean): void {
  if (value === getRestartAutomaticallyOnUpdate()) return;
  writePreferenceCache(storageKey, JSON.stringify(value));
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRestartAutomaticallyOnUpdate(): boolean {
  return useSyncExternalStore(
    subscribe,
    getRestartAutomaticallyOnUpdate,
    getRestartAutomaticallyOnUpdate,
  );
}

subscribePreferenceCache(storageKey, emit);
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null) emit();
  });
}
