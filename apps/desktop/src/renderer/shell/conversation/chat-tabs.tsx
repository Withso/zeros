// ──────────────────────────────────────────────────────────
// Conversation pane — Chat tabs strip (per-pane, sticky + responsive)
// ──────────────────────────────────────────────────────────
//
// One strip per PANE (split-pane groups live in conversation/pane-layout.tsx —
// before 2026-07-17 there was exactly one strip for the whole column
// and this file also owned workspace resolution + the selection
// keeper; those moved to ConversationPaneLayout). The strip lists the pane's
// chats as a Chrome-style pill row — unbounded, scrolling horizontally
// when they overflow.
//
// Behavior contract:
//
//   - `leading` (the Code/Design mode toggle) is the strip's fixed first
//     control, ahead of the history icon; `trailing` (the workbench expand
//     control, only while that panel is collapsed) is pinned past the "⋯"
//     menu. Both live OUTSIDE the scrolling lane, so neither moves as tabs
//     scroll. The owning column decides which pane in a split gets them (see
//     conversation/pane-layout.tsx) — this strip only seats what it is handed.
//     The row's height matches Workbench's header exactly, so the expand
//     control keeps one position across the collapse toggle.
//   - The fixed message-circle icon lists closed tabs (workspace-wide);
//     restoring one lands in THIS pane. It is pinned at the strip's right end,
//     immediately left of the "⋯" menu, so the pane's two menu controls read as
//     one cluster instead of straddling the tabs.
//   - "+" is the only new-tab control; new tabs are created in THIS
//     pane. It stays fixed after the lane while only the tabs scroll.
//   - The "⋯" menu is pinned at the far right: the first Split Right can grow
//     the conversation column to two 360px panes; later splits wait until the
//     resulting whole tree fits. Split Down follows the corresponding height
//     check. Both directions still respect the pane cap.
//   - Tabs are content-sized pills from 70px through 140px, then
//     truncate. Click → activate. Hover → ×. Right-click → Rename /
//     Close. Drag a tab onto a pane body to move it there (or onto the
//     right/bottom band to split — see PaneDropOverlay).
//   - The active tab pins to whichever strip edge it reaches.

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ClipboardList,
  Columns2,
  Copy,
  Ellipsis,
  MessageCircleQuestionMark,
  Pencil,
  Rows2,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";

import { cn } from "../../shared/ui/cn";
import { Button } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/renderer/shared/ui/primitives/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { useWorkspaceDispatch, type ChatThread } from "../../state/store";
import { useNativeRuntime } from "../../platform/runtime";
import { OpenInSubmenu } from "./conversation-header";
import { AgentIcon } from "../../features/agent/agent-icon";
import {
  useChatAwaitingKind,
  useChatStreaming,
} from "../../features/agent/sessions-store";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { useTerminalBusy } from "../terminal/terminal-activity";
import { ChatHistoryMenu } from "./chat-history-menu";
import { NewChatMenu } from "./new-chat-menu";
import { copyChatTranscript } from "../copy-chat-transcript";
import type { TranscriptMode } from "../../features/agent/transcript-format";
import {
  CHAT_TAB_DRAG_MIME,
  armTabDrag,
  clearTabDrag,
  isTabDragArmCurrent,
  useTabDragStore,
} from "./pane-portal-store";
import {
  horizontalOverflow,
  workspaceFadeVisibility as stickyTabFadeVisibility,
  workspacePinSide as stickyTabPinSide,
  workspaceScrollLeftForTab as scrollLeftForStickyTab,
} from "../workspace-tabs";

// ── className constants ──────────────────────────────────

/** Outer shell — the chat-tab row. The tabs are floating Chrome-style pills
 *  on the pane's --pane-bg window fill (bg1 focused / bg0 not; no border/fill of
 *  its own). h-10 is the app's chrome-band height: the global TopBar, Workbench's
 *  header, and the PR status row are all 40px, and Workbench's header seats the
 *  same h-7 pills in the same 6px of top/bottom breathing room via items-center
 *  — the row's height IS its vertical padding (children use h-full, so it stays
 *  a definite height rather than intrinsic py-*).
 *
 *  2026-09-01: this was h-11 (44px). Once Code's own header row was removed, the
 *  strip became the column's FIRST row, sitting beside Workbench's h-10 header —
 *  and the workbench expand control, which lives in whichever of the two owns it,
 *  landed 2px lower when the panel was collapsed. One shared height is the fix,
 *  so this constant is EXPORTED and the placeholder band in
 *  conversation/pane-layout.tsx consumes it rather than restating the literal. */
export const CHAT_STRIP_SHELL_CLS =
  "flex h-10 shrink-0 items-center overflow-hidden";

/** Column-owned strip slots. 2026-09-01: Code's conversation column dropped its
 * own h-10 name/mode row, so the mode toggle became this strip's fixed leading
 * control and the collapsed-workbench expand button its fixed trailing one.
 * Each slot owns only the window-edge gutter — the neighbouring control's own
 * `pl-2`/`pr-2` supplies the gap between them. Exported so the no-workspace
 * placeholder band in conversation/pane-layout.tsx seats them identically.
 *
 * `relative z-40` lifts both slots ABOVE the host pane's inactive-window veil
 * (`bg-bg0/30`, z-30 — see ChatPane in conversation/pane-layout.tsx). That veil
 * exists to dim a pane's own chrome and transcript when it isn't the focused
 * window, and it should keep doing that for the pane's tabs, history, "+" and
 * "⋯". These two controls are NOT pane-scoped: they act on the whole workspace
 * (Code↔Design) and the whole column (expand Workbench), and they only borrow a
 * corner of one pane's strip because the column no longer has a row of its own.
 * Dimming them by 30% toward bg0 made the mode toggle read as unavailable
 * whenever the top-left pane happened to be unfocused. z-40 matches the drag
 * drop overlay, which is a LATER sibling and so still paints over the strip
 * mid-drag. The pane's bg0 window fill still shows behind them (a ~1% shift
 * against bg1), so the surrounding strip keeps reading as recessed. */
export const CHAT_STRIP_LEADING_CLS =
  "relative z-40 flex h-full shrink-0 items-center pl-2 pr-1";
export const CHAT_STRIP_TRAILING_CLS =
  "relative z-40 flex h-full shrink-0 items-center pr-2";

/** History, plus, and the "⋯" menu all sit outside the scroll viewport. The lane
 * shrink-wraps while tabs fit, then consumes the available room and scrolls.
 *
 * 2026-09-01: history moved from the strip's left edge to its right end, so it
 * dropped the left gutter it used to own there — it now abuts the "⋯" menu, and
 * the two 24px icon buttons' own internal padding is the separation. The leading
 * slot picked up `pr-1` in exchange: with history gone from between them, the
 * mode toggle would otherwise sit 4px from the first tab pill. */
const HISTORY_CONTROL_CLS = "flex h-full shrink-0 items-center";
const PLUS_CONTROL_CLS = "flex h-full shrink-0 items-center";
/** Both menu controls are pinned at the far right, after the flexible filler,
 *  so they stay put no matter how many tabs are open. */
const PANE_MENU_CONTROL_CLS = "flex h-full shrink-0 items-center pr-2";
const TAB_VIEWPORT_CLS = "relative h-full min-w-0 shrink overflow-hidden";
const TAB_NAV_CLS =
  "h-full min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** The scrollable lane holds only chat tabs. Its 4px inner gutters and 4px
 *  tab gap match the workspace strip; History and "+" stay outside it. */
const TAB_ROW_CLS = "relative flex h-full w-max items-center gap-1 px-1";

/** Chrome-style pill — content-sized from 70px through a 140px cap (then
 *  truncates), no divider, and doesn't shrink (the strip scrolls instead).
 *  `relative` + `overflow-hidden` pin the affordance overlay and its fade to
 *  the rounded right edge. Surface progression on the --pane-bg window fill: an INACTIVE tab
 *  has no resting fill; hover and the ACTIVE tab both fill bg-bg2. Selection
 *  reads from the persistent fill + fg1 text. */
const TAB_BASE_CLS =
  "group/tab relative flex h-7 min-w-[70px] max-w-[140px] shrink-0 cursor-pointer select-none items-center gap-2 overflow-hidden rounded-sm px-2 text-left text-xs font-medium text-fg2 transition-none focus-within:bg-bg2 focus-within:text-fg2 data-[hovered=true]:bg-bg2 data-[hovered=true]:text-fg2 data-[active=true]:sticky data-[active=true]:left-1 data-[active=true]:right-1 data-[active=true]:z-20 data-[active=true]:bg-bg2 data-[active=true]:text-fg1 data-[active=true]:focus-within:text-fg1 data-[active=true]:data-[hovered=true]:text-fg1";

const TAB_LABEL_CLS = "min-w-0 truncate text-xs font-medium leading-none";

/** Overlay containing the close button. See the original notes: the
 *  gradient matches the tab's bg2 fill so long titles fade behind it. */
const TAB_HOVER_OVERLAY_CLS =
  "pointer-events-none absolute inset-y-0 right-0 flex w-10 items-center justify-end bg-gradient-to-l from-bg2 from-50% to-transparent pr-1.5 pl-4 opacity-0 transition-none group-data-[hovered=true]/tab:opacity-100 focus-within:opacity-100";

const TAB_AFFORDANCE_BTN_CLS =
  "pointer-events-auto size-5 inline-flex items-center justify-center rounded-sm shrink-0 text-fg2 hover:text-fg1 hover:bg-bg2-hover transition-[background-color,color] duration-120 ease-out";

const TITLE_INPUT_CLS =
  "flex-1 min-w-0 h-5 px-1.5 text-xs font-medium text-fg1 bg-transparent border border-border1 rounded-sm outline-none focus-visible:border-highlighted-bright focus-visible:ring-2 focus-visible:ring-highlighted-bright/30";

/** Synthetic "Untitled" tab — rendered while the workspace has zero
 *  visible chats (the selection keeper is mid-spawn). */
const TAB_UNTITLED_CLS =
  "group/tab relative flex h-7 min-w-[70px] max-w-[140px] shrink-0 cursor-default select-none items-center gap-2 overflow-hidden rounded-sm bg-bg2 px-2 text-xs font-medium text-fg1";

const PANE_MENU_BTN_CLS =
  "size-7 shrink-0 rounded-sm text-fg2 hover:bg-bg2-hover/40 hover:text-fg1 transition-[background-color,color] duration-120 ease-out";

const CHAT_CONTENT_INSET_PX = 4;
const CHAT_STICKY_EDGE_INSET_PX = 4;
const CHAT_TAB_GAP_PX = 4;
const CHAT_FADE_WIDTH_PX = 24;

function setChatFadeVisible(
  fade: HTMLDivElement | null,
  visible: boolean,
): void {
  if (!fade) return;
  const opacity = visible ? "1" : "0";
  if (fade.style.opacity !== opacity) fade.style.opacity = opacity;
}

function placeChatFade(
  fade: HTMLDivElement | null,
  visible: boolean,
  left: number,
): void {
  if (!fade) return;
  const transform = `translate3d(${left}px, 0, 0)`;
  if (fade.style.transform !== transform) fade.style.transform = transform;
  setChatFadeVisible(fade, visible);
}

/** Chromium reports a sticky tab's clamped offsetLeft. Its preceding regular
 * tab still exposes the active tab's natural flow position. */
function chatTabNaturalOffsetLeft(tab: HTMLDivElement): number {
  let sibling = tab.previousElementSibling;
  while (sibling) {
    if (
      sibling instanceof HTMLDivElement &&
      sibling.dataset.chatTab === "true"
    ) {
      return sibling.offsetLeft + sibling.offsetWidth + CHAT_TAB_GAP_PX;
    }
    sibling = sibling.previousElementSibling;
  }
  return CHAT_CONTENT_INSET_PX;
}

// ── Props ────────────────────────────────────────────────

export interface ChatTabsProps {
  workspaceFolder: string;
  paneId: string;
  /** This pane's visible chats, createdAt ASC (strip order). */
  chats: ChatThread[];
  /** The chat this pane is displaying (drives the selected pill). */
  activeChatId: string | null;
  /** Workspace-wide closed (archived) chats for the History menu. */
  historyChats: ChatThread[];
  /** Render the synthetic Untitled pill (workspace has zero chats). */
  showSyntheticUntitled: boolean;
  onSelectUntitled: () => void;
  onSelectChat: (chatId: string) => void;
  onPrefetchChat: (chatId: string) => void;
  onCloseTab: (chat: ChatThread, e?: React.MouseEvent) => void;
  onRestoreChat: (chat: ChatThread) => void;
  onSplit: (dir: "right" | "down") => void;
  canSplitRight: boolean;
  canSplitDown: boolean;
  /** Column-level control pinned before the history icon (the mode toggle).
   *  Handed to exactly one pane per column, so a split shows it once. */
  leading?: ReactNode;
  /** Column-level control pinned past the "⋯" menu at the window's right edge
   *  (the workbench expand button while that panel is collapsed). */
  trailing?: ReactNode;
}

// ── Component ────────────────────────────────────────────

export function ChatTabs({
  workspaceFolder,
  paneId,
  chats,
  activeChatId,
  historyChats,
  showSyntheticUntitled,
  onSelectUntitled,
  onSelectChat,
  onPrefetchChat,
  onCloseTab,
  onRestoreChat,
  onSplit,
  canSplitRight,
  canSplitDown,
  leading,
  trailing,
}: ChatTabsProps) {
  // Sticky strip refs + compositor-synced fade/hover machinery. All of
  // this is unchanged from the single-strip era — just scoped per pane.
  const chatNavRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const outerLeftFadeRef = useRef<HTMLDivElement | null>(null);
  const outerRightFadeRef = useRef<HTMLDivElement | null>(null);
  const afterPinnedLeftFadeRef = useRef<HTMLDivElement | null>(null);
  const beforePinnedRightFadeRef = useRef<HTMLDivElement | null>(null);
  const chatPointerRef = useRef<{
    clientX: number;
    clientY: number;
  } | null>(null);
  const hoveredTabRef = useRef<HTMLDivElement | null>(null);

  const setHoveredTab = useCallback((nextTab: HTMLDivElement | null) => {
    const currentTab = hoveredTabRef.current;
    if (currentTab === nextTab) return;
    currentTab?.removeAttribute("data-hovered");
    if (nextTab) nextTab.dataset.hovered = "true";
    hoveredTabRef.current = nextTab;
  }, []);

  /** Native :hover can remain attached to the element that used to be under a
   * stationary cursor during compositor scrolling. Re-hit-test the stored
   * viewport coordinate on every scroll event so hover follows the visible tab
   * synchronously, without a React render. */
  const retargetChatHover = useCallback(() => {
    const nav = chatNavRef.current;
    const pointer = chatPointerRef.current;
    if (!nav || !pointer) {
      setHoveredTab(null);
      return;
    }

    const navRect = nav.getBoundingClientRect();
    const insideHoverArea =
      pointer.clientX >= navRect.left + CHAT_STICKY_EDGE_INSET_PX &&
      pointer.clientX < navRect.right - CHAT_STICKY_EDGE_INSET_PX &&
      pointer.clientY >= navRect.top &&
      pointer.clientY < navRect.bottom;
    if (!insideHoverArea) {
      setHoveredTab(null);
      return;
    }

    const hit = document.elementFromPoint(pointer.clientX, pointer.clientY);
    const candidate = hit?.closest('[data-chat-tab="true"]') ?? null;
    setHoveredTab(
      candidate instanceof HTMLDivElement && nav.contains(candidate)
        ? candidate
        : null,
    );
  }, [setHoveredTab]);

  const handleChatPointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "touch") {
        chatPointerRef.current = null;
        setHoveredTab(null);
        return;
      }
      chatPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
      };
      retargetChatHover();
    },
    [retargetChatHover, setHoveredTab],
  );

  const handleChatWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      chatPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
      };
      retargetChatHover();
    },
    [retargetChatHover],
  );

  const clearChatPointer = useCallback(() => {
    chatPointerRef.current = null;
    setHoveredTab(null);
  }, [setHoveredTab]);

  const registerChatTab = useCallback(
    (chatId: string, node: HTMLDivElement | null) => {
      if (node) tabRefs.current.set(chatId, node);
      else tabRefs.current.delete(chatId);
    },
    [],
  );

  const measureChatStrip = useCallback(() => {
    const nav = chatNavRef.current;
    if (!nav) return;

    const overflow = horizontalOverflow({
      scrollLeft: nav.scrollLeft,
      scrollWidth: nav.scrollWidth,
      clientWidth: nav.clientWidth,
    });
    const activeTab = activeChatId ? tabRefs.current.get(activeChatId) : null;
    const activeTabWidth = activeTab?.offsetWidth ?? 0;
    const pinSide = activeTab
      ? stickyTabPinSide({
          scrollLeft: nav.scrollLeft,
          scrollWidth: nav.scrollWidth,
          clientWidth: nav.clientWidth,
          tabOffsetLeft: chatTabNaturalOffsetLeft(activeTab),
          tabWidth: activeTabWidth,
          edgeInset: CHAT_STICKY_EDGE_INSET_PX,
        })
      : null;
    const fades = stickyTabFadeVisibility(overflow, pinSide);

    setChatFadeVisible(outerLeftFadeRef.current, fades.outerLeft);
    setChatFadeVisible(outerRightFadeRef.current, fades.outerRight);
    placeChatFade(
      afterPinnedLeftFadeRef.current,
      fades.afterPinnedLeft,
      CHAT_STICKY_EDGE_INSET_PX + activeTabWidth,
    );
    placeChatFade(
      beforePinnedRightFadeRef.current,
      fades.beforePinnedRight,
      Math.max(
        0,
        nav.clientWidth -
          CHAT_STICKY_EDGE_INSET_PX -
          activeTabWidth -
          CHAT_FADE_WIDTH_PX,
      ),
    );
  }, [activeChatId]);

  const syncChatStrip = useCallback(() => {
    measureChatStrip();
    retargetChatHover();
  }, [measureChatStrip, retargetChatHover]);

  // Each workspace owns an independent logical chat list. Start a newly opened
  // workspace at the leading edge before revealing its active tab below.
  useLayoutEffect(() => {
    if (chatNavRef.current) chatNavRef.current.scrollLeft = 0;
  }, [workspaceFolder]);

  // Track responsive viewport changes and content-width changes (renames,
  // activity glyph swaps, newly-created or closed tabs).
  useLayoutEffect(() => {
    const nav = chatNavRef.current;
    if (!nav) return;
    syncChatStrip();
    const frame = window.requestAnimationFrame(syncChatStrip);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncChatStrip);
    observer?.observe(nav);
    if (nav.firstElementChild) observer?.observe(nav.firstElementChild);
    window.addEventListener("resize", syncChatStrip);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", syncChatStrip);
    };
  }, [workspaceFolder, chats.length, syncChatStrip]);

  // Reveal an externally selected/new/restored tab by its NATURAL flow slot.
  // scrollIntoView sees the sticky visual box and can incorrectly no-op.
  useLayoutEffect(() => {
    if (!activeChatId) return;
    const nav = chatNavRef.current;
    const activeTab = tabRefs.current.get(activeChatId);
    if (!nav || !activeTab) return;
    const targetScrollLeft = scrollLeftForStickyTab({
      scrollLeft: nav.scrollLeft,
      scrollWidth: nav.scrollWidth,
      clientWidth: nav.clientWidth,
      tabOffsetLeft: chatTabNaturalOffsetLeft(activeTab),
      tabWidth: activeTab.offsetWidth,
      edgeInset: CHAT_CONTENT_INSET_PX,
    });
    if (Math.abs(nav.scrollLeft - targetScrollLeft) > 0.5) {
      nav.scrollLeft = targetScrollLeft;
    }
    syncChatStrip();
  }, [activeChatId, workspaceFolder, chats.length, syncChatStrip]);

  // Roving-tabIndex keyboard navigation within THIS pane's tabs.
  const handleTabKeyDown = useCallback(
    (chatId: string, e: React.KeyboardEvent) => {
      const ids = chats.map((c) => c.id);
      const idx = ids.indexOf(chatId);
      if (idx < 0) return;
      let nextIdx: number | null = null;
      if (e.key === "ArrowLeft") nextIdx = idx === 0 ? ids.length - 1 : idx - 1;
      else if (e.key === "ArrowRight") nextIdx = (idx + 1) % ids.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = ids.length - 1;
      if (nextIdx === null) return;
      e.preventDefault();
      const nextId = ids[nextIdx];
      if (!nextId) return;
      onSelectChat(nextId);
      window.requestAnimationFrame(() => {
        tabRefs.current.get(nextId)?.focus();
      });
    },
    [chats, onSelectChat],
  );

  // Gate the "Open in" submenu the same way the top bar gates its split button:
  // hide it until the preload bridge lands, and until this pane resolves a
  // workspace folder to target.
  const nativeReady = useNativeRuntime().ready;
  const showOpenIn = nativeReady && workspaceFolder !== "";

  // ── Render ───────────────────────────────────────────

  return (
    <div className={CHAT_STRIP_SHELL_CLS}>
      {/* Fixed leading slot — outside the scrolling lane, so the mode toggle
          holds the strip's left edge no matter how far the tabs scroll. */}
      {leading ? (
        <div className={CHAT_STRIP_LEADING_CLS} data-chat-strip-leading="">
          {leading}
        </div>
      ) : null}

      <div className={TAB_VIEWPORT_CLS}>
        <div
          ref={chatNavRef}
          className={TAB_NAV_CLS}
          role="tablist"
          aria-label="Chat sessions"
          onScroll={syncChatStrip}
          onPointerEnter={handleChatPointer}
          onPointerMove={handleChatPointer}
          onPointerLeave={clearChatPointer}
          onPointerCancel={clearChatPointer}
          onWheelCapture={handleChatWheel}
        >
          <div className={TAB_ROW_CLS}>
            {showSyntheticUntitled ? (
              <UntitledTab onSelect={onSelectUntitled} />
            ) : (
              chats.map((chat) => (
                <TabRow
                  key={chat.id}
                  chat={chat}
                  paneId={paneId}
                  isActive={chat.id === activeChatId}
                  onSelect={onSelectChat}
                  onPrefetch={onPrefetchChat}
                  onClose={onCloseTab}
                  onArrowKey={handleTabKeyDown}
                  registerRef={(node) => registerChatTab(chat.id, node)}
                />
              ))
            )}
          </div>
        </div>

        {/* The active chat sits above the fades. When pinned, its edge fade
            relocates beside the tab; solid four-pixel gutters preserve spacing
            while preventing scrolled labels from leaking through. */}
        <div
          ref={outerLeftFadeRef}
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-(--pane-bg) to-transparent opacity-0"
          aria-hidden="true"
        />
        <div
          ref={outerRightFadeRef}
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-(--pane-bg) to-transparent opacity-0"
          aria-hidden="true"
        />
        <div
          ref={afterPinnedLeftFadeRef}
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-(--pane-bg) to-transparent opacity-0 will-change-transform"
          aria-hidden="true"
        />
        <div
          ref={beforePinnedRightFadeRef}
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-l from-(--pane-bg) to-transparent opacity-0 will-change-transform"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-30 w-1 bg-(--pane-bg)"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 z-30 w-1 bg-(--pane-bg)"
          aria-hidden="true"
        />
      </div>

      <div className={PLUS_CONTROL_CLS}>
        <NewChatMenu workspaceFolder={workspaceFolder} paneId={paneId} />
      </div>

      <div className="min-w-0 flex-1" aria-hidden="true" />

      {/* Closed-chat history — pinned left of the pane menu. */}
      <div className={HISTORY_CONTROL_CLS}>
        <ChatHistoryMenu chats={historyChats} onRestoreChat={onRestoreChat} />
      </div>

      {/* Pane menu — fixed at the right end of the strip. */}
      <div className={PANE_MENU_CONTROL_CLS}>
        <DropdownMenu>
          <Tooltip label="Pane options">
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={PANE_MENU_BTN_CLS}
                aria-label="Pane options"
              >
                <Ellipsis className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end" sideOffset={6} className="w-44">
            <DropdownMenuItem
              disabled={!canSplitDown}
              onSelect={() => onSplit("down")}
            >
              <Rows2 className="text-fg2" />
              <span>Split Down</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canSplitRight}
              onSelect={() => onSplit("right")}
            >
              <Columns2 className="text-fg2" />
              <span>Split Right</span>
            </DropdownMenuItem>
            {showOpenIn && (
              <>
                <DropdownMenuSeparator />
                <OpenInSubmenu path={workspaceFolder} />
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Fixed trailing slot — last, so the workbench expand control keeps the
          window's right edge it holds from Workbench's own header while that
          panel is open. */}
      {trailing ? (
        <div className={CHAT_STRIP_TRAILING_CLS} data-chat-strip-trailing="">
          {trailing}
        </div>
      ) : null}
    </div>
  );
}

// ── Untitled (synthetic) tab ─────────────────────────────

function UntitledTab({ onSelect }: { onSelect: () => void }) {
  return (
    <div
      role="tab"
      aria-selected="true"
      tabIndex={0}
      className={TAB_UNTITLED_CLS}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="min-w-0 truncate text-xs leading-none font-medium">
        Untitled
      </span>
    </div>
  );
}

// ── Tab row (with inline rename + close + drag) ──────────

interface TabRowProps {
  chat: ChatThread;
  paneId: string;
  isActive: boolean;
  onSelect: (chatId: string) => void;
  onPrefetch: (chatId: string) => void;
  onClose: (chat: ChatThread, e?: React.MouseEvent) => void;
  onArrowKey: (chatId: string, e: React.KeyboardEvent) => void;
  registerRef: (node: HTMLDivElement | null) => void;
}

function TabRow({
  chat,
  paneId,
  isActive,
  onSelect,
  onPrefetch,
  onClose,
  onArrowKey,
  registerRef,
}: TabRowProps) {
  const dispatch = useWorkspaceDispatch();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(chat.title || "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  // While the chat's agent is mid-turn, swap the static AgentIcon for the
  // ZerosSpinner so the tab head signals activity. See the original
  // single-strip notes for the terminal/awaiting variants.
  const isTerminal = chat.kind === "terminal";
  const isStreaming = useChatStreaming(chat.id);
  const awaitingKind = useChatAwaitingKind(chat.id);
  const isTerminalBusy = useTerminalBusy(chat.id, isTerminal);

  // Sync draft state when the chat title changes externally.
  useEffect(() => {
    if (!renaming) setDraft(chat.title || "");
  }, [chat.title, renaming]);

  const commitRename = useCallback(() => {
    const next = draft.trim();
    setRenaming(false);
    if (!next || next === chat.title) return;
    dispatch({ type: "UPDATE_CHAT_TITLE", id: chat.id, title: next });
  }, [chat.id, chat.title, dispatch, draft]);

  const cancelRename = useCallback(() => {
    setDraft(chat.title || "");
    setRenaming(false);
  }, [chat.title]);

  // Copy this tab's transcript. The action reads the FULL transcript from the
  // engine, so it works on a background tab whose slot was never hydrated.
  const copyTranscript = useCallback(
    (mode: TranscriptMode) =>
      copyChatTranscript(chat.id, mode, {
        title: chat.title,
        folder: chat.folder,
        exportedAt: Date.now(),
      }),
    [chat.id, chat.title, chat.folder],
  );

  // Enter inline-rename mode and focus the input (survives the context
  // menu close — see overlay-focus.ts notes in the original).
  const beginRename = useCallback(() => {
    setRenaming(true);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, []);

  // HTML5 drag — the payload rides dataTransfer; the drag-store copy
  // drives the pane drop overlays (dataTransfer data is unreadable
  // during dragover by spec). The store write is deferred one frame:
  // Chromium can abort a drag whose DOM mutates during the dragstart
  // dispatch, and setting the store synchronously mounts every pane's
  // drop overlay in that window. The token cancels the deferred write
  // when dragend (or unmount) beats the frame — otherwise an instantly
  // cancelled drag would strand a stale drag state and its overlays.
  const dragTokenRef = useRef(0);
  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.dataTransfer.setData(CHAT_TAB_DRAG_MIME, chat.id);
      e.dataTransfer.effectAllowed = "move";
      const token = ++dragTokenRef.current;
      const dragEpoch = armTabDrag();
      const drag = {
        chatId: chat.id,
        fromPaneId: paneId,
        folder: chat.folder,
      };
      window.requestAnimationFrame(() => {
        if (dragTokenRef.current !== token || !isTabDragArmCurrent(dragEpoch)) {
          return;
        }
        useTabDragStore.getState().setDrag(drag);
      });
    },
    [chat.id, chat.folder, paneId],
  );

  const handleDragEnd = useCallback(() => {
    dragTokenRef.current++;
    clearTabDrag();
  }, []);

  // If this tab unmounts MID-DRAG (archived by another surface, source
  // pane collapsed), the browser fires dragend at a detached node that
  // no listener sees — the drag store would stay set and the full-pane
  // drop overlays would keep swallowing clicks forever. Clear it here.
  useEffect(
    () => () => {
      dragTokenRef.current++;
      const store = useTabDragStore.getState();
      if (store.drag?.chatId === chat.id) clearTabDrag();
    },
    [chat.id],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={registerRef}
          role="tab"
          aria-selected={isActive}
          tabIndex={isActive ? 0 : -1}
          className={TAB_BASE_CLS}
          draggable={!renaming}
          onPointerEnter={() => onPrefetch(chat.id)}
          onFocus={() => onPrefetch(chat.id)}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onClick={() => {
            if (renaming) return;
            onSelect(chat.id);
          }}
          onKeyDown={(e) => {
            if (renaming) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(chat.id);
              return;
            }
            onArrowKey(chat.id, e);
          }}
          data-active={isActive}
          data-chat-tab="true"
        >
          {isTerminal ? (
            isTerminalBusy ? (
              <ZerosSpinner
                size={16}
                variant="agent"
                label="Agent working"
                className="shrink-0"
              />
            ) : (
              <TerminalIcon
                className={cn(
                  "size-3.5 shrink-0",
                  isActive ? "text-fg1" : "text-fg2",
                )}
                aria-hidden="true"
              />
            )
          ) : awaitingKind === "plan" ? (
            <ClipboardList
              size={14}
              className="text-fg2 shrink-0"
              aria-label="Plan ready for review"
            />
          ) : awaitingKind === "input" ? (
            <MessageCircleQuestionMark
              size={14}
              className="text-fg2 shrink-0"
              aria-label="Agent awaiting your input"
            />
          ) : isStreaming ? (
            <ZerosSpinner
              size={16}
              variant="agent"
              label="Agent working"
              className="shrink-0"
            />
          ) : (
            <AgentIcon
              agentId={chat.agentId}
              iconUrl={null}
              size={14}
              className="shrink-0"
              monochrome={!isActive}
            />
          )}
          {renaming ? (
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              className={TITLE_INPUT_CLS}
              spellCheck={false}
              aria-label="Rename chat"
            />
          ) : (
            <span className={TAB_LABEL_CLS}>
              {chat.title || "Untitled chat"}
            </span>
          )}
          {!renaming && (
            <div className={TAB_HOVER_OVERLAY_CLS} aria-hidden="false">
              <Tooltip label="Close chat">
                <button
                  type="button"
                  className={TAB_AFFORDANCE_BTN_CLS}
                  onClick={(e) => onClose(chat, e)}
                  aria-label="Close chat"
                >
                  <X className="size-3.5" />
                </button>
              </Tooltip>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={beginRename}>
          <Pencil />
          <span>Rename</span>
        </ContextMenuItem>
        {/* Terminal tabs are PTY-backed and have no agent transcript. */}
        {!isTerminal && (
          <>
            <ContextMenuSeparator className="bg-border3" />
            <ContextMenuItem onSelect={() => void copyTranscript("concise")}>
              <ClipboardList />
              <span>Copy concise transcript</span>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void copyTranscript("full")}>
              <Copy />
              <span>Copy full transcript</span>
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator className="bg-border3" />
        <ContextMenuItem onSelect={() => onClose(chat)}>
          <X />
          <span>Close Tab</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
