// ──────────────────────────────────────────────────────────
// workspace-files-cache — one shared, short-lived file list per cwd
// ──────────────────────────────────────────────────────────
//
// `listWorkspaceFiles` runs `git ls-files` (up to ~20k paths) — too heavy to
// call on every file-tree render or every agent-chat chip click. This caches
// the result briefly so:
//
//   • ordinary remounts reuse the SAME array reference so setState bails (no
//     re-render / tree resetPaths churn), while an explicit git/files refresh
//     invalidates the active cwd first and therefore never serves a deleted
//     path from the TTL cache; and
//   • agent-chat chip clicks resolve SYNCHRONOUSLY against the warm cache
//     (`peekWorkspaceFiles`) and open the tab instantly — no IPC before the tab
//     appears (the "pause / no response" the user reported).
//
// Bounded to a handful of workspaces so it never grows with usage (the user
// cares about RAM). Each cwd carries a generation: invalidating while an older
// request is in flight prevents that older response from overwriting the fresh
// result and resurrecting a file that was just discarded/deleted.
// ──────────────────────────────────────────────────────────

import { listWorkspaceFiles } from "@/native/git";

type Entry = { files: string[]; at: number; stale: boolean };
type InflightEntry = { generation: number; promise: Promise<string[]> };

const cache = new Map<string, Entry>();
const inflight = new Map<string, InflightEntry>();
const generations = new Map<string, number>();

const FRESH_MS = 4_000;
const MAX_ENTRIES = 12;
const MAX_GENERATIONS = 48;

function touchCacheEntry(key: string, entry: Entry): void {
  // Map iteration order is the LRU queue: a successful read/peek makes this
  // workspace the newest candidate instead of letting idle prefetch evict the
  // folder the user is actively navigating.
  cache.delete(key);
  cache.set(key, entry);
}

function writeCacheEntry(key: string, entry: Entry): void {
  touchCacheEntry(key, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Canonical cache identity for a workspace folder. Async operations can capture
 * `/repo/` while the active chat resolves to `/repo`. Treat them as one
 * workspace without mangling POSIX `/` or a Windows drive root (`C:\\`).
 * Exported so the sibling per-workspace listing caches key one folder one way. */
export function workspaceCacheKey(cwd: string): string {
  if (cwd === "/" || /^[A-Za-z]:[\\/]$/.test(cwd)) return cwd;
  return cwd.replace(/[\\/]+$/, "");
}

function pruneGenerations(): void {
  if (generations.size <= MAX_GENERATIONS) return;
  for (const cwd of generations.keys()) {
    // Never forget the guard for a request that can still resolve, or its old
    // generation could become current again and publish stale paths.
    if (inflight.has(cwd) || cache.has(cwd)) continue;
    generations.delete(cwd);
    if (generations.size <= MAX_GENERATIONS) break;
  }
}

/** Cached file list for `cwd`. Returns the cached array (same reference) when
 * it's fresher than FRESH_MS; otherwise fetches once (deduping concurrent
 * callers) and caches. A failed refresh keeps and returns prior exact-key rows;
 * a cold failure rejects so no consumer can mistake transport absence for an
 * authoritative empty workspace. */
export async function loadWorkspaceFiles(cwd: string): Promise<string[]> {
  const key = workspaceCacheKey(cwd);
  const hit = cache.get(key);
  if (hit && !hit.stale && Date.now() - hit.at < FRESH_MS) {
    touchCacheEntry(key, hit);
    return hit.files;
  }

  const generation = generations.get(key) ?? 0;
  const pending = inflight.get(key);
  if (pending?.generation === generation) return pending.promise;

  const p = listWorkspaceFiles(cwd)
    .then((files) => {
      // An invalidation may have happened while git ls-files was running. That
      // response describes the OLD disk generation: return it to its original
      // caller, but never publish it into the shared cache.
      if ((generations.get(key) ?? 0) !== generation) return files;
      // Preserve the published array when the listing is byte-for-byte the
      // same. @pierre/trees treats `paths` as model input; handing it a fresh
      // but equal array needlessly resets/reconciles every visible row.
      const previous = cache.get(key)?.files;
      const stableFiles = sameFileList(previous, files) ? previous! : files;
      writeCacheEntry(key, {
        files: stableFiles,
        at: Date.now(),
        stale: false,
      });
      return stableFiles;
    })
    .catch((error: unknown) => {
      const retained = cache.get(key)?.files;
      if (retained !== undefined) return retained;
      throw error;
    })
    .finally(() => {
      // A newer generation may already own this cwd's in-flight slot. Never
      // let the old request's finally delete the newer request.
      if (inflight.get(key)?.promise === p) inflight.delete(key);
    });

  inflight.set(key, { generation, promise: p });
  return p;
}

/** Mark one workspace's file list stale. The next load bypasses both the TTL
 * cache and any older in-flight request. Called by the shared git refresh hook
 * before consumers render with their new refresh key. */
export function invalidateWorkspaceFiles(cwd: string | undefined): void {
  if (!cwd) return;
  const key = workspaceCacheKey(cwd);
  generations.set(key, (generations.get(key) ?? 0) + 1);
  const retained = cache.get(key);
  if (retained) retained.stale = true;
  pruneGenerations();
}

/** A coarse engine DB_CHANGED does not identify which workspace changed. Drop
 * every bounded file-list entry so a background worktree edit cannot remain
 * stale when the user switches back to it within the normal TTL. */
export function invalidateAllWorkspaceFiles(): void {
  const cwds = new Set([
    ...cache.keys(),
    ...inflight.keys(),
    ...generations.keys(),
  ]);
  for (const cwd of cwds) {
    generations.set(cwd, (generations.get(cwd) ?? 0) + 1);
    const retained = cache.get(cwd);
    if (retained) retained.stale = true;
  }
  pruneGenerations();
}

/** Test-only reset for the module singleton. */
export function resetWorkspaceFilesCacheForTests(): void {
  cache.clear();
  inflight.clear();
  generations.clear();
}

/** Synchronous best-effort peek — the cached list (even if slightly stale) or
 *  null if this cwd was never loaded. Lets a click resolve without waiting. */
export function peekWorkspaceFiles(cwd: string): string[] | null {
  const key = workspaceCacheKey(cwd);
  const entry = cache.get(key);
  if (!entry) return null;
  touchCacheEntry(key, entry);
  return entry.files;
}

/** Prime the cache in the background (no await) — call when a chat / folder
 *  becomes active so the first file click resolves synchronously. */
export function warmWorkspaceFiles(cwd: string | undefined): void {
  if (cwd) void loadWorkspaceFiles(cwd).catch(() => {});
}

function sameFileList(
  previous: readonly string[] | undefined,
  next: readonly string[],
): boolean {
  return (
    previous !== undefined &&
    previous.length === next.length &&
    previous.every((path, index) => path === next[index])
  );
}
