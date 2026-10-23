// ──────────────────────────────────────────────────────────
// useShortcutsHotkey — ⌥⌘/ toggles the shortcuts palette
// ──────────────────────────────────────────────────────────

import { useEffect } from "react";

/** Pure matcher for the "open shortcuts menu" chord (⌥⌘/ or Ctrl+Alt+/), kept
 *  separate from the effect for regression tests. Matches on `event.code ===
 *  "Slash"` (the physical key) because Option/Alt, Shift and keyboard layouts
 *  can change the character produced by that key. */
export function matchesShortcutsHotkey(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "code">,
): boolean {
  if (!(event.metaKey || event.ctrlKey) || !event.altKey) return false;
  return event.code === "Slash";
}

/** ⌥⌘/ anywhere toggles the shortcuts palette. Unlike the app's other global
 *  chords this does NOT stand down inside editable surfaces: ⌥⌘/ produces no
 *  text, and the palette must be reachable (and closable) even while the chat
 *  composer or the palette's own search box is focused. `toggle` should be
 *  stable (wrap in useCallback) to avoid re-subscribing each render. */
export function useShortcutsHotkey(toggle: () => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!matchesShortcutsHotkey(event)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggle]);
}
