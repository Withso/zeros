// Keep these exports outside the Settings component module so Vite Fast Refresh does not reload it.

import { useCallback, useEffect, useState } from "react";

import { getSetting, setSetting } from "../../platform/settings";
import { isRunnableAgent, isSelectableAgent } from "../agent/agent-runnable";
import { isAgentEnabled } from "../agent/enabled-agents";
import { agentFamily } from "../agent/model-catalog";
import {
  clearFavoriteSelection,
  getFavoriteSelection,
  setFavoriteModel,
  subscribeFavoriteSelection,
} from "../agent/model-favorites";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";

// Legacy key remains the fallback when no catalog favorite is set.
export const DEFAULT_AGENT_KEY = "default-agent-id";

function pickByPreference<T extends BridgeRegistryAgent>(
  candidates: T[],
  starredId: string | null,
): T | null {
  const starred = findStarredAgent(candidates, starredId);
  if (starred) return starred;
  for (const family of ["claude", "codex", "cursor"] as const) {
    const preferred = candidates.find(
      (agent) => agentFamily(agent.id) === family,
    );
    if (preferred) return preferred;
  }
  return candidates[0] ?? null;
}

function findStarredAgent<T extends BridgeRegistryAgent>(
  agents: T[],
  starredId: string | null,
): T | null {
  if (!starredId) return null;
  const family = agentFamily(starredId);
  return agents.find(agent => agent.id === starredId) ??
    agents.find(agent => family !== "" && agentFamily(agent.id) === family) ?? null;
}

export function pickDefaultAgentId(
  agents: BridgeRegistryAgent[],
  starredId: string | null = getDefaultAgentId(),
): string | null {
  return pickAgentForNewChat(agents, starredId)?.id ?? null;
}

export function pickDefaultAgent<T extends BridgeRegistryAgent>(
  agents: T[],
  starredId: string | null = getDefaultAgentId(),
): T | null {
  return pickAgentForNewChat(agents, starredId);
}

// Honor a disconnected saved agent for recovery; never inherit another workspace's last-used agent.
export function pickAgentForNewChat<T extends BridgeRegistryAgent>(
  agents: T[],
  starredId: string | null = getDefaultAgentId(),
  isEnabled: (id: string, beta?: boolean) => boolean = isAgentEnabled,
): T | null {
  const starred = findStarredAgent(agents, starredId);
  if (starred) return starred;
  const enabled = agents.filter((agent) => isEnabled(agent.id, agent.beta));
  return (
    pickByPreference(enabled.filter(isSelectableAgent), starredId) ??
    pickByPreference(enabled.filter(isRunnableAgent), starredId) ??
    pickByPreference(
      enabled.filter((agent) => agent.installed === true),
      starredId,
    ) ??
    pickByPreference(enabled, starredId) ??
    pickByPreference(agents, starredId)
  );
}

// An empty registry still needs an agent binding so the composer can show recovery.
export const FALLBACK_NEW_CHAT_AGENT_ID = "claude";

export function getDefaultAgentId(): string | null {
  return (
    getFavoriteSelection()?.agentId ??
    getSetting<string | null>(DEFAULT_AGENT_KEY, null)
  );
}

export function setDefaultAgentId(agentId: string | null): void {
  if (!agentId) {
    clearFavoriteSelection();
    return;
  }
  const family = agentFamily(agentId);
  if (!family) {
    // Clear the curated favorite first so it cannot shadow an extension agent's legacy id.
    clearFavoriteSelection();
    setSetting(DEFAULT_AGENT_KEY, agentId);
    notifyLegacy();
    return;
  }
  // A provider-only choice must still follow future changes to the catalog default model.
  setFavoriteModel(family, null);
}

type Listener = () => void;
const legacyListeners = new Set<Listener>();

function notifyLegacy(): void {
  for (const listener of legacyListeners) {
    try {
      listener();
    } catch {
      // A throwing subscriber must not block the remaining mounts.
    }
  }
}

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
