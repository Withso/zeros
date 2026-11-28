import { useMemo, useRef } from "react";
import { ChevronRight, MessageCircle, Plus } from "lucide-react";
import {
  CommandItem,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives";
import { formatCompactAge } from "../../features/agent/format-age";
import {
  canOpenSideChat,
  getSideChatSeed,
  isSideChat,
  openSideChat,
  publishSideChat,
  sessionViewChatId,
} from "../../features/agent/side-chat";
import { editChat } from "../../state/cloud-chat-edits";
import type { ChatThread } from "../../state/store";
import { useWorkspaceDispatch, useWorkspaceStore, workbenchScopeForFolder } from "../../state/workspace-store";
import { NEW_TAB_MENU_CHROME } from "./new-tab-environment-menu";

export interface SideChatEntry {
  chat: ChatThread;
  /** The chat it was opened from, by name. */
  from: string | null;
  open: boolean;
}

/** Every side chat of one Workbench scope, newest first, with where each was
 *  opened from and whether its tab is open. */
export function sideChatEntries(
  chats: readonly ChatThread[],
  scope: string,
  openChatIds: ReadonlySet<string>,
): SideChatEntry[] {
  const titles = new Map(chats.map((chat) => [chat.id, chat.title]));
  return chats
    .filter((chat) => isSideChat(chat) && workbenchScopeForFolder(chat.folder) === scope)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
    .map((chat) => ({
      chat,
      from: (chat.sourceChatId ? titles.get(chat.sourceChatId)?.trim() : null) ||
        getSideChatSeed(chat.id)?.sourceTitle || null,
      open: openChatIds.has(chat.id),
    }));
}

/** The + menu's Side chat row and its submenu: New side chat, then every side
 *  chat in this workspace. Choosing one focuses its tab, or reopens a closed
 *  one. Side chats live only here and in their tabs, never in the chat
 *  column. */
export function NewTabSideChatMenu({
  open,
  onOpenChange,
  scope,
  folder,
  onDone,
  restoreSearchFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  scope: string;
  /** The folder whose session a New side chat starts from. */
  folder: string;
  onDone(): void;
  restoreSearchFocus(): void;
}) {
  const triggerRef = useRef<HTMLDivElement | null>(null);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <CommandItem
          ref={triggerRef}
          value="side-chat"
          onSelect={() => onOpenChange(true)}
          onPointerEnter={() => onOpenChange(true)}
          onPointerDown={(event) => {
            // This row enters a submenu; a press while hovered must not toggle
            // the open submenu closed before the click reopens it.
            event.preventDefault();
            onOpenChange(true);
          }}
          aria-label="Side chat"
          data-new-tab-side-chat=""
        >
          <MessageCircle className="size-3.5" />
          <span>Side chat</span>
          <ChevronRight className="text-fg2 ml-auto size-3.5" aria-hidden />
        </CommandItem>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className={`${NEW_TAB_MENU_CHROME} max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto`}
        aria-label="Side chats"
        aria-labelledby={undefined}
        onPointerDownOutside={(event) => {
          if (triggerRef.current?.contains(event.target as Node)) event.preventDefault();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onOpenChange(false);
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreSearchFocus();
        }}
      >
        {open && <SideChatItems scope={scope} folder={folder} onDone={onDone} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function sideChatListLabel(count: number, hydrating: boolean): string {
  if (count) return `In this workspace · ${count}`;
  return hydrating ? "Loading side chats…" : "No side chats yet";
}

function SideChatItems({ scope, folder, onDone }: { scope: string; folder: string; onDone(): void }) {
  const dispatch = useWorkspaceDispatch();
  const chats = useWorkspaceStore((state) => state.chats);
  const tabs = useWorkspaceStore((state) => state.workbenchByScope[scope]?.tabs);
  // While the folder's chats are being confirmed the list is unknown, not empty.
  const hydrating = useWorkspaceStore((state) => state.pendingChatHydrationFolder === folder);
  const source = useWorkspaceStore((state) => {
    const id = sessionViewChatId(state.chats, state.activeChatId, folder);
    return state.chats.find((chat) => chat.id === id && workbenchScopeForFolder(chat.folder) === scope) ?? null;
  });
  const entries = useMemo(() => {
    const openIds = new Set((tabs ?? []).flatMap((tab) => (tab.type === "chat" && tab.chatId ? [tab.chatId] : [])));
    return sideChatEntries(chats, scope, openIds);
  }, [chats, scope, tabs]);

  const reopen = (chat: ChatThread) => {
    if (chat.archived) editChat(dispatch, chat.id, { archived: false });
    publishSideChat(dispatch, { ...chat, archived: false });
    onDone();
  };

  return (
    <>
      <DropdownMenuItem
        disabled={!canOpenSideChat(source)}
        onSelect={() => {
          if (!canOpenSideChat(source)) return;
          openSideChat(source, null, { publishChat: (chat) => publishSideChat(dispatch, chat) });
          onDone();
        }}
        data-new-side-chat=""
      >
        <Plus className="text-fg2 size-3.5" />
        <span>New side chat</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-fg3 text-3xxs font-medium">
        {sideChatListLabel(entries.length, hydrating)}
      </DropdownMenuLabel>
      {entries.map(({ chat, from, open }) => (
        <DropdownMenuItem key={chat.id} onSelect={() => reopen(chat)} className="items-start" data-side-chat-entry={chat.id}>
          <MessageCircle className="text-fg2 mt-0.5 size-3.5" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-fg1 truncate">{chat.title.trim() || "Side chat"}</span>
            <span className="text-fg3 truncate text-3xxs leading-4">
              {[from ? `Branched from ${from}` : null, chat.archived ? "Closed" : formatCompactAge(chat.updatedAt)]
                .filter(Boolean).join(" · ")}
            </span>
          </span>
          {open && <span className="text-fg3 shrink-0 text-3xxs leading-4">Open</span>}
        </DropdownMenuItem>
      ))}
    </>
  );
}
