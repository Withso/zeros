// ──────────────────────────────────────────────────────────
// Conversation pane — Agent Workspace
// ──────────────────────────────────────────────────────────
//
// Conversation pane hosts the conversation layer (AIChatPanel / agent session
// for the active chat). IDE tools (Git / Terminal / Env / Todo)
// live in Workbench where they have room to breathe.
// ──────────────────────────────────────────────────────────

import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ConversationPaneLayout } from "./pane-layout";
import { TerminalDeck } from "./terminal-deck";
import { ChatDeck } from "./chat-deck";
import { ConversationHeader } from "./conversation-header";
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
import { WorkspaceModeHeader } from "../../shared/ui/workspace-mode-header";

// ── Conversation pane className constants ───────────────────────────
// Wave 1.5 finalize (2026-05-16): the .zeros-conversation pane family
// (lines 97-270 of the original app-shell.css) is now inline
// utilities. The bare class names stay as DOM hooks: jump-by-
// message navigation + content scripts query by class name.

// 2026-06-16: dropped `border-r border-border1`. 2026-07-11 flush redesign:
// the conversation/workbench seam line came back, but workbench owns it now (`border-l` on
// WORKBENCH_PANE_CLS) — conversation pane stays borderless so the seam is a single 1px line.
// No top gutter (2026-07-12): the h-10 topbar is the column's full 0..40px
// title strip, centering its content at y=20 — the traffic lights' midline —
// like repository panel's and workbench's first rows (and the lights line up in the
// repository panel-collapsed state too).
const CONVERSATION_BASE_CLS = "flex flex-col bg-bg1 overflow-hidden relative";
// Width policy (2026-07-17 — proportional columns):
//   - Conversation pane's share of the two-column row is a RATIO, not a pixel
//     width. `flex-grow: var(--zeros-column-2-ratio)` on conversation pane and
//     `flex-grow: calc(1 - ratio)` on workbench (see WORKBENCH_PANE_CLS) make BOTH
//     columns absorb window-resize deltas proportionally — before
//     this, conversation pane held a fixed pixel basis and every resize/maximize
//     delta flowed into workbench alone.
//   - `flex-basis: 0` so the grow factors alone decide the split;
//     `flex-shrink: 1` keeps degenerate cases well-defined.
//   - `min-w-[360px]` is the readability floor when the window gets
//     tiny (workbench floors at 200px on its side).
//   - `max-w-[min(2400px,70%)]` keeps the historical cap: workbench
//     always retains at least a 30% strip, and chat never exceeds
//     2400px on very wide monitors. The JS drag clamp
//     (`clampConversationRatio`) enforces the same bounds so the live
//     drag never exceeds what CSS would allow — no snap on release.
//   - Both grow factors are scaled ×100 (ratio·100 / (1−ratio)·100).
//     The proportions are identical, but flexbox only hands out ALL
//     remaining free space when the unfrozen items' grow factors sum
//     to ≥ 1 — with bare 0..1 factors, conversation pane hitting its 2400px cap
//     on an ultrawide left workbench with `(1−ratio)·row` instead of the
//     full remainder, i.e. an empty gap at the window's right edge.
//   - The flex declaration is IDENTICAL in both the workbench-open and
//     workbench-collapsed states. Only the max-width cap differs (see
//     CONVERSATION_FULL_WIDTH_CLS). Two reasons, both bugs we used to ship:
//       1. Collapsed used to be `flex-1 basis-auto`, i.e. grow 1. On
//          expand, conversation pane went from grow 1 to grow ratio·100 while workbench
//          appeared at grow (1−ratio)·100 — so the first frame handed col
//          2 only 1/(1+50) of the row and it slammed into its 360px floor
//          before growing back out. With a `transition-[flex-grow]` on
//          top, that overshoot was *animated*: a measured 1600 → 360 →
//          800px jerk on every expand. Same grow factor in both states =
//          no overshoot and nothing to animate.
//       2. `basis-auto` makes the browser compute the max-content width
//          of the whole chat transcript to size the column. `basis: 0`
//          costs nothing.
//     There is deliberately NO transition on flex-grow: the only things
//     that ever changed it were the collapse toggle and the boot-time
//     variable write, and both were glitches rather than motion design.
const CONVERSATION_DEFAULT_WIDTH_CLS =
  "[flex:calc(var(--zeros-column-2-ratio,0.5)*100)_1_0px] min-w-[360px] max-w-[min(2400px,70%)]";
// Collapsed: conversation pane is the only item in the row, so the grow factor hands
// it everything — but the 70% share cap would leave a 30% void where workbench
// used to be, so it is lifted here (and the 2400px ultrawide ceiling with
// it, matching the previous collapsed behaviour). Everything else is
// character-for-character CONVERSATION_DEFAULT_WIDTH_CLS; see the note above.
const CONVERSATION_FULL_WIDTH_CLS =
  "[flex:calc(var(--zeros-column-2-ratio,0.5)*100)_1_0px] min-w-[360px] max-w-none";

// Resize handle — a 6px hit strip at conversation pane's right edge, which now butts
// directly against workbench (workbench dropped its left padding, so there's
// no bg-1 gutter between them). `right-0` (not a negative offset) keeps the
// strip INSIDE conversation pane's `overflow-hidden` box. The strip stays transparent;
// the resize cursor + the idle "Drag to resize" hint that rides above the
// pointer are the only affordances.
const RESIZE_HANDLE_CLS =
  "absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize";
const RESIZE_HANDLE_HIDDEN_CLS = "hidden";

// Past this much horizontal travel the seam gesture counts as a DRAG
// (commits a ratio); anything less is a click and must not persist.
// Matches the sidebar seam's DRAG_THRESHOLD_PX (use-sidebar-drag.ts).
const DRAG_THRESHOLD_PX = 3;

const BODY_BASE_CLS =
  "flex-1 overflow-hidden min-h-0 flex flex-col p-0 [&>*]:flex-1 [&>*]:min-h-0";
/** Stacking wrapper for the body — the split-pane tree and the
 *  terminal deck both live here as siblings, so the long-lived
 *  terminal layers persist across pane-layout churn while each pane
 *  keyed-remounts its own chat view. (Chat-content centering is owned
 *  by AgentChat's inner `mx-auto max-w-[1152px]` measure; the per-pane
 *  chat-root classes moved into conversation/pane-layout.tsx.) */
const BODY_STACK_CLS = "relative size-full min-h-0";
/** The pane tree fills the stack; terminal layers portal into panes. */
const PANE_TREE_ROOT_CLS = "absolute inset-0 flex min-h-0 min-w-0";

/** 2026-07-17 proportional columns: persist conversation pane's SHARE of the
 *  two-column row (0..1) instead of a pixel width, so both columns
 *  scale together on window resize / maximize. The storage + clamp math
 *  lives in conversation/pane-sizing.ts (a leaf module, unit-testable without the
 *  chat tree, and importable from the pre-render boot path).
 *
 *  Applies the committed ratio as --zeros-column-2-ratio on the two-column
 *  row. Live drag frames bypass this inherited variable and write direct
 *  flex-grow values to the two flex items. Returns the current ratio and a
 *  setter that persists it and keeps the pre-render boot value current. */
function useConversationRatio(sectionRef: React.RefObject<HTMLElement | null>) {
  const [ratio, setRatio] = useState<number>(readPersistedConversationRatio);

  // Layout effect, not effect: the write must land before paint. Note
  // this is NOT the only writer — main.tsx publishes the same value on
  // <html> before the first render, because a descendant layout effect
  // that measures (ChatPane's split-availability observer) can flush
  // style before this one runs. Without the boot write the flush
  // resolved the columns at the 0.5 fallback first, which is a real
  // style change and therefore an animatable one. See boot-layout-vars.ts.
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
  workbenchCollapsed = false,
  onToggleWorkbench,
  workspace = null,
}: {
  workbenchCollapsed?: boolean;
  onToggleWorkbench?: () => void;
  workspace?: Workspace | null;
} = {}) {
  // User-resizable Conversation pane. Drag from the right edge updates conversation pane's
  // share of the row; localStorage persists across reload.
  const sectionRef = useRef<HTMLElement | null>(null);
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
      // Deliberately NO React state for "is resizing": the column's flex
      // declaration no longer transitions, so a resizing flag would exist
      // only to re-render ConversationPaneLayout (every pane, every transcript)
      // twice per gesture — a visible hitch at grab and release.
      // Geometry of the two-column flex ROW (conversation pane's parent), measured once.
      // The pointer's offset into the row IS conversation pane's share. Workbench is kept as
      // an explicit target so live frames can update the two standard
      // `flex-grow` properties without changing an inherited custom property.
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

      // 01q: belt-and-suspenders cleanup. Pointer events sometimes
      // disappear (focus loss, browser quirk, devtools interruption).
      // When pointerup doesn't fire, the move listener can stay
      // attached and the column keeps following the cursor. Therefore:
      //   • Listeners are added on BOTH the handle (primary path)
      //     AND on window (fallback). Either source triggers cleanup.
      //   • A unified `finish()` function runs cleanup exactly once
      //     via an `isFinished` guard.
      //   • Also listen for blur and pointerleave-window to abort.
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
      ref={sectionRef}
      data-zeros-column-2=""
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
      aria-label="Agent Workspace"
    >
      <WorkspaceModeHeader
        workspace={workspace}
        separator
        trailing={
          workbenchCollapsed && onToggleWorkbench ? (
            <WorkbenchToggleButton
              workbenchCollapsed
              onToggle={onToggleWorkbench}
            />
          ) : undefined
        }
      />
      {/* The per-workspace bar (project › workspace breadcrumb +
          "Open in" dropdown) is HIDDEN — the global TopBar already
          carries the breadcrumb, so a second one was pure noise. It
          stays MOUNTED so its functionality survives —
          the ⌘O (open in default app) and ⌘C (copy path) window-level
          shortcuts it registers keep working. Window dragging is
          unaffected (the global TopBar above the columns owns the drag
          region). The visible workspace row above now owns the workbench
          expand button while the panel is collapsed. Remove the `hidden`
          wrapper to bring this legacy row back. */}
      <div className="hidden">
        <ConversationHeader />
      </div>

      <div className={BODY_BASE_CLS}>
        {/* Stacking container — the split-pane tree (each pane renders
            its own tab strip + chat body) + the terminal-agent deck.
            The deck stays mounted at THIS level so pane-layout churn
            never tears down xterm; its layers portal into pane hosts. */}
        <div className={BODY_STACK_CLS}>
          <div className={PANE_TREE_ROOT_CLS}>
            <ConversationPaneLayout onMinimumSizeChange={setPaneMinimumSize} />
          </div>
          <ChatDeck />
          {/* Terminal-agent deck — every `kind: "terminal"` chat lives
              here. Each layer portals into the pane that owns the chat
              and shows only while it's that pane's displayed chat. */}
          <TerminalDeck />
        </div>
      </div>
      {/* Drag handle for the right
          edge. Hidden when workbench is collapsed (conversation pane is full-width then).
          Width persists across reload via localStorage. */}
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
