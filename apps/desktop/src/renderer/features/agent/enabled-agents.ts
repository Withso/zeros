// ──────────────────────────────────────────────────────────
// useEnabledAgents — universal (per-user, not per-project) state
// ──────────────────────────────────────────────────────────
//
// Which agents appear in the chat-composer picker. Toggled-on
// agents show up; off ones are hidden. Persists across projects and
// relaunches via localStorage.
//
// State is held in a module-level store so every consumer sees the
// same snapshot — a toggle in Settings → Agents propagates to an
// already-mounted composer pill in the same render cycle.
//
// First-run semantics: if the key is absent we treat ALL registry
// agents as enabled (so upgrading users don't suddenly see an empty
// picker) EXCEPT agents flagged `beta` in the manifest — those stay
// off until the user explicitly opts in. The first explicit toggle
// writes the concrete list (initial = all non-beta IDs) — from then
// on enabled ≠ disabled is a real distinction and new registry
// entries do NOT auto-enable.
// ──────────────────────────────────────────────────────────

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "zeros.agent.enabledAgents";

type PersistedShape = { ids: string[] } | null;

function readPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { ids?: unknown }).ids)
    ) {
      return {
        ids: (parsed as { ids: string[] }).ids.filter(
          (x) => typeof x === "string",
        ),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writePersisted(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ids }));
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

function setState(next: PersistedShape): void {
  current = next;
  emit();
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

/** Synchronous counterpart to the hook for spawn/default resolution paths.
 * Reads storage when the module snapshot is still first-run null so cold boot,
 * tests, and non-React callers all apply the same enabled-agent contract. */
export function isAgentEnabled(id: string, isBeta?: boolean): boolean {
  const persisted = current ?? readPersisted();
  return persisted ? persisted.ids.includes(id) : !isBeta;
}

// Cross-tab sync — in Electron this covers devtools-in-a-separate-
// window and any future multi-window setup.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    setState(readPersisted());
  });
}

export interface UseEnabledAgentsApi {
  /** Whether an agent should appear in the chat picker. Pass the
   *  agent's `beta` flag so first-run defaults skip beta agents
   *  (new users have to opt in via Settings → Agents). */
  isEnabled: (id: string, isBeta?: boolean) => boolean;
  /** Toggle an agent on/off. `defaultEnabledIds` is the list of IDs
   *  considered enabled on first run — pass the registry's non-beta
   *  IDs so the first explicit toggle preserves the beta-off
   *  default (rather than auto-enabling every beta agent). */
  toggle: (id: string, defaultEnabledIds: string[]) => void;
  hasExplicitChoice: boolean;
}

export function useEnabledAgents(): UseEnabledAgentsApi {
  const persisted = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const isEnabled = useCallback(
    (id: string, isBeta?: boolean): boolean =>
      persisted ? persisted.ids.includes(id) : !isBeta,
    [persisted],
  );

  const toggle = useCallback((id: string, defaultEnabledIds: string[]) => {
    const base = current ? current.ids.slice() : defaultEnabledIds.slice();
    const idx = base.indexOf(id);
    if (idx >= 0) base.splice(idx, 1);
    else base.push(id);
    writePersisted(base);
    setState({ ids: base });
  }, []);

  return {
    isEnabled,
    toggle,
    hasExplicitChoice: persisted !== null,
  };
}
