import { useSyncExternalStore } from "react";
import { PERSONAL_PREFERENCE_STORAGE } from "@zeros/protocol/personal-preferences";
import {
  readPreferenceCache,
  subscribePreferenceCache,
  writePreferenceCache,
} from "../../platform/personal-preferences";

const storageKey = PERSONAL_PREFERENCE_STORAGE.show_in_between_messages;
const listeners = new Set<() => void>();

/** On unless explicitly turned off, including for older settings files. */
export function getShowInBetweenMessages(): boolean {
  return readPreferenceCache(storageKey) !== "false";
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function setShowInBetweenMessages(value: boolean): void {
  if (value === getShowInBetweenMessages()) return;
  writePreferenceCache(storageKey, JSON.stringify(value));
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useShowInBetweenMessages(): boolean {
  return useSyncExternalStore(subscribe, getShowInBetweenMessages, getShowInBetweenMessages);
}

subscribePreferenceCache(storageKey, emit);
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null) emit();
  });
}
