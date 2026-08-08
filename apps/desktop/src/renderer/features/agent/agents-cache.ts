// ──────────────────────────────────────────────────────────
// agents-cache.ts — shared agent registry snapshot
// ──────────────────────────────────────────────────────────
//
// Both the Settings → Agents panel and the composer's agent pill
// read the same agent list (via `sessions.listAgents()`). Without
// a shared cache each component keeps its own copy and the two
// drift: logging in from Settings leaves the composer with a stale
// `installed: false` for that agent until its local load fires.
//
// This module keeps a single snapshot, lets any consumer subscribe,
// and exposes `refresh()` + `forceRefresh()` that re-hit the engine
// and broadcast the new list. Both panels invalidate this cache on
// window focus so returning from an external terminal `<agent> login`
// flips the state without a manual click.
// ──────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";

type LoadFn = (force?: boolean) => Promise<BridgeRegistryAgent[]>;

// ── Persisted snapshot (stale-while-revalidate) ──────────
//
// Cache the last successful registry response in localStorage so cold
// opens render the prior state immediately while the live probe runs
// in the background. The persisted shape carries a timestamp so the
// UI can dim very-old snapshots if we ever need to. We never persist
// secrets — `BridgeRegistryAgent` carries only public registry meta
// (installed / authenticated booleans + version strings).

const SNAPSHOT_STORAGE_KEY = "zeros.agent.registrySnapshot";

interface PersistedSnapshot {
  agents: BridgeRegistryAgent[];
  at: number;
}

function readSnapshot(): PersistedSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { agents?: unknown }).agents) &&
      typeof (parsed as { at?: unknown }).at === "number"
    ) {
      return parsed as PersistedSnapshot;
    }
    return null;
  } catch {
    return null;
  }
}

function writeSnapshot(next: BridgeRegistryAgent[]): void {
  try {
    localStorage.setItem(
      SNAPSHOT_STORAGE_KEY,
      JSON.stringify({
        agents: next,
        at: Date.now(),
      } satisfies PersistedSnapshot),
    );
  } catch {
    /* quota / private mode — best-effort, non-fatal */
  }
}

// Hydrate the in-memory snapshot from disk on module load. `agents`
// starts non-null when there's a prior session, so `useAgentsSnapshot`
// returns useful data on the very first render instead of "Loading…".
// lastLoadedAt is intentionally left at the persisted-at value so the
// 30 s freshness check in `loadAgents` schedules a background refresh
// when the cached data is older than that.
const persistedAtBoot = readSnapshot();
let agents: BridgeRegistryAgent[] | null = persistedAtBoot?.agents ?? null;
let lastLoadedAt = persistedAtBoot?.at ?? 0;
// Only a load that SUCCEEDED confirms the snapshot — `writeSnapshot` runs on
// that path alone, so a persisted list is a prior confirmed answer.
let confirmed = persistedAtBoot !== null;
let inFlight: Promise<BridgeRegistryAgent[]> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getAgentsSnapshot(): BridgeRegistryAgent[] | null {
  return agents;
}

/** Whether the published snapshot is an ANSWER rather than a fallback.
 *
 *  `runLoad` publishes `[]` when a load fails with nothing on disk, and that
 *  array is byte-identical to "the engine really has zero adapters". Anything
 *  that binds durable identity off the registry — auto-bind, its reconcile pass
 *  — has to tell those apart, or a startup blip pins a chat to the product
 *  fallback for good. `invalidateAgentsCache` deliberately leaves this alone:
 *  forcing the next read to hit the engine does not un-answer the last one. */
export function hasConfirmedAgents(): boolean {
  return confirmed;
}

export function subscribeAgents(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 01w (2026-05-20) — last fetch error, cleared on the next successful
 *  load. Surfaced via the thrown rejection + a console.warn so callers
 *  can show a toast instead of spinning forever. */
let lastError: Error | null = null;

/** Wrap a promise with a hard ceiling so a hung engine round-trip
 *  doesn't pin the agent picker in "Loading…" forever. The upstream
 *  bridge timeout is 30s; this caps total user-visible wait at 10s
 *  and the toast nudges the user toward a recovery action. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// Engine-side worst case for the initial probe sweep is ~13 s (auth
// probes max 5 s in parallel + version probes 8 s each behind the
// install probe). The earlier 10 s ceiling was tighter than that —
// the renderer rejected before the engine's first response could
// land, the snapshot stayed null, and every subsequent mount kicked
// off another doomed request. Both probe layers have their own
// internal timeouts + caches, so capping a little above the engine
// worst case keeps the visible wait bounded without killing valid
// work mid-flight. 30 s gives comfortable headroom on cold disks /
// heavy concurrent IDE workloads.
const LIST_AGENTS_TIMEOUT_MS = 30_000;

async function runLoad(
  loadFn: LoadFn,
  force: boolean,
): Promise<BridgeRegistryAgent[]> {
  try {
    const next = await withTimeout(
      loadFn(force),
      LIST_AGENTS_TIMEOUT_MS,
      "listAgents",
    );
    agents = next;
    lastLoadedAt = Date.now();
    confirmed = true;
    lastError = null;
    writeSnapshot(next);
    emit();
    return next;
  } catch (err) {
    // Stale-while-revalidate: if we already have a snapshot from disk
    // or a prior load, keep showing it. The error is captured
    // separately so the UI can toast a warning, and the next call
    // (refresh / window-focus / cache invalidate) will retry. Only
    // flip to the empty state when we genuinely have nothing to show
    // (true first run with no persisted snapshot + failed live load).
    //
    // CRITICAL: do NOT bump `lastLoadedAt` here. The empty `[]` array
    // is truthy in JS, so the freshness check in loadAgents() would
    // treat the fallback as a valid snapshot for the next 30 s — and
    // every subsequent loadAgents call (window-focus, bridge-restart
    // refresh) would short-circuit to the same empty array without
    // ever retrying the IPC. Leaving lastLoadedAt at its prior value
    // (0 on cold boot) makes the very next call re-attempt.
    if (agents === null) {
      agents = [];
    }
    lastError = err instanceof Error ? err : new Error(String(err));
    console.warn(`[agents-cache] listAgents failed: ${lastError.message}`);
    emit();
    throw lastError;
  } finally {
    inFlight = null;
  }
}

/**
 * Fetch the registry if we don't have one yet, or if the cached
 * snapshot is older than `maxAgeMs`. A concurrent caller with an
 * in-flight load receives the same promise rather than spawning
 * duplicate IPCs.
 */
export async function loadAgents(
  loadFn: LoadFn,
  maxAgeMs: number = 30_000,
): Promise<BridgeRegistryAgent[]> {
  const fresh = agents && Date.now() - lastLoadedAt < maxAgeMs;
  if (fresh && agents) return agents;
  if (inFlight) return inFlight;
  inFlight = runLoad(loadFn, false);
  return inFlight;
}

/**
 * Force a fresh fetch, bypassing the TTL. Used by the heading
 * refresh icon and on window focus to pick up external login.
 */
export async function refreshAgents(
  loadFn: LoadFn,
): Promise<BridgeRegistryAgent[]> {
  if (inFlight) return inFlight;
  inFlight = runLoad(loadFn, true);
  return inFlight;
}

/**
 * Invalidate without refetching — forces the next `loadAgents` call
 * to actually hit the engine. Useful when we know state changed but
 * don't want to pay for the IPC right now.
 */
export function invalidateAgentsCache(): void {
  lastLoadedAt = 0;
}

/** React hook — returns the current snapshot (null until first load). */
export function useAgentsSnapshot(): BridgeRegistryAgent[] | null {
  return useSyncExternalStore(
    subscribeAgents,
    getAgentsSnapshot,
    getAgentsSnapshot,
  );
}
