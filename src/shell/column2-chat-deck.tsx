// ──────────────────────────────────────────────────────────
// Column 2 — persistent non-terminal chat deck
// ──────────────────────────────────────────────────────────
//
// ChatPane owns geometry only. Transcript/composer trees live here, above the
// recursive pane layout, and portal into store-owned pane hosts. Switching a
// chat or workspace therefore reparents/reveals completed DOM instead of
// destroying markdown, TipTap, footer pills, scroll state, and syntax output.
// The deck is globally bounded; closed chats leave immediately.
// ──────────────────────────────────────────────────────────

import React, { useMemo } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";

import { cn } from "../zeros/ui/cn";
import {
  selectActiveFolder,
  useActivePage,
  useWorkspaceStore,
} from "../zeros/store/store";
import { DEFAULT_PANE_LAYOUT, paneForChat } from "../zeros/store/chat-panes";
import { useChatPanesStore } from "../zeros/store/chat-panes-store";
import { Column2ChatView } from "./column2-chat-view";
import { usePanePortalsStore } from "./column2-pane-stores";
import { useRetainedViewKeySet } from "./use-retained-view-keys";
import { usePreparedColumn2ChatId } from "./column2-chat-intent";

const MAX_RETAINED_CHAT_VIEWS = 12;

export function Column2ChatDeck() {
  const chats = useWorkspaceStore(
    useShallow((state) =>
      state.chats.filter((chat) => chat.kind !== "terminal" && !chat.archived),
    ),
  );
  const activeFolder = useWorkspaceStore(selectActiveFolder);
  const activePage = useActivePage();
  const pendingAutoSend = useWorkspaceStore((state) => state.pendingAutoSend);
  const paneSlots = usePanePortalsStore((state) => state.panes);
  const layoutsByFolder = useChatPanesStore((state) => state.byFolder);
  const preparedChatId = usePreparedColumn2ChatId();

  const availableChatIds = useMemo(
    () => new Set(chats.map((chat) => chat.id)),
    [chats],
  );
  const displayedChatIds = useMemo(() => {
    if (!activeFolder) return [];
    const layout = layoutsByFolder[activeFolder] ?? DEFAULT_PANE_LAYOUT;
    return chats
      .filter((chat) => chat.folder === activeFolder)
      .filter((chat) => {
        const paneId = paneForChat(layout, chat.id);
        return paneSlots[paneId]?.activeChatId === chat.id;
      })
      .map((chat) => chat.id);
  }, [activeFolder, chats, layoutsByFolder, paneSlots]);
  const queuedChatIds = useMemo(
    () => Object.keys(pendingAutoSend),
    [pendingAutoSend],
  );
  const chatIdsToRetain = useMemo(() => {
    // Queued prepared-workspace chats stay mounted even after the user creates
    // and navigates to another workspace, so each exact first message can
    // hydrate/spawn/drain. Visible and pointer-prepared surfaces come last and
    // therefore retain priority under the global bound; excess queued chats
    // drain in bounded batches and automatically make room for older intents.
    const active = [...queuedChatIds];
    if (preparedChatId) active.push(preparedChatId);
    active.push(...displayedChatIds);
    return active;
  }, [displayedChatIds, preparedChatId, queuedChatIds]);
  const retainedChatIds = useRetainedViewKeySet(
    chatIdsToRetain,
    MAX_RETAINED_CHAT_VIEWS,
    availableChatIds,
  );
  const chatsById = useMemo(
    () => new Map(chats.map((chat) => [chat.id, chat] as const)),
    [chats],
  );

  return (
    <>
      {retainedChatIds.map((chatId) => {
        const chat = chatsById.get(chatId);
        if (!chat) return null;
        const layout = layoutsByFolder[chat.folder] ?? DEFAULT_PANE_LAYOUT;
        const paneId = paneForChat(layout, chat.id);
        const slot = paneSlots[paneId];
        // A chat joins the deck only after its pane has committed a stable host.
        // The host remains owned by the store while inactive. One exception is
        // an exact queued create intent whose old split-pane host no longer
        // exists after navigation: mount it in a layout-inert fallback so its
        // persisted TipTap document can still start and drain. Never use this
        // fallback for ordinary retained views.
        if (!slot?.host) {
          if (!pendingAutoSend[chat.id]) return null;
          return (
            <div key={chat.id} hidden {...{ inert: "" }} aria-hidden="true">
              <Column2ChatView chatId={chat.id} surfaceActive={false} />
            </div>
          );
        }
        const isActive =
          activePage === "workspace" &&
          chat.folder === activeFolder &&
          slot.activeChatId === chat.id;
        const layer = (
          <div
            {...(!isActive ? { inert: "" } : {})}
            data-zeros-root=""
            className={cn(
              // --pane-bg is the chat-WINDOW fill, inherited from the pane
              // this layer is portaled into: bg1 on the focused pane (the
              // active window looks like the plain app canvas), bg0 on
              // unfocused panes (plus the pane's bg0/30 veil) so inactive
              // windows read as recessed. See --pane-bg in zeros-tokens.css.
              "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden bg-(--pane-bg)",
              isActive
                ? "pointer-events-auto visible"
                : "pointer-events-none invisible",
            )}
            aria-hidden={!isActive}
          >
            <Column2ChatView
              chatId={chat.id}
              surfaceActive={isActive}
              preparing={preparedChatId === chat.id && !isActive}
            />
          </div>
        );
        return createPortal(layer, slot.host, chat.id);
      })}
    </>
  );
}
