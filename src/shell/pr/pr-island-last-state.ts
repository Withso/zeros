// ──────────────────────────────────────────────────────────
// pr-island-last-state — durable "last rendered PR status" per workspace#pr
// ──────────────────────────────────────────────────────────
//
// The island's in-memory caches (last settled batch, stability mask) die with
// the renderer — an app relaunch or a dev reload wiped them, so the next
// mount rendered "Loading..." and the tab glyph dropped to the brown "open"
// fallback even though nothing about the PR changed. The 2026-07-21 contract
// says a status may only repaint when GitHub settles on a DIFFERENT status,
// so the last rendered state must survive the renderer.
//
// This module persists, per `workspaceId#prNumber`, the last stabilized
// island state together with the stability key (head/base generation) it was
// derived under:
//   • getPrIslandLastState — the render fallback while no settled batch
//     exists yet. "Loading..." now appears only for a PR this machine has
//     never derived a status for.
//   • hydration seeds pr-status-stability, so the first post-relaunch fetch
//     that answers "unknown — still recomputing" is masked by the persisted
//     state exactly like an in-session transient. A real change (new head,
//     new definitive state) replaces it the moment the fetch settles.
//
// Storage is a single bounded localStorage document (LRU, newest last).
// Entries are validated structurally on read — a corrupt or stale-schema
// document degrades to the empty cache, never to a crash. All storage I/O is
// best-effort: environments without localStorage (tests, weird contexts)
// simply lose durability, not correctness.
// ──────────────────────────────────────────────────────────

import type {
  PrIslandAction,
  PrIslandState,
  PrIslandTone,
} from "./pr-status";
import { registerPrWorkspaceCacheForget } from "./pr-cache-forget";
import { seedPrIslandStability } from "./pr-status-stability";

const STORAGE_KEY = "zeros.pr-island.last-states.v1";
const MAX_ENTRIES = 64;

interface PersistedEntry {
  stabilityKey: string;
  state: PrIslandState;
  at: number;
}

const byDataKey = new Map<string, PersistedEntry>();

const TONES: ReadonlySet<string> = new Set([
  "neutral",
  "success",
  "warning",
  "merged",
  "danger",
  "closed",
]);

function isAction(value: unknown): value is PrIslandAction {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.kind === "string" &&
    typeof a.label === "string" &&
    typeof a.behavior === "string" &&
    (a.variant === "primary" ||
      a.variant === "secondary" ||
      a.variant === "dashed")
  );
}

function isIslandState(value: unknown): value is PrIslandState {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.kind === "string" &&
    typeof s.label === "string" &&
    typeof s.tone === "string" &&
    TONES.has(s.tone as PrIslandTone) &&
    Array.isArray(s.actions) &&
    s.actions.every(isAction)
  );
}

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
    store.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(byDataKey)),
    );
  } catch {
    // Quota/security errors lose durability only; the session cache stands.
  }
}

function hydrate(): void {
  const store = storage();
  if (!store) return;
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  for (const [dataKey, entry] of Object.entries(parsed)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.stabilityKey !== "string" ||
      typeof e.at !== "number" ||
      !isIslandState(e.state)
    ) {
      continue;
    }
    byDataKey.set(dataKey, {
      stabilityKey: e.stabilityKey,
      state: e.state,
      at: e.at,
    });
    // Arm the anti-flap mask for this exact generation before any fetch runs.
    seedPrIslandStability(e.stabilityKey, e.state);
  }
}

hydrate();

// Deletion purge (pr-cache-forget): persisted last states for a permanently
// deleted workspace would otherwise survive relaunches until LRU eviction.
// The stability masks these entries seeded are cleared by
// pr-status-stability's own registration.
registerPrWorkspaceCacheForget((workspaceId) => {
  const prefix = `${workspaceId}#`;
  let changed = false;
  for (const key of byDataKey.keys()) {
    if (!key.startsWith(prefix)) continue;
    byDataKey.delete(key);
    changed = true;
  }
  if (changed) persist();
});

/** The last state this PR's island rendered — across relaunches. Null only
 *  when no status was ever derived for this `workspaceId#prNumber` here. */
export function getPrIslandLastState(dataKey: string): PrIslandState | null {
  return byDataKey.get(dataKey)?.state ?? null;
}

/** Record a freshly derived (stabilized, non-"checking") island state. */
export function rememberPrIslandLastState(
  dataKey: string,
  stabilityKey: string,
  state: PrIslandState,
): void {
  if (state.kind === "checking") return;
  const prev = byDataKey.get(dataKey);
  if (
    prev &&
    prev.stabilityKey === stabilityKey &&
    prev.state.kind === state.kind &&
    prev.state.label === state.label
  ) {
    return; // Unchanged — skip the localStorage write.
  }
  byDataKey.delete(dataKey);
  byDataKey.set(dataKey, { stabilityKey, state, at: Date.now() });
  while (byDataKey.size > MAX_ENTRIES) {
    const oldest = byDataKey.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    byDataKey.delete(oldest);
  }
  persist();
}

export function resetPrIslandLastStatesForTesting(): void {
  byDataKey.clear();
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}

/** Test-only: re-run hydration against the current (mock) storage. */
export function hydratePrIslandLastStatesForTesting(): void {
  byDataKey.clear();
  hydrate();
}
