// ──────────────────────────────────────────────────────────
// Conversation pane — fixed closed-chat history control
// ──────────────────────────────────────────────────────────

import React, { useState } from "react";
import {
  MessageCircle,
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

/** 14px glyph. The size MUST live here, not on the icon: Button's base
 *  `[&_svg]:size-4` is a descendant selector and outranks any `size-*` utility
 *  on the svg itself, so a per-icon class is silently ignored. On the button,
 *  cn()'s twMerge sees the same `[&_svg]:size-*` group and keeps this one.
 *  message-circle is a full-bleed bubble, so at the shared 16px it read much
 *  heavier than the "⋯" beside it. */
const HISTORY_BUTTON_CLS = "shrink-0 text-fg2 [&_svg]:size-3.5";
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
            <MessageCircle />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        // The trigger sits at the strip's right end (beside the "⋯" menu), so
        // the panel hangs leftward from it — `align="start"` would push a
        // 300px-wide list off the window edge.
        align="end"
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
