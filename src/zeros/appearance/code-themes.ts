// ──────────────────────────────────────────────────────────
// Unified code-theme registry
// ──────────────────────────────────────────────────────────
//
// ONE Shiki theme id drives every code surface so they stay in lockstep:
//   • agent tool-call code blocks (shiki, syntax.ts)
//   • diffs (@pierre/diffs, diff-theme.ts)
//   • the CodeMirror editor (Files-tab Edit mode, code-editor/)
//
// Every entry is a STANDARD Shiki bundled theme name. That's deliberate:
//   • @pierre/diffs accepts any bundled name (via @pierre/theming's registry),
//   • the app's own shiki + the editor load them by name (shiki dynamic-imports
//     the grammar/theme on demand),
//   • so there's NO custom theme JSON and NO extra dependency.
//
// The user picks one PER APP VARIANT in Appearance settings (the dark and light
// app themes each remember their own pick; see store.ts). The public
// AppearancePrefs.codeTheme always carries the id resolved for the CURRENT
// variant. All names verified against the installed shiki@4.0.2 bundled-themes
// list.
// ──────────────────────────────────────────────────────────

export interface CodeThemeOption {
  /** Stable id stored in AppearancePrefs.codeTheme. */
  id: string;
  /** Dropdown label. */
  label: string;
  /** Shiki bundled theme name — the highlight theme used EVERYWHERE and the
   *  syntax-cache key. */
  shiki: string;
  /** Light vs dark — drives @pierre/diffs `themeType` and the editor's
   *  background handling (a light theme needs a light editor background so its
   *  light token colors stay readable on the otherwise-dark app). */
  appearance: "light" | "dark";
}

// The catalog is split by `appearance`, and each app variant only ever uses its
// own half: the Settings picker lists codeThemesForVariant(variant), and the
// store resolves the active theme with resolveCodeThemeForVariant — so a dark
// app always highlights with a dark theme and a light app with a light one.
// That invariant matters because the code theme drives ONLY the syntax TOKEN
// colors — every code surface (code blocks, diffs, editor, terminal, settings
// preview) keeps a UNIFORM background = the app surface. The bg tracks the APP
// mode, not the code theme, so a wrong-polarity theme (near-white tokens on the
// light app's white bg) is unreadable by construction. The 3 dark Catppuccin
// flavors (Mocha/Macchiato/Frappé) were dropped — they differ only by
// background, so on the shared app bg they were indistinguishable. `appearance`
// feeds @pierre/diffs `themeType` (which sets the shadow root's color-scheme).
export const CODE_THEMES: CodeThemeOption[] = [
  // ── dark — listed when the app variant is dark ──
  { id: "default", label: "Default", shiki: "github-dark-default", appearance: "dark" },
  { id: "dracula", label: "Dracula", shiki: "dracula", appearance: "dark" },
  { id: "nord", label: "Nord", shiki: "nord", appearance: "dark" },
  { id: "tokyo-night", label: "Tokyo Night", shiki: "tokyo-night", appearance: "dark" },
  { id: "gruvbox-dark", label: "Gruvbox Dark", shiki: "gruvbox-dark-medium", appearance: "dark" },
  { id: "solarized-dark", label: "Solarized Dark", shiki: "solarized-dark", appearance: "dark" },
  // ── light — listed when the app variant is light (Latte first: it's the default) ──
  { id: "catppuccin-latte", label: "Catppuccin Latte", shiki: "catppuccin-latte", appearance: "light" },
  { id: "github-light", label: "GitHub Light", shiki: "github-light-default", appearance: "light" },
  { id: "one-light", label: "One Light", shiki: "one-light", appearance: "light" },
  { id: "solarized-light", label: "Solarized Light", shiki: "solarized-light", appearance: "light" },
  { id: "gruvbox-light", label: "Gruvbox Light", shiki: "gruvbox-light-medium", appearance: "light" },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", shiki: "rose-pine-dawn", appearance: "light" },
];

/** The dark-app default; the light-app default is Catppuccin Latte — pick the
 *  right one with defaultCodeThemeForVariant. */
export const DEFAULT_CODE_THEME_ID = "default";

const BY_ID = new Map(CODE_THEMES.map((t) => [t.id, t]));

/** Resolve a stored codeTheme id to its option, falling back to Default for an
 *  unknown/legacy id (so a removed/renamed theme — e.g. a dropped Catppuccin dark
 *  flavor still in someone's localStorage — never breaks highlighting).
 *  NB: variant-blind — for anything driven by the CURRENT app theme, prefer the
 *  store's already-resolved `prefs.codeTheme` (or resolveCodeThemeForVariant). */
export function resolveCodeTheme(id: string | undefined): CodeThemeOption {
  return (id ? BY_ID.get(id) : undefined) ?? BY_ID.get(DEFAULT_CODE_THEME_ID)!;
}

/** The default code theme for a resolved app variant — used when a user has no
 *  stored pick FOR THAT VARIANT (an explicit pick always wins within its
 *  variant). Light → Catppuccin Latte, whose dark token colors read on the
 *  light app bg (the uniform code bg follows the app surface); dark →
 *  "Default" = github-dark-default. */
export function defaultCodeThemeForVariant(variant: string): string {
  return variant === "light" ? "catppuccin-latte" : DEFAULT_CODE_THEME_ID;
}

/** The picker list for a resolved app variant — only themes whose token colors
 *  read on that variant's uniform code bg (see the catalog invariant above). */
export function codeThemesForVariant(variant: "dark" | "light"): CodeThemeOption[] {
  return CODE_THEMES.filter((t) => t.appearance === variant);
}

/** Resolve a per-variant stored pick to its option. A pick only applies to its
 *  own variant: an unknown id, no pick, or a wrong-polarity pick (possible via
 *  cross-window payloads or hand-edited storage) falls back to the variant's
 *  default so code is never highlighted with unreadable wrong-polarity colors. */
export function resolveCodeThemeForVariant(
  id: string | undefined,
  variant: "dark" | "light",
): CodeThemeOption {
  const opt = id ? BY_ID.get(id) : undefined;
  if (opt && opt.appearance === variant) return opt;
  return BY_ID.get(defaultCodeThemeForVariant(variant))!;
}

/** Migrate a legacy single-slot codeTheme (schema before per-variant picks) into
 *  the per-variant shape. "default" was the value the old store FROZE into
 *  storage for users who never picked anything — treat it (and unknown ids) as
 *  "no pick" so those users finally get the variant-aware default; a real pick
 *  lands in the slot of its own appearance. */
export function migrateLegacyCodeTheme(id: string): { dark?: string; light?: string } {
  if (id === DEFAULT_CODE_THEME_ID) return {};
  const opt = BY_ID.get(id);
  if (!opt) return {};
  return { [opt.appearance]: opt.id };
}
