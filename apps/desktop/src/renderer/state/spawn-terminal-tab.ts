// ──────────────────────────────────────────────────────────
// spawn-terminal-tab — open a terminal-agent tab in Conversation pane
// ──────────────────────────────────────────────────────────

import {
  ensureFallbackTerminalAgent,
  getDefaultTerminalAgentId,
  resolveTerminalAgent,
} from "../features/settings/terminal-agents";
import { newChatId } from "./chat-id";
import type { ChatThread } from "./store";
import { useWorkspaceDispatch, useWorkspaceStore } from "./workspace-store";

type Dispatch = ReturnType<typeof useWorkspaceDispatch>;

/** Open a terminal-agent tab using the configured default terminal agent.
 *  The feature flag is deliberately enforced by callers: this helper owns
 *  only creation, so the plus menu and ⌘⇧T share the exact same tab shape. */
export function spawnTerminalTab(args: {
  folder: string;
  dispatch: Dispatch;
}): ChatThread {
  const { folder, dispatch } = args;
  let agentId = getDefaultTerminalAgentId();
  let agent = resolveTerminalAgent(agentId);

  // A user who enabled Terminal Agents can open a useful terminal immediately,
  // even before visiting its settings page. Existing defaults are preserved.
  if (!agent) {
    agent = ensureFallbackTerminalAgent();
    agentId = agent?.id ?? getDefaultTerminalAgentId() ?? agentId;
  }

  // Terminal tabs are named after the CLI they run. Keep parallel tabs
  // distinguishable while allowing a closed tab's name to be reused.
  const baseName = agent?.name?.trim() || "Terminal";
  const usedTitles = new Set(
    useWorkspaceStore
      .getState()
      .chats.filter(
        (chat) =>
          chat.folder === folder && chat.kind === "terminal" && !chat.archived,
      )
      .map((chat) => chat.title),
  );
  let title = baseName;
  for (let sequence = 2; usedTitles.has(title); sequence += 1) {
    title = `${baseName} ${sequence}`;
  }

  const now = Date.now();
  const chat: ChatThread = {
    id: newChatId(),
    folder,
    kind: "terminal",
    agentId,
    agentName: agent?.name ?? null,
    model: null,
    effort: "medium",
    permissionMode: "auto",
    title,
    createdAt: now,
    updatedAt: now,
  };
  dispatch({ type: "ADD_CHAT", chat });
  dispatch({ type: "SET_ACTIVE_CHAT", id: chat.id });
  return chat;
}
