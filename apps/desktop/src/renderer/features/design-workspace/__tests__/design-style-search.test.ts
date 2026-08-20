import { describe, expect, it } from "vitest";

import { designStyleSearchSections } from "../design-style-search";

describe("design style property search", () => {
  it("finds controls by their exact CSS property names", () => {
    expect(designStyleSearchSections("box-sizing")).toEqual(["layout"]);
    expect(designStyleSearchSections("border-top-left-radius")).toEqual([
      "appearance",
    ]);
    expect(designStyleSearchSections("font-stretch")).toEqual(["typography"]);
    expect(designStyleSearchSections("transition-duration")).toEqual([
      "transition",
    ]);
  });

  it("supports multi-token intent and rejects unrelated properties", () => {
    expect(designStyleSearchSections("grid gap")).toEqual(["layout"]);
    expect(designStyleSearchSections("keyframes timeline")).toEqual(["motion"]);
    expect(designStyleSearchSections("definitely-not-a-property")).toEqual([]);
  });
});
