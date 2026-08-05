// ──────────────────────────────────────────────────────────
// Context graph data — keyed server-state cache for the Context tab
// ──────────────────────────────────────────────────────────
//
// The graph listing is a bridge read keyed by the workspace folder, so it
// follows the same contract as workspace-file-data-cache.ts: bounded
// KeyedAsyncCache, request dedup, and retention of the last confirmed
// exact-key snapshot while a refresh is in flight (a refresh must
// never blank an already-rendered canvas).
//
// Scaffolding rides the first load: one idempotent `context.graph.scaffold`
// per folder per session, BEFORE the first list, so opening the Context tab
// is what materialises `.context-graph/` for pre-existing workspaces (new
// worktrees get it at create time in the engine).
// ──────────────────────────────────────────────────────────

import { useCallback, useSyncExternalStore } from "react";

import {
  listContextGraph,
  scaffoldContextGraph,
  type ContextGraphListWire,
} from "@/renderer/platform/context-graph";
import {
  KeyedAsyncCache,
  type AsyncCacheSnapshot,
} from "@/renderer/shared/lib/keyed-async-cache";

const graphCache = new KeyedAsyncCache<ContextGraphListWire>(32);

/** Folders whose scaffold ran this session — once is enough, the engine call
 *  is idempotent and re-runs on the attachment write path anyway. */
const scaffolded = new Set<string>();

function normalizeCwd(cwd: string): string {
  if (cwd === "/" || /^[A-Za-z]:[\\/]$/.test(cwd)) return cwd;
  return cwd.replace(/[\\/]+$/, "");
}

export function contextGraphKey(cwd: string): string {
  return normalizeCwd(cwd);
}

async function fetchContextGraph(cwd: string): Promise<ContextGraphListWire> {
  if (!scaffolded.has(cwd)) {
    // Best-effort: a client without graph writes (or a broken graph) still gets the listing;
    // the set is marked only on success so a transient failure retries.
    try {
      const res = await scaffoldContextGraph(cwd);
      if (res.ok) scaffolded.add(cwd);
    } catch {
      /* listing below still answers; the empty state explains the rest */
    }
  }
  return listContextGraph(cwd);
}

/** Subscribe to one folder's graph snapshot (stable references, exact-key). */
export function useContextGraphSnapshot(
  cwd: string,
): AsyncCacheSnapshot<ContextGraphListWire> {
  const key = contextGraphKey(cwd);
  const subscribe = useCallback(
    (listener: () => void) => graphCache.subscribe(key, listener),
    [key],
  );
  const getSnapshot = useCallback(() => graphCache.getSnapshot(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Read or refresh one folder's graph. Concurrent callers share the request;
 *  `force` bypasses the freshness window after a known mutation.
 *
 *  A forced load INVALIDATES first — the invalidate-before-load contract the
 *  other refresh-bus caches follow. Force alone is not enough here: the
 *  attach-time write signal fires while the tab's activation listing can
 *  still be in flight, and KeyedAsyncCache dedups a forced load into a
 *  non-stale pending request. Without the invalidation the PRE-write listing
 *  both satisfies the forced reload and publishes as fresh — the just-staged
 *  attachment stays off the canvas until the next unrelated refresh. The
 *  generation bump inside invalidate() also stops that stale in-flight
 *  response from publishing at all. */
export function loadContextGraph(
  cwd: string,
  options: { force?: boolean; maxAgeMs?: number } = {},
): Promise<ContextGraphListWire> {
  const key = contextGraphKey(cwd);
  if (options.force) graphCache.invalidate(key);
  return graphCache.load(key, () => fetchContextGraph(key), options);
}

/** Test-only reset. The cache stays a module singleton in production. */
export function resetContextGraphCacheForTests(): void {
  graphCache.clear();
  scaffolded.clear();
}
