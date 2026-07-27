// ──────────────────────────────────────────────────────────
// Appearance prefs — types + defaults
// ──────────────────────────────────────────────────────────
//
// Current model (2026-07-12):
//   - mode: "system" | "light" | "dark"
//   - codeTheme: resolved syntax-theme id for the current variant
//     (stored as per-variant picks — see StoredAppearancePrefs)
//
// All neutral / accent tokens are concrete HSL values in
// `styles/zeros-tokens.css`. `:root` carries the dark default —
// "Zeros Shade" (muted warm gray, cool blue accent) — and the
// `[data-theme="light"]` block carries the light overrides
// (shipped 2026-07-11). `data-theme` on <html> selects between
// them and drives the `dark:` Tailwind variant.
//
// ─── History ────────────────────────────────────────────────
// 2026-05-16 (Phase 01b Wave 0): hue/intensity/accent sliders
//   + their OKLCH recipe exports were deleted in pursuit of a
//   strict mode-only v0 model.
// 2026-05-25: themeHue + themeChromaMul restored as two
//   primitive sliders driving the neutral palette via calc()
//   in tokens.css. `--brand` retired in the same change.
// 2026-05-26: sliders removed for good. Strategic call —
//   Design Mode + canvas-frame styling don't compose with a
//   global hue/chroma layer, and a single theme cuts the QA
//   matrix in half. Tokens are now concrete HSL values; no
//   `--theme-hue` / `--theme-chroma-mul` indirection.
// 2026-05-26 (later): "Neutral" theme added as a 4th mode.
//   Pure-gray variant (hue 0, saturation 0%). Lives in
//   `[data-theme="neutral"]` overrides; selected by user.
// 2026-05-27: Pure-black "Dark Theme" promoted to :root default.
//   The previous warm Orka Black palette moved to
//   `[data-theme="orka-night"]`; "orka-night" added as a 5th
//   mode so users can opt back into the warm palette.
// 2026-07-07: All variants retired. "Zeros Shade" (muted warm
//   gray + cool blue accent) promoted to :root as the single
//   dark theme; the orka-night / neutral / zeros-blue /
//   zeros-shade modes and their [data-theme] blocks were
//   deleted. Saved legacy modes migrate to "dark" on load.
// 2026-07-12: codeTheme storage went per-variant (dark + light
//   each remember their own pick). The old single-slot string —
//   which the store had frozen to the dark default for everyone —
//   migrates via migrateLegacyCodeTheme on load.
// ──────────────────────────────────────────────────────────

export type ThemeMode = "system" | "light" | "dark";

/** Resolved variant after `system` is decided via prefers-color-scheme.
 *  This is what gets written to the document's data-theme attribute. */
export type ThemeVariant = "dark" | "light";

export interface AppearancePrefs {
  mode: ThemeMode;
  /** Syntax-highlighting theme id (see code-themes.ts) shared by code blocks,
   *  diffs, the editor, and the terminal. This is the RESOLVED id for the
   *  CURRENT variant — the store re-derives it whenever the variant flips
   *  (mode change, or an OS appearance flip in "system" mode), so its
   *  appearance always matches the app theme. */
  codeTheme: string;
}

/** What actually lands in localStorage. `codeThemes` holds only EXPLICIT
 *  per-variant picks — an absent slot means "follow that variant's default"
 *  (defaultCodeThemeForVariant) and is never written implicitly, so the
 *  default keeps flipping with the app theme instead of freezing at whatever
 *  variant happened to be active on first save (the pre-2026-07-12 bug that
 *  made the light code themes unreachable). */
export interface StoredAppearancePrefs {
  mode: ThemeMode;
  codeThemes: { dark?: string; light?: string };
}

export const DEFAULT_STORED_PREFS: StoredAppearancePrefs = {
  mode: "dark",
  codeThemes: {},
};

export const STORAGE_KEY = "zeros.appearance.v2";

/** Resolve `mode` to a concrete variant: explicit modes pass through,
 *  "system" follows the macOS prefers-color-scheme signal. */
export function resolveVariant(
  mode: ThemeMode,
  systemPrefersDark: boolean,
): ThemeVariant {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return systemPrefersDark ? "dark" : "light";
}
