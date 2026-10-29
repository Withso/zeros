import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ConversationPaneLayout } from "./pane-layout";
import { TerminalDeck } from "./terminal-deck";
import { ChatDeck } from "./chat-deck";
import { ConversationHeader } from "./conversation-header";
import { ConversationWorkspaceHeader } from "./workspace-header";
import {
  CONVERSATION_MIN_PX,
  CONVERSATION_RATIO_VAR,
  WORKBENCH_COLUMN_ATTR,
  WORKBENCH_MIN_PX,
  clampConversationRatio,
  flushPendingConversationRatioPaint,
  persistConversationRatio,
  readPersistedConversationRatio,
} from "./pane-sizing";
import type { PaneTreeMinimumSize } from "./pane-portal-store";
import { cn } from "../../shared/ui/cn";
import { useResizeHint } from "../use-resize-hint";
import { beginContinuousLayoutResize } from "../terminal/continuous-layout-resize";
import { WorkbenchToggleButton } from "../workbench/toggle-button";
import type { Workspace } from "../../platform/git";
import { workspaceIsReadOnly } from "../../state/workspace-history";
import { WorkspaceHistoryBar } from "../workspace-history-bar";
import { selectActiveFolder, useActivePage, useWorkspaceStore } from "../../state/store";

import { popoverBoundaryProps } from "@/renderer/shared/ui/popover-boundary";
import { BrowserFloatStack } from "@/renderer/features/browser/browser-float-stack";
import {
  ConversationSummaryProvider,
  ConversationSummaryTrigger,
  ConversationSummaryIsland,
} from "./conversation-summary";

// Borderless: Workbench owns the single 1px seam (`border-l` on
// WORKBENCH_PANE_CLS).
const CONVERSATION_BASE_CLS = "flex flex-col bg-bg1 overflow-hidden relative";
// Proportional columns: conversation pane grows by --zeros-column-2-ratio and
// workbench by 1 − ratio (flex-basis 0), so both absorb window resizes. Floors
// are 360px here and 200px for workbench; max-w-[min(2400px,70%)] keeps a 30%
// workbench strip, and clampConversationRatio enforces the same bounds during a
// drag. Grow factors are scaled ×100 because flexbox hands out all free space
// only when unfrozen grow factors sum to ≥ 1. The flex declaration is the same
// with workbench open or collapsed (only max-width differs) and never
// transitions: changing grow factors on expand caused a 1600 → 360 → 800px jerk.
const CONVERSATION_DEFAULT_WIDTH_CLS =
  "[flex:calc(var(--zeros-column-2-ratio,0.5)*100)_1_0px] min-w-[360px] max-w-[min(2400px,70%)]";
// Collapsed: the only item in the row, so lift the 70% and 2400px caps that
// would leave a void; otherwise identical to CONVERSATION_DEFAULT_WIDTH_CLS.
const CONVERSATION_FULL_WIDTH_CLS =
  "[flex:calc(var(--zeros-column-2-ratio,0.5)*100)_1_0px] min-w-[360px] max-w-none";

// A 6px hit strip at the right edge, inside the `overflow-hidden` box (`right-0`,
// not a negative offset). It stays transparent; the cursor and the "Drag to
// resize" hint are the only affordances.
const RESIZE_HANDLE_CLS =
  "absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize";
const RESIZE_HANDLE_HIDDEN_CLS = "hidden";

// Past this much horizontal travel the seam gesture counts as a DRAG
// (commits a ratio); anything less is a click and must not persist.
// Matches the sidebar seam's DRAG_THRESHOLD_PX (use-sidebar-drag.ts).
const DRAG_THRESHOLD_PX = 3;

const BODY_BASE_CLS =
  "flex-1 overflow-hidden min-h-0 flex flex-col p-0 [&>*]:flex-1 [&>*]:min-h-0";
/** The split-pane tree and the terminal deck are siblings here, so terminal
 *  layers persist across pane-layout churn. */
const BODY_STACK_CLS = "relative size-full min-h-0";
/** The pane tree fills the stack; terminal layers portal into panes. */
const PANE_TREE_ROOT_CLS = "absolute inset-0 flex min-h-0 min-w-0 flex-col";

/** Persist conversation pane's share of the row (0..1; math in pane-sizing.ts)
 *  so both columns scale on resize. The committed ratio applies as
 *  --zeros-column-2-ratio; live drag frames write flex-grow directly instead. */
function useConversationRatio(sectionRef: React.RefObject<HTMLElement | null>) {
  const [ratio, setRatio] = useState<number>(readPersistedConversationRatio);

  // A layout effect so the write lands before paint. main.tsx also publishes the
  // value on <html> before the first render, because a descendant's measuring
  // layout effect can flush style first (boot-layout-vars.ts).
  useLayoutEffect(() => {
    sectionRef.current?.parentElement?.style.setProperty(
      CONVERSATION_RATIO_VAR,
      String(ratio),
    );
  }, [ratio, sectionRef]);

  const persist = useCallback((next: number) => {
    const clamped = persistConversationRatio(next);
    setRatio(clamped);
    // Keep the document-level boot value current too: if the two-column
    // row is ever recreated (it is rendered conditionally), its inline
    // variable goes with it and the inherited value is what the newly
    // inserted columns resolve against on their very first style pass.
    document.documentElement.style.setProperty(
      CONVERSATION_RATIO_VAR,
      String(clamped),
    );
  }, []);

  return { ratio, persist };
}

export function ConversationPane({
  workbenchCollapsed: requestedWorkbenchCollapsed = false,
  onToggleWorkbench,
  workspace = null,
  windowControlsInset = false,
}: {
  workbenchCollapsed?: boolean;
  onToggleWorkbench?: () => void;
  workspace?: Workspace | null;
  /** The app sidebar is collapsed, so its traffic lights and panel-left
   *  toggle float over this column's top-left corner (sidebar-toggle.tsx). */
  windowControlsInset?: boolean;
} = {}) {
  const readOnly = workspaceIsReadOnly(workspace);
  const surfaceActive = useActivePage() === "workspace";
  const activateLinkedContext = (event: React.SyntheticEvent) => {
    if (!event.isTrusted || !surfaceActive) return;
    const state = useWorkspaceStore.getState();
    const folder = selectActiveFolder(state);
    if (folder && state.localLinkNavigation?.passive) state.dispatch({ type: "ACTIVATE_LOCAL_LINK", folder });
  };
  const workbenchCollapsed = readOnly || requestedWorkbenchCollapsed;
  const emptyHistory =
    readOnly && workspace ? (
      <>
        <div className="text-fg2 flex flex-1 items-center justify-center text-sm">
          No chat history.
        </div>
        <WorkspaceHistoryBar
          key={workspace.id}
          workspace={workspace}
          surfaceActive={surfaceActive}
        />
      </>
    ) : null;
  // User-resizable Conversation pane. Drag from the right edge updates conversation pane's
  // share of the row; localStorage persists across reload.
  const sectionRef = useRef<HTMLElement | null>(null);
  const revealWorkbench = useCallback(() => {
    if (workbenchCollapsed) onToggleWorkbench?.();
  }, [workbenchCollapsed, onToggleWorkbench]);
  const { ratio: colRatio, persist: persistColRatio } =
    useConversationRatio(sectionRef);
  const { hintHandlers, hint } = useResizeHint("Drag to resize");
  const [paneMinimumSize, setPaneMinimumSizeState] =
    useState<PaneTreeMinimumSize>({
      width: CONVERSATION_MIN_PX,
      height: 0,
    });
  const setPaneMinimumSize = useCallback((next: PaneTreeMinimumSize) => {
    setPaneMinimumSizeState((current) =>
      current.width === next.width && current.height === next.height
        ? current
        : next,
    );
  }, []);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (workbenchCollapsed) return;
      // Primary button only — matching TerminalPanelResizer. Without this
      // a right-click on the seam started a capture-backed drag that ran
      // underneath the context menu.
      if (!e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const pointerId = e.pointerId;
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        /* capture can fail in rare cases; we'll proceed without it */
      }
      // No React "is resizing" state: it would only re-render every pane twice per
      // gesture. The pointer's offset into the row is the share; live frames write
      // the two flex items' flex-grow directly.
      const row = sectionRef.current?.parentElement;
      const conversationPane = sectionRef.current;
      const workbenchPane = row?.querySelector<HTMLElement>(
        `[${WORKBENCH_COLUMN_ATTR}]`,
      );
      const rect = row?.getBoundingClientRect();
      const rowLeft = rect?.left ?? 0;
      const rowWidth = rect?.width ?? 0;
      const startClientX = e.clientX;
      let lastRatio = colRatio;
      let rafId: number | null = null;
      // Click-vs-drag gate (mirrors useSidebarResizeDrag /
      // TerminalPanelResizer): a plain click or a few px of trackpad
      // jitter on the handle must not commit a ratio nudge. Only a
      // real drag past the threshold writes the variable or persists.
      let moved = false;

      // Pointer events can vanish (focus loss, devtools), leaving the column
      // following the cursor. Listen on both the handle and window, abort on blur and
      // pointerleave, and run one guarded finish().
      let isFinished = false;
      // Starting the shared gesture also freezes every hidden retained layer
      // and iframe at its current size (see resize-gesture-freeze.ts), so the
      // per-frame layout below is bounded to the VISIBLE surfaces. The active
      // transcript and composer re-wrap live and track the seam exactly until
      // the active split tree's recursive physical width floor is reached.
      const finishContinuousResize = beginContinuousLayoutResize();

      const paintRatio = () => {
        rafId = null;
        // A custom property written on the row inherits into every transcript,
        // diff, iframe, and xterm descendant. Direct standard properties keep
        // style invalidation on the two flex items while preserving the same
        // ratio math and live layout.
        conversationPane?.style.setProperty(
          "flex-grow",
          String(lastRatio * 100),
        );
        workbenchPane?.style.setProperty(
          "flex-grow",
          String((1 - lastRatio) * 100),
        );
      };

      const onMove = (ev: PointerEvent) => {
        if (isFinished) return;
        if (!moved && Math.abs(ev.clientX - startClientX) > DRAG_THRESHOLD_PX) {
          moved = true;
        }
        if (!moved) return;
        // Ratio math in the move handler (cheap), style write in rAF
        // (coalesced) — so a release that beats the scheduled frame
        // still persists the freshest position.
        lastRatio = clampConversationRatio(
          (ev.clientX - rowLeft) / (rowWidth || 1),
          rowWidth,
          paneMinimumSize.width,
        );
        if (rafId !== null) return;
        rafId = requestAnimationFrame(paintRatio);
      };

      const finish = () => {
        if (isFinished) return;
        isFinished = true;
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        handle.removeEventListener("lostpointercapture", finish);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        // Pointer-up can arrive before the latest animation frame. Paint that
        // final ratio synchronously before persisting it; if it equals the
        // existing React state, setRatio intentionally won't render again.
        flushPendingConversationRatioPaint(
          rafId,
          cancelAnimationFrame,
          paintRatio,
        );
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        try {
          if (handle.hasPointerCapture(pointerId)) {
            handle.releasePointerCapture(pointerId);
          }
        } catch {
          /* already released */
        }
        // Commit the inherited variable only ONCE, then remove the temporary
        // direct grow overrides. Both declarations resolve to the same final
        // geometry, so the handoff cannot snap; descendants avoid per-frame
        // style invalidation throughout the drag.
        if (moved) {
          row?.style.setProperty(CONVERSATION_RATIO_VAR, String(lastRatio));
          conversationPane?.style.removeProperty("flex-grow");
          workbenchPane?.style.removeProperty("flex-grow");
          persistColRatio(lastRatio);
        }
        // Terminal fit schedulers resume — and frozen hidden layers thaw —
        // only after the exact final geometry is published, producing one
        // xterm reflow / one hidden-layer relayout instead of one per frame.
        finishContinuousResize();
      };

      // Lock the cursor + suppress text selection window-wide for the whole
      // gesture (matching TerminalPanelResizer and the Home rail seam). The
      // 6px strip is narrow enough that a fast drag outruns the pointer and
      // the I-beam flickers back in over the transcript otherwise.
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
      handle.addEventListener("lostpointercapture", finish);
      // Window-level fallbacks — if the pointer leaves the handle or
      // the browser drops capture, these still fire.
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
    },
    [workbenchCollapsed, colRatio, paneMinimumSize.width, persistColRatio],
  );

  return (
    <section
      onPointerDownCapture={activateLinkedContext}
      onKeyDownCapture={activateLinkedContext}
      ref={sectionRef}
      data-zeros-column-2=""
      {...popoverBoundaryProps}
      className={cn(
        CONVERSATION_BASE_CLS,
        workbenchCollapsed
          ? CONVERSATION_FULL_WIDTH_CLS
          : CONVERSATION_DEFAULT_WIDTH_CLS,
      )}
      // The active split tree's physical floor, capped by what the row can
      // actually hand over. A tree minimum wider than that (the window shrank
      // after the split was made) would otherwise beat the max-width cap and
      // push Workbench off the edge; `min()` lets CSS re-resolve the cap on
      // every resize with no measurement of our own. Panes below their own
      // floor degrade through the composer's responsive breakpoints, which is
      // strictly better than a clipped row.
      style={{
        minWidth: workbenchCollapsed
          ? `min(${paneMinimumSize.width}px, 100%)`
          : `min(${paneMinimumSize.width}px, calc(100% - ${WORKBENCH_MIN_PX}px))`,
      }}
      aria-label={readOnly ? "Workspace history" : "Agent Workspace"}
    >
      {/* Hidden but mounted: the app sidebar already names the repository and
          workspace, and this row still registers the ⌘O / ⌘C shortcuts. */}
      {!readOnly && (
        <div className="hidden">
          <ConversationHeader />
        </div>
      )}

      <div className={BODY_BASE_CLS}>
        {/* Stacking container — the split-pane tree (each pane renders
            its own tab strip + chat body) + the terminal-agent deck.
            The deck stays mounted at THIS level so pane-layout churn
            never tears down xterm; its layers portal into pane hosts. */}
        <div className={BODY_STACK_CLS}>
          <div className={PANE_TREE_ROOT_CLS}>
            <ConversationSummaryProvider
              enabled={!readOnly}
              workbenchCollapsed={workbenchCollapsed}
              onRevealWorkbench={revealWorkbench}
            >
              <ConversationWorkspaceHeader
                workspace={workspace}
                readOnly={readOnly}
                windowControlsInset={windowControlsInset}
                onRevealWorkbench={revealWorkbench}
                trailing={
                  !readOnly && (
                    <>
                      <ConversationSummaryTrigger />
                      {workbenchCollapsed && onToggleWorkbench ? (
                        <WorkbenchToggleButton
                          workbenchCollapsed
                          onToggle={onToggleWorkbench}
                        />
                      ) : null}
                    </>
                  )
                }
              />
              <ConversationPaneLayout
                workspace={workspace}
                readOnly={readOnly}
                emptyContent={emptyHistory}
                onMinimumSizeChange={setPaneMinimumSize}
                bodyAside={!readOnly && <ConversationSummaryIsland />}
              />
            </ConversationSummaryProvider>
          </div>
          <ChatDeck workspace={workspace} />
          {/* Terminal-agent deck — every `kind: "terminal"` chat lives
              here. Each layer portals into the pane that owns the chat
              and shows only while it's that pane's displayed chat. */}
          {!readOnly && <TerminalDeck />}
        </div>
      </div>
      {/* Floated Browser tabs hover over the chat's bottom-right corner,
          stacked above the agent browser picture in picture. */}
      {!readOnly && <BrowserFloatStack onRevealWorkbench={revealWorkbench} />}
      {/* Hidden while workbench is collapsed; conversation pane is full width then. */}
      <div
        className={cn(
          RESIZE_HANDLE_CLS,
          workbenchCollapsed && RESIZE_HANDLE_HIDDEN_CLS,
        )}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel"
        onPointerDown={onResizePointerDown}
        {...hintHandlers}
      />
      {hint}
    </section>
  );
}
