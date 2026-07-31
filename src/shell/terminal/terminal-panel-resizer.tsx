// ──────────────────────────────────────────────────────────
// Terminal Panel Resizer — row 1 / row 2 horizontal seam
// ──────────────────────────────────────────────────────────
//
// Restores the complete interaction model of the former row-2 seam: live
// pointer-captured resizing, pixel floors for both rows, drag-to-collapse,
// dragging open from collapsed, persisted percentages, click-vs-drag
// protection, window-level release fallbacks, and double-click centering.

import React, {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

import { useResizeHint } from "../use-resize-hint";
import {
  TERMINAL_PANEL_DEFAULT_PCT,
  TERMINAL_PANEL_HEIGHT_VAR,
  TERMINAL_PANEL_MAX_PCT,
  TERMINAL_PANEL_MIN_PCT,
  TERMINAL_PANEL_MIN_PX,
  TERMINAL_ROW1_MIN_PX,
  TERMINAL_SEAM_PX,
  useTerminalPanelLayoutStore,
} from "./terminal-panel-layout";

// Re-exported for the existing call sites/tests that reach for the seam
// geometry through the resizer; the constants themselves now live in the
// leaf layout module so the panel's CSS can be built from them too.
export {
  TERMINAL_PANEL_HEIGHT_VAR,
  TERMINAL_PANEL_MIN_PX,
  TERMINAL_ROW1_MIN_PX,
};

const PANEL_SELECTOR = "[data-terminal-panel]";

const COLLAPSE_THRESHOLD_PX = 56;
const DRAG_THRESHOLD_PX = 3;
export const TERMINAL_PANEL_DOUBLE_CLICK_MS = 400;
export const TERMINAL_PANEL_DOUBLE_CLICK_SLOP_PX = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Pure drag geometry, exported so the two row floors stay regression-tested. */
export function terminalPanelPctForPointer({
  containerHeight,
  containerBottom,
  clientY,
}: {
  containerHeight: number;
  containerBottom: number;
  clientY: number;
}): number {
  if (containerHeight <= 0) return TERMINAL_PANEL_DEFAULT_PCT;
  const maxPanelPx = Math.max(
    TERMINAL_PANEL_MIN_PX,
    containerHeight - TERMINAL_ROW1_MIN_PX - TERMINAL_SEAM_PX,
  );
  const panelPx = clamp(
    containerBottom - clientY,
    TERMINAL_PANEL_MIN_PX,
    maxPanelPx,
  );
  return clamp(
    (panelPx / containerHeight) * 100,
    TERMINAL_PANEL_MIN_PCT,
    TERMINAL_PANEL_MAX_PCT,
  );
}

export function isTerminalPanelDoubleClick(
  previous: { at: number; y: number },
  current: { at: number; y: number },
): boolean {
  return (
    current.at - previous.at < TERMINAL_PANEL_DOUBLE_CLICK_MS &&
    current.at >= previous.at &&
    Math.abs(current.y - previous.y) < TERMINAL_PANEL_DOUBLE_CLICK_SLOP_PX
  );
}

/** Publish the committed height onto the PANEL element, which is also what
 *  the drag writes per frame.
 *
 *  Two deliberate choices, each fixing a real defect:
 *
 *  • The panel, not column 3. Custom properties inherit, so setting this one
 *    on the column invalidated style for every descendant — the diff viewer,
 *    the file tree, the browser iframes — on every animation frame of a seam
 *    drag. Scoping it to the panel confines that to the panel.
 *
 *  • A layout effect, not React's `style` prop. React only rewrites style it
 *    owns when its own previous style object differs. Dragging the panel open
 *    from collapsed flips `expanded`, and that re-render would rewrite a
 *    React-owned variable with the pre-drag stored percentage — yanking the
 *    panel off the pointer for a frame. An unchanged `heightPct` doesn't
 *    re-run this effect, so the live drag is never clobbered. */
function useApplyTerminalPanelHeight(
  containerRef: RefObject<HTMLDivElement | null>,
): void {
  const heightPct = useTerminalPanelLayoutStore(
    (state) => state.layout.heightPct,
  );
  useLayoutEffect(() => {
    containerRef.current
      ?.querySelector<HTMLElement>(PANEL_SELECTOR)
      ?.style.setProperty(TERMINAL_PANEL_HEIGHT_VAR, `${heightPct}%`);
  }, [containerRef, heightPct]);
}

interface TerminalPanelResizerProps {
  containerRef: RefObject<HTMLDivElement | null>;
}

export function TerminalPanelResizer({
  containerRef,
}: TerminalPanelResizerProps) {
  const setExpanded = useTerminalPanelLayoutStore((state) => state.setExpanded);
  const setHeightPct = useTerminalPanelLayoutStore(
    (state) => state.setHeightPct,
  );
  const reset = useTerminalPanelLayoutStore((state) => state.reset);
  const lastPctRef = useRef(TERMINAL_PANEL_DEFAULT_PCT);
  const lastDownRef = useRef({ at: 0, y: 0 });
  useApplyTerminalPanelHeight(containerRef);

  const openAtCenter = useCallback(() => {
    reset();
  }, [reset]);

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();

      const currentDown = { at: Date.now(), y: event.clientY };
      const doubleClick = isTerminalPanelDoubleClick(
        lastDownRef.current,
        currentDown,
      );
      lastDownRef.current = doubleClick ? { at: 0, y: 0 } : currentDown;
      if (doubleClick) {
        try {
          window.getSelection()?.removeAllRanges();
        } catch {
          // Selection API is optional in tests / non-browser runtimes.
        }
        openAtCenter();
        return;
      }

      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const panel = container.querySelector<HTMLElement>(PANEL_SELECTOR);
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        // Window listeners below still finish the gesture if capture fails.
      }

      const rect = container.getBoundingClientRect();
      const containerHeight = rect.height;
      const containerBottom = rect.bottom;
      if (panel) panel.style.transition = "none";

      const layout = useTerminalPanelLayoutStore.getState().layout;
      lastPctRef.current = layout.heightPct;
      let expandedNow = layout.expanded;
      const startClientY = event.clientY;
      let lastClientY = event.clientY;
      let rafId: number | null = null;
      let finished = false;
      let collapseIntent = false;
      let moved = false;

      const apply = () => {
        rafId = null;
        if (containerHeight <= 0) return;
        const rawPanelPx = containerBottom - lastClientY;
        if (rawPanelPx < TERMINAL_PANEL_MIN_PX - COLLAPSE_THRESHOLD_PX) {
          collapseIntent = true;
          if (panel && expandedNow) panel.style.opacity = "0.55";
          return;
        }

        collapseIntent = false;
        if (panel) panel.style.opacity = "";
        if (!expandedNow) {
          setExpanded(true);
          expandedNow = true;
        }
        const pct = terminalPanelPctForPointer({
          containerHeight,
          containerBottom,
          clientY: lastClientY,
        });
        lastPctRef.current = pct;
        // Scoped to the PANEL, not column 3: custom properties inherit, so
        // writing this one on the column dirtied style for the diff viewer,
        // file tree, and browser iframes on every single drag frame.
        panel?.style.setProperty(TERMINAL_PANEL_HEIGHT_VAR, `${pct}%`);
      };

      const onMove = (moveEvent: PointerEvent) => {
        if (finished) return;
        lastClientY = moveEvent.clientY;
        if (
          !moved &&
          Math.abs(moveEvent.clientY - startClientY) > DRAG_THRESHOLD_PX
        )
          moved = true;
        if (rafId !== null) return;
        rafId = requestAnimationFrame(apply);
      };

      const finish = () => {
        if (finished) return;
        finished = true;
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        if (rafId !== null) {
          // Do not drop the freshest pointer position when pointerup beats the
          // scheduled frame; it may be the frame that crossed the collapse
          // threshold or reached the user's final height.
          cancelAnimationFrame(rafId);
          rafId = null;
          apply();
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (panel) {
          panel.style.transition = "";
          panel.style.opacity = "";
        }
        try {
          if (handle.hasPointerCapture(pointerId))
            handle.releasePointerCapture(pointerId);
        } catch {
          // The pointer may already have been released by the browser.
        }

        const committed =
          useTerminalPanelLayoutStore.getState().layout.heightPct;
        // Both non-commit branches rewind the panel's override to the stored
        // value themselves: nothing else will, because the layout effect above
        // only fires when `heightPct` actually changes — and in these branches
        // it deliberately hasn't.
        if (expandedNow && collapseIntent) {
          setExpanded(false);
          panel?.style.setProperty(TERMINAL_PANEL_HEIGHT_VAR, `${committed}%`);
        } else if (expandedNow && moved) {
          setHeightPct(lastPctRef.current);
        } else if (expandedNow) {
          // A click or sub-threshold jitter must never overwrite the saved size.
          panel?.style.setProperty(TERMINAL_PANEL_HEIGHT_VAR, `${committed}%`);
        }
      };

      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
    },
    [containerRef, openAtCenter, setExpanded, setHeightPct],
  );

  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        // Selection API is optional.
      }
      openAtCenter();
    },
    [openAtCenter],
  );

  const { hintHandlers, hint } = useResizeHint(
    "Drag to resize · Double-click to center",
  );

  return (
    <div className="bg-border1 relative h-px shrink-0">
      {/* Invisible grab strip — the resize cursor + the idle "Drag to resize"
          hint above the pointer are the only affordances. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel"
        className="absolute inset-x-0 -inset-y-[7px] z-20 cursor-ns-resize select-none"
        onPointerDown={onResizePointerDown}
        onMouseDown={(event) => event.preventDefault()}
        onDoubleClick={onDoubleClick}
        {...hintHandlers}
      />
      {hint}
    </div>
  );
}
