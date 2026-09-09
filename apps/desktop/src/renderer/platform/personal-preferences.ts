import {
  PERSONAL_PREFERENCE_STORAGE,
  personalPreferencesSchema,
  type PersonalPreferenceKey,
} from "@zeros/protocol/personal-preferences";

const keyByStorage = new Map(
  Object.entries(PERSONAL_PREFERENCE_STORAGE).map(([key, storage]) => [
    storage,
    key as PersonalPreferenceKey,
  ]),
);
const listeners = new Map<string, Set<() => void>>();
const pendingListeners = new Set<() => void>();
const cache = new Map<string, string | null>();
const volatileKeys = new Set<string>();
const OUTBOX = "zeros-personal-preferences-pending";
const pending = new Map<
  PersonalPreferenceKey,
  { value: unknown; version: number }
>();
let version = 0;

try {
  const saved = JSON.parse(localStorage.getItem(OUTBOX) ?? "{}");
  for (const [key, value] of Object.entries(saved)) {
    if (!Object.hasOwn(PERSONAL_PREFERENCE_STORAGE, key)) continue;
    if (
      value === null ||
      personalPreferencesSchema.safeParse({ [key]: value }).success
    )
      pending.set(key as PersonalPreferenceKey, { value, version: ++version });
  }
} catch {
  /* no pending writes */
}

function persistPending(): void {
  try {
    localStorage.setItem(
      OUTBOX,
      JSON.stringify(
        Object.fromEntries(
          [...pending].map(([key, entry]) => [key, entry.value]),
        ),
      ),
    );
  } catch {
    /* memory copy remains */
  }
}
export function readPreferenceCache(storage: string): string | null {
  if (volatileKeys.has(storage)) return cache.get(storage) ?? null;
  try {
    return localStorage.getItem(storage);
  } catch {
    return cache.get(storage) ?? null;
  }
}
export function writePreferenceCache(
  storage: string,
  raw: string | null,
): boolean {
  const key = keyByStorage.get(storage);
  if (key) {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (
      value === null ||
      personalPreferencesSchema.safeParse({ [key]: value }).success
    ) {
      cache.set(storage, raw);
      pending.set(key, { value, version: ++version });
      persistPending();
      for (const listener of pendingListeners) listener();
    }
  }
  try {
    if (raw === null) localStorage.removeItem(storage);
    else localStorage.setItem(storage, raw);
    volatileKeys.delete(storage);
    return true;
  } catch {
    if (key) volatileKeys.add(storage);
    return false;
  }
}
export function subscribePreferenceCache(
  storage: string,
  listener: () => void,
): () => void {
  let set = listeners.get(storage);
  if (!set) {
    set = new Set();
    listeners.set(storage, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
export function onPendingPreferences(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}
export function pendingPreferences() {
  return new Map(pending);
}
export function legacyPersonalPreferences(): Record<string, unknown> {
  const legacy: Record<string, unknown> = {};
  for (const [key, storage] of Object.entries(PERSONAL_PREFERENCE_STORAGE)) {
    try {
      const value: unknown = JSON.parse(readPreferenceCache(storage) ?? "null");
      if (
        value !== null &&
        personalPreferencesSchema.safeParse({ [key]: value }).success
      )
        legacy[key] = value;
    } catch {
      /* invalid legacy values are retained in their cache */
    }
  }
  return legacy;
}
export function acceptPersonalPreferences(
  doc: unknown,
  sent: ReturnType<typeof pendingPreferences>,
): void {
  const parsed = personalPreferencesSchema.parse(doc);
  for (const [key, entry] of sent)
    if (pending.get(key)?.version === entry.version) pending.delete(key);
  persistPending();
  for (const [key, storage] of Object.entries(PERSONAL_PREFERENCE_STORAGE)) {
    if (pending.has(key as PersonalPreferenceKey)) continue;
    const value = parsed[key as PersonalPreferenceKey];
    const raw = value === undefined ? null : JSON.stringify(value);
    if (readPreferenceCache(storage) === raw) continue;
    cache.set(storage, raw);
    try {
      if (raw === null) localStorage.removeItem(storage);
      else localStorage.setItem(storage, raw);
      volatileKeys.delete(storage);
    } catch {
      volatileKeys.add(storage);
      /* synchronous memory cache remains */
    }
    for (const listener of listeners.get(storage) ?? []) listener();
  }
}
