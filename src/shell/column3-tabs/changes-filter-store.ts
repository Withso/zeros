// ──────────────────────────────────────────────────────────
// Changes filter store — ONE live scope + turn filter per git target
// ──────────────────────────────────────────────────────────
//
// More than one Changes surface can be mounted at once for the same
// workspace (today the Changes tab; historically also row 2's Changes view,
// which drove this design). If each held its own copy of
// the scope / turn filter, the two lists would diverge the moment one changed
// — and their Viewed-store publishes (publishChanges: list order + per-file
// hashes) would race with CONFLICTING data, corrupting the auto-advance sweep
// and auto-unmark. So the filter is a module store keyed by git target
// (worktree id / trunk repo root): both surfaces subscribe, change together,
// and always publish the same change set.
//
// Persistence stays in changes-scope / changes-turn-filter (same keys as
// before) — this store is the live, shared layer above them. The turn filter
// is stored as an IDENTITY ({chatId, turnId}); callers resolve it against
// their freshly-loaded turns list (see useChangesModel).

import { useSyncExternalStore } from "react";

import {
  DEFAULT_SCOPE,
  clearChangesScopes,
  loadChangesScope,
  saveChangesScope,
  type Scope,
} from "./changes-scope";
import {
  clearTurnFilterIds,
  loadTurnFilterId,
  saveTurnFilterId,
  type TurnFilterId,
} from "./changes-turn-filter";

export interface ChangesFilter {
  scope: Scope;
  /** The selected turn's identity, or null = "No turns" (the scope applies). */
  turn: TurnFilterId | null;
}

const cache = new Map<string, ChangesFilter>();
const listeners = new Set<() => void>();
const MAX_LIVE_FILTER_TARGETS = 128;

function cacheFilter(target: string, filter: ChangesFilter): void {
  cache.delete(target);
  cache.set(target, filter);
  while (cache.size > MAX_LIVE_FILTER_TARGETS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function scopeEquals(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "commit" || b.kind !== "commit" || a.sha === b.sha;
}

function turnEquals(a: TurnFilterId | null, b: TurnFilterId | null): boolean {
  if (a === null || b === null) return a === b;
  return a.chatId === b.chatId && a.turnId === b.turnId;
}

/** The current filter for `target` — seeded from the persisted scope/turn on
 *  first read, then a stable cached reference until a set replaces it. */
export function getChangesFilter(target: string): ChangesFilter {
  let state = cache.get(target);
  if (!state) {
    state = {
      scope: loadChangesScope(target) ?? DEFAULT_SCOPE,
      turn: loadTurnFilterId(target),
    };
    cacheFilter(target, state);
  }
  return state;
}

/** Pick a scope. Clears the turn filter (they're mutually exclusive) and
 *  persists both, exactly like the old per-view setScope. */
export function setChangesScope(target: string, scope: Scope): void {
  const cur = getChangesFilter(target);
  if (scopeEquals(cur.scope, scope) && cur.turn === null) return;
  cacheFilter(target, { scope, turn: null });
  saveChangesScope(target, scope);
  saveTurnFilterId(target, null);
  emit();
}

/** Pick a turn (or null = "No turns") and persist the choice. */
export function setChangesTurnFilter(
  target: string,
  turn: TurnFilterId | null,
): void {
  const cur = getChangesFilter(target);
  if (turnEquals(cur.turn, turn)) return;
  cacheFilter(target, { scope: cur.scope, turn });
  saveTurnFilterId(target, turn);
  emit();
}

/** Drop live + persisted filter choices when their owner is removed. */
export function clearChangesFilters(targets: readonly string[]): void {
  let changed = false;
  const removed = [...new Set(targets.filter(Boolean))];
  for (const target of removed) {
    changed = cache.delete(target) || changed;
  }
  clearChangesScopes(removed);
  clearTurnFilterIds(removed);
  if (changed) emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive shared filter for `target` — every mounted Changes surface for
 *  the same target re-renders together on any scope/turn change. */
export function useChangesFilter(target: string): ChangesFilter {
  return useSyncExternalStore(
    subscribe,
    () => getChangesFilter(target),
    () => getChangesFilter(target),
  );
}

/** Test-only reset for the module singleton. */
export function resetChangesFilterForTests(): void {
  cache.clear();
  listeners.clear();
}
