// ──────────────────────────────────────────────────────────
// pr-island-state-store — last derived island kind per workspace + PR
// ──────────────────────────────────────────────────────────
//
// The PR status island derives its state only while mounted (the active
// workspace's Changes/Review row). The top bar's workspace tabs want the same
// signal — "merge-conflicts" paints a red conflict glyph, "ready-to-merge" a
// green PR arrow, … — so the island PUBLISHES each derived kind here and the
// tabs subscribe. Entries persist after unmount (a tab keeps its last-known
// icon when you switch away) AND across relaunches (2026-07-21: hydrated from
// localStorage, so a reload can't drop a green glyph to the brown "open"
// fallback while nothing changed — the icon repaints only when the island
// derives a different status). Workspaces that never derived here fall back
// to their persisted prState (see top-bar.tsx); persisted TERMINAL prStates
// (merged/closed — engine-reconciled from GitHub) outrank this store there,
// so a stale pre-relaunch kind can never hide an external merge/close.
// Bounded by the number of live workspaces with PRs.
// ──────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";

import { registerPrWorkspaceCacheForget } from "./pr-cache-forget";

const STORAGE_KEY = "zeros.pr-island.kinds.v1";
const kinds = new Map<string, string>();
const listeners = new Set<() => void>();
const MAX_KINDS = 128;

function storage(): Storage | null {
  // Via `window`, not the bare `localStorage` global — Node 22's lazy
  // localStorage getter fires a process warning on mere `typeof` probes.
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

function persist(): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kinds)));
  } catch {
    // Losing durability is fine; the in-session store stands.
  }
}

function hydrate(): void {
  const store = storage();
  if (!store) return;
  let parsed: unknown;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return;
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  for (const [key, kind] of Object.entries(parsed)) {
    if (typeof kind === "string") kinds.set(key, kind);
  }
}

hydrate();

// Deletion purge (pr-cache-forget): entries are keyed `workspaceId#prNumber`
// AND persisted — without this, a permanently deleted workspace's kinds ride
// localStorage across relaunches until LRU pressure happens to evict them.
// Subscribers are notified so a mounted tab strip drops the glyph in the same
// commit that removes the workspace row.
registerPrWorkspaceCacheForget((workspaceId) => {
  const prefix = `${workspaceId}#`;
  let changed = false;
  for (const key of kinds.keys()) {
    if (!key.startsWith(prefix)) continue;
    kinds.delete(key);
    changed = true;
  }
  if (!changed) return;
  persist();
  for (const l of listeners) l();
});

function ownerKey(workspaceId: string, prNumber: number): string {
  return `${workspaceId}#${prNumber}`;
}

/** Record the island's currently derived state kind for a workspace (null
 *  clears it — e.g. the PR number changed and nothing is derived yet). */
export function publishPrIslandKind(
  workspaceId: string,
  prNumber: number,
  kind: string | null,
): void {
  const key = ownerKey(workspaceId, prNumber);
  const prev = kinds.get(key);
  if (kind == null) {
    if (prev === undefined) return;
    kinds.delete(key);
  } else {
    if (prev === kind) return;
    // Refresh insertion order so bounded eviction is least-recently-written.
    kinds.delete(key);
    kinds.set(key, kind);
    while (kinds.size > MAX_KINDS) {
      const oldest = kinds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      kinds.delete(oldest);
    }
  }
  persist();
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Exact-key snapshot used by the hook and focused tests. A workspace without
 *  a current PR must never inherit its preceding PR's terminal state. */
export function getPrIslandKind(
  workspaceId: string,
  prNumber: number | null,
): string | null {
  return prNumber == null
    ? null
    : (kinds.get(ownerKey(workspaceId, prNumber)) ?? null);
}

/** The last island kind derived for this exact workspace + PR identity. */
export function usePrIslandKind(
  workspaceId: string,
  prNumber: number | null,
): string | null {
  return useSyncExternalStore(subscribe, () =>
    getPrIslandKind(workspaceId, prNumber),
  );
}

export function resetPrIslandKindsForTesting(): void {
  kinds.clear();
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}
