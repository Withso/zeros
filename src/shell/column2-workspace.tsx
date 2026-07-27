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
  COLUMN_2_RATIO_DEFAULT,
  COLUMN_2_RATIO_VAR,
  clampColumn2Ratio,
  flushPendingColumn2RatioPaint,
  sanitizeColumn2Ratio,
} from "./column2-ratio";
import { cn } from "../zeros/ui/cn";
import { useResizeHint } from "./use-resize-hint";

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
const COL2_DEFAULT_WIDTH_CLS =
  "[flex:calc(var(--zeros-column-2-ratio,0.5)*100)_1_0px] min-w-[320px] max-w-[min(2400px,70%)] transition-[flex-grow] duration-150 ease-out";
const COL2_WIDE_CLS = "flex-1 basis-auto min-w-[320px] border-r-0";
const COL2_RESIZING_CLS = "transition-none";

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
 *  scale together on window resize / maximize. The clamp math lives in
 *  column2-ratio.ts (a leaf module, unit-testable without the chat
 *  tree). */
const COLUMN_2_RATIO_KEY = "zeros.column2.ratio";
/** Pre-ratio installs persisted a pixel width here — migrated once
 *  (px ÷ window width ≈ share of the row) then removed. */
const COLUMN_2_LEGACY_WIDTH_KEY = "zeros.column2.width";

/** Read the persisted ratio once, apply it as --zeros-column-2-ratio
 *  on the two-column ROW element (col 2's parent — scoped there, not
 *  :root, so ratio writes only recalc the columns that consume it).
 *  Returns the current ratio and a setter that writes to both the CSS
 *  variable (immediate visual effect) and localStorage (persistence). */
function useColumn2Ratio(sectionRef: React.RefObject<HTMLElement | null>) {
  const [ratio, setRatio] = useState<number>(() => {
    if (typeof window === "undefined") return COLUMN_2_RATIO_DEFAULT;
    try {
      const raw = window.localStorage.getItem(COLUMN_2_RATIO_KEY);
      if (raw != null) {
        return sanitizeColumn2Ratio(Number.parseFloat(raw));
      }
      // One-time migration from the pixel era: the old value was col
      // 2's width in a row that spanned (approximately) the window,
      // so px ÷ innerWidth preserves the user's visual layout.
      // Persist immediately so the migration survives the reload that
      // removes the legacy key. (Idempotent under StrictMode's double
      // initializer: the second run reads the freshly written key.)
      const legacy = window.localStorage.getItem(COLUMN_2_LEGACY_WIDTH_KEY);
      if (legacy != null) {
        window.localStorage.removeItem(COLUMN_2_LEGACY_WIDTH_KEY);
        const px = Number.parseInt(legacy, 10);
        if (Number.isFinite(px) && window.innerWidth > 0) {
          const migrated = sanitizeColumn2Ratio(px / window.innerWidth);
          window.localStorage.setItem(COLUMN_2_RATIO_KEY, String(migrated));
          return migrated;
        }
      }
    } catch {
      /* private mode / quota — fall through to default */
    }
    return COLUMN_2_RATIO_DEFAULT;
  });

  // Apply to the row on every change so the CSS picks it up (col 3 is
  // a sibling under the same row, so it inherits the variable for its
  // `calc(1 - ratio)` grow factor). Layout effect, not effect: the
  // write must land before first paint, or a persisted non-default
  // ratio flashes one frame of the 0.5 CSS fallback on mount.
  useLayoutEffect(() => {
    sectionRef.current?.parentElement?.style.setProperty(
      COLUMN_2_RATIO_VAR,
      String(ratio),
    );
  }, [ratio, sectionRef]);

  const persist = useCallback((next: number) => {
    const clamped = sanitizeColumn2Ratio(next);
    setRatio(clamped);
    try {
      window.localStorage.setItem(COLUMN_2_RATIO_KEY, String(clamped));
    } catch {
      /* persistence is best-effort */
    }
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
  const [isResizing, setIsResizing] = useState(false);
  const { hintHandlers, hint } = useResizeHint("Drag to resize");

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (col3Collapsed) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const pointerId = e.pointerId;
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        /* capture can fail in rare cases; we'll proceed without it */
      }
      setIsResizing(true);
      // Geometry of the two-column flex ROW (col 2's parent), measured
      // once — the captured pointer means the window can't resize
      // mid-drag. The pointer's offset into the row IS col 2's share.
      const row = sectionRef.current?.parentElement;
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

      const paintRatio = () => {
        rafId = null;
        // Writing the shared variable on the row moves BOTH columns:
        // col 2 grows by `ratio`, col 3 by `1 - ratio` — and the
        // scoped write keeps the per-frame style recalc inside the
        // two-column subtree.
        row?.style.setProperty(COLUMN_2_RATIO_VAR, String(lastRatio));
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
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        // Pointer-up can arrive before the latest animation frame. Paint that
        // final ratio synchronously before persisting it; if it equals the
        // existing React state, setRatio intentionally won't render again.
        flushPendingColumn2RatioPaint(rafId, cancelAnimationFrame, paintRatio);
        setIsResizing(false);
        try {
          if (handle.hasPointerCapture(pointerId)) {
            handle.releasePointerCapture(pointerId);
          }
        } catch {
          /* already released */
        }
        // Commit only a real drag. Persist re-applies the same variable
        // value via state — the live drag and the committed layout
        // agree, so no snap. A no-move click leaves the ratio untouched
        // (the variable was never written this gesture).
        if (moved) persistColRatio(lastRatio);
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
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
        isResizing && COL2_RESIZING_CLS,
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
