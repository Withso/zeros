// ──────────────────────────────────────────────────────────
// pr-cache-forget — purge every PR-scoped renderer cache for one workspace
// ──────────────────────────────────────────────────────────
//
// Half a dozen modules keep bounded module-level caches keyed by
// `workspaceId#prNumber` (or the workspace id alone): the island's last
// settled batches (pr-status-island), PR-sync probe bookkeeping
// (use-workspace-pr-sync), the published island kinds (pr-island-state-store,
// persisted), the durable last-rendered states (pr-island-last-state,
// persisted), the anti-flap stability masks (pr-status-stability), and the
// Review snapshots (review-data). A permanently DELETED workspace can never
// be read under that id again, so its entries are dead weight — and the two
// localStorage-backed stores would otherwise carry them across relaunches
// until LRU pressure happens to evict them.
//
// Registry (not direct imports) on purpose: the natural aggregation point
// would import pr-status-island.tsx, which itself imports archive-actions —
// the very caller of this purge — creating an import cycle. Instead each
// cache-owning module registers a small forget function at load time and
// remains the sole owner of its key shape and persistence. A module that
// never loaded has empty in-memory caches, so a missing registration is
// harmless by construction.
//
// ARCHIVE deliberately does NOT purge: an archived workspace can be restored
// under the same id + PR, and the retained caches are exactly what makes the
// restored island/Review paint instantly instead of flashing "Loading...".

type ForgetPrWorkspaceCaches = (workspaceId: string) => void;

const forgetters = new Set<ForgetPrWorkspaceCaches>();

/** Called once, at module load, by each PR-cache-owning module. */
export function registerPrWorkspaceCacheForget(
  forget: ForgetPrWorkspaceCaches,
): void {
  forgetters.add(forget);
}

/** Drop every registered PR cache entry for this workspace id. Invoked by the
 *  confirmed-deletion commit (archive-actions) alongside
 *  forgetChangesSnapshots, after the engine authoritatively removed the row. */
export function forgetPrCachesForWorkspace(workspaceId: string): void {
  for (const forget of forgetters) forget(workspaceId);
}
