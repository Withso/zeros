import { describe, expect, it } from "vitest";
import { designMovementDelta, designParentDelta, designRelocatedBorderStyles } from "../design-movement-geometry";

describe("design movement coordinates", () => {
  it("keeps a world grab point beneath the pointer while the camera pans and zooms", () => {
    const start = { x: 128, y: 92 };
    const viewport = { left: 20, top: 30 };
    const grab = { x: 40, y: 20 };
    expect(designMovementDelta({ x: 154, y: 206 }, viewport, { panX: 50, panY: 120, zoom: 0.5 }, start, grab)).toEqual({ x: 0, y: 0 });
    expect(designMovementDelta({ x: 155, y: 206 }, viewport, { panX: 0, panY: 120, zoom: 0.5 }, start, grab)).toEqual({ x: 102, y: 0 });
    expect(designMovementDelta({ x: 356, y: 374 }, viewport, { panX: 0, panY: 120, zoom: 2 }, start, grab)).toEqual({ x: 0, y: 0 });
  });

  it("inverts the full parent linear map for a world-space nudge", () => {
    expect(designParentDelta([0, 2, -3, 0, 100, 50], { x: 1, y: 0 })).toEqual({ x: 0, y: -1 / 3 });
    expect(designParentDelta([-2, 0, 1, 3, 100, 50], { x: 8, y: 3 })).toEqual({ x: -3.5, y: 1 });
    expect(() => designParentDelta(null, { x: 1, y: 0 })).toThrow(/coordinates/);
    expect(() => designParentDelta([0, 0, 0, 0, 0, 0], { x: 1, y: 0 })).toThrow(/invertible/);
  });

  it("preserves the complete border transform and margins on reparenting", () => {
    const result = designRelocatedBorderStyles({
      border: [0, 2, -3, 1, 160, 180],
      parent: [2, 0, 0, 2, 100, 50],
      delta: { x: 60, y: 0 },
      margin: { x: 20, y: 5 },
    });
    expect(result).toEqual({ left: "40px", top: "60px", transform: "matrix(0,1,-1.5,0.5,0,0)", "transform-origin": "0 0", rotate: "none", scale: "none", translate: "none" });
  });
});
