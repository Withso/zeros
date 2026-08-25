import { describe, expect, it } from "vitest";

import { designFrameLayoutIconKind } from "../design-layer-layout";

describe("design layer layout icons", () => {
  it("keeps block and hidden frames on the ordinary frame icon", () => {
    expect(designFrameLayoutIconKind({ display: "block" })).toBe("frame");
    expect(designFrameLayoutIconKind({ display: "none" })).toBe("frame");
  });

  it("distinguishes vertical and horizontal flex directions", () => {
    expect(
      designFrameLayoutIconKind({
        display: "flex",
        flexDirection: "column",
      }),
    ).toBe("flex-vertical");
    expect(
      designFrameLayoutIconKind({
        display: "inline-flex",
        flexDirection: "column-reverse",
      }),
    ).toBe("flex-vertical");
    expect(
      designFrameLayoutIconKind({ display: "flex", flexDirection: "row" }),
    ).toBe("flex-horizontal");
    expect(
      designFrameLayoutIconKind({
        display: "flex",
        flexDirection: "row-reverse",
      }),
    ).toBe("flex-horizontal");
  });

  it("uses the grid icon for grid and inline-grid frames", () => {
    expect(designFrameLayoutIconKind({ display: "grid" })).toBe("grid");
    expect(designFrameLayoutIconKind({ display: "inline-grid" })).toBe("grid");
  });
});
