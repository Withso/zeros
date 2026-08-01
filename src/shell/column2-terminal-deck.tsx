// ──────────────────────────────────────────────────────────
// Column 2 — Terminal-agent tab deck
// ──────────────────────────────────────────────────────────
//
// Mounted ONCE at the column level (a sibling of the pane tree inside
// Column2Workspace's body stack). Renders every `kind: "terminal"`
// ChatThread as a persistent layer; the layer's DOM is PORTALED into
// the pane that owns the chat (split panes, 2026-07-17) and is visible
// only while it's that pane's displayed chat.
//
// Why the deck stays outside the pane tree:
//
//   Pane leaves mount/unmount as the user splits, collapses and
//   resizes. If terminal layers were children of a pane, every layout
//   change would tear down the xterm widget. Keeping the deck stable
//   and portaling each layer means a pane rearrangement at most MOVES
//   DOM nodes. (A chat moved BETWEEN panes changes its portal target,
//   which does remount the layer — equivalent to a page refresh; the
//   PTY itself survives on the engine either way, see
//   terminal-session-view.tsx "do NOT ptyKill on unmount".)
//
// Terminals whose workspace isn't in view (or whose pane host hasn't
// registered yet) render into the deck's own hidden container, exactly
// like the pre-panes behavior for background workspaces.
//
// Visibility contract mirrors the column-3 terminal panel:
//   - Displayed in its pane → `visible pointer-events-auto`, full bg
//   - Everything else      → `invisible pointer-events-none`, aria-hidden
// ──────────────────────────────────────────────────────────

import React from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";

import { cn } from "../zeros/ui/cn";
import {
  selectActiveFolder,
  useActivePage,
  useWorkspaceDispatch,
  useWorkspaceStore,
} from "../zeros/store/store";
import { paneForChat } from "../zeros/store/chat-panes";
import { usePaneLayout } from "../zeros/store/chat-panes-store";
import { usePanePortalsStore } from "./column2-pane-stores";
import { TerminalSessionView } from "./terminal/terminal-session-view";

export function Column2TerminalDeck() {
  // Select only terminal-kind chats; useShallow keeps the result
  // reference-stable when that set is unchanged, so unrelated store
  // mutations don't re-render this deck or reconcile xterm.
  const terminals = useWorkspaceStore(
    useShallow((s) =>
      s.chats.filter((c) => c.kind === "terminal" && !c.archived),
    ),
  );
  const activeFolder = useWorkspaceStore(selectActiveFolder);
  const activePage = useActivePage();
  const layout = usePaneLayout(activeFolder);
  const paneSlots = usePanePortalsStore((s) => s.panes);
  const dispatch = useWorkspaceDispatch();

  if (terminals.length === 0) return null;

  return (
    <>
      {terminals.map((chat) => {
        // Resolve where this terminal should live: the owning pane of
        // the ACTIVE workspace, else the deck's hidden container.
        const inActiveWorkspace = chat.folder === activeFolder;
        const paneId = inActiveWorkspace ? paneForChat(layout, chat.id) : null;
        const slot = paneId ? paneSlots[paneId] : undefined;
        // Active-workspace terminal whose pane host hasn't registered
        // yet (the deck's very first render commits before the pane's
        // refs run): skip this cycle instead of mounting into the
        // fallback — the immediate re-portal would remount xterm.
        if (paneId && !slot?.host) return null;
        const isActive =
          activePage === "workspace" && !!slot && slot.activeChatId === chat.id;
        const promoteTerminalChat = () => {
          if (
            isActive &&
            useWorkspaceStore.getState().activeChatId !== chat.id
          ) {
            dispatch({ type: "SET_ACTIVE_CHAT", id: chat.id });
          }
        };
        const layer = (
          <div
            key={chat.id}
            // Hidden terminal layers stay mounted for PTY/xterm survival; the
            // freeze pin keeps them out of per-frame layout during seam drags
            // (see resize-gesture-freeze.ts).
            {...(!isActive
              ? { inert: "", "data-zeros-resize-freeze": "" }
              : {})}
            className={cn(
              // `p-4` matches the col-3 terminal panel's padding; the
              // padding area inherits bg-bg1 (= the xterm background)
              // so it reads as one continuous terminal surface.
              "bg-bg1 absolute inset-0 flex min-h-0 min-w-0 flex-col p-4",
              isActive
                ? "pointer-events-auto visible"
                : "pointer-events-none invisible",
            )}
            aria-hidden={!isActive}
            // Focus follows pointer and keyboard/programmatic entry for
            // terminal bodies. The pane section's capture handlers can't
            // see these events:
            // portaled layers propagate through the DECK's React tree,
            // not the pane's. Promote the terminal directly (same effect
            // as clicking its tab).
            onPointerDownCapture={promoteTerminalChat}
            onFocusCapture={promoteTerminalChat}
          >
            <TerminalSessionView
              sessionId={chat.id}
              cwd={chat.folder}
              visible={isActive}
              agentId={chat.agentId}
            />
          </div>
        );
        return slot?.host ? (
          createPortal(layer, slot.host, chat.id)
        ) : (
          <React.Fragment key={chat.id}>{layer}</React.Fragment>
        );
      })}
    </>
  );
}
