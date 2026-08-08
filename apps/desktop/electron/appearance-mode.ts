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

export const NEUTRAL_DARK_WINDOW_BACKGROUND = "#121212";
export const ORKA_BLACK_WINDOW_BACKGROUND = "#131111";
export const LIGHT_WINDOW_BACKGROUND = "#ffffff";

// Every dark first-frame color this app has ever persisted, so a value left in
// userData by an earlier launch is RE-RESOLVED against the active mode instead
// of painting a stale frame before the renderer reports its palette:
// `#121212` is neutral Dark's bg1 and `#131111` is Orka black's (each maps to
// itself when its own mode is active); `#0e0c0c` was the older hard-coded
// BrowserWindow fallback; `#141414` was neutral Dark during the brief window
// when its bg1 sat at L8.
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
