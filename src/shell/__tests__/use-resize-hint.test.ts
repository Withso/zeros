import { describe, expect, it } from "vitest";

import { computeHintPlacement } from "../use-resize-hint";

// The chip is 200×28 for these cases; the viewport is 1400×900 unless a case
// says otherwise. Constants baked into the placement: 14px gap above the
// pointer, 8px viewport margin, 22px (14+8) drop when it flips below.
const base = {
  width: 200,
  height: 28,
  viewportWidth: 1400,
  viewportHeight: 900,
};

describe("computeHintPlacement", () => {
  it("centres on and sits above the pointer with room to spare", () => {
    expect(computeHintPlacement({ ...base, x: 500, y: 500 })).toEqual({
      left: 400, // 500 − 200/2
      top: 458, // 500 − 14 − 28
    });
  });

  it("flips below the pointer when there isn't room above (top edge)", () => {
    expect(computeHintPlacement({ ...base, x: 500, y: 20 })).toEqual({
      left: 400,
      top: 42, // 20 + 14 + 8
    });
  });

  it("stays above at the exact boundary where it just fits", () => {
    // y − 14 − 28 === 8 → no flip.
    expect(computeHintPlacement({ ...base, x: 500, y: 50 })).toEqual({
      left: 400,
      top: 8,
    });
  });

  it("clamps to the left margin near the left edge", () => {
    expect(computeHintPlacement({ ...base, x: 40, y: 500 })).toEqual({
      left: 8, // clamped from 40 − 100 = −60
      top: 458,
    });
  });

  it("clamps to the right margin near the right edge", () => {
    expect(computeHintPlacement({ ...base, x: 1390, y: 500 })).toEqual({
      left: 1192, // 1400 − 8 − 200
      top: 458,
    });
  });
});
