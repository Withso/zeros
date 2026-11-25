import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  readThemes,
  resolveRgb,
} from "../../../../../../../scripts/design-system/token-palette.mjs";

const themes = readThemes();

describe("Local pill theme contract", () => {
  // P13: the workspace link rests on accent-bg on the composer (bg1-raised)
  // and in the agent chat (bg1), and on accent-bg-hover inside a sent message,
  // where accent-bg sits too close to the bg2 bubble.
  it("keeps the workspace link a visible blue on each ground with readable text", () => {
    for (const theme of [themes.dark, themes.light]) {
      for (const [ground, fill] of [["bg1", "accent-bg"], ["bg1-raised", "accent-bg"], ["bg2", "accent-bg-hover"]]) {
        expect(contrastRatio(resolveRgb(theme, fill), resolveRgb(theme, ground)), `${fill} on ${ground}`).toBeGreaterThanOrEqual(1.1);
        expect(contrastRatio(resolveRgb(theme, "accent-on-bg"), resolveRgb(theme, fill))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("removes the unused per-agent pill tints", () => {
    for (const theme of Object.values(themes)) {
      expect([...theme.keys()].filter((name) => /^agent-(claude|codex)-/.test(name))).toEqual([]);
    }
  });
});
