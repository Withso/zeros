import { describe, expect, it } from "vitest";

import { designStyleSectionOrder } from "../design-style-sections";

describe("Style panel section order", () => {
  it("puts Typography before Fill on a text layer, as drawn", () => {
    expect(designStyleSectionOrder("text")).toEqual([
      "position", "layout", "appearance", "typography", "fill", "stroke",
      "shadow", "blur", "transform", "transition", "motion", "more-styles", "export",
    ]);
  });

  it("puts Fill before Typography on any other layer", () => {
    expect(designStyleSectionOrder("other")).toEqual([
      "position", "layout", "appearance", "fill", "typography", "stroke",
      "shadow", "blur", "transform", "transition", "motion", "more-styles", "export",
    ]);
  });

  it("returns one stable list per kind", () => {
    expect(designStyleSectionOrder("text")).toBe(designStyleSectionOrder("text"));
  });
});
