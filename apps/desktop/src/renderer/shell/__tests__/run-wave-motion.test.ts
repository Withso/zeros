import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const runWave = require(
  resolve(process.cwd(), "styles/Artifacts/run-wave/run-wave.js"),
) as {
  RUN_WAVE_MOTION: {
    cycleDurationMs: number;
    poseDurationMs: number;
    subdivisionsPerPose: number;
    bars: Array<{ x: number; rest: number }>;
    poses: number[][];
  };
  buildStyleText: () => string;
  scaleAtProgress: (barIndex: number, progress: number) => number;
  visibleStrokeWidthForSize: (size: number) => number;
};

describe("Run audio-wave motion", () => {
  it("uses the approved true-size stroke weights", () => {
    expect(runWave.visibleStrokeWidthForSize(14)).toBe(1);
    expect(runWave.visibleStrokeWidthForSize(16)).toBe(1.2);
  });

  it("uses the approved faster traveling pass", () => {
    expect(runWave.RUN_WAVE_MOTION.cycleDurationMs).toBe(1500);
    expect(runWave.RUN_WAVE_MOTION.poseDurationMs).toBe(75);
    expect(runWave.RUN_WAVE_MOTION.subdivisionsPerPose).toBe(3);
    expect(runWave.RUN_WAVE_MOTION.bars).toHaveLength(5);
    expect(runWave.RUN_WAVE_MOTION.bars.map((bar) => bar.x)).toEqual([
      2.5, 6.25, 10, 13.75, 17.5,
    ]);
    expect(runWave.RUN_WAVE_MOTION.poses).toHaveLength(20);
    expect(runWave.RUN_WAVE_MOTION.cycleDurationMs).toBe(
      runWave.RUN_WAVE_MOTION.poseDurationMs *
        runWave.RUN_WAVE_MOTION.poses.length,
    );
    expect(
      runWave.RUN_WAVE_MOTION.poses.every((pose) => pose.length === 5),
    ).toBe(true);
    expect("bpm" in runWave.RUN_WAVE_MOTION).toBe(false);
    expect("measures" in runWave.RUN_WAVE_MOTION).toBe(false);

    const css = runWave.buildStyleText();
    expect(css.match(/@keyframes/g)).toHaveLength(5);
    expect(css).toContain("animation-duration:1500ms");
    expect(css).toContain("animation-timing-function:linear");
    expect(css).toContain("transform-origin:center bottom");
    expect(css).toContain(".run-wave-bar--4");
  });

  it("moves one coherent rounded contour across the fixed baseline", () => {
    for (const pose of runWave.RUN_WAVE_MOTION.poses) {
      expect(Math.max(...pose) - Math.min(...pose)).toBeGreaterThan(0.5);
    }

    const signatures = runWave.RUN_WAVE_MOTION.poses.map((pose) =>
      pose.join(","),
    );
    expect(new Set(signatures)).toHaveLength(20);
  });

  it("advances the waveform by one bar every four poses", () => {
    const poses = runWave.RUN_WAVE_MOTION.poses;
    const bars = runWave.RUN_WAVE_MOTION.bars;

    for (let poseIndex = 0; poseIndex < poses.length; poseIndex += 1) {
      for (let barIndex = 0; barIndex < bars.length; barIndex += 1) {
        const shiftedPose = poses[(poseIndex + 4) % poses.length];
        const shiftedBar = (barIndex + 1) % bars.length;

        expect(shiftedPose[shiftedBar]).toBeCloseTo(
          poses[poseIndex][barIndex],
          6,
        );
      }
    }
  });

  it("moves every top endpoint through one smooth rise and fall", () => {
    for (
      let barIndex = 0;
      barIndex < runWave.RUN_WAVE_MOTION.bars.length;
      barIndex += 1
    ) {
      const directions = runWave.RUN_WAVE_MOTION.poses.map((pose, poseIndex) =>
        Math.sign(
          runWave.RUN_WAVE_MOTION.poses[
            (poseIndex + 1) % runWave.RUN_WAVE_MOTION.poses.length
          ][barIndex] - pose[barIndex],
        ),
      );
      const directionChanges = directions.filter(
        (direction, index) =>
          direction !==
          directions[(index + directions.length - 1) % directions.length],
      ).length;

      expect(directionChanges).toBe(2);
      expect(
        Math.min(
          ...runWave.RUN_WAVE_MOTION.poses.map((pose) => pose[barIndex]),
        ),
      ).toBe(0.35);
      expect(
        Math.max(
          ...runWave.RUN_WAVE_MOTION.poses.map((pose) => pose[barIndex]),
        ),
      ).toBe(1);
    }
  });

  it("closes every wave curve at the full-loop seam", () => {
    const derivativeStep = 0.000001;

    for (
      let barIndex = 0;
      barIndex < runWave.RUN_WAVE_MOTION.bars.length;
      barIndex += 1
    ) {
      const start = runWave.scaleAtProgress(barIndex, 0);
      const end = runWave.scaleAtProgress(barIndex, 1);
      const outgoing =
        (runWave.scaleAtProgress(barIndex, derivativeStep) - start) /
        derivativeStep;
      const incoming =
        (end - runWave.scaleAtProgress(barIndex, 1 - derivativeStep)) /
        derivativeStep;

      expect(end).toBe(start);
      expect(Math.abs(outgoing - incoming)).toBeLessThan(0.001);
    }
  });
});
