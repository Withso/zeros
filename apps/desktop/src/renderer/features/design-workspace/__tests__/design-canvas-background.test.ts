import { describe, expect, it } from "vitest";

import {
  designCanvasBackgroundPresentation,
  normalizeDesignCanvasBackground,
  resolveDesignCanvasDefaultBackground,
} from "../design-canvas-background";

describe("design canvas background", () => {
  it("normalizes a persisted workspace color without losing opacity", () => {
    // check:ui ignore-next -- authored canvas-color fixture.
    expect(normalizeDesignCanvasBackground("rgb(51 102 153 / 0.5)")).toBe(
      // check:ui ignore-next -- canonical authored canvas-color assertion.
      "#33669980",
    );
    expect(normalizeDesignCanvasBackground("not a color")).toBeNull();
    expect(normalizeDesignCanvasBackground(null)).toBeNull();
  });

  it("presents the opaque hex and opacity used by the Page row", () => {
    // check:ui ignore-next -- authored canvas-color fixture.
    expect(designCanvasBackgroundPresentation("#33669980")).toEqual({
      hex: "336699",
      opacity: 50,
    });
  });

  it("resolves the default from the current --bg2 token", () => {
    // check:ui ignore-next -- simulated computed value of the --bg2 token.
    expect(resolveDesignCanvasDefaultBackground(() => "hsl(0 0% 13%)")).toBe(
      // check:ui ignore-next -- exact token-resolution assertion.
      "#212121",
    );
    expect(resolveDesignCanvasDefaultBackground(() => "invalid")).toBe(
      // check:ui ignore-next -- runtime fallback assertion.
      "#212121",
    );
  });
});
