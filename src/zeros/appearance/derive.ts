// ──────────────────────────────────────────────────────────
// applyTheme — set data-theme attribute on <html>
// ──────────────────────────────────────────────────────────
//
// 2026-05-26: only `data-theme` is written. The hue + intensity
// primitives (`--theme-hue`, `--theme-chroma-mul`) are gone —
// tokens in zeros-tokens.css are concrete HSL values, so there
// is nothing to drive from JS beyond mode switching.
//
// Transition suppression on variant change is preserved —
// switching dark↔light still flashes ugly if every transition
// runs its own duration. We add `.zeros-no-transitions` for
// one frame on switch.
// ──────────────────────────────────────────────────────────

import { isElectron, nativeInvoke } from "../../native/runtime";
import { resolveVariant, type AppearancePrefs } from "./prefs";
import { resolveTokenValue } from "./resolve-tokens";

export interface ApplyThemeContext {
  systemPrefersDark: boolean;
}

/** When the variant changes (dark↔light) we suppress transitions for
 *  one frame so the swap lands instantly instead of every component
 *  chasing the new colors over its own duration. */
let lastVariant: string | null = null;

export function applyTheme(
  prefs: AppearancePrefs,
  ctx: ApplyThemeContext,
  root: HTMLElement = document.documentElement,
): void {
  const variant = resolveVariant(prefs.mode, ctx.systemPrefersDark);

  const variantChanged = lastVariant !== null && lastVariant !== variant;
  if (variantChanged) {
    root.classList.add("zeros-no-transitions");
  }

  root.setAttribute("data-theme", variant);

  if (variantChanged && typeof window !== "undefined") {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        root.classList.remove("zeros-no-transitions");
      });
    });
  }
  lastVariant = variant;

  syncNativeWindowBackground();
  syncNativeThemeMode(prefs.mode);
}

/** Report the theme MODE to the main process (`appearance_set_mode`):
 *  it persists the mode to userData (the durable copy localStorage —
 *  relocated under ~/Library/Caches — can't provide) and points
 *  `nativeTheme.themeSource` at it so native context menus/dialogs
 *  follow the app theme. The MODE, not the resolved variant, so
 *  "system" keeps native chrome AND the renderer's matchMedia on the
 *  live OS signal. Deduped — applyTheme also runs on OS flips and
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
