// ──────────────────────────────────────────────────────────
// pr-status-stability — keep the island from flapping through "Checking…"
// ──────────────────────────────────────────────────────────
//
// GitHub computes `mergeable_state` LAZILY: the first pulls.get after any
// push/merge/base-move — or simply after its cache expires while the app was
// in the background — returns "unknown" while it recomputes (usually a few
// seconds). Deriving that batch verbatim produces the flap the 2026-07-19 UX
// spec forbids: "Ready to merge" → "Checking mergeability…" → "Ready to
// merge" with no user action in between.
//
// The rule (2026-07-21, hardened): "checking" is a TRANSIENT, never a status.
// When a batch derives it, keep rendering the LAST DEFINITIVE state — actions
// included — for the SAME head/base generation, with no time limit. The
// island keeps probing in the background (fast re-probes, then the slow
// poll); the row changes only when GitHub settles on a state that actually
// differs. The generation-scoped key is the safety boundary: a new push
// (this client or another) changes the key, so a fresh head can never wear
// the previous head's "Ready to merge". An action clicked off a masked state
// is server-validated anyway (e.g. merge on a PR that silently became
// conflicted fails with an error toast, and the refetch re-derives).
//
// "Checking mergeability…" therefore renders only when there is nothing
// definitive to hold: a true first look at this generation (fresh PR, app
// restart, post-push new head).
//
// Direct actions call clearPrIslandStability first: the action deliberately
// invalidated the old state, so masking with it would read as a dead click.
//
// Module-level (not React state) so the mask survives the unmount/remount of
// row-1 tab switches and workspace hops, exactly like the island's last-known
// data cache.
// ──────────────────────────────────────────────────────────

import type { PrIslandState } from "./pr-status";
import { registerPrWorkspaceCacheForget } from "./pr-cache-forget";

const MAX_STABILITY_ENTRIES = 64;
const lastDefinitive = new Map<string, PrIslandState>();

// Deletion purge (pr-cache-forget): stability keys embed the island dataKey
// (`workspaceId#prNumber@generation`), so a prefix match drops every
// generation's mask for the permanently deleted workspace.
registerPrWorkspaceCacheForget((workspaceId) => {
  const prefix = `${workspaceId}#`;
  for (const key of lastDefinitive.keys()) {
    if (key.startsWith(prefix)) lastDefinitive.delete(key);
  }
});

function remember(key: string, state: PrIslandState): void {
  lastDefinitive.delete(key);
  lastDefinitive.set(key, state);
  while (lastDefinitive.size > MAX_STABILITY_ENTRIES) {
    const oldest = lastDefinitive.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    lastDefinitive.delete(oldest);
  }
}

/** Resolve what the island should RENDER for this derivation. Definitive
 *  states pass through (and become the mask anchor); a "checking" derivation
 *  is masked by the generation's last definitive state — however long ago it
 *  settled — so background re-checks never repaint an unchanged status. */
export function stabilizePrIslandState(
  key: string,
  derived: PrIslandState,
): PrIslandState {
  if (derived.kind !== "checking") {
    remember(key, derived);
    return derived;
  }
  return lastDefinitive.get(key) ?? derived;
}

/** Arm the mask from a PERSISTED state (pr-island-last-state hydration) so
 *  the first fetch after an app relaunch / dev reload is masked exactly like
 *  an in-session one. Live derivations always win: the seed applies only when
 *  the generation has no anchor yet. */
export function seedPrIslandStability(key: string, state: PrIslandState): void {
  if (state.kind === "checking") return;
  if (lastDefinitive.has(key)) return;
  remember(key, state);
}

/** Forget the definitive state for a key — called by direct actions right
 *  before their optimistic patch (the previous state is intentionally void,
 *  so a following transient must not be masked by it) and available for a
 *  PR-number change. */
export function clearPrIslandStability(key: string): void {
  lastDefinitive.delete(key);
}

export function resetPrIslandStabilityForTesting(): void {
  lastDefinitive.clear();
}
