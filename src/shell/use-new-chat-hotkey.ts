// ──────────────────────────────────────────────────────────
// useNewTabHotkeys — Column 2 tab creation shortcuts
// ──────────────────────────────────────────────────────────
//
//   ⌘T   → new chat with the configured default model
//   ⌘⇧T  → new default terminal-agent tab (feature enabled only)

import { useEffect } from "react";

import { useAgentSessions } from "../zeros/agent/sessions-hooks";
import { useExperimentalFeature } from "../zeros/settings/experimental-features";
import { spawnNewChatTab } from "../zeros/store/spawn-default-chat";
import { spawnTerminalTab } from "../zeros/store/spawn-terminal-tab";
import { useWorkspaceDispatch, useWorkspaceStore } from "../zeros/store/store";
import { selectActiveFolder } from "../zeros/store/workspace-store";

export type NewTabShortcut = "chat" | "terminal";

/** Pure shortcut matcher kept separate from the side effect for regression
 *  tests. Command is intentional: Ctrl+T remains available to terminal TUIs. */
export function resolveNewTabShortcut(
  event: Pick<
    KeyboardEvent,
    "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code"
  >,
  terminalAgentsEnabled: boolean,
): NewTabShortcut | null {
  if (!event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.code !== "KeyT") return null;
  if (event.shiftKey) {
    return terminalAgentsEnabled ? "terminal" : null;
  }
  return "chat";
}

export function useNewTabHotkeys(): void {
  const dispatch = useWorkspaceDispatch();
  const sessions = useAgentSessions();
  const [terminalAgentsEnabled] = useExperimentalFeature("terminalAgents");

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const shortcut = resolveNewTabShortcut(event, terminalAgentsEnabled);
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
  }, [dispatch, sessions, terminalAgentsEnabled]);
}
