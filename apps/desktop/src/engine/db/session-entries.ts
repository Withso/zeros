/** Top-level entries of an Electron session profile that Chromium rebuilds on
 * demand. Everything else, including names this list does not know, is durable
 * renderer state (Local Storage, IndexedDB, Cookies, Session Storage,
 * WebStorage, Service Worker, Partitions, …). Observed on Electron 43 /
 * Chromium 150; see docs/storage-layout.md. */
export const REGENERABLE_SESSION_ENTRIES = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnWebGPUCache",
  "DawnGraphiteCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "Shared Dictionary",
  "VideoDecodeStats",
  "Dictionaries",
] as const;

/** The regenerable entries main relocates out of the session profile into
 * the cache dir (`session.setCodeCachePath`). The rest cannot be relocated on
 * this Electron and stay in the profile. */
export const CACHE_DIR_SESSION_ENTRIES = ["Code Cache"] as const;

export function isRegenerableSessionEntry(name: string): boolean {
  return (REGENERABLE_SESSION_ENTRIES as readonly string[]).includes(name);
}
