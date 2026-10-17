import { describe, expect, it } from "vitest";

import {
  designThemeIdFromName,
  designThemeLabel,
  designThemeView,
  effectiveDesignTheme,
} from "../design-themes";

describe("Design theme names", () => {
  it("names the default theme and lists the others in the engine's order", () => {
    const view = designThemeView(
      [
        { id: "dark", label: "Dark", base: true },
        { id: "light", label: "Light" },
        { id: "sepia", label: "Sepia" },
      ],
      ["light", "amber"],
    );
    expect(view.baseId).toBe("dark");
    expect(view.baseLabel).toBe("Dark");
    expect(view.others).toEqual(["light", "sepia", "amber"]);
    expect(view.label(null)).toBe("Dark");
    expect(view.label("dark")).toBe("Dark");
    expect(view.label("light")).toBe("Light");
    expect(view.label("amber")).toBe("Amber");
  });

  it("keeps Base and the ids it is given when an older engine sends no names", () => {
    const view = designThemeView(undefined, ["light", "high-contrast"]);
    expect(view.baseId).toBeNull();
    expect(view.baseLabel).toBe("Base");
    expect(view.others).toEqual(["high-contrast", "light"]);
    expect(view.label("high-contrast")).toBe("High contrast");
  });

  it("ignores malformed names", () => {
    const view = designThemeView([
      { id: "Bad", label: "Bad", base: true },
      { id: "light", label: "  " },
    ] as never, ["light"]);
    expect(view.baseId).toBeNull();
    expect(view.others).toEqual(["light"]);
    expect(view.label("light")).toBe("Light");
  });

  it("shows the default theme when no other theme is chosen", () => {
    expect(effectiveDesignTheme(null, "dark")).toBe("dark");
    expect(effectiveDesignTheme("light", "dark")).toBe("light");
    expect(effectiveDesignTheme(null, null)).toBeNull();
  });

  it("derives a theme id from a display name", () => {
    expect(designThemeIdFromName("High contrast")).toBe("high-contrast");
    expect(designThemeIdFromName("  Dark  ")).toBe("dark");
    expect(designThemeIdFromName("Crème brûlée")).toBe("creme-brulee");
    expect(designThemeIdFromName("2024 brand")).toBe("brand");
    expect(designThemeIdFromName("🎨")).toBeNull();
    expect(designThemeLabel("brand_2")).toBe("Brand 2");
  });
});
