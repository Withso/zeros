// ──────────────────────────────────────────────────────────
// useCodeTheme — subscribe a component to the active code-theme id
// ──────────────────────────────────────────────────────────
//
// Returns the current AppearancePrefs.codeTheme and re-renders the caller when
// it changes (via the appearance store's subscribe/getPrefs). Use it in any code
// surface (code blocks, diffs, editor) so a picker change updates it LIVE — pass
// the returned id into useMemo deps / option builders that read the theme.
// ──────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";
import { getPrefs, subscribe } from "./store";

export function useCodeTheme(): string {
  return useSyncExternalStore(
    subscribe,
    () => getPrefs().codeTheme,
    () => getPrefs().codeTheme,
  );
}
