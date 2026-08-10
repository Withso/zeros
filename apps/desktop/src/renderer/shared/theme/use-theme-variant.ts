// ──────────────────────────────────────────────────────────
// Theme subscriptions for JS-rendered surfaces
// ──────────────────────────────────────────────────────────
//
// useThemeVariant returns resolved dark/light appearance and is appropriate
// for polarity decisions such as code-theme filtering. useThemeId also
// distinguishes Orka black from neutral Dark; canvas/xterm surfaces that read
// concrete token VALUES must use it so a dark-palette-only switch repaints.
// Regular DOM styling should keep using var(--…), which re-themes with zero JS.
// ──────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";
import { getThemeId, getVariant, subscribe } from "./store";
import type { ThemeId, ThemeVariant } from "./prefs";

export function useThemeVariant(): ThemeVariant {
  return useSyncExternalStore(subscribe, getVariant, getVariant);
}

export function useThemeId(): ThemeId {
  return useSyncExternalStore(subscribe, getThemeId, getThemeId);
}
