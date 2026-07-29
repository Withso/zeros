// Shared motion model for the live Run audio wave. The reference GIF contains
// two nearly identical traveling passes in its four-second file; this version
// accelerates that motion to a 1.5-second pass. Twenty phase poses move a rounded
// cosine crest across five distinct spatial samples while every bottom endpoint
// remains fixed. A periodic Catmull–Rom spline keeps value and direction smooth.

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

const WAVE_BAR_X = [2.5, 6.25, 10, 13.75, 17.5] as const;
const WAVE_POSE_COUNT = 20;
const WAVE_MIN_SCALE = 0.35;
const WAVE_MAX_SCALE = 1;
const WAVE_START_CREST_BAR = 2;

function scaleForPose(barIndex: number, poseIndex: number): number {
  const midpoint = (WAVE_MIN_SCALE + WAVE_MAX_SCALE) / 2;
  const amplitude = (WAVE_MAX_SCALE - WAVE_MIN_SCALE) / 2;
  const phase =
    (barIndex - WAVE_START_CREST_BAR) / WAVE_BAR_X.length -
    poseIndex / WAVE_POSE_COUNT;

  return rounded(midpoint + amplitude * Math.cos(phase * Math.PI * 2));
}

const WAVE_BARS = WAVE_BAR_X.map((x, index) => ({
  x,
  rest: scaleForPose(index, 0),
}));

const WAVE_POSES = Array.from({ length: WAVE_POSE_COUNT }, (_, poseIndex) =>
  WAVE_BAR_X.map((_x, barIndex) => scaleForPose(barIndex, poseIndex)),
);

export const RUN_WAVE_MOTION = {
  cycleDurationMs: 1_500,
  poseDurationMs: 75,
  // Dense samples preserve the smooth contour at the faster cadence.
  subdivisionsPerPose: 3,
  bars: WAVE_BARS,
  poses: WAVE_POSES,
} as const;

/** The SVG uses non-scaling strokes, so this value is the visible CSS-pixel
 * weight at every icon size: 1px at 14px and 1.2px at 16px. */
export function runWaveStrokeWidth(size: number): number {
  const safeSize = Number.isFinite(size) && size > 0 ? size : 16;
  return rounded(Math.max(0.8, safeSize * 0.1 - 0.4));
}

function wrappedIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  progress: number,
): number {
  const progress2 = progress * progress;
  const progress3 = progress2 * progress;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * progress +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * progress2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * progress3)
  );
}

export function runWaveScaleAtProgress(
  barIndex: number,
  progress: number,
): number {
  const poseCount = RUN_WAVE_MOTION.poses.length;
  const safeBarIndex = Math.min(
    RUN_WAVE_MOTION.bars.length - 1,
    Math.max(0, Math.trunc(barIndex)),
  );
  const finiteProgress = Number.isFinite(progress) ? progress : 0;
  const wrappedProgress = ((finiteProgress % 1) + 1) % 1;
  const posePosition = wrappedProgress * poseCount;
  const p1Index = Math.floor(posePosition);
  const localProgress = posePosition - p1Index;
  const p0 = RUN_WAVE_MOTION.poses[wrappedIndex(p1Index - 1, poseCount)];
  const p1 = RUN_WAVE_MOTION.poses[wrappedIndex(p1Index, poseCount)];
  const p2 = RUN_WAVE_MOTION.poses[wrappedIndex(p1Index + 1, poseCount)];
  const p3 = RUN_WAVE_MOTION.poses[wrappedIndex(p1Index + 2, poseCount)];

  return catmullRom(
    p0[safeBarIndex],
    p1[safeBarIndex],
    p2[safeBarIndex],
    p3[safeBarIndex],
    localProgress,
  );
}

export const RUN_WAVE_SAMPLE_COUNT =
  RUN_WAVE_MOTION.poses.length * RUN_WAVE_MOTION.subdivisionsPerPose;

function smilNumber(value: number): string {
  return value.toFixed(6).replace(/(?:\.0+|(\.\d+?)0+)$/, "$1");
}

export const RUN_WAVE_KEY_TIMES = Array.from(
  { length: RUN_WAVE_SAMPLE_COUNT + 1 },
  (_, sample) =>
    sample === RUN_WAVE_SAMPLE_COUNT
      ? "1"
      : smilNumber(sample / RUN_WAVE_SAMPLE_COUNT),
).join(";");

export const RUN_WAVE_BAR_VALUES = RUN_WAVE_MOTION.bars.map((_bar, barIndex) =>
  Array.from({ length: RUN_WAVE_SAMPLE_COUNT + 1 }, (_, sample) => {
    const progress = sample / RUN_WAVE_SAMPLE_COUNT;
    return `1 ${smilNumber(runWaveScaleAtProgress(barIndex, progress))}`;
  }).join(";"),
);
