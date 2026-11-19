import { readPreferenceCache, writePreferenceCache } from "./personal-preferences";

const OWNER_KEY = "zeros-account-presentation-owner:v1";
export const ORGANIZATION_PRESENTATION_KEY = "organizations:v1";
export const CLOUD_CATALOG_PRESENTATION_KEY = "cloud-catalog:v1";
export const CLOUD_CHATS_PRESENTATION_KEY = "cloud-chats:v2";
export const CLOUD_FILE_LIST_PRESENTATION_KEY = "cloud-file-lists:v1";
export const CLOUD_TRANSCRIPT_SUMMARIES_PRESENTATION_KEY = "cloud-transcript-summaries:v1";
let owner: string | null | undefined;
let generation = 0;
let storage: { read(key: string): string | null; write(key: string, raw: string | null): void } = {
  read: readPreferenceCache,
  write: writePreferenceCache,
};

export function isolateAccountPresentationStorageForTests(): void {
  const entries = new Map<string, string>();
  storage = {
    read: (key) => entries.get(key) ?? null,
    write: (key, raw) => {
      if (raw === null) entries.delete(key);
      else entries.set(key, raw);
    },
  };
}

export const accountPresentationOwner = (backend: string, account: string) =>
  JSON.stringify([backend.replace(/\/+$/, ""), account]);
export const getAccountPresentationOwner = () => owner ?? null;
export const accountPresentationGeneration = () => generation;

/** Retain presentation across reload for the same account/backend; retire it on replacement or sign-out. */
export function bindAccountPresentationOwner(next: string | null): { changed: boolean; retire: boolean } {
  if (owner === next) return { changed: false, retire: false };
  const saved = storage.read(OWNER_KEY);
  const retire = next === null || owner !== undefined || saved !== null && saved !== next;
  owner = next;
  generation++;
  if (retire) {
    for (const key of [ORGANIZATION_PRESENTATION_KEY, CLOUD_CATALOG_PRESENTATION_KEY, CLOUD_CHATS_PRESENTATION_KEY, CLOUD_FILE_LIST_PRESENTATION_KEY, CLOUD_TRANSCRIPT_SUMMARIES_PRESENTATION_KEY, "cloud-chats:v1"])
      storage.write(`zeros-${key}`, null);
  }
  storage.write(OWNER_KEY, next);
  return { changed: true, retire };
}

export function readAccountPresentation(key: string, expectedOwner: string, maxBytes: number): unknown {
  try {
    const raw = storage.read(`zeros-${key}`);
    if (!raw || raw.length * 2 > maxBytes) return null;
    const envelope = JSON.parse(raw);
    return envelope?.version === 1 && envelope.owner === expectedOwner ? envelope.value : null;
  } catch { return null; }
}

export function writeAccountPresentation(key: string, expectedOwner: string, value: unknown, maxBytes: number): void {
  try {
    const raw = JSON.stringify({ version: 1, owner: expectedOwner, value });
    // An oversized replacement must not leave removed rows in an older cache.
    storage.write(`zeros-${key}`, raw.length * 2 <= maxBytes ? raw : null);
  } catch { /* Presentation is best-effort; the server still owns the data. */ }
}
