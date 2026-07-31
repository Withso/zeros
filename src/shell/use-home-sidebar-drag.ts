// ──────────────────────────────────────────────────────────
// useHomeSidebarResizeDrag — the Home rail seam drag gesture
// ──────────────────────────────────────────────────────────
//
// A pointer-captured drag for the HomeSidebar's right-edge seam. Mirrors the
// row-1 sidebar seam (use-sidebar-drag.ts): geometry is resolved once at
// pointer-down (the captured pointer means the rail can't move mid-drag), the
// live width is written straight to the element's inline style per rAF tick
// (no React re-render per pointer move), and ONE store commit (persist +
// broadcast) fires on release. The rail's left edge is fixed (leftmost of the
// window), so width is simply `pointerX − railLeft`, pixel-clamped.

import { useCallback } from "react";

import {
  clampHomeSidebarWidth,
  setHomeSidebarWidth,
} from "./home-sidebar-width";

// Past this much horizontal travel the gesture counts as a DRAG (commits a
// width); anything less is a click and must not persist a stale value.
const DRAG_THRESHOLD_PX = 3;

/** Pointer-down handler for the rail seam. `railRef` is the rail wrapper whose
 *  left edge anchors the drag and whose inline width the live drag writes.
 *  `onResizingChange` toggles the handle's active affordance (fires once when a
 *  real drag begins, and again on release). */
export function useHomeSidebarResizeDrag(
  railRef: React.RefObject<HTMLDivElement | null>,
  onResizingChange?: (resizing: boolean) => void,
): (e: React.PointerEvent<HTMLDivElement>) => void {
  return useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const railEl = railRef.current;
      if (!railEl) return;
      // Primary button only. A right- or middle-click otherwise opened a
      // capture-backed drag that kept running under the context menu, and its
      // pointerup never arrived — leaving the body cursor locked to ew-resize.
      if (!e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const pointerId = e.pointerId;
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        /* capture occasionally fails — proceed without it */
      }

      const left = railEl.getBoundingClientRect().left;
      const startInlineWidth = railEl.style.width;
      const startClientX = e.clientX;
      let lastClientX = e.clientX;
      let lastWidth: number | null = null;
      let rafId: number | null = null;
      let isFinished = false;
      // Click-vs-drag gate: only a real drag commits a width on release.
      let moved = false;

      const apply = () => {
        rafId = null;
        const next = clampHomeSidebarWidth(lastClientX - left);
        lastWidth = next;
        railEl.style.width = `${next}px`;
      };

      const onMove = (ev: PointerEvent) => {
        if (isFinished) return;
        lastClientX = ev.clientX;
        if (!moved && Math.abs(ev.clientX - startClientX) > DRAG_THRESHOLD_PX) {
          moved = true;
          onResizingChange?.(true);
        }
        if (rafId !== null) return; // coalesce bursts into one paint
        rafId = requestAnimationFrame(apply);
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
        // pointerup can beat the scheduled paint — flush the freshest clientX
        // so a quick drag isn't dropped or committed one frame behind.
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          apply();
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
        // Commit only a real drag; the store value then matches the inline
        // width the drag left behind, so React's next render is a no-op
        // reconcile. A no-move click restores the starting inline width.
        if (moved && lastWidth != null) {
          setHomeSidebarWidth(lastWidth);
        } else {
          railEl.style.width = startInlineWidth;
        }
        onResizingChange?.(false);
      };

      // Lock the cursor + suppress text selection window-wide so the pointer
      // doesn't flicker over the rail mid-drag.
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
      // Window-level fallbacks — if capture is dropped (focus loss / devtools),
      // these still end the drag.
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
    },
    [railRef, onResizingChange],
  );
}
