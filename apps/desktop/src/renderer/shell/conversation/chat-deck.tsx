// ──────────────────────────────────────────────────────────
// Conversation pane — persistent non-terminal chat deck
// ──────────────────────────────────────────────────────────
//
// ChatPane owns geometry only. Transcript/composer trees live here, above the
// recursive pane layout, and portal into store-owned pane hosts. Switching a
// chat or workspace therefore reparents/reveals completed DOM instead of
// destroying markdown, TipTap, footer pills, scroll state, and syntax output.
// The deck is globally bounded; closed chats leave immediately.
// ──────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";

import { cn } from "../../shared/ui/cn";
import {
  selectActiveFolder,
  useActivePage,
  useWorkspaceStore,
} from "../../state/store";
import { DEFAULT_PANE_LAYOUT, paneForChat } from "../../state/chat-panes";
import { useChatPanesStore } from "../../state/chat-panes-store";
import { ChatView } from "./chat-view";
import { usePanePortalsStore } from "./pane-portal-store";
import { useRetainedViewKeySet } from "../use-retained-view-keys";
import { usePreparedChatId } from "./chat-intent";
import { useAgentSessions } from "../../features/agent/sessions-hooks";
import type { Workspace } from "../../platform/git";
import {
  useArchivedWorkspaces,
  useLiveWorkspaces,
  useProjects,
} from "../../state/use-projects";
import { readOnlyWorkspaceForFolder } from "../../state/workspace-history";
import { WorkspaceHistoryBar } from "../workspace-history-bar";

const MAX_RETAINED_CHAT_VIEWS = 12;

export function ChatDeck({
  workspace = null,
}: { workspace?: Workspace | null } = {}) {
  const sessions = useAgentSessions();
  const allChats = useWorkspaceStore(
    useShallow((state) =>
      state.chats.filter((chat) => chat.kind !== "terminal"),
    ),
  );
  const { workspaces: live } = useLiveWorkspaces();
  const { workspaces: archived } = useArchivedWorkspaces();
  const { projects } = useProjects();
  const workspaceOwners = useMemo(() => {
    const rows = new Map(archived.map((row) => [row.id, row]));
    for (const row of live) rows.set(row.id, row);
    // The route's authoritative owner wins over a stale aggregate response.
    if (workspace) rows.set(workspace.id, workspace);
    return Array.from(rows.values());
  }, [live, archived, workspace]);
  const historyOwners = useMemo(
    () =>
      new Map(
        allChats.map((chat) => [
          chat.id,
          readOnlyWorkspaceForFolder(chat.folder, workspaceOwners, projects),
        ]),
      ),
    [allChats, workspaceOwners, projects],
  );
  const chats = useMemo(
    () =>
      allChats.filter((chat) => !chat.archived || !!historyOwners.get(chat.id)),
    [allChats, historyOwners],
  );
  const activeFolder = useWorkspaceStore(selectActiveFolder);
  const activePage = useActivePage();
  const pendingAutoSend = useWorkspaceStore((state) => state.pendingAutoSend);
  const paneSlots = usePanePortalsStore((state) => state.panes);
  const layoutsByFolder = useChatPanesStore((state) => state.byFolder);
  const preparedChatId = usePreparedChatId();

  const availableChatIds = useMemo(
    () => new Set(chats.map((chat) => chat.id)),
    [chats],
  );
  const displayedChatIds = useMemo(() => {
    if (!activeFolder) return [];
    return chats
      .filter(
        (chat) =>
          (workspace && historyOwners.get(chat.id)?.id === workspace.id) ||
          chat.folder === activeFolder,
      )
      .filter((chat) => {
        const folder = historyOwners.get(chat.id)?.path ?? chat.folder;
        const layout = layoutsByFolder[folder] ?? DEFAULT_PANE_LAYOUT;
        const paneId = paneForChat(layout, chat.id);
        return paneSlots[paneId]?.activeChatId === chat.id;
      })
      .map((chat) => chat.id);
  }, [
    activeFolder,
    chats,
    historyOwners,
    workspace,
    layoutsByFolder,
    paneSlots,
  ]);
  const queuedChatIds = useMemo(
    () => Object.keys(pendingAutoSend).filter((id) => !historyOwners.get(id)),
    [pendingAutoSend, historyOwners],
  );
  const chatIdsToRetain = useMemo(() => {
    // Queued prepared-workspace chats stay mounted even after the user creates
    // and navigates to another workspace, so each exact first message can
    // hydrate/spawn/drain. Visible and pointer-prepared surfaces come last and
    // therefore retain priority under the global bound; excess queued chats
    // drain in bounded batches and automatically make room for older intents.
    const active = [...queuedChatIds];
    if (preparedChatId && !historyOwners.get(preparedChatId))
      active.push(preparedChatId);
    active.push(...displayedChatIds);
    return active;
  }, [displayedChatIds, preparedChatId, queuedChatIds, historyOwners]);
  const retainedChatIds = useRetainedViewKeySet(
    chatIdsToRetain,
    MAX_RETAINED_CHAT_VIEWS,
    availableChatIds,
  );
  const chatsById = useMemo(
    () => new Map(chats.map((chat) => [chat.id, chat] as const)),
    [chats],
  );
  const setRetainedChatIds = sessions.setRetainedChatIds;
  const setRetainedChatIdsRef = useRef(setRetainedChatIds);
  setRetainedChatIdsRef.current = setRetainedChatIds;

  // Publish only the COMMITTED deck. The eviction action runs in a passive
  // effect, after removed ChatViews have flushed drafts/queue holds and after
  // newly-retained views exist. Recent switching remains the exact same 12-view
  // DOM deck; this merely bounds the transcript arrays behind older slots.
  useEffect(() => {
    setRetainedChatIds(retainedChatIds);
  }, [retainedChatIds, setRetainedChatIds]);
  useEffect(() => () => setRetainedChatIdsRef.current([]), []);

  return (
    <>
      {retainedChatIds.map((chatId) => {
        const chat = chatsById.get(chatId);
        if (!chat) return null;
        const historyWorkspace = historyOwners.get(chat.id);
        const readOnly = !!historyWorkspace;
        const layoutFolder = historyWorkspace?.path ?? chat.folder;
        const layout = layoutsByFolder[layoutFolder] ?? DEFAULT_PANE_LAYOUT;
        const paneId = paneForChat(layout, chat.id);
        const slot = paneSlots[paneId];
        // A chat joins the deck only after its pane has committed a stable host.
        // The host remains owned by the store while inactive. One exception is
        // an exact queued create intent whose old split-pane host no longer
        // exists after navigation: mount it in a layout-inert fallback so its
        // persisted TipTap document can still start and drain. Never use this
        // fallback for ordinary retained views.
        if (!slot?.host) {
          if (readOnly || pendingAutoSend[chat.id] === undefined) return null;
          return (
            <div key={chat.id} hidden {...{ inert: "" }} aria-hidden="true">
              <ChatView chatId={chat.id} surfaceActive={false} />
            </div>
          );
        }
        const isActive =
          activePage === "workspace" &&
          (chat.folder === activeFolder ||
            (readOnly && historyWorkspace.id === workspace?.id)) &&
          slot.activeChatId === chat.id;
        const layer = (
          <div
            // Hidden retained chats keep full layout (visibility retention),
            // but a seam drag must not re-wrap 11 invisible transcripts per
            // frame — the freeze pin rides the same conditional as `inert`.
            // See resize-gesture-freeze.ts.
            {...(!isActive
              ? { inert: "", "data-zeros-resize-freeze": "" }
              : {})}
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
            <ChatView
              chatId={chat.id}
              surfaceActive={isActive}
              preparing={!readOnly && preparedChatId === chat.id && !isActive}
              readOnly={readOnly}
              composerReplacement={
                historyWorkspace ? (
                  <WorkspaceHistoryBar
                    key={historyWorkspace.id}
                    workspace={historyWorkspace}
                    surfaceActive={isActive}
                  />
                ) : null
              }
            />
          </div>
        );
        return createPortal(layer, slot.host, chat.id);
      })}
    </>
  );
}
