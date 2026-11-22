import { describe, expect, it } from "vitest";

import { cssOverlappingProperties, cssPropertiesOverlap, cssPropertyLonghands } from "../css-longhands";

describe("whether two CSS properties set the same thing", () => {
  it("matches a longhand to its shorthand in both directions", () => {
    for (const [shorthand, longhand] of [
      ["gap", "row-gap"], ["gap", "column-gap"], ["background", "background-color"], ["border-radius", "border-top-left-radius"],
      ["transition", "transition-duration"], ["padding", "padding-left"], ["inset", "top"], ["flex", "flex-basis"],
      ["font", "font-size"], ["border", "border-top-width"], ["border-width", "border-left-width"], ["background-position", "background-position-x"],
    ]) {
      expect(cssPropertiesOverlap(shorthand!, longhand!)).toBe(true);
      expect(cssPropertiesOverlap(longhand!, shorthand!)).toBe(true);
    }
    expect(cssPropertiesOverlap("border", "border-color")).toBe(true);
    expect(cssPropertiesOverlap("background", "background")).toBe(true);
  });

  it("keeps different properties apart", () => {
    for (const [a, b] of [["gap", "padding"], ["background", "color"], ["border-radius", "border-width"], ["row-gap", "column-gap"],
      ["width", "min-width"], ["transition", "animation"], ["--zd-gap", "gap"], ["--a", "--A"]])
      expect(cssPropertiesOverlap(a!, b!)).toBe(false);
    expect(cssPropertiesOverlap("--chip-round", "--chip-round")).toBe(true);
  });

  it("treats a logical property as either physical side, and sizes as their axis", () => {
    expect(cssPropertiesOverlap("inline-size", "width")).toBe(true);
    expect(cssPropertiesOverlap("block-size", "height")).toBe(true);
    expect(cssPropertiesOverlap("padding-inline", "padding-left")).toBe(true);
    expect(cssPropertiesOverlap("padding-inline", "padding-right")).toBe(true);
    expect(cssPropertiesOverlap("padding-inline", "padding-top")).toBe(false);
    expect(cssPropertiesOverlap("inset-inline", "left")).toBe(true);
    expect(cssPropertiesOverlap("margin-block", "margin-bottom")).toBe(true);
    expect(cssPropertiesOverlap("border-start-end-radius", "border-radius")).toBe(true);
    expect(cssPropertiesOverlap("border-inline-color", "border-left-color")).toBe(true);
    expect(cssPropertyLonghands("Row-Gap")).toEqual(new Set(["row-gap"]));
  });

  it("lists the keys of a record that a write overlaps", () => {
    expect(cssOverlappingProperties({ gap: ["gap"], color: ["ink"], "border-radius": ["radius"] }, "row-gap")).toEqual(["gap"]);
    expect(cssOverlappingProperties({ "border-top-left-radius": ["radius"], width: ["w"] }, "border-radius")).toEqual(["border-top-left-radius"]);
  });
});
