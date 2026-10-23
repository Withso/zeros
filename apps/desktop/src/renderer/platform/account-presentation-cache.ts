import { readPreferenceCache, writePreferenceCache } from "./personal-preferences";

const OWNER_KEY = "zeros-account-presentation-owner:v1";
export const ORGANIZATION_PRESENTATION_KEY = "organizations:v1";
export const CLOUD_CATALOG_PRESENTATION_KEY = "cloud-catalog:v1";
export const CLOUD_CHATS_PRESENTATION_KEY = "cloud-chats:v2";
export const CLOUD_TRANSCRIPT_SUMMARIES_PRESENTATION_KEY = "cloud-transcript-summaries:v1";
let owner: string | null | undefined;
let generation = 0;

export const accountPresentationOwner = (backend: string, account: string) =>
  JSON.stringify([backend.replace(/\/+$/, ""), account]);
export const getAccountPresentationOwner = () => owner ?? null;
export const accountPresentationGeneration = () => generation;

/** One account/backend on this device. A renderer reload retains its snapshot;
 * replacement or sign-out removes it before another identity can render. */
export function bindAccountPresentationOwner(next: string | null): { changed: boolean; retire: boolean } {
  if (owner === next) return { changed: false, retire: false };
  const saved = readPreferenceCache(OWNER_KEY);
  const retire = next === null || owner !== undefined || saved !== null && saved !== next;
  owner = next;
  generation++;
  if (retire) {
    for (const key of [ORGANIZATION_PRESENTATION_KEY, CLOUD_CATALOG_PRESENTATION_KEY, CLOUD_CHATS_PRESENTATION_KEY, CLOUD_TRANSCRIPT_SUMMARIES_PRESENTATION_KEY, "cloud-chats:v1"])
      writePreferenceCache(`zeros-${key}`, null);
  }
  writePreferenceCache(OWNER_KEY, next);
  return { changed: true, retire };
}

export function readAccountPresentation(key: string, expectedOwner: string, maxBytes: number): unknown {
  try {
    const raw = readPreferenceCache(`zeros-${key}`);
    if (!raw || raw.length * 2 > maxBytes) return null;
    const envelope = JSON.parse(raw);
    return envelope?.version === 1 && envelope.owner === expectedOwner ? envelope.value : null;
  } catch { return null; }
}

export function writeAccountPresentation(key: string, expectedOwner: string, value: unknown, maxBytes: number): void {
  try {
    const raw = JSON.stringify({ version: 1, owner: expectedOwner, value });
    // An oversized replacement must not leave removed rows in an older cache.
    writePreferenceCache(`zeros-${key}`, raw.length * 2 <= maxBytes ? raw : null);
  } catch { /* Presentation is best-effort; the server still owns the data. */ }
}
