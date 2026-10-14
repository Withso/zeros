import { useSyncExternalStore } from "react";
import { PERSONAL_PREFERENCE_STORAGE } from "@zeros/protocol/personal-preferences";
import {
  readPreferenceCache,
  subscribePreferenceCache,
  writePreferenceCache,
} from "../../platform/personal-preferences";

export type FollowUpBehavior = "queue" | "steer";

const storageKey = PERSONAL_PREFERENCE_STORAGE.follow_up_behavior;
const listeners = new Set<() => void>();

/** Queue is also the fallback for older settings files and invalid caches. */
export function getFollowUpBehavior(): FollowUpBehavior {
  return readPreferenceCache(storageKey) === '"steer"' ? "steer" : "queue";
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function setFollowUpBehavior(value: FollowUpBehavior): void {
  if (value === getFollowUpBehavior()) return;
  writePreferenceCache(storageKey, JSON.stringify(value));
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFollowUpBehavior(): FollowUpBehavior {
  return useSyncExternalStore(subscribe, getFollowUpBehavior, getFollowUpBehavior);
}

subscribePreferenceCache(storageKey, emit);
if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (event.key === storageKey || event.key === null) emit();
  });
}
