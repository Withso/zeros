// ──────────────────────────────────────────────────────────
// useNewTabHotkeys — Conversation pane tab creation shortcuts
// ──────────────────────────────────────────────────────────
//
//   ⌘T   → new chat with the configured default model
//   ⌘⇧T  → new default terminal-agent tab (feature enabled only)

import { useEffect } from "react";

import { useAgentSessions } from "../features/agent/sessions-hooks";
import { useExperimentalFeature } from "../features/settings/experimental-features";
import { spawnNewChatTab } from "../state/spawn-default-chat";
import { spawnTerminalTab } from "../state/spawn-terminal-tab";
import { useWorkspaceDispatch, useWorkspaceStore } from "../state/store";
import { selectActiveFolder } from "../state/workspace-store";

export type NewTabShortcut = "chat" | "terminal";

/** Pure shortcut matcher kept separate from the side effect for regression
 *  tests. Command is intentional: Ctrl+T remains available to terminal TUIs. */
export function resolveNewTabShortcut(
  event: Pick<
    KeyboardEvent,
    "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code"
  >,
  terminalAgentsEnabled: boolean,
  agentTabsEnabled = true,
): NewTabShortcut | null {
  if (!agentTabsEnabled) return null;
  if (!event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.code !== "KeyT") return null;
  if (event.shiftKey) {
    return terminalAgentsEnabled ? "terminal" : null;
  }
  return "chat";
}

export function useNewTabHotkeys(agentTabsEnabled = true): void {
  const dispatch = useWorkspaceDispatch();
  const sessions = useAgentSessions();
  const [terminalAgentsEnabled] = useExperimentalFeature("terminalAgents");

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const shortcut = resolveNewTabShortcut(
        event,
        terminalAgentsEnabled,
        agentTabsEnabled,
      );
      if (!shortcut) return;
      const folder = selectActiveFolder(useWorkspaceStore.getState());
      if (!folder) return;

      event.preventDefault();
      if (shortcut === "terminal") {
        spawnTerminalTab({ folder, dispatch });
        return;
      }
      void spawnNewChatTab({ folder, sessions, dispatch });
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [agentTabsEnabled, dispatch, sessions, terminalAgentsEnabled]);
}
