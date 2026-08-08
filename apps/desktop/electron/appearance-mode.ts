// App theme modes cross the renderer/main boundary and are persisted in
// userData. Keep validation and native Electron polarity mapping in one place:
// Orka black is a distinct app palette, but nativeTheme still has only the
// standard system/light/dark sources.

export const APPEARANCE_MODES = [
  "system",
  "light",
  "dark",
  "orka-black",
] as const;

export type AppearanceMode = (typeof APPEARANCE_MODES)[number];
export type NativeThemeSource = Exclude<AppearanceMode, "orka-black">;

export const NEUTRAL_DARK_WINDOW_BACKGROUND = "#141414";
export const ORKA_BLACK_WINDOW_BACKGROUND = "#131111";
export const LIGHT_WINDOW_BACKGROUND = "#ffffff";

// `#131111` is the rendered value of the former hsl(5 5% 7%) bg1;
// `#0e0c0c` was the older hard-coded BrowserWindow fallback; and `#121212`
// was neutral Dark before bg1 moved from L7 to L8. Any can remain in userData
// after an upgrade and would otherwise paint a stale first frame before the
// renderer reports the active palette.
const LEGACY_DARK_WINDOW_BACKGROUNDS = new Set([
  "#131111",
  "#0e0c0c",
  "#121212",
]);

const APPEARANCE_MODE_SET = new Set<string>(APPEARANCE_MODES);

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return typeof value === "string" && APPEARANCE_MODE_SET.has(value);
}

export function nativeThemeSourceForAppearanceMode(
  mode: AppearanceMode,
): NativeThemeSource {
  return mode === "orka-black" ? "dark" : mode;
}

export function migrateLegacyWindowBackground(
  color: string,
  mode: AppearanceMode | null,
  systemUsesDark: boolean,
): string {
  if (!LEGACY_DARK_WINDOW_BACKGROUNDS.has(color.toLowerCase())) {
    return color;
  }
  if (mode === "orka-black") return ORKA_BLACK_WINDOW_BACKGROUND;
  if (mode === "light" || (mode === "system" && !systemUsesDark)) {
    return LIGHT_WINDOW_BACKGROUND;
  }
  return NEUTRAL_DARK_WINDOW_BACKGROUND;
}
