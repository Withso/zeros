import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  readThemes,
  resolveRgb,
} from "../../../../../../../scripts/design-system/token-palette.mjs";

const themes = readThemes();

describe("Local pill theme contract", () => {
  it("makes the light workspace fill distinct on the real composer and bubble surfaces", () => {
    const fill = resolveRgb(themes.light, themes.light.has("blue-pill-bg") ? "blue-pill-bg" : "blue-bg");
    // The fill is supplemental: readable text and the workspace glyph identify it.
    expect(contrastRatio(fill, resolveRgb(themes.light, "bg2"))).toBeGreaterThanOrEqual(1.25);
    expect(contrastRatio(fill, resolveRgb(themes.light, "highlighted-bg"))).toBeGreaterThanOrEqual(1.2);
    expect(contrastRatio(fill, resolveRgb(themes.light, "blue-fg"))).toBeGreaterThanOrEqual(4.5);
  });

  it("preserves the exact dark workspace colors", () => {
    expect(resolveRgb(themes.dark, "blue-pill-bg")).toEqual(resolveRgb(themes.dark, "blue-bg"));
    expect(resolveRgb(themes.dark, "blue-pill-hover")).toEqual([26, 43, 96].map((c) => c / 255));
    expect(resolveRgb(themes.dark, "blue-fg")).toEqual([145, 197, 253].map((c) => c / 255));
  });

  it("removes the unused per-agent pill tints", () => {
    for (const theme of Object.values(themes)) {
      expect([...theme.keys()].filter((name) => /^agent-(claude|codex)-/.test(name))).toEqual([]);
    }
  });
});
