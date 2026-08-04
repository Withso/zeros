// ──────────────────────────────────────────────────────────
// useCodeThemeFg — the active code theme's own base foreground
// ──────────────────────────────────────────────────────────
//
// The editor's chrome paints text Shiki leaves uncolored (and every character
// before tokens land) with the CODE THEME's foreground, not the app's --fg1, so a
// file never opens in chrome white and repaints into the theme. That colour lives
// in the resolved Shiki theme registration, which is available synchronously once
// the shared highlighter has the theme loaded.
//
// Synchronous on the common path (the highlighter is warmed at idle, and every
// code surface in the app loads the same single theme), so the value is already
// in hand during the render that builds the editor's extensions. While it is
// cold, this returns null — the chrome falls back to --fg1 — and re-renders once
// the theme resolves.
// ──────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

import {
  ensureThemeColors,
  getThemeColorsSync,
} from "@/zeros/agent/renderers/syntax";

/** Non-empty foreground for `theme`, or null while it is unresolved. */
function peekFg(theme: string): string | null {
  return getThemeColorsSync(theme)?.fg || null;
}

export function useCodeThemeFg(theme: string): string | null {
  const [fg, setFg] = useState(() => peekFg(theme));

  useEffect(() => {
    const sync = peekFg(theme);
    if (sync) {
      setFg(sync);
      return;
    }
    // Cold (first mount, or a just-picked theme): hold the current value rather
    // than dropping to --fg1 for a frame — on a theme switch the tokens on screen
    // are still the previous theme's, so its foreground is the consistent one to
    // keep until the new theme resolves.
    let cancelled = false;
    void ensureThemeColors(theme).then((colors) => {
      if (!cancelled && colors?.fg) setFg(colors.fg);
    });
    return () => {
      cancelled = true;
    };
  }, [theme]);

  return fg;
}
