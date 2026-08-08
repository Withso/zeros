import { describe, expect, it } from "vitest";

import {
  designDurationMs,
  designMotionIterationCount,
  moveDesignMotionPoint,
  removeDesignMotionPoint,
  sampleDesignMotionStyles,
  setDesignMotionPoint,
  type DesignMotionKeyframe,
} from "../design-motion-values";

const FRAMES: DesignMotionKeyframe[] = [
  { offset: 0, styles: { opacity: "0", transform: "translateY(8px)" } },
  { offset: 50, styles: { opacity: ".5" } },
  { offset: 100, styles: { opacity: "1", transform: "translateY(0)" } },
];

describe("design motion timeline values", () => {
  it("moves one property point without moving unrelated tracks", () => {
    expect(moveDesignMotionPoint(FRAMES, "opacity", 50, 75)).toEqual([
      { offset: 0, styles: { opacity: "0", transform: "translateY(8px)" } },
      { offset: 75, styles: { opacity: ".5" } },
      {
        offset: 100,
        styles: { opacity: "1", transform: "translateY(0)" },
      },
    ]);
  });

  it("merges, replaces, and removes individual property points", () => {
    const added = setDesignMotionPoint(FRAMES, "scale", 50, ".96");
    expect(added[1]).toEqual({
      offset: 50,
      styles: { opacity: ".5", scale: ".96" },
    });
    expect(removeDesignMotionPoint(added, "opacity", 50)).toEqual([
      FRAMES[0],
      { offset: 50, styles: { scale: ".96" } },
      FRAMES[2],
    ]);
  });

  it("interpolates compatible numeric values for unsaved scrubbing", () => {
    expect(sampleDesignMotionStyles(FRAMES, 25)).toMatchObject({
      opacity: "0.25",
      transform: "translateY(8px)",
    });
    expect(sampleDesignMotionStyles(FRAMES, 75).opacity).toBe("0.75");
  });

  it("rejects zero or malformed durations when the caller supplies no fallback", () => {
    expect(designDurationMs("0ms", 0)).toBe(0);
    expect(designDurationMs("0s", 0)).toBe(0);
    expect(designDurationMs("later", 0)).toBe(0);
    expect(designDurationMs(".25s", 0)).toBe(250);
    expect(designDurationMs("120000ms", 0)).toBe(60_000);
  });

  it("distinguishes finite animation counts from an infinite preview", () => {
    expect(designMotionIterationCount("1")).toBe(1);
    expect(designMotionIterationCount("2.5")).toBe(2.5);
    expect(designMotionIterationCount("infinite")).toBe(Infinity);
    expect(designMotionIterationCount("-1")).toBeNull();
    expect(designMotionIterationCount("many")).toBeNull();
  });
});
