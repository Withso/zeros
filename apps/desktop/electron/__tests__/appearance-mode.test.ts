import { describe, expect, it } from "vitest";

import {
  APPEARANCE_MODES,
  isAppearanceMode,
  migrateLegacyWindowBackground,
  nativeThemeSourceForAppearanceMode,
} from "../appearance-mode";

describe("appearance modes", () => {
  it("recognizes every persisted app mode and rejects retired or unknown ids", () => {
    expect(APPEARANCE_MODES).toEqual(["system", "light", "dark", "orka-black"]);
    for (const mode of APPEARANCE_MODES)
      expect(isAppearanceMode(mode)).toBe(true);
    expect(isAppearanceMode("orka-night")).toBe(false);
    expect(isAppearanceMode("neutral")).toBe(false);
    expect(isAppearanceMode(null)).toBe(false);
  });

  it("maps Orka black to Electron's dark native polarity", () => {
    expect(nativeThemeSourceForAppearanceMode("system")).toBe("system");
    expect(nativeThemeSourceForAppearanceMode("light")).toBe("light");
    expect(nativeThemeSourceForAppearanceMode("dark")).toBe("dark");
    expect(nativeThemeSourceForAppearanceMode("orka-black")).toBe("dark");
  });

  it("migrates stale dark first-frame colors to the active palette", () => {
    expect(migrateLegacyWindowBackground("#131111", "dark", true)).toBe(
      "#141414",
    );
    expect(migrateLegacyWindowBackground("#0E0C0C", null, true)).toBe(
      "#141414",
    );
    expect(migrateLegacyWindowBackground("#121212", "dark", true)).toBe(
      "#141414",
    );
    expect(migrateLegacyWindowBackground("#131111", "system", false)).toBe(
      "#ffffff",
    );
    expect(migrateLegacyWindowBackground("#131111", "orka-black", true)).toBe(
      "#131111",
    );
    expect(migrateLegacyWindowBackground("#0E0C0C", "orka-black", true)).toBe(
      "#131111",
    );
    expect(migrateLegacyWindowBackground("#121212", "orka-black", true)).toBe(
      "#131111",
    );
    expect(migrateLegacyWindowBackground("#242424", "dark", true)).toBe(
      "#242424",
    );
  });
});
