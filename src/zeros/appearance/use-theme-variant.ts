// ──────────────────────────────────────────────────────────
// useThemeVariant — subscribe a component to the resolved app variant
// ──────────────────────────────────────────────────────────
//
// Returns the resolved "dark" | "light" (what data-theme carries — "system"
// already decided via prefers-color-scheme) and re-renders the caller when it
// changes, including on an OS appearance flip in system mode. Use it in
// surfaces that resolve token VALUES in JS (xterm themes via resolveTokenValue,
// canvas colors) — regular DOM styling should keep using var(--…), which
// re-themes with zero JS.
// ──────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";
import { getVariant, subscribe } from "./store";
import type { ThemeVariant } from "./prefs";

export function useThemeVariant(): ThemeVariant {
  return useSyncExternalStore(subscribe, getVariant, getVariant);
}
