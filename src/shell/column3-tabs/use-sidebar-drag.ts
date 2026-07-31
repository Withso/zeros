// ──────────────────────────────────────────────────────────
// useSidebarResizeDrag — the row-1 sidebar seam drag gesture
// ──────────────────────────────────────────────────────────
//
// One pointer-captured drag handler shared by the File tab's tree sidebar and
// the Changes tab's changed-file sidebar. Both resize the SAME committed width
// preference (files-sidebar-width), so the seam behaves identically wherever
// it appears: writes the sidebar element's width per rAF tick during the drag
// and commits ONE store update (persist + broadcast) on release. Geometry is
// resolved once at pointer-down — the captured pointer means the column can't
// resize mid-drag.

import { useCallback } from "react";

import {
  clampFilesSidebarFraction,
  setFilesSidebarFraction,
} from "./files-sidebar-width";

// Past this much horizontal travel the seam gesture counts as a DRAG (commits
// a width); anything less is a click and must not persist a stale value.
const DRAG_THRESHOLD_PX = 3;

/** Cancel a queued paint and synchronously apply its latest pointer position.
 * Returns whether a frame was flushed so the caller can clear its handle. */
export function flushPendingSidebarResize(
  frameId: number | null,
  cancelFrame: (frameId: number) => void,
  apply: () => void,
): boolean {
  if (frameId === null) return false;
  cancelFrame(frameId);
  apply();
  return true;
}

/** Pointer-down handler for the sidebar seam. `containerRef` is the two-pane
 *  root (measured once per gesture); `sidebarRef` is the left pane whose width
 *  the live drag writes directly (no React re-render per pointer tick). */
export function useSidebarResizeDrag(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sidebarRef: React.RefObject<HTMLDivElement | null>,
): (e: React.PointerEvent<HTMLDivElement>) => void {
  return useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      const sidebarEl = sidebarRef.current;
      if (!container || !sidebarEl) return;
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

      const rect = container.getBoundingClientRect();
      const startInlineWidth = sidebarEl.style.width;
      const startClientX = e.clientX;
      let lastClientX = e.clientX;
      let lastFraction: number | null = null;
      let rafId: number | null = null;
      let isFinished = false;
      // Click-vs-drag gate: only a real drag commits a width on release.
      let moved = false;

      const apply = () => {
        rafId = null;
        const raw = lastClientX - rect.left;
        // Pixel-clamped (sidebar floor + viewer reservation) then converted
        // to a share of the container, so the live width always equals what
        // the commit will persist — no snap-back on release. Percentage
        // widths keep the two panes proportional when the column resizes.
        const next = clampFilesSidebarFraction(raw, rect.width);
        lastFraction = next;
        sidebarEl.style.width = `${next * 100}%`;
      };

      const onMove = (ev: PointerEvent) => {
        if (isFinished) return;
        lastClientX = ev.clientX;
        if (!moved && Math.abs(ev.clientX - startClientX) > DRAG_THRESHOLD_PX) {
          moved = true;
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
        // pointerup can beat the scheduled paint. Flush the freshest clientX
        // after cancelling so a quick drag is not dropped and a longer drag
        // does not commit one frame behind the release position.
        if (flushPendingSidebarResize(rafId, cancelAnimationFrame, apply)) {
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
        if (moved && lastFraction != null) {
          setFilesSidebarFraction(lastFraction);
        } else {
          sidebarEl.style.width = startInlineWidth;
        }
      };

      // Lock the cursor + suppress text selection window-wide so the pointer
      // doesn't flicker over the panes mid-drag.
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
      // Window-level fallbacks — if capture is dropped (focus loss /
      // devtools), these still end the drag.
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
    },
    [containerRef, sidebarRef],
  );
}
