// ──────────────────────────────────────────────────────────
// Context graph data — keyed server-state cache for the Context tab
// ──────────────────────────────────────────────────────────
//
// The graph listing is a bridge read keyed by the workspace folder, so it
// follows the same contract as workspace-file-data-cache.ts: bounded
// KeyedAsyncCache, request dedup, and retention of the last confirmed
// exact-key snapshot while a refresh is in flight (Rule 11 — a refresh must
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
} from "@/native/context-graph";
import {
  KeyedAsyncCache,
  type AsyncCacheSnapshot,
} from "@/zeros/lib/keyed-async-cache";

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
    // Best-effort: a web client (or a broken graph) still gets the listing;
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
 *  `force` bypasses the freshness window after a known mutation. */
export function loadContextGraph(
  cwd: string,
  options: { force?: boolean; maxAgeMs?: number } = {},
): Promise<ContextGraphListWire> {
  const key = contextGraphKey(cwd);
  return graphCache.load(key, () => fetchContextGraph(key), options);
}

/** Test-only reset. The cache stays a module singleton in production. */
export function resetContextGraphCacheForTests(): void {
  graphCache.clear();
  scaffolded.clear();
}
