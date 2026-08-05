// ──────────────────────────────────────────────────────────
// Conversation pane — fixed closed-chat history control
// ──────────────────────────────────────────────────────────

import React, { useState } from "react";
import {
  MessagesSquare,
  RotateCcw,
  Terminal as TerminalIcon,
} from "lucide-react";

import { AgentIcon } from "../../features/agent/agent-icon";
import type { ChatThread } from "../../state/store";
import { Button } from "../../shared/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { Tooltip } from "../../shared/ui/primitives";
import { formatChatHistoryTime } from "./chat-history";

const HISTORY_BUTTON_CLS = "shrink-0 text-fg2";
const HISTORY_ROW_CLS =
  "flex max-w-[420px] min-w-[300px] items-center gap-2 px-2 py-1.5 text-fg1";
const HISTORY_TIME_CLS = "ml-2 shrink-0 text-xs tabular-nums text-fg2";

export function ChatHistoryMenu({
  chats,
  onRestoreChat,
}: {
  chats: ChatThread[];
  onRestoreChat: (chat: ChatThread) => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) setNow(Date.now());
      }}
    >
      <Tooltip label="Chat history">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={HISTORY_BUTTON_CLS}
            aria-label="Chat history"
          >
            <MessagesSquare className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="max-h-[360px] min-w-[300px] overflow-y-auto p-1"
      >
        {chats.length === 0 ? (
          <DropdownMenuItem disabled>No closed chats</DropdownMenuItem>
        ) : (
          chats.map((chat) => (
            <DropdownMenuItem
              key={chat.id}
              onSelect={() => onRestoreChat(chat)}
              className={HISTORY_ROW_CLS}
            >
              {chat.kind === "terminal" ? (
                <TerminalIcon className="text-fg2 size-3.5 shrink-0" />
              ) : (
                <AgentIcon
                  agentId={chat.agentId}
                  iconUrl={null}
                  size={14}
                  className="shrink-0"
                  monochrome
                />
              )}
              <span className="min-w-0 flex-1 truncate">
                {chat.title || "Untitled chat"}
              </span>
              <span className={HISTORY_TIME_CLS}>
                {formatChatHistoryTime(chat.updatedAt, now)}
              </span>
              <RotateCcw
                className="text-fg2 size-3 shrink-0"
                aria-hidden="true"
              />
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
