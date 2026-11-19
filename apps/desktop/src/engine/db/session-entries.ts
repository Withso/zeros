/** Top-level entries of an Electron session profile that Chromium rebuilds on
 * demand, for per-entry classification (`pnpm storage:sweep` keeps an equal
 * copy). No directory is clearable as a whole. Everything else, including
 * names this list does not know, is durable renderer state (Local Storage,
 * IndexedDB, Cookies, Session Storage, WebStorage, Service Worker, Partitions,
 * …). Observed on Electron 43 / Chromium 150; see docs/storage-layout.md. */
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
  // Per-run blob swap (`blob_storage/<run id>`); Chromium removes old runs. Not
  // IndexedDB's blob store, which lives inside IndexedDB/.
  "blob_storage",
] as const;

export function isRegenerableSessionEntry(name: string): boolean {
  return (REGENERABLE_SESSION_ENTRIES as readonly string[]).includes(name);
}
