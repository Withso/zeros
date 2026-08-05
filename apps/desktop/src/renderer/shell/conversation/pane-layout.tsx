// ──────────────────────────────────────────────────────────
// Conversation pane — split-pane container
// ──────────────────────────────────────────────────────────
//
// Owns the pane tree for the ACTIVE workspace: each leaf pane renders
// its own chat-tab strip + body (chat view / terminal host), split
// nodes render two children around a draggable divider. The layout
// model lives in apps/desktop/src/renderer/state/chat-panes.ts; this file is only the
// view + the user gestures:
//
//   - Tab-strip "⋯" menu → Split Right / Split Down. A pane with 2+
//     tabs moves its ACTIVE tab into the new pane; a pane with 1 tab
//     spawns a fresh chat there instead (you can't empty the source).
//   - Dragging a tab over a pane shows directional drop zones:
//     right band → split right, bottom band → split down, everywhere
//     else → move the tab into this pane.
//   - Splitters resize 50/50 defaults freely (pixel-clamped); a
//     double-click resets to 50/50.
//   - Focus follows pointer-down: interacting with a pane makes its
//     displayed chat the global active chat (composer hotkeys, workbench
//     scope, and the topbar all follow, exactly like a tab click).
//
// This component also inherits two responsibilities that used to live
// in ChatTabs (which is now a per-pane dumb strip): resolving
// the active workspace, and the selection-keeper invariant (a
// workspace in view ALWAYS has an active chat).
// ──────────────────────────────────────────────────────────

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "../../shared/ui/cn";
import { useResizeHint } from "../use-resize-hint";
import {
  selectActiveFolder,
  selectChatToRestoreForFolder,
  useActiveChatId,
  useActivePage,
  useChats,
  useNewAgentFolder,
  useWorkspaceDispatch,
  useWorkspaceStore,
  type ChatThread,
} from "../../state/store";
import {
  spawnDefaultChatForWorkspace,
  spawnNewChatTab,
} from "../../state/spawn-default-chat";
import { type Project } from "../../state/projects-store";
import {
  useProjectForFolder,
  useWorkspacesFor,
} from "../../state/use-projects";
import { buildLocalMainWorkspace } from "../../state/local-main-workspace";
import {
  findWorkspaceForFolder,
  resolveWorkspacePresentationFolder,
} from "../../state/workspace-resolution";
import type { Workspace } from "../../platform/git";
import { ptyKill } from "../../platform/pty";
import { useAgentSessions } from "../../features/agent/sessions-hooks";
import { useSessionsStore } from "../../features/agent/sessions-store";
import { getLiveChatDraft } from "../../features/agent/composer-live-drafts";
import {
  MAX_PANES,
  type PaneLayout,
  type PaneNode,
  type SplitDirection,
  firstLeafId,
  leafIds,
  paneForChat,
  resolvePaneActiveChatId,
  topRightLeafId,
} from "../../state/chat-panes";
import { WorkbenchToggleButton } from "../workbench/toggle-button";
import {
  useChatPanesStore,
  usePaneLayout,
} from "../../state/chat-panes-store";
import { ChatTabs } from "./chat-tabs";
import {
  isChatDiscardableOnClose,
  messageCountForChatClose,
} from "./chat-close";
import {
  captureScrollWithin,
  preserveScrollGeometryWithin,
  restoreScrollWithin,
} from "../scroll-memory";
import { prepareChatView } from "./chat-intent";
import { useInstantViewSwitch } from "../../shared/ui/use-instant-view-switch";
import { useWorkspaceProvisioning } from "../../state/pending-workspaces";
import { beginContinuousLayoutResize } from "../terminal/continuous-layout-resize";
import {
  CHAT_TAB_DRAG_MIME,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  PANE_TERMINAL_HOST_CLS,
  clearTabDrag,
  usePanePortalsStore,
  useTabDragStore,
} from "./pane-portal-store";

// ── Layout constants ─────────────────────────────────────

/** No-workspace placeholder band — matches the per-pane tab strip height
 *  (STRIP_SHELL_CLS in conversation/chat-tabs.tsx) so the top chrome doesn't jump
 *  when a workspace loads. */
const STRIP_SHELL_CLS = "flex h-11 shrink-0 items-center overflow-hidden";

// ── Workspace resolution (moved from conversation/chat-tabs) ──

/** Resolve the workspace that owns the given folder path, including chats
 * rooted in a subdirectory. Confirmed managed worktrees win over the broader
 * main-checkout prefix (a linked worktree may itself live below repoRoot). */
function resolveWorkspaceForFolder(
  folder: string | null,
  project: Project | null,
  workspaces: Workspace[],
): Workspace | null {
  if (!folder || !project) return null;
  const managed = findWorkspaceForFolder(folder, workspaces);
  if (managed) return managed;
  const main = buildLocalMainWorkspace(project);
  return findWorkspaceForFolder(folder, [main]) ? main : null;
}

// ── Shared pane context ──────────────────────────────────

type DropZone = "center" | "right" | "down";

interface PaneCtx {
  folder: string;
  layout: PaneLayout;
  chatsByPane: Map<string, ChatThread[]>;
  focusedPaneId: string;
  /** Pane hosting workspace-level top-right chrome (workbench expand). */
  topRightPaneId: string;
  globalActiveChatId: string | null;
  historyChats: ChatThread[];
  workspaceHasChats: boolean;
  paneCount: number;
  workbenchCollapsed: boolean;
  onToggleWorkbench?: () => void;
  onSelectChat: (chatId: string) => void;
  onPrefetchChat: (chatId: string) => void;
  onSelectUntitled: () => void;
  onCloseTab: (paneId: string, chat: ChatThread, e?: React.MouseEvent) => void;
  onRestoreChat: (paneId: string, chat: ChatThread) => void;
  onSplit: (paneId: string, dir: "right" | "down") => void;
  onDropOnPane: (paneId: string, zone: DropZone, chatId: string) => void;
}

const EMPTY_CHATS: ChatThread[] = [];

// ── Container ────────────────────────────────────────────

export function ConversationPaneLayout({
  workbenchCollapsed = false,
  onToggleWorkbench,
}: {
  workbenchCollapsed?: boolean;
  onToggleWorkbench?: () => void;
} = {}) {
  const paneSurfaceRef = useRef<HTMLDivElement | null>(null);
  const activeChatId = useActiveChatId();
  const activePage = useActivePage();
  const chats = useChats();
  const newAgentFolder = useNewAgentFolder();
  const dispatch = useWorkspaceDispatch();
  const sessions = useAgentSessions();
  const { closeSession } = sessions;

  const activeFolder = useWorkspaceStore(selectActiveFolder);
  const pendingWorkspaceValidationFolder = useWorkspaceStore(
    (state) => state.pendingWorkspaceValidationFolder,
  );
  const project = useProjectForFolder(activeFolder);
  const { workspaces } = useWorkspacesFor(project?.repoSlug ?? null);
  const activeWorkspace = useMemo(
    () => resolveWorkspaceForFolder(activeFolder, project, workspaces),
    [activeFolder, project, workspaces],
  );
  const activeWorkspaceProvisioning = useWorkspaceProvisioning(activeFolder);
  // ADD_CHAT publishes this exact prepared destination and its first Untitled
  // chat atomically in the workspace store. Use that same snapshot as the
  // first-paint presentation owner instead of depending solely on the separate
  // pending-create store (two external-store updates may commit in either
  // render). The exact path is still gated from agent spawning until create
  // confirms; this only makes the already-created chat UI visible.
  // The selected folder may intentionally be a subdirectory of its workspace.
  // Validate it through the owning Workspace row, but keep the exact chat cwd
  // as the state/pane/terminal identity instead of collapsing it to the root.
  // A locally prepared exact path is also a valid PRESENTATION owner before its
  // authoritative row lands, which lets its optimistic Untitled chat render
  // immediately without making the path usable for agent/session spawning.
  const activeWorkspacePath = resolveWorkspacePresentationFolder({
    activeFolder,
    hasResolvedWorkspace: activeWorkspace !== null,
    isProvisioning: activeWorkspaceProvisioning,
    pendingValidationFolder: pendingWorkspaceValidationFolder,
    hasLiveChatAtActiveFolder:
      !!activeFolder &&
      chats.some((chat) => !chat.archived && chat.folder === activeFolder),
  });
  useInstantViewSwitch(
    `panes:${activeWorkspacePath ?? activeFolder ?? "none"}:${activeChatId ?? "none"}`,
    paneSurfaceRef,
  );

  // All chats owned by this workspace, sorted createdAt ASC (strip
  // order). Visible = live tabs, history = archived (newest first).
  const allChats = useMemo(() => {
    if (!activeWorkspacePath) return EMPTY_CHATS;
    return chats
      .filter((c) => c.folder === activeWorkspacePath)
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [activeWorkspacePath, chats]);

  const visibleChats = useMemo(
    () => allChats.filter((c) => !c.archived),
    [allChats],
  );

  const historyChats = useMemo(() => {
    const visibleIds = new Set(visibleChats.map((c) => c.id));
    return allChats
      .filter((c) => !visibleIds.has(c.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [allChats, visibleChats]);

  // ── Selection keeper ────────────────────────────────────
  // A workspace in view must ALWAYS have an active chat — Conversation pane
  // renders a dead pane for a null selection. See the original comment
  // block in conversation/chat-tabs (pre-panes) for the full history.
  useEffect(() => {
    if (
      activePage !== "workspace" ||
      !activeWorkspacePath ||
      pendingWorkspaceValidationFolder === activeWorkspacePath
    ) {
      return;
    }
    if (visibleChats.length === 0) {
      if (newAgentFolder !== activeWorkspacePath) {
        dispatch({
          type: "SET_NEW_AGENT_FOLDER",
          folder: activeWorkspacePath,
        });
      }
      void spawnDefaultChatForWorkspace({
        folder: activeWorkspacePath,
        sessions,
        dispatch,
      });
      return;
    }
    const selectionValid =
      activeChatId !== null && visibleChats.some((c) => c.id === activeChatId);
    if (!selectionValid) {
      const restoreId =
        selectChatToRestoreForFolder(
          useWorkspaceStore.getState(),
          activeWorkspacePath,
        ) ?? visibleChats[visibleChats.length - 1]!.id;
      dispatch({ type: "SET_ACTIVE_CHAT", id: restoreId });
    }
  }, [
    activeChatId,
    activePage,
    visibleChats,
    newAgentFolder,
    activeWorkspacePath,
    pendingWorkspaceValidationFolder,
    sessions,
    dispatch,
  ]);

  // ── Pane layout + membership ─────────────────────────
  const layout = usePaneLayout(activeWorkspacePath);
  const splitPane = useChatPanesStore((s) => s.splitPane);
  const moveChatToPane = useChatPanesStore((s) => s.moveChatToPane);
  const setPaneActiveChat = useChatPanesStore((s) => s.setPaneActiveChat);
  const beginAssignNextChat = useChatPanesStore((s) => s.beginAssignNextChat);

  const chatsByPane = useMemo(() => {
    const map = new Map<string, ChatThread[]>();
    for (const paneId of leafIds(layout.root)) map.set(paneId, []);
    for (const chat of visibleChats) {
      const paneId = paneForChat(layout, chat.id);
      const list = map.get(paneId);
      if (list) list.push(chat);
      else map.set(paneId, [chat]);
    }
    return map;
  }, [layout, visibleChats]);

  const focusedPaneId = useMemo(() => {
    if (activeChatId && visibleChats.some((c) => c.id === activeChatId)) {
      return paneForChat(layout, activeChatId);
    }
    return firstLeafId(layout.root);
  }, [activeChatId, visibleChats, layout]);

  // ── Handlers ─────────────────────────────────────────

  const handleSelectChat = useCallback(
    (chatId: string) => {
      dispatch({ type: "SET_ACTIVE_CHAT", id: chatId });
    },
    [dispatch],
  );

  const handleSelectUntitled = useCallback(() => {
    if (!activeWorkspacePath) return;
    dispatch({ type: "SET_NEW_AGENT_FOLDER", folder: activeWorkspacePath });
  }, [activeWorkspacePath, dispatch]);

  const handlePrefetchChat = useCallback(
    (chatId: string) => {
      void sessions.hydrateChat(chatId);
      prepareChatView(chatId);
    },
    [sessions],
  );

  const handleCloseTab = useCallback(
    (paneId: string, chat: ChatThread, e?: React.MouseEvent) => {
      e?.stopPropagation();
      const closedFolder = chat.folder;
      // Fresh read — the pane-focus pointerdown that preceded this click
      // may have re-pointed the global selection this same tick.
      const globalActive = useWorkspaceStore.getState().activeChatId;
      const wasActive = globalActive === chat.id;

      // Prefer the pane-local neighbor (tab to the right, else left) so
      // closing keeps the user inside the SAME pane.
      const paneChats = chatsByPane.get(paneId) ?? EMPTY_CHATS;
      let replacement: ChatThread | null = null;
      const idx = paneChats.findIndex((c) => c.id === chat.id);
      if (idx >= 0) {
        replacement = paneChats[idx + 1] ?? paneChats[idx - 1] ?? null;
      }

      // Snapshot transcript use BEFORE reaping. Older chats may have released
      // their message objects after leaving the bounded 12-view deck, so the
      // retained `hasTranscript` hint is just as authoritative as a non-empty
      // resident array. Missing it would DELETE a used-but-still-Untitled chat
      // instead of archiving it.
      const sessionSlot = useSessionsStore.getState().sessions[chat.id];
      const messageCount = messageCountForChatClose(sessionSlot);

      // Reap the backing resource (see conversation/chat-tabs history: a
      // terminal tab's PTY must be EXPLICITLY killed; a chat tab reaps
      // its engine session, transcript kept on disk).
      if (chat.kind === "terminal") {
        void ptyKill({ sessionId: chat.id });
      } else {
        closeSession(chat.id);
      }

      // A never-used "Untitled" tab (no message, no rename/title, no typed
      // draft) is DISCARDED so it never clutters the History menu; every
      // other close ARCHIVES (soft-delete, restorable from History). See
      // conversation/chat-close for the exact "never used" contract. Draft inputs:
      // the keystroke-fresh live mirror (this active tab) plus the
      // unmount-flushed store copy (a background tab closed via its ×).
      const discard = isChatDiscardableOnClose({
        kind: chat.kind,
        title: chat.title,
        messageCount,
        liveDraft: getLiveChatDraft(chat.id),
        storedDraft: useWorkspaceStore.getState().chatComposerDrafts[chat.id],
      });
      dispatch({ type: discard ? "DELETE_CHAT" : "ARCHIVE_CHAT", id: chat.id });

      if (wasActive) {
        if (replacement) {
          dispatch({ type: "SET_ACTIVE_CHAT", id: replacement.id });
        } else if (visibleChats.length > 1) {
          // Pane emptied but other panes still have chats — the
          // ARCHIVE_CHAT / DELETE_CHAT reducer already re-pointed the
          // selection to the most-recent live sibling; reconcile collapses
          // this pane.
        } else {
          // Last chat in the workspace: spawn a fresh default chat so
          // the user is never parked on a no-chat pane.
          dispatch({ type: "SET_NEW_AGENT_FOLDER", folder: closedFolder });
          void spawnDefaultChatForWorkspace({
            folder: closedFolder,
            sessions,
            dispatch,
          });
        }
      } else if (replacement && activeWorkspacePath) {
        // The closed chat wasn't the global selection, but if it WAS
        // this pane's displayed chat, keep the pane on its neighbor.
        // Gated on the displayed chat — closing a background tab must
        // not clobber the pane's memory (the displayed chat stays).
        const displayed = resolvePaneActiveChatId(
          layout,
          paneId,
          globalActive,
          paneChats,
        );
        if (displayed === chat.id) {
          setPaneActiveChat(activeWorkspacePath, paneId, replacement.id);
        }
      }
    },
    [
      chatsByPane,
      visibleChats,
      closeSession,
      dispatch,
      sessions,
      activeWorkspacePath,
      setPaneActiveChat,
      layout,
    ],
  );

  /** Restore a chat from History into the pane whose menu was used. */
  const handleRestoreChat = useCallback(
    (paneId: string, chat: ChatThread) => {
      if (chat.archived) {
        dispatch({ type: "UNARCHIVE_CHAT", id: chat.id });
      }
      if (activeWorkspacePath) {
        moveChatToPane(activeWorkspacePath, chat.id, paneId);
      }
      dispatch({ type: "SET_ACTIVE_CHAT", id: chat.id });
    },
    [dispatch, activeWorkspacePath, moveChatToPane],
  );

  const handleSplit = useCallback(
    (paneId: string, dir: "right" | "down") => {
      if (!activeWorkspacePath) return;
      const direction: SplitDirection = dir === "right" ? "row" : "column";
      const paneChats = chatsByPane.get(paneId) ?? EMPTY_CHATS;
      if (paneChats.length >= 2) {
        // Move this pane's active tab into the new pane.
        const globalActive = useWorkspaceStore.getState().activeChatId;
        const moved =
          resolvePaneActiveChatId(layout, paneId, globalActive, paneChats) ??
          paneChats[paneChats.length - 1]!.id;
        const newPane = splitPane(
          activeWorkspacePath,
          paneId,
          direction,
          moved,
        );
        if (newPane) dispatch({ type: "SET_ACTIVE_CHAT", id: moved });
      } else {
        // Single tab — keep it in place and open a fresh chat in the
        // new pane (the reservation also shields the empty pane from
        // reconcile-collapse until the spawn lands).
        const newPane = splitPane(activeWorkspacePath, paneId, direction, null);
        if (!newPane) return;
        beginAssignNextChat(activeWorkspacePath, newPane);
        spawnNewChatTab({
          folder: activeWorkspacePath,
          sessions,
          dispatch,
        })
          .then((chat) => {
            // Belt-and-suspenders: the reconcile subscription normally
            // routes the new chat via the reservation; this covers a
            // reservation that expired during a slow registry probe.
            moveChatToPane(activeWorkspacePath, chat.id, newPane);
          })
          .catch(() => {
            // Spawn failed — the empty pane stays until its reservation
            // expires, then reconcile collapses it. Nothing to surface.
          });
      }
    },
    [
      activeWorkspacePath,
      chatsByPane,
      layout,
      splitPane,
      beginAssignNextChat,
      moveChatToPane,
      sessions,
      dispatch,
    ],
  );

  const handleDropOnPane = useCallback(
    (paneId: string, zone: DropZone, chatId: string) => {
      if (!activeWorkspacePath) return;
      const fromPane = paneForChat(layout, chatId);
      if (zone === "center") {
        if (fromPane !== paneId) {
          moveChatToPane(activeWorkspacePath, chatId, paneId);
        }
        dispatch({ type: "SET_ACTIVE_CHAT", id: chatId });
        return;
      }
      // Splitting with the pane's only tab onto itself is a no-op (the
      // source pane would collapse right back).
      const fromChats = chatsByPane.get(fromPane) ?? EMPTY_CHATS;
      if (fromPane === paneId && fromChats.length <= 1) return;
      const direction: SplitDirection = zone === "right" ? "row" : "column";
      const newPane = splitPane(activeWorkspacePath, paneId, direction, chatId);
      if (newPane) {
        dispatch({ type: "SET_ACTIVE_CHAT", id: chatId });
      } else if (fromPane !== paneId) {
        // Split refused (pane cap raced the gesture) — degrade to a
        // plain move so the drop still lands somewhere sensible.
        moveChatToPane(activeWorkspacePath, chatId, paneId);
        dispatch({ type: "SET_ACTIVE_CHAT", id: chatId });
      }
    },
    [
      activeWorkspacePath,
      layout,
      chatsByPane,
      moveChatToPane,
      splitPane,
      dispatch,
    ],
  );

  const paneCountValue = leafIds(layout.root).length;

  const ctx = useMemo<PaneCtx>(
    () => ({
      folder: activeWorkspacePath ?? "",
      layout,
      chatsByPane,
      focusedPaneId,
      topRightPaneId: topRightLeafId(layout.root),
      globalActiveChatId: activeChatId,
      historyChats,
      workspaceHasChats: visibleChats.length > 0,
      paneCount: paneCountValue,
      workbenchCollapsed,
      onToggleWorkbench,
      onSelectChat: handleSelectChat,
      onPrefetchChat: handlePrefetchChat,
      onSelectUntitled: handleSelectUntitled,
      onCloseTab: handleCloseTab,
      onRestoreChat: handleRestoreChat,
      onSplit: handleSplit,
      onDropOnPane: handleDropOnPane,
    }),
    [
      activeWorkspacePath,
      layout,
      chatsByPane,
      focusedPaneId,
      activeChatId,
      historyChats,
      visibleChats.length,
      paneCountValue,
      workbenchCollapsed,
      onToggleWorkbench,
      handleSelectChat,
      handlePrefetchChat,
      handleSelectUntitled,
      handleCloseTab,
      handleRestoreChat,
      handleSplit,
      handleDropOnPane,
    ],
  );

  // No active destination → keep the chrome band so heights don't jump. There
  // is intentionally no "No workspace selected" copy: every valid workspace
  // destination owns an Untitled chat, including a prepared create's first
  // paint, and an actually empty destination needs no misleading error state.
  if (!activeWorkspacePath) {
    return (
      <div ref={paneSurfaceRef} className="flex min-h-0 flex-1 flex-col">
        <div className={STRIP_SHELL_CLS} data-tauri-drag-region />
        <div className="min-h-0 flex-1" />
      </div>
    );
  }

  return (
    <div ref={paneSurfaceRef} className="flex min-h-0 min-w-0 flex-1">
      <PaneNodeView node={layout.root} ctx={ctx} />
    </div>
  );
}

// ── Recursive tree view ──────────────────────────────────

function PaneNodeView({ node, ctx }: { node: PaneNode; ctx: PaneCtx }) {
  if (node.type === "leaf") {
    return <ChatPane paneId={node.id} ctx={ctx} />;
  }
  return <SplitView node={node} ctx={ctx} />;
}

function SplitView({
  node,
  ctx,
}: {
  node: Extract<PaneNode, { type: "split" }>;
  ctx: PaneCtx;
}) {
  const isRow = node.direction === "row";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef<HTMLDivElement | null>(null);
  const secondRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0 min-w-0 flex-1",
        isRow ? "flex-row" : "flex-col",
      )}
    >
      <div
        ref={firstRef}
        style={{ flexGrow: node.ratio, flexShrink: 1, flexBasis: 0 }}
        className="flex min-h-0 min-w-0 overflow-hidden"
      >
        <PaneNodeView node={node.first} ctx={ctx} />
      </div>
      <PaneSplitter
        direction={node.direction}
        splitId={node.id}
        folder={ctx.folder}
        containerRef={containerRef}
        firstRef={firstRef}
        secondRef={secondRef}
      />
      <div
        ref={secondRef}
        style={{ flexGrow: 1 - node.ratio, flexShrink: 1, flexBasis: 0 }}
        className="flex min-h-0 min-w-0 overflow-hidden"
      >
        <PaneNodeView node={node.second} ctx={ctx} />
      </div>
    </div>
  );
}

// ── Splitter ─────────────────────────────────────────────

function PaneSplitter({
  direction,
  splitId,
  folder,
  containerRef,
  firstRef,
  secondRef,
}: {
  direction: SplitDirection;
  splitId: string;
  folder: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  firstRef: React.RefObject<HTMLDivElement | null>;
  secondRef: React.RefObject<HTMLDivElement | null>;
}) {
  const isRow = direction === "row";
  const setSplitRatio = useChatPanesStore((s) => s.setSplitRatio);
  const { hintHandlers, hint } = useResizeHint(
    "Drag to resize · Double-click to reset",
  );

  const clampToContainer = useCallback(
    (clientX: number, clientY: number): number | null => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const size = isRow ? rect.width : rect.height;
      if (size <= 0) return null;
      const raw = isRow
        ? (clientX - rect.left) / size
        : (clientY - rect.top) / size;
      const minPx = isRow ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT;
      // When the container can't honor both pixel minimums, pin 50/50.
      if (size < minPx * 2) return 0.5;
      const minRatio = Math.max(0.1, minPx / size);
      return Math.min(1 - minRatio, Math.max(minRatio, raw));
    },
    [containerRef, isRow],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Primary button only, like every other seam in the app. A right- or
      // middle-click otherwise opened a capture-backed drag that kept running
      // under the context menu.
      if (!e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const pointerId = e.pointerId;
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        /* proceed uncaptured */
      }
      let lastRatio: number | null = null;
      let rafId: number | null = null;
      let finished = false;
      const finishContinuousResize = beginContinuousLayoutResize();

      const apply = (ratio: number) => {
        // Imperative during the drag — a store write per frame would
        // re-render both pane subtrees (chat transcripts) continuously.
        if (firstRef.current) firstRef.current.style.flexGrow = String(ratio);
        if (secondRef.current) {
          secondRef.current.style.flexGrow = String(1 - ratio);
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (finished) return;
        const ratio = clampToContainer(ev.clientX, ev.clientY);
        if (ratio === null) return;
        lastRatio = ratio;
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (lastRatio !== null) apply(lastRatio);
        });
      };

      const finish = () => {
        if (finished) return;
        finished = true;
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        handle.removeEventListener("lostpointercapture", finish);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        try {
          if (handle.hasPointerCapture(pointerId)) {
            handle.releasePointerCapture(pointerId);
          }
        } catch {
          /* already released */
        }
        // Land the DOM exactly on the final ratio first — a pending rAF
        // may have been cancelled above, and when the commit below
        // no-ops (ratio unchanged in the store) there's no re-render to
        // repaint, so the DOM must already be right.
        if (lastRatio !== null) apply(lastRatio);
        // Single store commit. Don't clear the imperative styles — the
        // re-render writes the SAME flexGrow values over them (React
        // diffs against its previous style prop, not the DOM), so the
        // handoff is seamless; clearing first would flash a 50/50 frame.
        if (lastRatio !== null) setSplitRatio(folder, splitId, lastRatio);
        finishContinuousResize();
      };

      // Lock the cursor + suppress text selection for the gesture, like the
      // other seams. Without it a fast drag that outruns the 6px strip put an
      // I-beam over the transcript and started selecting message text.
      document.body.style.cursor = isRow ? "ew-resize" : "ns-resize";
      document.body.style.userSelect = "none";
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
      handle.addEventListener("lostpointercapture", finish);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
    },
    [
      clampToContainer,
      firstRef,
      isRow,
      secondRef,
      setSplitRatio,
      folder,
      splitId,
    ],
  );

  return (
    <div
      role="separator"
      aria-orientation={isRow ? "vertical" : "horizontal"}
      aria-label="Resize panes"
      className={cn(
        "relative z-10 flex shrink-0",
        isRow ? "w-1.5 cursor-ew-resize" : "h-1.5 cursor-ns-resize",
      )}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setSplitRatio(folder, splitId, 0.5)}
      {...hintHandlers}
    >
      {/* Resting 1px seam so the two panes read as separate surfaces. The
          resize cursor + the idle "Drag to resize" hint above the pointer
          are the only other affordances. */}
      <div
        className={cn(
          "bg-border1 pointer-events-none absolute",
          isRow
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2",
        )}
        aria-hidden="true"
      />
      {hint}
    </div>
  );
}

// ── Leaf pane ────────────────────────────────────────────

function ChatPane({ paneId, ctx }: { paneId: string; ctx: PaneCtx }) {
  const dispatch = useWorkspaceDispatch();
  const setSlot = usePanePortalsStore((s) => s.setSlot);
  const getOrCreateHost = usePanePortalsStore((s) => s.getOrCreateHost);
  const paneChats = ctx.chatsByPane.get(paneId) ?? EMPTY_CHATS;
  const paneActiveChatId = resolvePaneActiveChatId(
    ctx.layout,
    paneId,
    ctx.globalActiveChatId,
    paneChats,
  );
  const isFocused = ctx.focusedPaneId === paneId;

  // Publish this pane's displayed chat for the terminal deck.
  // useLayoutEffect so a terminal that just became this pane's chat is
  // visible on the same frame the pane body commits (no blank flash).
  useLayoutEffect(() => {
    setSlot(paneId, { activeChatId: paneActiveChatId });
  }, [paneId, paneActiveChatId, setSlot]);
  useEffect(
    () => () => {
      // Tree-shape changes REMOUNT a pane at a new position, and this passive
      // cleanup runs after the replacement instance has reparented the stable
      // host. Clear only when that host is still disconnected, which means no
      // live replacement owns the pane id.
      const slot = usePanePortalsStore.getState().panes[paneId];
      if (!slot?.host?.isConnected) {
        usePanePortalsStore.getState().clearSlot(paneId);
      }
    },
    [paneId],
  );

  /** The store-owned host currently attached to this pane fiber. Callback-ref
   * cleanup runs while the old mount is still connected, which is our last
   * safe point to freeze compositor scroll + content-visibility geometry. */
  const mountedHostRef = useRef<HTMLElement | null>(null);

  const preserveHostBeforeMove = useCallback((host: HTMLElement | null) => {
    if (!host?.isConnected) return;
    captureScrollWithin(host);
    preserveScrollGeometryWithin(host);
  }, []);

  const hostMountRefCallback = useCallback(
    (mount: HTMLDivElement | null) => {
      if (!mount) {
        preserveHostBeforeMove(mountedHostRef.current);
        mountedHostRef.current = null;
        return;
      }
      const host = getOrCreateHost(paneId);
      if (
        host &&
        (host.parentElement !== mount || mount.childNodes.length !== 1)
      ) {
        // Read the outgoing host BEFORE replaceChildren detaches it. Chromium
        // drops both scrollTop and content-visibility's remembered `auto`
        // sizes on removal; preserving both makes the destination restorable
        // in this commit instead of two correction frames later.
        preserveHostBeforeMove(mount.firstElementChild as HTMLElement | null);
        // A ChatPane fiber can be reused with a different paneId when the
        // active workspace changes to a same-shaped tree. Detach that prior
        // pane's stable host instead of accumulating two containers here.
        mount.replaceChildren(host);
        // Reattaching a preserved subtree resets every scroller inside it to
        // 0 (Chromium discards scroll state on remove+insert — the loss
        // moveBefore() was designed to prevent). Hand registered scrollers
        // (chat transcripts) their offsets back before this commit paints.
        restoreScrollWithin(host);
      }
      mountedHostRef.current = host;
    },
    [paneId, getOrCreateHost, preserveHostBeforeMove],
  );

  // Split availability — a pane must fit two pixel-minimum halves.
  const rootRef = useRef<HTMLElement | null>(null);
  const [canSplit, setCanSplit] = useState({ right: true, down: true });
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const next = {
        right: rect.width >= MIN_PANE_WIDTH * 2 + 6,
        down: rect.height >= MIN_PANE_HEIGHT * 2 + 6,
      };
      setCanSplit((prev) =>
        prev.right === next.right && prev.down === next.down ? prev : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const atPaneCap = ctx.paneCount >= MAX_PANES;

  // Focus follows both pointer and keyboard/programmatic entry: interacting
  // with an unfocused pane promotes its displayed chat to the global
  // selection (composer hotkeys, workbench scope and the breadcrumb all follow).
  // Pointer covers clicks before their target handler runs; focusin covers
  // tabbing into the strip/composer (and xterm's hidden textarea) without a
  // pointer event.
  const handlePaneActivation = useCallback(() => {
    if (
      !paneActiveChatId ||
      useWorkspaceStore.getState().activeChatId === paneActiveChatId
    ) {
      return;
    }
    dispatch({ type: "SET_ACTIVE_CHAT", id: paneActiveChatId });
  }, [paneActiveChatId, dispatch]);

  // NATIVE capture listeners — NOT React onPointerDownCapture/onFocusCapture
  // props on the section. The chat/terminal body is portaled into this pane's
  // host node: it's inside the section in the real DOM, but its REACT parent
  // is the deck component, and React synthetic events propagate through the
  // React tree — so React handlers here only ever saw the tab strip (a direct
  // child), and clicking the transcript/composer of an inactive window did
  // NOT activate it. Native listeners walk the actual DOM, so a pointerdown
  // (or focus landing) ANYWHERE in the window — strip, transcript, composer,
  // terminal — activates the pane.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    el.addEventListener("pointerdown", handlePaneActivation, true);
    el.addEventListener("focusin", handlePaneActivation, true);
    return () => {
      el.removeEventListener("pointerdown", handlePaneActivation, true);
      el.removeEventListener("focusin", handlePaneActivation, true);
    };
  }, [handlePaneActivation]);

  // Show the synthetic Untitled tab only while the whole WORKSPACE has
  // no chats (the keeper is mid-spawn) — and only in the FIRST pane,
  // where the keeper's spawn will land; a persisted split revisited
  // with all chats archived would otherwise show one pill per pane.
  const showSyntheticUntitled =
    paneChats.length === 0 &&
    !ctx.workspaceHasChats &&
    paneId === firstLeafId(ctx.layout.root);

  const splitRightAllowed = canSplit.right && !atPaneCap;
  const splitDownAllowed = canSplit.down && !atPaneCap;

  return (
    <section
      ref={rootRef}
      data-pane-root=""
      data-pane-focused={isFocused ? "true" : "false"}
      // --pane-bg is the window's surface color: bg1 (the :root default — the
      // ACTIVE window is indistinguishable from the pre-split app) on the
      // focused pane, bg0 on every other pane so inactive windows read as
      // recessed/dull. The override is set HERE and inherited by everything
      // inside the window (tab strip fades, the portaled chat deck fill, the
      // transcript scroll mask), so the whole window re-tints as one when
      // focus moves. Inactive panes additionally get the bg0/30 veil below.
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col bg-(--pane-bg)",
        !isFocused && "[--pane-bg:var(--bg0)]",
      )}
    >
      <ChatTabs
        workspaceFolder={ctx.folder}
        paneId={paneId}
        chats={paneChats}
        activeChatId={paneActiveChatId}
        historyChats={ctx.historyChats}
        showSyntheticUntitled={showSyntheticUntitled}
        onSelectUntitled={ctx.onSelectUntitled}
        onSelectChat={ctx.onSelectChat}
        onPrefetchChat={ctx.onPrefetchChat}
        onCloseTab={(chat, e) => ctx.onCloseTab(paneId, chat, e)}
        onRestoreChat={(chat) => ctx.onRestoreChat(paneId, chat)}
        onSplit={(dir) => ctx.onSplit(paneId, dir)}
        canSplitRight={splitRightAllowed}
        canSplitDown={splitDownAllowed}
        extraTrailing={
          // With the conversation pane topbar hidden, this strip's right end is the
          // only remaining on-screen home for the workbench expand button —
          // hosted by the TOP-RIGHT pane so it hugs the panel it opens.
          ctx.workbenchCollapsed &&
          ctx.onToggleWorkbench &&
          paneId === ctx.topRightPaneId ? (
            <WorkbenchToggleButton workbenchCollapsed onToggle={ctx.onToggleWorkbench} />
          ) : undefined
        }
      />
      <div className="relative min-h-0 min-w-0 flex-1">
        {/* Mount point for the store-owned content host. Persistent chat and
            terminal decks portal into this stable node; a replacement pane
            only reparents it, preserving the completed DOM. */}
        <div
          ref={hostMountRefCallback}
          className={PANE_TERMINAL_HOST_CLS}
          data-pane-terminal-host-mount=""
        />
      </div>
      {/* Inactive-window veil: every pane EXCEPT the one holding the global
          active chat gets a bg0/30 wash over its whole surface (strip + body)
          — on top of its bg0 window fill — so exactly one "active chat
          window" reads at full brightness. It sits above the portaled
          chat/terminal layer (z-auto) but below the drag drop overlay (z-40).
          Pointer-transparent, so clicking a dimmed pane still activates it
          via the section's native capture listeners — the wash then lifts on
          the next render as this pane becomes focused. */}
      {!isFocused && (
        <div
          className="bg-bg0/30 pointer-events-none absolute inset-0 z-30"
          aria-hidden="true"
        />
      )}
      {/* Drop overlay covers the WHOLE pane (strip + body) so dropping
          a dragged tab onto another pane's strip moves it there too. */}
      <PaneDropOverlay
        paneId={paneId}
        ctx={ctx}
        canSplitRight={splitRightAllowed}
        canSplitDown={splitDownAllowed}
      />
    </section>
  );
}

// ── Drop overlay (tab drag targets) ──────────────────────

/** True when a drag carries one of our chat tabs (dataTransfer types
 *  are readable during dragover even though the payload isn't). */
function isTabDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(CHAT_TAB_DRAG_MIME);
}

/** Zone for a drag position. Split bands demote to "center" when the
 *  pane can't actually split that way (too small / at the pane cap) —
 *  the drop then MOVES the tab instead of silently doing nothing, and
 *  the highlight never promises a split that won't happen. */
function zoneForEvent(
  e: React.DragEvent<HTMLDivElement>,
  canSplitRight: boolean,
  canSplitDown: boolean,
): DropZone {
  const rect = e.currentTarget.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return "center";
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  const rightDepth = canSplitRight ? x - 0.75 : -1;
  const downDepth = canSplitDown ? y - 0.75 : -1;
  if (rightDepth > 0 || downDepth > 0) {
    return rightDepth >= downDepth ? "right" : "down";
  }
  return "center";
}

function PaneDropOverlay({
  paneId,
  ctx,
  canSplitRight,
  canSplitDown,
}: {
  paneId: string;
  ctx: PaneCtx;
  canSplitRight: boolean;
  canSplitDown: boolean;
}) {
  const drag = useTabDragStore((s) => s.drag);
  const [zone, setZone] = useState<DropZone | null>(null);

  const active = drag !== null && drag.folder === ctx.folder;
  useEffect(() => {
    if (!active) setZone(null);
  }, [active]);

  if (!active) return null;

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isTabDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const next = zoneForEvent(e, canSplitRight, canSplitDown);
    setZone((prev) => (prev === next ? prev : next));
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isTabDrag(e)) return;
    e.preventDefault();
    // Recompute from the event — the state value can lag a frame.
    const dropZone = zoneForEvent(e, canSplitRight, canSplitDown);
    setZone(null);
    const chatId =
      e.dataTransfer.getData(CHAT_TAB_DRAG_MIME) ||
      useTabDragStore.getState().drag?.chatId;
    clearTabDrag();
    if (chatId) ctx.onDropOnPane(paneId, dropZone, chatId);
  };

  return (
    <div
      className="absolute inset-0 z-40"
      onDragOver={handleDragOver}
      onDragLeave={() => setZone(null)}
      onDrop={handleDrop}
    >
      {zone && (
        <div
          className={cn(
            "border-highlighted-bright/50 bg-highlighted-bg/40 pointer-events-none absolute rounded-sm border",
            zone === "center" && "inset-1",
            zone === "right" && "inset-y-1 right-1 left-1/2",
            zone === "down" && "inset-x-1 top-1/2 bottom-1",
          )}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
