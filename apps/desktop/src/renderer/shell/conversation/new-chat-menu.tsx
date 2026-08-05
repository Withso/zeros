// ──────────────────────────────────────────────────────────
// Conversation pane — "+" new-tab control
// ──────────────────────────────────────────────────────────
//
// Terminal Agents disabled:
//   "+" opens a chat immediately with the configured default model.
//
// Terminal Agents enabled:
//   "+" opens one flat menu with exactly Chat and Terminal. There is no
//   adjacent chevron and no agent submenu; model/agent changes remain in the
//   chat composer and Terminal uses the configured default terminal agent.

import React, { useCallback } from "react";
import { MessageSquare, Plus, Terminal as TerminalIcon } from "lucide-react";

import { useAgentSessions } from "../../features/agent/sessions-hooks";
import { useExperimentalFeature } from "../../features/settings/experimental-features";
import { useChatPanesStore } from "../../state/chat-panes-store";
import { spawnNewChatTab } from "../../state/spawn-default-chat";
import { spawnTerminalTab } from "../../state/spawn-terminal-tab";
import { useWorkspaceDispatch } from "../../state/store";
import { Button } from "../../shared/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { Tooltip } from "../../shared/ui/primitives";

const PLUS_BUTTON_CLS =
  "size-7 shrink-0 rounded-sm text-fg2 hover:bg-bg2-hover/40 hover:text-fg1 transition-[background-color,color] duration-120 ease-out";

export interface NewChatMenuProps {
  /** Cwd / workspace path the new tab should attach to. */
  workspaceFolder: string;
  /** The pane whose "+" this is — the new tab is routed there (split
   *  panes, 2026-07-17). Omitted → the focused pane gets it. */
  paneId?: string;
}

export function NewChatMenu({
  workspaceFolder,
  paneId,
}: NewChatMenuProps) {
  const dispatch = useWorkspaceDispatch();
  const sessions = useAgentSessions();
  const beginAssignNextChat = useChatPanesStore((s) => s.beginAssignNextChat);
  const [terminalAgentsEnabled] = useExperimentalFeature("terminalAgents");

  const openChat = useCallback(() => {
    // Reserve THIS pane for the chat about to be created — otherwise
    // the reconcile subscription routes it to the focused pane, which
    // is wrong when the user clicked "+" on an unfocused pane.
    if (paneId) beginAssignNextChat(workspaceFolder, paneId);
    void spawnNewChatTab({
      folder: workspaceFolder,
      sessions,
      dispatch,
    });
  }, [dispatch, sessions, workspaceFolder, paneId, beginAssignNextChat]);

  const openTerminal = useCallback(() => {
    if (paneId) beginAssignNextChat(workspaceFolder, paneId);
    spawnTerminalTab({ folder: workspaceFolder, dispatch });
  }, [dispatch, workspaceFolder, paneId, beginAssignNextChat]);

  const plusButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      className={PLUS_BUTTON_CLS}
      aria-label={terminalAgentsEnabled ? "New tab" : "New chat"}
      onClick={terminalAgentsEnabled ? undefined : openChat}
    >
      <Plus className="size-3.5" />
    </Button>
  );

  if (!terminalAgentsEnabled) {
    return (
      <div className="flex shrink-0 items-center">
        <Tooltip label="New chat" shortcut="⌘T">
          {plusButton}
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center">
      <DropdownMenu>
        <Tooltip label="New tab">
          <DropdownMenuTrigger asChild>{plusButton}</DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="start" sideOffset={6} className="w-44">
          <DropdownMenuItem onSelect={openChat}>
            <MessageSquare className="text-fg2" />
            <span>Chat</span>
            <DropdownMenuShortcut>⌘T</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openTerminal}>
            <TerminalIcon className="text-fg2" />
            <span>Terminal</span>
            <DropdownMenuShortcut>⌘⇧T</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
