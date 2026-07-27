import { describe, expect, it } from "vitest";

import {
  STORY_SHIMMER_FRAME_COUNT,
  STORY_SHIMMER_MICRO_DEFAULTS,
  STORY_SHIMMER_MOTION_DEFAULTS,
  STORY_SHIMMER_POSES,
  STORY_SHIMMER_SCENE_COUNT,
  STORY_SHIMMER_SCENE_FRAME_COUNT,
  STORY_SHIMMER_TRANSITIONS,
  STORY_SHIMMER_VIEW_SIZE,
  storyShimmerProjection,
} from "../../loaders/story-shimmer-motion";

describe("Story shimmer motion", () => {
  it("uses the approved loader tuning", () => {
    expect(STORY_SHIMMER_MOTION_DEFAULTS).toEqual({
      cycleDurationMs: 8000,
      dotRadius: 0.4,
      dotScale: 1,
      frameBlend: true,
      shimmerIntensity: 0.9,
      speed: 1,
    });
    expect(STORY_SHIMMER_MICRO_DEFAULTS).toEqual({
      cssSizePx: 24,
      maxMicroCssSizePx: 32,
      minimumMicroCssRadiusPx: 0.36,
      minimumPhysicalRadiusPx: 0.52,
    });
  });

  it("expands five 12×12 scenes into a 100-frame loop", () => {
    expect(STORY_SHIMMER_SCENE_COUNT).toBe(5);
    expect(STORY_SHIMMER_SCENE_FRAME_COUNT).toBe(20);
    expect(STORY_SHIMMER_FRAME_COUNT).toBe(
      STORY_SHIMMER_SCENE_COUNT * STORY_SHIMMER_SCENE_FRAME_COUNT,
    );
    expect(STORY_SHIMMER_POSES).toHaveLength(STORY_SHIMMER_FRAME_COUNT);
    expect(STORY_SHIMMER_TRANSITIONS).toHaveLength(STORY_SHIMMER_FRAME_COUNT);
  });

  it("keeps every frame inside the 12-unit view with sane dot budgets", () => {
    const half = STORY_SHIMMER_VIEW_SIZE / 2;
    for (const pose of STORY_SHIMMER_POSES) {
      // Enough dots to read a silhouette, few enough to stay minimal.
      expect(pose.length).toBeGreaterThanOrEqual(15);
      expect(pose.length).toBeLessThanOrEqual(70);
      for (const dot of pose) {
        expect(Math.abs(dot.x)).toBeLessThanOrEqual(half);
        expect(Math.abs(dot.y)).toBeLessThanOrEqual(half);
        expect(dot.alpha).toBeGreaterThan(0);
        expect(dot.alpha).toBeLessThanOrEqual(1);
        expect(dot.radius).toBeGreaterThan(0);
      }
    }
  });

  it("closes every transition, including the final-to-first seam", () => {
    for (let index = 0; index < STORY_SHIMMER_FRAME_COUNT; index += 1) {
      const from = new Map(
        STORY_SHIMMER_POSES[index].map((dot) => [`${dot.x}:${dot.y}`, dot]),
      );
      const to = new Map(
        STORY_SHIMMER_POSES[(index + 1) % STORY_SHIMMER_FRAME_COUNT].map(
          (dot) => [`${dot.x}:${dot.y}`, dot],
        ),
      );
      const transition = STORY_SHIMMER_TRANSITIONS[index];
      expect(transition.length).toBeGreaterThan(0);

      for (const dot of transition) {
        const key = `${dot.x}:${dot.y}`;
        expect(dot.fromAlpha).toBe(from.get(key)?.alpha ?? 0);
        expect(dot.toAlpha).toBe(to.get(key)?.alpha ?? 0);
        expect(dot.fromAlpha).toBeGreaterThanOrEqual(0);
        expect(dot.fromAlpha).toBeLessThanOrEqual(1);
        expect(dot.toAlpha).toBeGreaterThanOrEqual(0);
        expect(dot.toAlpha).toBeLessThanOrEqual(1);
      }
    }
  });

  it("sweeps the highlight band fully across every silhouette", () => {
    // The per-scene highlight center travels −0.22 → 1.22; every dot's
    // projection must fall inside that sweep so no dot is skipped.
    for (const pose of STORY_SHIMMER_POSES) {
      for (const dot of pose) {
        const projection = storyShimmerProjection(dot.x, dot.y);
        expect(projection).toBeGreaterThan(-0.22);
        expect(projection).toBeLessThan(1.22);
      }
    }
  });
});
