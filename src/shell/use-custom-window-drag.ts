// ──────────────────────────────────────────────────────────
// useCustomWindowDrag — JS-driven window drag for column headers
// ──────────────────────────────────────────────────────────
//
// Standard `-webkit-app-region: drag` swallows every click on macOS
// (electron/electron#1354, status:wontfix). That broke single-click
// popover dismissal on the column-2/3 headers, since both rows are
// drag handles AND popover-trigger rows. The Cursor / VS Code answer
// is to drop the CSS drag region entirely and run drag in JS via IPC.
//
// This hook gives any header element the same three behaviours the
// OS title bar would provide:
//   - Single-click → propagates normally (Radix dismisses popovers).
//   - Hold + drag  → moves the window (main process polls cursor +
//                    calls win.setPosition every frame).
//   - Double-click → toggles maximize/minimize per the macOS
//                    AppleActionOnDoubleClick preference.
//
// Why Pointer Events + setPointerCapture (not mouseup):
//
//   With the old `window.addEventListener("mouseup", stop)`, the
//   renderer only saw mouseup when the cursor was inside the window
//   at the moment of release. In a multi-display drag, the cursor
//   can briefly outrun the window (setPosition lags the cursor by a
//   few px each tick), and the user can release the button while
//   the cursor is geometrically outside the window — especially on
//   the second display. The OS routes that mouseup to whatever's
//   under the cursor on that display, and the renderer never sees
//   it. Symptom: the polling timer in main runs forever; the window
//   keeps following the cursor after the user released.
//
//   `setPointerCapture(pointerId)` tells Chromium to deliver every
//   subsequent event for that pointer to the captured element —
//   regardless of cursor position, regardless of which display
//   the cursor is on, regardless of whether the cursor is inside
//   the window. Pointerup then fires reliably. We also defensively
//   check `event.buttons === 0` on every pointermove as a second
//   line of defence — if the browser ever delivers a move with no
//   buttons held (rare cross-display edge case), the drag ends
//   immediately on the next move event.
//
// Children that should NOT trigger window drag opt out by being a
// native interactive element (`<button>` / `<a>` / `<input>` /
// `<textarea>` / `<select>` / `<label>`), carrying a matching ARIA
// `role` (tab, button, menuitem, combobox, …) used by Radix and the
// app's own composite widgets, being `contenteditable`, or carrying
// `data-no-window-drag`. Clicks landing on Radix portaled content
// (popover bodies) are also ignored so a user picking an item inside
// an open popover doesn't kick off a drag.

import { useEffect, type RefObject } from "react";
import { isNativeRuntime, nativeInvoke } from "../native/runtime";

const INTERACTIVE_SEL = [
  // Native interactive HTML elements.
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "label",
  // ARIA-role widgets that act as interactive elements even though
  // their tag is a `<div>` / `<span>`. Covers tabs (col-3 pills,
  // col-2 chat tabs), Radix dropdowns/popovers, command menus, the
  // workspace-name inline editor, etc.
  '[role="tab"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  // Editable content surfaces (rich-text fields, etc.). Excludes
  // `contenteditable="false"` because that's an inert override.
  '[contenteditable]:not([contenteditable="false"])',
  // Explicit opt-out for children that don't fit any of the above
  // but still need to swallow the drag (custom widgets, drag handles
  // belonging to a different surface, etc.).
  "[data-no-window-drag]",
  // Radix portals — popover/dropdown content bodies floating above
  // the header. Without this, clicking an item inside an open popover
  // could kick off a window drag.
  "[data-radix-popper-content-wrapper]",
].join(", ");

/** Squared-distance threshold (in px) the cursor must travel from the
 *  pointerdown origin before we commit to a window drag. Without this,
 *  a stationary click on header chrome would call `window_drag_start`
 *  → the main-process poller can nudge the window by 1–2 px before
 *  pointerup fires (Cursor / VS Code use the same pattern). Squared
 *  to avoid an Math.sqrt() per pointermove. */
const DRAG_THRESHOLD_PX = 4;
const DRAG_THRESHOLD_SQ = DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX;

function isInteractive(target: HTMLElement | null): boolean {
  if (!target) return true;
  return !!target.closest(INTERACTIVE_SEL);
}

/** Apply window-drag + double-click-zoom semantics to `ref.current`.
 *  No-ops outside the Electron runtime (browser dev mode). */
export function useCustomWindowDrag(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!isNativeRuntime()) return;
    const el = ref.current;
    if (!el) return;

    // Drag has two phases:
    //   1. `pendingPress` is set on pointerdown; we're waiting to see
    //      whether the cursor crosses the threshold.
    //   2. `dragging = true` once we've called window_drag_start. From
    //      this point the OS-side poller owns the window position
    //      until pointerup / blur / dblclick / no-buttons-detected.
    // A stationary click never enters phase 2 → no IPC, no nudge.
    let dragging = false;
    let pendingPress: { x: number; y: number; pointerId: number } | null =
      null;
    let capturedPointerId: number | null = null;

    const releasePointer = (): void => {
      if (capturedPointerId === null) return;
      try {
        el.releasePointerCapture(capturedPointerId);
      } catch {
        /* already released or never captured — non-fatal */
      }
      capturedPointerId = null;
    };

    const stop = (): void => {
      pendingPress = null;
      releasePointer();
      if (!dragging) return;
      dragging = false;
      void nativeInvoke("window_drag_end").catch(() => {
        /* swallow — drag was already ended, nothing to do */
      });
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      if (isInteractive(event.target as HTMLElement | null)) return;
      // Block the browser default for non-interactive title-bar
      // surfaces: text selection on click + word selection on
      // double-click. This used to be implicit because the CSS drag
      // region disabled all DOM interactions; now we own it.
      event.preventDefault();

      // Capture the pointer to this element so subsequent
      // pointermove / pointerup events are delivered here even when
      // the cursor leaves the window or crosses to another display.
      // Without capture, a release while the cursor is geometrically
      // outside the window (which happens easily during fast
      // cross-display drags — setPosition lags the cursor by a few
      // px each frame) routes mouseup to whatever's under the cursor
      // instead of to our renderer. Symptom: window keeps following
      // the cursor after the user lifted the mouse button.
      try {
        el.setPointerCapture(event.pointerId);
        capturedPointerId = event.pointerId;
      } catch {
        /* setPointerCapture not supported on this element — fall
           through; the blur + document-pointerup safety nets below
           still catch most release paths */
      }

      // Arm the threshold watcher — don't call window_drag_start yet.
      // A stationary press resolves into a normal click on pointerup,
      // letting Radix popovers dismiss as expected.
      pendingPress = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
      };
    };

    const onPointerMove = (event: PointerEvent): void => {
      // Defensive check: if the browser delivers a move with no
      // buttons held, the user must have released without us seeing
      // the pointerup. End the drag immediately so the window stops
      // following the cursor. (Belt-and-braces — pointer capture +
      // pointerup is the primary path; this catches the corner case
      // where capture silently dropped, e.g. element removal mid-drag
      // or a renderer focus event clobbering the capture.)
      if (event.buttons === 0) {
        if (dragging || pendingPress) {
          stop();
        }
        return;
      }
      if (!pendingPress || dragging) return;
      if (event.pointerId !== pendingPress.pointerId) return;
      const dx = event.clientX - pendingPress.x;
      const dy = event.clientY - pendingPress.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_SQ) return;
      // Threshold crossed — commit to the drag.
      pendingPress = null;
      dragging = true;
      void nativeInvoke("window_drag_start").catch(() => {
        dragging = false;
      });
    };

    const onPointerUp = (event: PointerEvent): void => {
      // If we captured a specific pointer, only that one should end
      // the drag — protects against multi-touch / multi-pointer
      // weirdness. If we never captured (setPointerCapture failed),
      // capturedPointerId is null and we accept any release.
      if (capturedPointerId !== null && event.pointerId !== capturedPointerId) {
        return;
      }
      stop();
    };

    const onDoubleClick = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      if (isInteractive(event.target as HTMLElement | null)) return;
      // Belt + braces — the pointerdown preventDefault should already
      // have killed the word-selection default, but some browsers
      // still attempt it on the dblclick step.
      event.preventDefault();
      // Cancel any in-flight drag — the OS-style behaviour is that
      // a dblclick supersedes a drag in progress.
      stop();
      void nativeInvoke("window_zoom_toggle").catch(() => {
        /* non-essential; ignore */
      });
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("dblclick", onDoubleClick);
    // Document-level pointerup catches the corner case where pointer
    // capture was implicitly released by the browser (element removal,
    // focus loss in some Chromium versions) and the up event then
    // bubbled up the normal DOM path instead of going through capture.
    document.addEventListener("pointerup", onPointerUp);
    // Window-level blur safety net — if the OS app loses focus mid-
    // drag (Cmd-Tab, etc.), abort so the window doesn't stay glued
    // to the cursor when the user returns.
    window.addEventListener("blur", stop);

    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("dblclick", onDoubleClick);
      document.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("blur", stop);
      stop();
    };
  }, [ref]);
}
