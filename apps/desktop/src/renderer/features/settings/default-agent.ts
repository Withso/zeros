// ──────────────────────────────────────────────────────────
// Default agent/model identity
// ──────────────────────────────────────────────────────────
//
// Persisted choice of "which agent does New Chat start with."
// Read/written via getSetting/setSetting. Lives in its own module
// so settings-page.tsx can export only React components (required
// for Vite Fast Refresh — mixed exports force a full reload, which
// re-INITs every agent adapter every save).
//
// Surfaces that read this:
//   - Settings → Models (lets the user pick the default explicitly)
//   - Model pickers (exactly one global star identifies that same default)
//
// The Conversation pane menu uses the `useDefaultAgent()` hook below so all
// mounts re-render in sync when the default moves from any surface.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";

import { getSetting, setSetting } from "../../platform/settings";
import { isRunnableAgent } from "../agent/agent-runnable";
import { isAgentEnabled } from "../agent/enabled-agents";
import { agentFamily } from "../agent/model-catalog";
import {
  clearFavoriteSelection,
  getFavoriteSelection,
  setFavoriteModel,
  subscribeFavoriteSelection,
} from "../agent/model-favorites";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";

/** Storage key for the user's preferred default agent (used by New Chat). */
export const DEFAULT_AGENT_KEY = "default-agent-id";

/** The one preference ordering every "which agent?" resolution shares:
 *  the starred choice (exact id, else same family), then the product
 *  provider order Codex → Claude → Cursor, then the first candidate.
 *  Returns null only for an empty candidate list. */
function pickByPreference(
  candidates: BridgeRegistryAgent[],
  starredId: string | null,
): BridgeRegistryAgent | null {
  if (starredId) {
    const starredFamily = agentFamily(starredId);
    const starred = candidates.find(
      (agent) =>
        agent.id === starredId ||
        (starredFamily !== "" && agentFamily(agent.id) === starredFamily),
    );
    if (starred) return starred;
  }
  for (const family of ["codex", "claude", "cursor"] as const) {
    const preferred = candidates.find(
      (agent) => agentFamily(agent.id) === family,
    );
    if (preferred) return preferred;
  }
  return candidates[0] ?? null;
}

/** Resolve the agent id a brand-new chat should bind to.
 *
 *  Priority:
 *    1. The user's default agent (picked in Settings → Models) — if
 *       it's still enabled and runnable on this machine.
 *    2. Product provider order: Codex, then Claude, then Cursor. This makes
 *       every connected-provider combination deterministic and intentionally
 *       prefers Codex when both Codex and Claude are available.
 *    3. First enabled, runnable agent in the registry — last-resort fallback
 *       so a machine that's missing claude still gets *some* agent
 *       (e.g. someone with only Codex installed).
 *    4. null — only if zero enabled agents are runnable. Callers must handle.
 *
 *  Deliberately omit a "sticky last-used" step: an unset preference resolves
 *  to the stable fallback rather than whichever agent was last used in another
 *  workspace. */
export function pickDefaultAgentId(
  agents: BridgeRegistryAgent[],
  starredId: string | null = getDefaultAgentId(),
): string | null {
  const runnable = agents.filter(
    (agent) => isAgentEnabled(agent.id, agent.beta) && isRunnableAgent(agent),
  );
  return pickByPreference(runnable, starredId)?.id ?? null;
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

/** Which agent should a brand-new chat BIND to, given that a chat must
 *  always end up with one (there is no picker; the composer's sign-in /
 *  install flow is the recovery surface for a not-ready agent)?
 *
 *  Tiered relaxation of `pickDefaultAgentId` — each tier applies the same
 *  starred → Codex → Claude → Cursor → first ordering:
 *    1. enabled + runnable (identical to pickDefaultAgentId),
 *    2. enabled + installed — nothing is signed in; bind the best installed
 *       agent so AgentChat's "Sign in required" flow can take over,
 *    3. enabled — detected but not even installed; the spawn path surfaces
 *       the install error with instructions,
 *    4. any registry agent — the user disabled everything; an agent the
 *       user hid still beats a dead pane, and the pill lets them switch.
 *
 *  Returns null ONLY for an empty registry list (engine listed zero
 *  adapters / listing failed). Callers that must bind anyway fall back to
 *  FALLBACK_NEW_CHAT_AGENT_ID. */
export function pickAgentForNewChat(
  agents: BridgeRegistryAgent[],
  starredId: string | null = getDefaultAgentId(),
  isEnabled: (id: string, beta?: boolean) => boolean = isAgentEnabled,
): BridgeRegistryAgent | null {
  const enabled = agents.filter((agent) => isEnabled(agent.id, agent.beta));
  return (
    pickByPreference(enabled.filter(isRunnableAgent), starredId) ??
    pickByPreference(
      enabled.filter((agent) => agent.installed === true),
      starredId,
    ) ??
    pickByPreference(enabled, starredId) ??
    pickByPreference(agents, starredId)
  );
}

/** Hardcoded last-resort binding for a chat born while the registry is
 *  EMPTY (engine listed zero adapters, or the list call failed and the
 *  cache published its `[]` fallback). The product rule "every chat always
 *  has an agent" outranks accuracy here: binding the product-priority
 *  default renders a live composer whose spawn error ("not installed" /
 *  sign-in) is actionable, where an unbound chat renders a dead pane.
 *  Codex per the Codex → Claude → Cursor product order. */
export const FALLBACK_NEW_CHAT_AGENT_ID = "codex";

/** Read the default agent id from persistent settings. Returns null if never
 *  set; New Chat then follows the fallback chain in `pickDefaultAgentId`. */
export function getDefaultAgentId(): string | null {
  return (
    getFavoriteSelection()?.agentId ??
    getSetting<string | null>(DEFAULT_AGENT_KEY, null)
  );
}

/** Persist the default agent id. Pass null to clear. */
export function setDefaultAgentId(agentId: string | null): void {
  if (!agentId) {
    clearFavoriteSelection();
    return;
  }
  const family = agentFamily(agentId);
  if (!family) {
    // An extension-provided runnable agent cannot live in the curated
    // agent+model record. Clear any prior curated selection first so the
    // legacy id below does not remain shadowed by a stale global favorite.
    clearFavoriteSelection();
    setSetting(DEFAULT_AGENT_KEY, agentId);
    notifyLegacy();
    return;
  }
  // Choosing a provider moves the global star to that provider's effective
  // catalog fallback without pinning today's fallback model forever. A later
  // catalog default update should still reach users who picked only an agent.
  setFavoriteModel(family, null);
}

// ── Pub/sub bus ──────────────────────────────────────────

type Listener = () => void;
const legacyListeners = new Set<Listener>();

function notifyLegacy(): void {
  for (const listener of legacyListeners) listener();
}

/** React hook returning the current default + a toggle/set helper.
 *  Re-renders whenever any caller of setDefaultAgentId() fires. */
export function useDefaultAgent(): {
  agentId: string | null;
  setDefault: (agentId: string | null) => void;
} {
  const [agentId, setAgentId] = useState<string | null>(() =>
    getDefaultAgentId(),
  );

  useEffect(() => {
    const sync = () => setAgentId(getDefaultAgentId());
    const unsubscribeFavorite = subscribeFavoriteSelection(sync);
    legacyListeners.add(sync);
    return () => {
      unsubscribeFavorite();
      legacyListeners.delete(sync);
    };
  }, []);

  const setDefault = useCallback((next: string | null) => {
    setDefaultAgentId(next);
  }, []);
  return { agentId, setDefault };
}
