// ──────────────────────────────────────────────────────────
// applyTheme — set appearance + palette attributes on <html>
// ──────────────────────────────────────────────────────────
//
// `data-theme` remains the resolved appearance contract (dark/light).
// Orka black is a second DARK palette, selected independently with
// `data-theme-palette="orka-black"`; this keeps Tailwind's `dark:`
// variant and every polarity-sensitive consumer binary.
//
// Transition suppression on concrete-theme change is preserved —
// switching palettes still flashes ugly if every transition
// runs its own duration. We add `.zeros-no-transitions` for
// one frame on switch.
// ──────────────────────────────────────────────────────────

import { isElectron, nativeInvoke } from "../../platform/runtime";
import {
  resolveThemeId,
  themeVariantForId,
  type AppearancePrefs,
  type ThemeId,
} from "./prefs";
import { resolveTokenValue } from "./resolve-tokens";

export interface ApplyThemeContext {
  systemPrefersDark: boolean;
}

/** When the concrete theme changes we suppress transitions for one frame so
 *  the swap lands instantly instead of every component chasing it. */
let lastThemeId: ThemeId | null = null;

export function applyTheme(
  prefs: AppearancePrefs,
  ctx: ApplyThemeContext,
  root: HTMLElement = document.documentElement,
): void {
  const themeId = resolveThemeId(prefs.mode, ctx.systemPrefersDark);
  const variant = themeVariantForId(themeId);

  const themeChanged = lastThemeId !== null && lastThemeId !== themeId;
  if (themeChanged) {
    root.classList.add("zeros-no-transitions");
  }

  root.setAttribute("data-theme", variant);
  if (themeId === "orka-black") {
    root.setAttribute("data-theme-palette", themeId);
  } else {
    root.removeAttribute("data-theme-palette");
  }

  if (themeChanged && typeof window !== "undefined") {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        root.classList.remove("zeros-no-transitions");
      });
    });
  }
  lastThemeId = themeId;

  syncNativeWindowBackground();
  syncNativeThemeMode(prefs.mode);
}

/** Report the theme MODE to the main process (`appearance_set_mode`):
 *  it persists the mode to userData (the durable copy localStorage —
 *  relocated under ~/Library/Caches — can't provide) and makes
 *  native chrome follow the app polarity (main maps Orka black to
 *  native dark). The MODE, not the resolved variant, is sent so System
 *  keeps native chrome AND the renderer's matchMedia on the live OS
 *  signal. Deduped — applyTheme also runs on OS flips and
 *  cross-window syncs where the mode hasn't changed. */
let lastReportedMode: string | null = null;
function syncNativeThemeMode(mode: AppearancePrefs["mode"]): void {
  if (!isElectron() || mode === lastReportedMode) return;
  lastReportedMode = mode;
  void nativeInvoke("appearance_set_mode", { mode }).catch(() => {
    /* bridge missing / command not registered — cosmetic, ignore */
  });
}

/** Keep the Electron BrowserWindow's pre-paint backgroundColor in sync
 *  with the theme's --bg1 — otherwise a light-theme user gets a dark
 *  flash at launch/resize (the main process persists the reported hex
 *  and uses it when creating the next window). Best-effort: no-ops in
 *  the browser dev harness, before the tokens stylesheet loads, or if
 *  the IPC bridge is missing. */
function syncNativeWindowBackground(): void {
  if (!isElectron()) return;
  const bg1 = resolveTokenValue("--bg1");
  if (!bg1) return;
  // Normalize whatever the token holds (our hsl() literals) to #rrggbb —
  // the one format both Electron's parser and the persisted-file
  // validator accept. Canvas fillStyle is the standard normalizer.
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = bg1;
  const hex = ctx.fillStyle;
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  void nativeInvoke("window_set_background", { color: hex }).catch(() => {
    /* bridge missing / command not registered — cosmetic, ignore */
  });
}
