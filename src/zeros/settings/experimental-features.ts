// ──────────────────────────────────────────────────────────
// Experimental features — opt-in, per-user feature flags
// ──────────────────────────────────────────────────────────
//
// Toggled from Settings → Experimental. Off by default ("Expect
// breaking changes"); flipping one on reveals that feature's surface
// elsewhere in the app — e.g. `terminalAgents` shows the Terminal
// Agents tab in the settings sidebar.
//
// Module-level store + useSyncExternalStore (mirrors enabled-agents.ts)
// so a toggle in the Experimental panel propagates to an
// already-mounted consumer in the same render cycle — no reload. Reads
// are synchronous so non-React call sites can gate too.
//
// localStorage-backed for now (UI-only opt-ins); no settings.toml
// mirror yet. To add a flag: extend `ExperimentalFeature`, then drop a
// SettingsRow + Switch into ExperimentalPanel.
// ──────────────────────────────────────────────────────────

import { useCallback, useSyncExternalStore } from "react";

/** The set of experimental feature flags. */
export type ExperimentalFeature = "terminalAgents" | "workInLocalMain";

const STORAGE_KEY = "zeros.experimentalFeatures";

type PersistedShape = Partial<Record<ExperimentalFeature, boolean>>;

function readPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as PersistedShape)
      : {};
  } catch {
    return {};
  }
}

function writePersisted(next: PersistedShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage quota / private mode — non-fatal */
  }
}

// ── Shared module-level store ───────────────────────────
let current: PersistedShape = readPersisted();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): PersistedShape {
  return current;
}

/** Read a flag synchronously. Off by default. */
export function isExperimentalEnabled(feature: ExperimentalFeature): boolean {
  return current[feature] === true;
}

/** Flip a flag and notify every subscriber. Always swaps the snapshot
 *  reference so useSyncExternalStore consumers re-render. */
export function setExperimentalEnabled(
  feature: ExperimentalFeature,
  on: boolean,
): void {
  current = { ...current, [feature]: on };
  writePersisted(current);
  emit();
}

// Cross-window sync — Electron devtools-in-a-separate-window and any
// future multi-window setup (mirrors enabled-agents.ts).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    current = readPersisted();
    emit();
  });
}

/** Hook: `[on, setOn]` for one experimental feature. Re-renders every
 *  consumer when the flag flips. */
export function useExperimentalFeature(
  feature: ExperimentalFeature,
): [boolean, (on: boolean) => void] {
  const persisted = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const on = persisted[feature] === true;
  const set = useCallback(
    (next: boolean) => setExperimentalEnabled(feature, next),
    [feature],
  );
  return [on, set];
}
