import { describe, expect, it } from "vitest";

import { nextFrameGeometry } from "../frame-metadata";

describe("automatic frame placement", () => {
  it("keeps the three-column grid for ordinary canvases", () => {
    const existing = [0, 1, 2, 3].map((index) => ({
      x: 0,
      y: 0,
      w: 1_440,
      h: 900,
      z: index,
    }));
    expect(nextFrameGeometry(existing, { width: 1_440, height: 900 })).toEqual({
      x: 1_560,
      y: 1_020,
      w: 1_440,
      h: 900,
      z: 4,
    });
  });

  it("stays within the storable coordinates below the frame-count limit", () => {
    // 183 frames with one at the tallest storable height: the three-column
    // grid would place the next frame at y = 61 × 16,504 = 1,006,744.
    const existing = Array.from({ length: 183 }, (_, index) => ({
      x: 0,
      y: 0,
      w: 1_440,
      h: index === 0 ? 16_384 : 900,
      z: index,
    }));
    for (const count of [183, 255]) {
      const placed = nextFrameGeometry(existing.slice(0, count).concat(
        Array.from({ length: Math.max(0, count - 183) }, (_, index) => ({
          x: 0,
          y: 0,
          w: 1_440,
          h: 900,
          z: 183 + index,
        })),
      ), { width: 1_440, height: 900 });
      expect(Math.abs(placed.x)).toBeLessThanOrEqual(1_000_000);
      expect(Math.abs(placed.y)).toBeLessThanOrEqual(1_000_000);
    }
  });
});
