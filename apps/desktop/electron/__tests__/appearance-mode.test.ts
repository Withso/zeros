import { describe, expect, it } from "vitest";

import {
  APPEARANCE_MODES,
  isAppearanceMode,
  migrateLegacyWindowBackground,
} from "../appearance-mode";

describe("appearance modes", () => {
  it("recognizes every persisted app mode and rejects retired or unknown ids", () => {
    expect(APPEARANCE_MODES).toEqual(["system", "light", "dark"]);
    for (const mode of APPEARANCE_MODES)
      expect(isAppearanceMode(mode)).toBe(true);
    expect(isAppearanceMode("orka-night")).toBe(false);
    expect(isAppearanceMode("orka-black")).toBe(false);
    expect(isAppearanceMode("neutral")).toBe(false);
    expect(isAppearanceMode(null)).toBe(false);
  });

  it("migrates stale dark first-frame colors to the active palette", () => {
    expect(migrateLegacyWindowBackground("#131111", "dark", true)).toBe(
      "#121212",
    );
    expect(migrateLegacyWindowBackground("#0E0C0C", null, true)).toBe(
      "#121212",
    );
    expect(migrateLegacyWindowBackground("#141414", "dark", true)).toBe(
      "#121212",
    );
    expect(migrateLegacyWindowBackground("#131111", "system", false)).toBe(
      "#ffffff",
    );
    expect(migrateLegacyWindowBackground("#242424", "dark", true)).toBe(
      "#242424",
    );
    // Neutral Dark's own value maps to itself.
    expect(migrateLegacyWindowBackground("#121212", "dark", true)).toBe(
      "#121212",
    );
  });
});
