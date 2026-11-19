import {
  readPreferenceCache,
  writePreferenceCache,
  subscribePreferenceCache,
} from "../../platform/personal-preferences";

import { useCallback, useSyncExternalStore } from "react";
import type { AgentControlFeature } from "@zeros/protocol/agent-control-rollout";

export type ExperimentalFeature =
  | "terminalAgents"
  | "hideArchivedWorkspacesAfter15Days"
  | "gibberishAgentThinking"
  | AgentControlFeature;

// This persisted key also identifies the preference in the shared cache.
const STORAGE_KEY = "zeros.experimentalFeatures";

type PersistedShape = Partial<Record<ExperimentalFeature, boolean>>;

function readPersisted(): PersistedShape {
  try {
    const raw = readPreferenceCache(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    // Retired preference: old installations may keep the key on disk, but it
    // must never re-enable original-folder work. Drop it on the next write.
    const retained = { ...parsed } as PersistedShape & {
      workInLocalMain?: boolean;
    };
    delete retained.workInLocalMain;
    return retained;
  } catch {
    return {};
  }
}

function writePersisted(next: PersistedShape): void {
  try {
    writePreferenceCache(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage quota / private mode — non-fatal */
  }
}

let current: PersistedShape = readPersisted();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): PersistedShape {
  return current;
}

export function isExperimentalEnabled(feature: ExperimentalFeature): boolean {
  return current[feature] === true;
}

export function setExperimentalEnabled(
  feature: ExperimentalFeature,
  on: boolean,
): void {
  current = { ...current, [feature]: on };
  writePersisted(current);
  emit();
}

// Windows share persisted flags but not in-memory snapshots.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    current = readPersisted();
    emit();
  });
}

export function useExperimentalFeature(
  feature: ExperimentalFeature,
): [boolean, (on: boolean) => void] {
  const persisted = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const on = persisted[feature] === true;
  const set = useCallback(
    (next: boolean) => setExperimentalEnabled(feature, next),
    [feature],
  );
  return [on, set];
}

subscribePreferenceCache(STORAGE_KEY, () => {
  current = readPersisted();
  emit();
});
