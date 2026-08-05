// ──────────────────────────────────────────────────────────
// Overlay focus — kill the "ghost" focus ring Radix overlays leave
// on their trigger after a POINTER-driven close.
// ──────────────────────────────────────────────────────────
//
// Why this exists
// ---------------
// Every Radix overlay (DropdownMenu, Select, Popover) traps focus
// while open and RESTORES focus to its trigger when it closes
// (FocusScope `onUnmountAutoFocus`, surfaced as `onCloseAutoFocus`).
// That restore is correct for keyboard users — it puts focus back
// where they were so they don't lose their place.
//
// The bug: Chromium's `:focus-visible` heuristic CARRIES the
// "focus is visible" state across a programmatic focus move. While
// the overlay is open Radix focuses its items programmatically, so
// the overlay counts as focus-visible. When it closes and focus is
// restored to the trigger, Chromium copies that visible state onto
// the trigger — so the trigger lights up its `focus-visible:ring-*`
// chrome even though the user only ever used the mouse. That bright
// ring left on a "+" button / dropdown after you pick an item is the
// bug that reads as a "stuck" or unexpectedly auto-focused control.
//
// The fix: track the last input modality globally and, from the
// overlay primitives' `onCloseAutoFocus`, cancel the focus-restore
// ONLY when the close was pointer-driven. Keyboard closes keep the
// restore (and the ring), so keyboard a11y is unchanged. A cancelled
// restore drops focus to <body> — exactly what a mouse user expects
// (same as clicking any plain button that opens nothing).
//
// Centralising this in the primitives is what makes the fix systemic:
// it replaces the ad-hoc `onCloseAutoFocus={(e) => e.preventDefault()}`
// + `focus-visible:ring-0` band-aids that had been sprinkled across a
// handful of tab strips. Those only patched the few spots someone
// happened to notice, and the blunt versions ALSO killed the ring for
// genuine keyboard focus.

type InputModality = "pointer" | "keyboard";

// Default to "pointer": before any interaction there is nothing to
// restore focus *from*, and "pointer" is the no-ring branch, so the
// safe default is to never paint a spurious ring.
let lastInputModality: InputModality = "pointer";

if (typeof window !== "undefined") {
  // Capture phase + passive: we only observe (never interfere, never
  // call preventDefault here), and we want to read the modality before
  // any handler down the tree can stop the event from propagating.
  // `pointerdown` covers mouse, touch, and pen in one event.
  window.addEventListener(
    "pointerdown",
    () => {
      lastInputModality = "pointer";
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    "keydown",
    () => {
      lastInputModality = "keyboard";
    },
    { capture: true, passive: true },
  );
}

/** The modality of the most recent user input (pointer vs keyboard). */
export function getLastInputModality(): InputModality {
  return lastInputModality;
}

/**
 * Default `onCloseAutoFocus` behaviour for Radix overlay content
 * (DropdownMenu / Select / Popover). Cancels Radix's focus-restore to
 * the trigger when the overlay was closed by POINTER — the case that
 * produces the spurious `:focus-visible` ring — while leaving keyboard
 * closes alone so focus (and the ring) returns to the trigger for
 * keyboard users.
 *
 * Wire it as the primitive's default and still forward to any
 * consumer-supplied handler so per-site overrides keep working:
 *
 *   onCloseAutoFocus={(event) => {
 *     suppressPointerRefocus(event);
 *     userOnCloseAutoFocus?.(event);
 *   }}
 */
export function suppressPointerRefocus(event: Event): void {
  if (lastInputModality === "pointer") {
    event.preventDefault();
  }
}
