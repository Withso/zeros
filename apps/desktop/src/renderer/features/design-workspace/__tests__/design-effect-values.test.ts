import { describe, expect, it } from "vitest";

import {
  formatDesignShadow,
  formatDesignTransform,
  parseDesignShadow,
  parseDesignTransform,
} from "../design-effect-values";

describe("design effect values", () => {
  it("parses and formats editable box and text shadows", () => {
    expect(
      parseDesignShadow("inset 4px 8px 16px 2px rgba(1, 2, 3, 0.5)"), // check:ui ignore-line (authored CSS fixture)
    ).toEqual({
      inset: true,
      x: 4,
      y: 8,
      blur: 16,
      spread: 2,
      color: "rgba(1, 2, 3, 0.5)", // check:ui ignore-line (authored CSS fixture)
    });
    expect(
      formatDesignShadow({
        inset: false,
        x: 0,
        y: 6,
        blur: 24,
        spread: 0,
        color: "#00000040", // check:ui ignore-line (authored CSS fixture)
      }),
    ).toBe("0px 6px 24px 0px #00000040"); // check:ui ignore-line (authored CSS fixture)
  });

  it("decomposes common transform functions and 2D matrices", () => {
    expect(
      parseDesignTransform(
        "translateX(12px) translateY(-4px) rotate(30deg) scale(1.2, 0.8)",
      ),
    ).toMatchObject({ x: 12, y: -4, rotate: 30, scaleX: 1.2, scaleY: 0.8 });
    expect(parseDesignTransform("matrix(0, 1, -1, 0, 20, 30)")).toMatchObject({
      x: 20,
      y: 30,
      rotate: 90,
      scaleX: 1,
      scaleY: 1,
    });
    expect(
      formatDesignTransform({
        x: 12,
        y: -4,
        rotate: 30,
        scaleX: 1.2,
        scaleY: 0.8,
        skewX: 0,
        skewY: 0,
      }),
    ).toBe("translate(12px, -4px) rotate(30deg) scale(1.2, 0.8)");
  });
});
