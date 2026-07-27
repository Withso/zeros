import { describe, expect, it } from "vitest";

import {
  RUN_HORSE_FRAME_COUNT,
  RUN_HORSE_KEY_POSE_COUNT,
  RUN_HORSE_MICRO_DEFAULTS,
  RUN_HORSE_MOTION_DEFAULTS,
  RUN_HORSE_POSES,
  RUN_HORSE_SUBDIVISION,
  RUN_HORSE_TRANSITIONS,
  isRunHorseMicroDot,
} from "../../loaders/run-horse-motion";

describe("Run horse shimmer motion", () => {
  it("uses the approved loader tuning", () => {
    expect(RUN_HORSE_MOTION_DEFAULTS).toEqual({
      cycleDurationMs: 1760,
      dotScale: 1.2,
      frameBlend: true,
      glitterStrength: 0,
      speed: 0.8,
    });
    expect(RUN_HORSE_MICRO_DEFAULTS).toEqual({
      cssSizePx: 28,
      dotDensity: 0.5,
      minimumPhysicalRadiusPx: 0.55,
    });
  });

  it("uses a stable half-density lattice for the micro-loader", () => {
    const sample = Array.from({ length: 20 }, (_, y) =>
      Array.from({ length: 20 }, (_, x) => isRunHorseMicroDot(x, y)),
    ).flat();

    expect(sample.filter(Boolean)).toHaveLength(200);
    expect(isRunHorseMicroDot(-14, -10)).toBe(true);
    expect(isRunHorseMicroDot(-13, -10)).toBe(false);

    for (const transition of RUN_HORSE_TRANSITIONS) {
      const visible = transition.filter(
        (dot) => Math.max(dot.from, dot.to) >= 0.018,
      );
      const microDots = visible.filter((dot) =>
        isRunHorseMicroDot(dot.x, dot.y),
      );
      expect(microDots.length / visible.length).toBeGreaterThan(0.45);
      expect(microDots.length / visible.length).toBeLessThan(0.55);
    }
  });

  it("expands 11 traced poses into 33 non-empty motion frames", () => {
    expect(RUN_HORSE_KEY_POSE_COUNT).toBe(11);
    expect(RUN_HORSE_SUBDIVISION).toBe(3);
    expect(RUN_HORSE_FRAME_COUNT).toBe(33);
    expect(RUN_HORSE_POSES).toHaveLength(RUN_HORSE_FRAME_COUNT);
    expect(RUN_HORSE_TRANSITIONS).toHaveLength(RUN_HORSE_FRAME_COUNT);
    expect(RUN_HORSE_POSES.every((pose) => pose.size > 0)).toBe(true);
  });

  it("closes every transition, including the final-to-first seam", () => {
    for (let index = 0; index < RUN_HORSE_FRAME_COUNT; index += 1) {
      const from = RUN_HORSE_POSES[index];
      const to = RUN_HORSE_POSES[(index + 1) % RUN_HORSE_FRAME_COUNT];
      const transition = RUN_HORSE_TRANSITIONS[index];
      expect(transition.length).toBeGreaterThan(0);

      for (const dot of transition) {
        const key = `${dot.x}:${dot.y}`;
        expect(dot.from).toBe(from.get(key) ?? 0);
        expect(dot.to).toBe(to.get(key) ?? 0);
        expect(dot.from).toBeGreaterThanOrEqual(0);
        expect(dot.from).toBeLessThanOrEqual(1);
        expect(dot.to).toBeGreaterThanOrEqual(0);
        expect(dot.to).toBeLessThanOrEqual(1);
      }
    }
  });
});
