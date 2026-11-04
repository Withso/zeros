// App theme modes cross the renderer/main boundary and are persisted in
// userData. Keep validation and the first-frame window background in one
// place. The three modes map 1:1 onto Electron's nativeTheme.themeSource,
// so no polarity translation is needed.

export const APPEARANCE_MODES = ["system", "light", "dark"] as const;

export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

export const NEUTRAL_DARK_WINDOW_BACKGROUND = "#141414";
export const LIGHT_WINDOW_BACKGROUND = "#ffffff";

// Every dark first-frame color this app has ever persisted, so a value left in
// userData by an earlier launch is RE-RESOLVED against the active mode instead
// of painting a stale frame before the renderer reports its palette:
// `#141414` is neutral Dark's bg1 (maps to itself); `#121212` was its bg1
// before the Zeros Design palette; `#131111` was the retired Orka black
// palette's bg1; `#0e0c0c` was the older hard-coded BrowserWindow fallback.
const LEGACY_DARK_WINDOW_BACKGROUNDS = new Set([
  "#121212",
  "#131111",
  "#0e0c0c",
  "#141414",
]);

const APPEARANCE_MODE_SET = new Set<string>(APPEARANCE_MODES);

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return typeof value === "string" && APPEARANCE_MODE_SET.has(value);
}

export function migrateLegacyWindowBackground(
  color: string,
  mode: AppearanceMode | null,
  systemUsesDark: boolean,
): string {
  if (!LEGACY_DARK_WINDOW_BACKGROUNDS.has(color.toLowerCase())) {
    return color;
  }
  if (mode === "light" || (mode === "system" && !systemUsesDark)) {
    return LIGHT_WINDOW_BACKGROUND;
  }
  return NEUTRAL_DARK_WINDOW_BACKGROUND;
}
