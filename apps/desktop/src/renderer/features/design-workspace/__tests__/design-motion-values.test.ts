import { describe, expect, it } from "vitest";

import {
  addDesignMotionPropertyKeyframe,
  designDurationMs,
  designMotionIterationCount,
  designMotionFirstListValue,
  designMotionEasingIsValid,
  designMotionNudgedOffset,
  designMotionOffsetAtTime,
  designMotionPlaybackStartOffset,
  designMotionPresetKeyframes,
  designMotionPreviewCurrentTime,
  designMotionRulerMarks,
  designMotionTimeAtOffset,
  designMotionTimeInputOffset,
  designMotionTranslationAtOffset,
  designMotionTranslationPoints,
  designMotionTracksAreValid,
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
  it("keeps functional easing commas inside the first CSS list item", () => {
    expect(
      designMotionFirstListValue(
        "cubic-bezier(0.22, 1, 0.36, 1), steps(4, end)",
      ),
    ).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(designMotionFirstListValue("300ms, 600ms")).toBe("300ms");
  });

  it("accepts authored CSS easing functions without permitting invalid timing", () => {
    expect(designMotionEasingIsValid("ease-out")).toBe(true);
    expect(designMotionEasingIsValid("cubic-bezier(0.22, 1, 0.36, 1)")).toBe(
      true,
    );
    expect(designMotionEasingIsValid("steps(5, end)")).toBe(true);
    expect(designMotionEasingIsValid("cubic-bezier(-0.1, 0, 1, 1)")).toBe(
      false,
    );
    expect(designMotionEasingIsValid("steps(0, end)")).toBe(false);
    expect(designMotionEasingIsValid("ease, linear")).toBe(false);
    expect(designMotionEasingIsValid("spring(1, 100, 10)")).toBe(false);
  });

  it("turns an inspector property into a valid timeline track at the playhead", () => {
    expect(
      addDesignMotionPropertyKeyframe(FRAMES, "border-radius", 40, "12px"),
    ).toEqual([
      {
        offset: 0,
        styles: {
          opacity: "0",
          transform: "translateY(8px)",
          "border-radius": "12px",
        },
      },
      { offset: 40, styles: { "border-radius": "12px" } },
      { offset: 50, styles: { opacity: ".5" } },
      {
        offset: 100,
        styles: {
          opacity: "1",
          transform: "translateY(0)",
          "border-radius": "12px",
        },
      },
    ]);
  });

  it("adds only the requested point when an inspector property already has a track", () => {
    expect(
      addDesignMotionPropertyKeyframe(FRAMES, "opacity", 25, "0.2"),
    ).toEqual([
      { offset: 0, styles: { opacity: "0", transform: "translateY(8px)" } },
      { offset: 25, styles: { opacity: "0.2" } },
      { offset: 50, styles: { opacity: ".5" } },
      {
        offset: 100,
        styles: { opacity: "1", transform: "translateY(0)" },
      },
    ]);
  });

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

  it("maps effect progress through positive and negative animation delays", () => {
    expect(designMotionPreviewCurrentTime(500, 1_000, 200)).toBe(700);
    expect(designMotionPreviewCurrentTime(1_500, 1_000, 200)).toBe(1_200);
    expect(designMotionPreviewCurrentTime(0, 1_000, -250)).toBe(-250);
  });

  it("builds readable, duration-aware millisecond ruler marks", () => {
    expect(designMotionRulerMarks(300)).toEqual([
      { time: 0, offset: 0 },
      { time: 100, offset: 33.3 },
      { time: 200, offset: 66.7 },
      { time: 300, offset: 100 },
    ]);
    expect(designMotionRulerMarks(1_000)).toEqual([
      { time: 0, offset: 0 },
      { time: 200, offset: 20 },
      { time: 400, offset: 40 },
      { time: 600, offset: 60 },
      { time: 800, offset: 80 },
      { time: 1_000, offset: 100 },
    ]);
  });

  it("converts precise timeline time and progress without escaping the effect", () => {
    expect(designMotionOffsetAtTime(75, 300)).toBe(25);
    expect(designMotionOffsetAtTime(-10, 300)).toBe(0);
    expect(designMotionOffsetAtTime(600, 300)).toBe(100);
    expect(designMotionTimeAtOffset(33.3, 300)).toBe(100);
    expect(designMotionTimeAtOffset(125, 300)).toBe(300);
  });

  it("restarts playback from the beginning after the playhead reaches the end", () => {
    expect(designMotionPlaybackStartOffset(100)).toBe(0);
    expect(designMotionPlaybackStartOffset(140)).toBe(0);
    expect(designMotionPlaybackStartOffset(72.34)).toBe(72.3);
    expect(designMotionPlaybackStartOffset(-4)).toBe(0);
  });

  it("does not turn a temporarily blank time field into the first frame", () => {
    expect(designMotionTimeInputOffset("", 400)).toBeNull();
    expect(designMotionTimeInputOffset("later", 400)).toBeNull();
    expect(designMotionTimeInputOffset("200", 400)).toBe(50);
    expect(designMotionTimeInputOffset("600", 400)).toBe(100);
  });

  it("nudges keyframes precisely with optional coarse keyboard steps", () => {
    expect(designMotionNudgedOffset(50, -1)).toBe(49);
    expect(designMotionNudgedOffset(50, 1, true)).toBe(60);
    expect(designMotionNudgedOffset(0, -1)).toBe(0);
    expect(designMotionNudgedOffset(99.5, 1)).toBe(100);
  });

  it("projects transform translation keyframes into an inline canvas path", () => {
    const motion = [
      { offset: 0, styles: { transform: "translateY(16px) scale(.96)" } },
      { offset: 50, styles: { transform: "translate(20px, 8px)" } },
      { offset: 100, styles: { transform: "none" } },
    ];
    expect(designMotionTranslationPoints(motion)).toEqual([
      { offset: 0, x: 0, y: 16 },
      { offset: 50, x: 20, y: 8 },
      { offset: 100, x: 0, y: 0 },
    ]);
    expect(designMotionTranslationAtOffset(motion, 75)).toEqual({
      x: 10,
      y: 4,
    });
  });

  it("reads individual translate and matrix values without inventing a path", () => {
    expect(
      designMotionTranslationPoints([
        { offset: 0, styles: { translate: "4px 8px" } },
        { offset: 100, styles: { translate: "20px 24px" } },
      ]),
    ).toEqual([
      { offset: 0, x: 4, y: 8 },
      { offset: 100, x: 20, y: 24 },
    ]);
    expect(
      designMotionTranslationPoints([
        { offset: 0, styles: { opacity: "0" } },
        { offset: 100, styles: { opacity: "1" } },
      ]),
    ).toEqual([]);
    expect(
      designMotionTranslationPoints([
        { offset: 0, styles: { transform: "scale(1)" } },
        { offset: 50, styles: { transform: "scale(1.04)" } },
        { offset: 100, styles: { transform: "scale(1)" } },
      ]),
    ).toEqual([]);
  });

  it("builds multi-property entrance and emphasis presets", () => {
    expect(designMotionPresetKeyframes("slide-up")).toEqual([
      {
        offset: 0,
        styles: { opacity: "0", transform: "translateY(24px)" },
      },
      { offset: 100, styles: { opacity: "1", transform: "none" } },
    ]);
    expect(designMotionPresetKeyframes("pulse")).toEqual([
      { offset: 0, styles: { transform: "scale(1)" } },
      { offset: 50, styles: { transform: "scale(1.04)" } },
      { offset: 100, styles: { transform: "scale(1)" } },
    ]);
  });

  it("requires at least two points on every property track", () => {
    expect(designMotionTracksAreValid(FRAMES)).toBe(true);
    expect(
      designMotionTracksAreValid(
        removeDesignMotionPoint(FRAMES, "transform", 100),
      ),
    ).toBe(false);
  });
});
