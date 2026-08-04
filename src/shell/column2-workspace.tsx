// ──────────────────────────────────────────────────────────
// Column 2 — Agent Workspace
// ──────────────────────────────────────────────────────────
//
// Col 2 hosts the conversation layer (AIChatPanel / agent session
// for the active chat). IDE tools (Git / Terminal / Env / Todo)
// live in Column 3 where they have room to breathe.
// ──────────────────────────────────────────────────────────

import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Column2Panes } from "./column2-panes";
import { Column2TerminalDeck } from "./column2-terminal-deck";
import { Column2ChatDeck } from "./column2-chat-deck";
import { Column2TopBar } from "./column2-topbar";
import {
  COLUMN_2_RATIO_VAR,
  clampColumn2Ratio,
  flushPendingColumn2RatioPaint,
  persistColumn2Ratio,
  readPersistedColumn2Ratio,
} from "./column2-ratio";
import { cn } from "../zeros/ui/cn";
import { useResizeHint } from "./use-resize-hint";
import { beginContinuousLayoutResize } from "./terminal/continuous-layout-resize";

// ── Column 2 className constants ───────────────────────────
// Wave 1.5 finalize (2026-05-16): the .zeros-column-2 family
// (lines 97-270 of the original app-shell.css) is now inline
// utilities. The bare class names stay as DOM hooks: jump-by-
// message navigation + content scripts query by class name.

// 2026-06-16: dropped `border-r border-border1`. 2026-07-11 flush redesign:
// the col-2/col-3 seam line came back, but col-3 owns it now (`border-l` on
// COL3_CLS) — col-2 stays borderless so the seam is a single 1px line.
// No top gutter (2026-07-12): the h-10 topbar is the column's full 0..40px
// title strip, centering its content at y=20 — the traffic lights' midline —
// like col-1's and col-3's first rows (and the lights line up in the
// col-1-collapsed state too).
const COL2_BASE_CLS = "flex flex-col bg-bg1 overflow-hidden relative";
// Width policy (2026-07-17 — proportional columns):
//   - Col 2's share of the two-column row is a RATIO, not a pixel
//     width. `flex-grow: var(--zeros-column-2-ratio)` on col 2 and
//     `flex-grow: calc(1 - ratio)` on col 3 (see COL3_CLS) make BOTH
//     columns absorb window-resize deltas proportionally — before
//     this, col 2 held a fixed pixel basis and every resize/maximize
//     delta flowed into col 3 alone.
//   - `flex-basis: 0` so the grow factors alone decide the split;
//     `flex-shrink: 1` keeps degenerate cases well-defined.
//   - `min-w-[320px]` is the readability floor when the window gets
//     tiny (col 3 floors at 200px on its side).
//   - `max-w-[min(2400px,70%)]` keeps the historical cap: col 3
//     always retains at least a 30% strip, and chat never exceeds
//     2400px on very wide monitors. The JS drag clamp
//     (`clampColumn2Ratio`) enforces the same bounds so the live
//     drag never exceeds what CSS would allow — no snap on release.
//   - Both grow factors are scaled ×100 (ratio·100 / (1−ratio)·100).
//     The proportions are identical, but flexbox only hands out ALL
//     remaining free space when the unfrozen items' grow factors sum
//     to ≥ 1 — with bare 0..1 factors, col 2 hitting its 2400px cap
//     on an ultrawide left col 3 with `(1−ratio)·row` instead of the
//     full remainder, i.e. an empty gap at the window's right edge.
//   - The flex declaration is IDENTICAL in both the col-3-open and
//     col-3-collapsed states. Only the max-width cap differs (see
//     COL2_WIDE_CLS). Two reasons, both bugs we used to ship:
//       1. Collapsed used to be `flex-1 basis-auto`, i.e. grow 1. On
//          expand, col 2 went from grow 1 to grow ratio·100 while col 3
//          appeared at grow (1−ratio)·100 — so the first frame handed col
//          2 only 1/(1+50) of the row and it slammed into its 320px floor
//          before growing back out. With a `transition-[flex-grow]` on
//          top, that overshoot was *animated*: a measured 1600 → 320 →
//          800px jerk on every expand. Same grow factor in both states =
//          no overshoot and nothing to animate.
//       2. `basis-auto` makes the browser compute the max-content width
//          of the whole chat transcript to size the column. `basis: 0`
//          costs nothing.
//     There is deliberately NO transition on flex-grow: the only things
//     that ever changed it were the collapse toggle and the boot-time
//     variable write, and both were glitches rather than motion design.
const COL2_DEFAULT_WIDTH_CLS =
  "[flex:calc(var(--zeros-column-2-ratio,0.5)*100)_1_0px] min-w-[320px] max-w-[min(2400px,70%)]";
// Collapsed: col 2 is the only item in the row, so the grow factor hands
// it everything — but the 70% share cap would leave a 30% void where col 3
// used to be, so it is lifted here (and the 2400px ultrawide ceiling with
// it, matching the previous collapsed behaviour). Everything else is
// character-for-character COL2_DEFAULT_WIDTH_CLS; see the note above.
const COL2_WIDE_CLS =
  "[flex:calc(var(--zeros-column-2-ratio,0.5)*100)_1_0px] min-w-[320px] max-w-none";

// Resize handle — a 6px hit strip at col 2's right edge, which now butts
// directly against column 3 (column 3 dropped its left padding, so there's
// no bg-1 gutter between them). `right-0` (not a negative offset) keeps the
// strip INSIDE col 2's `overflow-hidden` box. The strip stays transparent;
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
 *  chat-root classes moved into column2-panes.tsx.) */
const BODY_STACK_CLS = "relative size-full min-h-0";
/** The pane tree fills the stack; terminal layers portal into panes. */
const PANE_TREE_ROOT_CLS = "absolute inset-0 flex min-h-0 min-w-0";

/** 2026-07-17 proportional columns: persist col 2's SHARE of the
 *  two-column row (0..1) instead of a pixel width, so both columns
 *  scale together on window resize / maximize. The storage + clamp math
 *  lives in column2-ratio.ts (a leaf module, unit-testable without the
 *  chat tree, and importable from the pre-render boot path).
 *
 *  Applies the committed ratio as --zeros-column-2-ratio on the two-column
 *  row. Live drag frames bypass this inherited variable and write direct
 *  flex-grow values to the two flex items. Returns the current ratio and a
 *  setter that persists it and keeps the pre-render boot value current. */
function useColumn2Ratio(sectionRef: React.RefObject<HTMLElement | null>) {
  const [ratio, setRatio] = useState<number>(readPersistedColumn2Ratio);

  // Layout effect, not effect: the write must land before paint. Note
  // this is NOT the only writer — main.tsx publishes the same value on
  // <html> before the first render, because a descendant layout effect
  // that measures (ChatPane's split-availability observer) can flush
  // style before this one runs. Without the boot write the flush
  // resolved the columns at the 0.5 fallback first, which is a real
  // style change and therefore an animatable one. See boot-layout-vars.ts.
  useLayoutEffect(() => {
    sectionRef.current?.parentElement?.style.setProperty(
      COLUMN_2_RATIO_VAR,
      String(ratio),
    );
  }, [ratio, sectionRef]);

  const persist = useCallback((next: number) => {
    const clamped = persistColumn2Ratio(next);
    setRatio(clamped);
    // Keep the document-level boot value current too: if the two-column
    // row is ever recreated (it is rendered conditionally), its inline
    // variable goes with it and the inherited value is what the newly
    // inserted columns resolve against on their very first style pass.
    document.documentElement.style.setProperty(
      COLUMN_2_RATIO_VAR,
      String(clamped),
    );
  }, []);

  return { ratio, persist };
}

export function Column2Workspace({
  col3Collapsed = false,
  onToggleCol3,
}: {
  col3Collapsed?: boolean;
  onToggleCol3?: () => void;
} = {}) {
  // User-resizable Column 2. Drag from the right edge updates col 2's
  // share of the row; localStorage persists across reload.
  const sectionRef = useRef<HTMLElement | null>(null);
  const { ratio: colRatio, persist: persistColRatio } =
    useColumn2Ratio(sectionRef);
  const { hintHandlers, hint } = useResizeHint("Drag to resize");

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (col3Collapsed) return;
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
      // only to re-render Column2Panes (every pane, every transcript)
      // twice per gesture — a visible hitch at grab and release.
      // Geometry of the two-column flex ROW (col 2's parent), measured once.
      // The pointer's offset into the row IS col 2's share. Column 3 is kept as
      // an explicit target so live frames can update the two standard
      // `flex-grow` properties without changing an inherited custom property.
      const row = sectionRef.current?.parentElement;
      const column2 = sectionRef.current;
      const column3 = row?.querySelector<HTMLElement>(
        "[data-zeros-column-3]",
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
      // disappear (focus loss, browser quirk, devtools interruption)
      // — when pointerup doesn't fire, the move listener stayed
      // attached and the column kept following the cursor (the
      // "wiggle" the user reported). Now:
      //   • Listeners are added on BOTH the handle (primary path)
      //     AND on window (fallback). Either source triggers cleanup.
      //   • A unified `finish()` function runs cleanup exactly once
      //     via an `isFinished` guard.
      //   • Also listen for blur and pointerleave-window to abort.
      let isFinished = false;
      // Starting the shared gesture also freezes every hidden retained layer
      // and iframe at its current size (see resize-gesture-freeze.ts), so the
      // per-frame layout below is bounded to the VISIBLE surfaces. The active
      // transcript and composer re-wrap live and track the seam exactly — no
      // width floor, no content clipped under column 3 mid-drag.
      const finishContinuousResize = beginContinuousLayoutResize();

      const paintRatio = () => {
        rafId = null;
        // A custom property written on the row inherits into every transcript,
        // diff, iframe, and xterm descendant. Direct standard properties keep
        // style invalidation on the two flex items while preserving the same
        // ratio math and live layout.
        column2?.style.setProperty("flex-grow", String(lastRatio * 100));
        column3?.style.setProperty("flex-grow", String((1 - lastRatio) * 100));
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
        lastRatio = clampColumn2Ratio(
          (ev.clientX - rowLeft) / (rowWidth || 1),
          rowWidth,
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
        flushPendingColumn2RatioPaint(rafId, cancelAnimationFrame, paintRatio);
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
          row?.style.setProperty(COLUMN_2_RATIO_VAR, String(lastRatio));
          column2?.style.removeProperty("flex-grow");
          column3?.style.removeProperty("flex-grow");
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
    [col3Collapsed, colRatio, persistColRatio],
  );

  return (
    <section
      ref={sectionRef}
      className={cn(
        COL2_BASE_CLS,
        col3Collapsed ? COL2_WIDE_CLS : COL2_DEFAULT_WIDTH_CLS,
      )}
      aria-label="Agent Workspace"
    >
      {/* The per-workspace bar (project › workspace breadcrumb +
          "Open in" dropdown) is HIDDEN — the global TopBar already
          carries the breadcrumb, so a second one was pure noise. It
          stays MOUNTED so its functionality survives —
          the ⌘O (open in default app) and ⌘C (copy path) window-level
          shortcuts it registers keep working. Window dragging is
          unaffected (the global TopBar above the columns owns the drag
          region), and the col-3 expand button this row used to host
          when the panel is collapsed now renders at the right end of
          the top-right pane's tab strip (see Column2Panes). Remove the
          `hidden` wrapper to bring the row back. */}
      <div className="hidden">
        <Column2TopBar
          col3Collapsed={col3Collapsed}
          onToggleCol3={onToggleCol3}
        />
      </div>

      <div className={BODY_BASE_CLS}>
        {/* Stacking container — the split-pane tree (each pane renders
            its own tab strip + chat body) + the terminal-agent deck.
            The deck stays mounted at THIS level so pane-layout churn
            never tears down xterm; its layers portal into pane hosts. */}
        <div className={BODY_STACK_CLS}>
          <div className={PANE_TREE_ROOT_CLS}>
            <Column2Panes
              col3Collapsed={col3Collapsed}
              onToggleCol3={onToggleCol3}
            />
          </div>
          <Column2ChatDeck />
          {/* Terminal-agent deck — every `kind: "terminal"` chat lives
              here. Each layer portals into the pane that owns the chat
              and shows only while it's that pane's displayed chat. */}
          <Column2TerminalDeck />
        </div>
      </div>
      {/* Phase 2 chat overhaul (2026-05-07): drag handle for the right
          edge. Hidden when col3 is collapsed (col2 is full-width then).
          Width persists across reload via localStorage. */}
      <div
        className={cn(
          RESIZE_HANDLE_CLS,
          col3Collapsed && RESIZE_HANDLE_HIDDEN_CLS,
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
