// ──────────────────────────────────────────────────────────
// AppearanceProvider — React glue around the theme store
// ──────────────────────────────────────────────────────────
//
// The store handles all theming work (apply on load, listen to system
// changes, sync across windows). The provider is just so React
// components can read prefs reactively via useAppearance(). Mounting
// the provider isn't strictly required for theming to work — the
// store flushes on module load — but it's the canonical entry point
// and where we'd add things like a no-transitions class during mode
// swaps in Phase 2.
// ──────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";
import {
  getPrefs,
  setPrefs as storeSetPrefs,
  subscribe,
} from "./store";
import type { AppearancePrefs } from "./prefs";

export function useAppearance(): {
  prefs: AppearancePrefs;
  setPrefs: (patch: Partial<AppearancePrefs>) => void;
} {
  const prefs = useSyncExternalStore(subscribe, getPrefs, getPrefs);
  return { prefs, setPrefs: storeSetPrefs };
}

export function AppearanceProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  // Touch the store so importing this provider also imports the store
  // (and runs its module-level flush) — defensive: most apps will
  // import the store via useAppearance, but if a build setup tree-
  // shakes this file the store's initialization could be elided.
  useSyncExternalStore(subscribe, getPrefs, getPrefs);
  return <>{children}</>;
}
