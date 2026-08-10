import { describe, expect, it } from "vitest";

import {
  formatDesignColor,
  formatDesignColorNotation,
  hsvaToRgba,
  parseDesignColor,
  rgbaToHsva,
} from "../design-color-values";

describe("design color values", () => {
  it("parses common authored and computed CSS color formats", () => {
    expect(parseDesignColor("transparent")).toEqual({
      r: 0,
      g: 0,
      b: 0,
      a: 0,
    });
    // check:ui ignore-next -- parser fixture must exercise literal hex input.
    expect(parseDesignColor("#33669980")).toEqual({
      r: 51,
      g: 102,
      b: 153,
      a: 128 / 255,
    });
    // check:ui ignore-next -- parser fixture must exercise literal rgba input.
    expect(parseDesignColor("rgba(10, 20, 30, 0.25)")).toEqual({
      r: 10,
      g: 20,
      b: 30,
      a: 0.25,
    });
    // check:ui ignore-next -- parser fixture must exercise literal hsl input.
    expect(parseDesignColor("hsl(120 100% 25% / 50%)")).toEqual({
      r: 0,
      g: 128,
      b: 0,
      a: 0.5,
    });
    // check:ui ignore-next -- malformed parser fixture must include literal rgb.
    expect(parseDesignColor("rgb(10 20 30 / 50% / ignored)")).toBeNull();
  });

  it("round-trips hue, saturation, value, and alpha without drift", () => {
    const rgba = { r: 88, g: 34, b: 221, a: 0.42 };
    const roundTrip = hsvaToRgba(rgbaToHsva(rgba));
    expect(roundTrip.r).toBeCloseTo(rgba.r, 5);
    expect(roundTrip.g).toBeCloseTo(rgba.g, 5);
    expect(roundTrip.b).toBeCloseTo(rgba.b, 5);
    expect(roundTrip.a).toBeCloseTo(rgba.a, 5);
  });

  it("formats opaque and translucent colors without losing alpha", () => {
    // check:ui ignore-next -- formatter assertion intentionally verifies CSS hex output.
    expect(formatDesignColor({ r: 255, g: 0, b: 170, a: 1 })).toBe("#FF00AA");
    expect(formatDesignColor({ r: 255, g: 0, b: 170, a: 0.5 })).toBe(
      // check:ui ignore-next -- formatter assertion intentionally verifies alpha hex output.
      "#FF00AA80",
    );
  });

  it("makes the color editor notation selector produce real CSS formats", () => {
    const color = { r: 255, g: 0, b: 170, a: 0.5 };
    // check:ui ignore-next -- formatter assertion intentionally verifies alpha hex output.
    expect(formatDesignColorNotation(color, "hex")).toBe("#FF00AA80");
    expect(formatDesignColorNotation(color, "rgb")).toBe(
      // check:ui ignore-next -- formatter assertion intentionally verifies CSS rgb output.
      "rgb(255 0 170 / 0.5)",
    );
    expect(formatDesignColorNotation(color, "hsl")).toBe(
      // check:ui ignore-next -- formatter assertion intentionally verifies CSS hsl output.
      "hsl(320 100% 50% / 0.5)",
    );
  });
});
