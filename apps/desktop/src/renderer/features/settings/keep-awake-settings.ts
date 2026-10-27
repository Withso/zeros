import { useEffect, useSyncExternalStore } from "react";
import type { KeepAwakePreferences } from "../../../../shared/keep-awake";
import { nativeInvoke, useNativeRuntime } from "../../platform/runtime";

interface KeepAwakeSettingsSnapshot {
  preferences: KeepAwakePreferences | null;
  saving: boolean;
  error: string | null;
}

// One device-owned snapshot survives Settings/owner switches. Main persists
// the preference outside Chromium's purgeable cache; no cloud write is made.
let snapshot: KeepAwakeSettingsSnapshot = { preferences: null, saving: false, error: null };
const listeners = new Set<() => void>();
let read: Promise<void> | null = null;
let revision = 0;

function publish(next: KeepAwakeSettingsSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function loadKeepAwakePreferences(): Promise<void> {
  if (snapshot.preferences) return Promise.resolve();
  if (read) return read;
  const atRevision = revision;
  read = nativeInvoke<KeepAwakePreferences>("keep_awake_get").then(preferences => {
    if (revision === atRevision) publish({ preferences, saving: false, error: null });
  }).catch(error => {
    if (revision === atRevision)
      publish({ ...snapshot, error: "Couldn't load the keep awake setting." });
    throw error;
  }).finally(() => { read = null; });
  return read;
}

export async function setKeepAwakeEnabled(enabled: boolean): Promise<void> {
  const atRevision = ++revision;
  publish({ ...snapshot, saving: true, error: null });
  try {
    const preferences = await nativeInvoke<KeepAwakePreferences>("keep_awake_set", { enabled });
    if (revision === atRevision) publish({ preferences, saving: false, error: null });
  } catch (error) {
    if (revision === atRevision) publish({ ...snapshot, saving: false });
    throw error;
  }
}

export function useKeepAwakeSettings(): KeepAwakeSettingsSnapshot {
  const { ready } = useNativeRuntime();
  useEffect(() => {
    if (ready) void loadKeepAwakePreferences().catch(() => {});
  }, [ready]);
  return useSyncExternalStore(subscribe, getKeepAwakeSettings, getKeepAwakeSettings);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getKeepAwakeSettings(): KeepAwakeSettingsSnapshot { return snapshot; }
