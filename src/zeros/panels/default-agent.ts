// ──────────────────────────────────────────────────────────
// Default ("starred") agent preference
// ──────────────────────────────────────────────────────────
//
// Persisted choice of "which agent does New Chat start with."
// Read/written via getSetting/setSetting. Lives in its own module
// so settings-page.tsx can export only React components (required
// for Vite Fast Refresh — mixed exports force a full reload, which
// re-INITs every agent adapter every save).
//
// Surfaces that read this:
//   - Settings → Agents (lets the user pick the default explicitly)
//   - Column 2 "+" menu (star toggle on each agent row + autopick
//     when the user clicks Chat with a default set)
//
// The Column 2 menu uses the `useDefaultAgent()` hook below so all
// mounts re-render in sync when the user stars / unstars an agent
// from any surface — settings page, "+" menu, etc.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";

import { getSetting, setSetting } from "../../native/settings";
import { isRunnableAgent } from "../agent/agent-runnable";
import type { BridgeRegistryAgent } from "../bridge/messages";
import { FALLBACK_AGENT_ID } from "../agent/default-agent-id";

export { FALLBACK_AGENT_ID } from "../agent/default-agent-id";

/** Storage key for the user's preferred default agent (used by New Chat). */
export const DEFAULT_AGENT_KEY = "default-agent-id";

/** Hardcoded fallback agent when the user hasn't picked a default.
 *
 *  The user's product decision (2026-05-23) is "no chat ever lands in a
 *  no-agent state"; the 2026-07-10 spec pins the unset default to
 *  "claude". The constant lives here so every surface that resolves
 *  "what agent should this new chat use?" — the dispatcher, the
 *  hydration backfill, Column2ChatView's safety net — agrees on one
 *  source of truth. The model is not pinned here: it comes from the
 *  family's effective favorite (the user's ★, else the catalog's
 *  defaultFavorites entry — Opus 4.8 for claude). */
/** Resolve the agent id a brand-new chat should bind to.
 *
 *  Priority:
 *    1. The user's default agent (picked in Settings → Models) — if
 *       it's still runnable on this machine.
 *    2. FALLBACK_AGENT_ID ("claude", 2026-07-10 spec) — if it's
 *       runnable. Hardcoded fallback covers "user hasn't picked yet"
 *       without falling back to a per-workspace sticky that
 *       surprises them.
 *    3. First runnable agent in the registry — last-resort fallback
 *       so a machine that's missing claude still gets *some* agent
 *       (e.g. someone with only Codex installed).
 *    4. null — only if zero agents are runnable. Callers must handle.
 *
 *  Pre-2026-05-23 the chain included a "sticky last-used" step. That
 *  was removed when the user clarified that an unstarred state should
 *  ALWAYS default to codex (not whichever agent the user last talked
 *  to on the previous worktree). */
export function pickDefaultAgentId(
  agents: BridgeRegistryAgent[],
  starredId: string | null = getDefaultAgentId(),
): string | null {
  const runnable = agents.filter(isRunnableAgent);
  if (runnable.length === 0) return null;
  if (starredId) {
    const starred = runnable.find((a) => a.id === starredId);
    if (starred) return starred.id;
  }
  const fallback = runnable.find((a) => a.id === FALLBACK_AGENT_ID);
  if (fallback) return fallback.id;
  return runnable[0]?.id ?? null;
}

/** Same priority chain as `pickDefaultAgentId`, but returns the full
 *  registry entry so callers can grab `name` + `icon` for the chat
 *  thread row. Returns null when no agent is runnable. */
export function pickDefaultAgent(
  agents: BridgeRegistryAgent[],
  starredId: string | null = getDefaultAgentId(),
): BridgeRegistryAgent | null {
  const id = pickDefaultAgentId(agents, starredId);
  if (!id) return null;
  return agents.find((a) => a.id === id) ?? null;
}

/** Read the default agent id from persistent settings. Returns null if
 *  never set — the New Chat flow then falls back to the first installed
 *  agent, or prompts the user if nothing is installed. */
export function getDefaultAgentId(): string | null {
  return getSetting<string | null>(DEFAULT_AGENT_KEY, null);
}

/** Persist the default agent id. Pass null to clear. */
export function setDefaultAgentId(agentId: string | null): void {
  setSetting(DEFAULT_AGENT_KEY, agentId);
  notify();
}

// ── Pub/sub bus ──────────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listeners shouldn't throw; keep going */
    }
  }
}

/** React hook returning the current default + a toggle/set helper.
 *  Re-renders whenever any caller of setDefaultAgentId() fires. */
export function useDefaultAgent(): {
  agentId: string | null;
  setDefault: (agentId: string | null) => void;
  toggleDefault: (agentId: string) => void;
} {
  const [agentId, setAgentId] = useState<string | null>(() =>
    getDefaultAgentId(),
  );

  useEffect(() => {
    const sync = () => setAgentId(getDefaultAgentId());
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const setDefault = useCallback((next: string | null) => {
    setDefaultAgentId(next);
  }, []);

  /** Star the agent if not already default; un-star if it already is. */
  const toggleDefault = useCallback((id: string) => {
    const current = getDefaultAgentId();
    setDefaultAgentId(current === id ? null : id);
  }, []);

  return { agentId, setDefault, toggleDefault };
}
