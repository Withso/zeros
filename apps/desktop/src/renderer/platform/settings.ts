// ──────────────────────────────────────────────────────────
// Native Settings API — single entry point for user prefs
// ──────────────────────────────────────────────────────────
//
// localStorage-backed in both the native renderer and Vite development harness.
//
// ──────────────────────────────────────────────────────────

const PREFIX = "zeros-";

export function getSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Legacy plain strings (pre-JSON) — return as-is if T is string-compatible
      return raw as unknown as T;
    }
  } catch {
    return fallback;
  }
}

/** Best-effort write. Returns whether the value actually landed — quota and
 *  privacy-mode failures are swallowed, so a caller that is about to DESTROY
 *  the only other copy of this value (see getSettingMigrated) has to be able
 *  to tell. Existing callers may keep ignoring the result. */
export function setSetting<T>(key: string, value: T): boolean {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    // Ignore quota / privacy errors — settings are best-effort.
    return false;
  }
}

export function removeSetting(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // Ignore.
  }
}

/** Read a key that used to live under a different name, moving the old value
 *  across on first read and clearing the old slot. Renaming a persisted key
 *  otherwise silently resets it for every existing user — the value is gone,
 *  not defaulted, so callers can't tell "never set" from "set under the old
 *  name". Call it in place of getSetting at the reader; it is idempotent and
 *  costs one extra localStorage read only until the move happens.
 *
 *  The legacy key is removed ONLY once the new key demonstrably holds the
 *  value: `setSetting` swallows quota/privacy failures, so removing first (or
 *  unconditionally) can destroy the sole copy — losing exactly the selection
 *  this function exists to preserve. On a failed copy we return the legacy
 *  value and leave it in place, so the next launch retries. */
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

  // Write, then READ BACK. The return value alone isn't enough: a storage that
  // accepts setItem and drops the value (Safari private mode has shipped this)
  // would still report success.
  const wrote = setSetting(key, legacy);
  const readBack = getSetting<T>(key, sentinel);
  if (wrote && readBack !== sentinel) removeSetting(legacyKey);
  return legacy;
}
