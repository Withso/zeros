import {
  readPreferenceCache,
  writePreferenceCache,
} from "./personal-preferences";
const PREFIX = "zeros-";

export function getSetting<T>(key: string, fallback: T): T {
  try {
    const raw = readPreferenceCache(PREFIX + key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Some legacy preferences were stored as plain strings, not JSON.
      return raw as unknown as T;
    }
  } catch {
    return fallback;
  }
}

/** The boolean reports whether the persistent write succeeded, not whether the preference was queued in memory. */
export function setSetting<T>(key: string, value: T): boolean {
  try {
    return writePreferenceCache(PREFIX + key, JSON.stringify(value));
  } catch {
    return false;
  }
}

export function removeSetting(key: string): void {
  try {
    writePreferenceCache(PREFIX + key, null);
  } catch {
    // Removal never throws to the caller.
  }
}

/** Keep returning the legacy value until storage confirms its replacement; otherwise renaming a key can erase the only copy. */
export function getSettingMigrated<T>(
  key: string,
  legacyKey: string,
  fallback: T,
): T {
  const sentinel = Symbol("unset") as unknown as T;
  const current = getSetting<T>(key, sentinel);
  if (current !== sentinel) return current;
  const legacy = getSetting<T>(legacyKey, sentinel);
  if (legacy === sentinel) return fallback;

  // Read back the new key: browser storage can accept a write without retaining the value.
  const wrote = setSetting(key, legacy);
  const readBack = getSetting<T>(key, sentinel);
  if (wrote && readBack !== sentinel) removeSetting(legacyKey);
  return legacy;
}
