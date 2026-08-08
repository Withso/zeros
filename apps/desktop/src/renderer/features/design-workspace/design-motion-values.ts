// Pure timeline transforms shared by motion UI and regression tests.

export interface DesignMotionKeyframe {
  offset: number;
  styles: Readonly<Record<string, string>>;
}

export interface DesignMotionPoint {
  property: string;
  offset: number;
  value: string;
}

function boundedOffset(offset: number): number {
  return Math.round(Math.min(100, Math.max(0, offset)) * 10) / 10;
}

function normalizedFrames(
  keyframes: readonly DesignMotionKeyframe[],
): DesignMotionKeyframe[] {
  const byOffset = new Map<number, Record<string, string>>();
  for (const keyframe of keyframes) {
    const offset = boundedOffset(keyframe.offset);
    const styles = byOffset.get(offset) ?? {};
    Object.assign(styles, keyframe.styles);
    if (Object.keys(styles).length > 0) byOffset.set(offset, styles);
  }
  return [...byOffset.entries()]
    .sort(([left], [right]) => left - right)
    .map(([offset, styles]) => ({ offset, styles }));
}

export function designMotionPoints(
  keyframes: readonly DesignMotionKeyframe[],
): DesignMotionPoint[] {
  return normalizedFrames(keyframes).flatMap((keyframe) =>
    Object.entries(keyframe.styles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([property, value]) => ({
        property,
        offset: keyframe.offset,
        value,
      })),
  );
}

export function designMotionProperties(
  keyframes: readonly DesignMotionKeyframe[],
): string[] {
  return [
    ...new Set(designMotionPoints(keyframes).map((point) => point.property)),
  ].sort();
}

export function setDesignMotionPoint(
  keyframes: readonly DesignMotionKeyframe[],
  property: string,
  offset: number,
  value: string,
): DesignMotionKeyframe[] {
  const frames = normalizedFrames(keyframes);
  const exactOffset = boundedOffset(offset);
  const current = frames.find((keyframe) => keyframe.offset === exactOffset);
  if (current) {
    return frames.map((keyframe) =>
      keyframe === current
        ? { ...keyframe, styles: { ...keyframe.styles, [property]: value } }
        : keyframe,
    );
  }
  return normalizedFrames([
    ...frames,
    { offset: exactOffset, styles: { [property]: value } },
  ]);
}

export function removeDesignMotionPoint(
  keyframes: readonly DesignMotionKeyframe[],
  property: string,
  offset: number,
): DesignMotionKeyframe[] {
  const exactOffset = boundedOffset(offset);
  return normalizedFrames(
    keyframes.flatMap((keyframe) => {
      if (boundedOffset(keyframe.offset) !== exactOffset) return [keyframe];
      const styles = { ...keyframe.styles };
      delete styles[property];
      return Object.keys(styles).length > 0 ? [{ ...keyframe, styles }] : [];
    }),
  );
}

export function moveDesignMotionPoint(
  keyframes: readonly DesignMotionKeyframe[],
  property: string,
  fromOffset: number,
  toOffset: number,
): DesignMotionKeyframe[] {
  const point = designMotionPoints(keyframes).find(
    (candidate) =>
      candidate.property === property &&
      candidate.offset === boundedOffset(fromOffset),
  );
  if (!point) return normalizedFrames(keyframes);
  return setDesignMotionPoint(
    removeDesignMotionPoint(keyframes, property, fromOffset),
    property,
    toOffset,
    point.value,
  );
}

function numericCssValue(
  value: string,
): { number: number; unit: string } | null {
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))([a-z%]*)$/i.exec(value.trim());
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  return Number.isFinite(number)
    ? { number, unit: match[2]?.toLowerCase() ?? "" }
    : null;
}

function interpolatedValue(
  from: string,
  to: string,
  progress: number,
): string | null {
  const left = numericCssValue(from);
  const right = numericCssValue(to);
  if (!left || !right || left.unit !== right.unit) return null;
  const value = left.number + (right.number - left.number) * progress;
  const rounded = Math.round(value * 10_000) / 10_000;
  return `${Object.is(rounded, -0) ? 0 : rounded}${left.unit}`;
}

/** Samples a draft without requiring its keyframes to exist in the iframe yet.
 * CSS-simple numeric values interpolate; complex values hold the previous key. */
export function sampleDesignMotionStyles(
  keyframes: readonly DesignMotionKeyframe[],
  offset: number,
): Record<string, string> {
  const target = boundedOffset(offset);
  const styles: Record<string, string> = {};
  for (const property of designMotionProperties(keyframes)) {
    const points = designMotionPoints(keyframes).filter(
      (point) => point.property === property,
    );
    const exact = points.find((point) => point.offset === target);
    if (exact) {
      styles[property] = exact.value;
      continue;
    }
    const before = [...points].reverse().find((point) => point.offset < target);
    const after = points.find((point) => point.offset > target);
    if (!before && after) styles[property] = after.value;
    else if (before && !after) styles[property] = before.value;
    else if (before && after) {
      styles[property] =
        interpolatedValue(
          before.value,
          after.value,
          (target - before.offset) / (after.offset - before.offset),
        ) ?? before.value;
    }
  }
  return styles;
}

export function designDurationMs(value: string, fallback = 300): number {
  const match = /^((?:\d+(?:\.\d+)?|\.\d+))(ms|s)$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return fallback;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return fallback;
  const milliseconds = match[2].toLowerCase() === "s" ? amount * 1_000 : amount;
  if (milliseconds <= 0) return fallback;
  return Math.min(60_000, Math.max(1, milliseconds));
}

/** Parse CSS animation-iteration-count while preserving the distinction that
 * lets timeline playback stop for finite motion and loop only for `infinite`. */
export function designMotionIterationCount(value: string): number | null {
  const source = value.trim().toLocaleLowerCase();
  if (source === "infinite") return Infinity;
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(source)) return null;
  const count = Number(source);
  return Number.isFinite(count) && count >= 0 ? Math.min(1_000, count) : null;
}
