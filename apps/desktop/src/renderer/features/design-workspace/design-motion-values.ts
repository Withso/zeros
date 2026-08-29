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

export interface DesignMotionRulerMark {
  time: number;
  offset: number;
}

export interface DesignMotionTranslationPoint {
  offset: number;
  x: number;
  y: number;
}

export type DesignMotionPresetId =
  | "fade-in"
  | "slide-up"
  | "slide-down"
  | "slide-left"
  | "slide-right"
  | "scale-in"
  | "blur-in"
  | "pulse"
  | "spin";

/** Read the first value from a comma-separated CSS list without treating
 * commas inside functions (cubic-bezier, steps, linear, var) as separators. */
export function designMotionFirstListValue(value: string): string {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

/** Validate one CSS timing function. Browser builds defer to CSS.supports;
 * the parser fallback keeps source/model tests deterministic. */
export function designMotionEasingIsValid(value: string): boolean {
  const candidate = value.trim();
  if (
    candidate.length === 0 ||
    candidate.length > 256 ||
    designMotionFirstListValue(candidate) !== candidate
  ) {
    return false;
  }
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
    return CSS.supports("animation-timing-function", candidate);
  }
  if (
    /^(?:linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/i.test(
      candidate,
    )
  ) {
    return true;
  }
  const cssNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  const bezier = /^cubic-bezier\((.*)\)$/i.exec(candidate);
  if (bezier?.[1]) {
    const values = bezier[1].split(",").map((part) => part.trim());
    if (values.length !== 4 || values.some((part) => !cssNumber.test(part))) {
      return false;
    }
    const x1 = Number(values[0]);
    const x2 = Number(values[2]);
    return x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1;
  }
  const steps =
    /^steps\(\s*(\d+)\s*(?:,\s*(jump-start|jump-end|jump-none|jump-both|start|end)\s*)?\)$/i.exec(
      candidate,
    );
  if (steps?.[1]) {
    const count = Number(steps[1]);
    return count >= (steps[2]?.toLocaleLowerCase() === "jump-none" ? 2 : 1);
  }
  const linear = /^linear\((.*)\)$/i.exec(candidate);
  return Boolean(
    linear?.[1] &&
    /^[\d.eE+,%\s-]+$/.test(linear[1]) &&
    (linear[1].match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/g)?.length ?? 0) >= 2,
  );
}

/** Ready-to-edit CSS keyframes for common entrance and emphasis motions. The
 * returned frames stay small and standards-based, so presets are starting
 * points rather than opaque runtime effects. */
export function designMotionPresetKeyframes(
  preset: DesignMotionPresetId,
): DesignMotionKeyframe[] {
  switch (preset) {
    case "fade-in":
      return [
        { offset: 0, styles: { opacity: "0" } },
        { offset: 100, styles: { opacity: "1" } },
      ];
    case "slide-up":
      return [
        {
          offset: 0,
          styles: { opacity: "0", transform: "translateY(24px)" },
        },
        { offset: 100, styles: { opacity: "1", transform: "none" } },
      ];
    case "slide-down":
      return [
        {
          offset: 0,
          styles: { opacity: "0", transform: "translateY(-24px)" },
        },
        { offset: 100, styles: { opacity: "1", transform: "none" } },
      ];
    case "slide-left":
      return [
        {
          offset: 0,
          styles: { opacity: "0", transform: "translateX(24px)" },
        },
        { offset: 100, styles: { opacity: "1", transform: "none" } },
      ];
    case "slide-right":
      return [
        {
          offset: 0,
          styles: { opacity: "0", transform: "translateX(-24px)" },
        },
        { offset: 100, styles: { opacity: "1", transform: "none" } },
      ];
    case "scale-in":
      return [
        {
          offset: 0,
          styles: { opacity: "0", transform: "scale(.94)" },
        },
        { offset: 100, styles: { opacity: "1", transform: "none" } },
      ];
    case "blur-in":
      return [
        {
          offset: 0,
          styles: { opacity: "0", filter: "blur(8px)" },
        },
        { offset: 100, styles: { opacity: "1", filter: "none" } },
      ];
    case "pulse":
      return [
        { offset: 0, styles: { transform: "scale(1)" } },
        { offset: 50, styles: { transform: "scale(1.04)" } },
        { offset: 100, styles: { transform: "scale(1)" } },
      ];
    case "spin":
      return [
        { offset: 0, styles: { transform: "rotate(0deg)" } },
        { offset: 100, styles: { transform: "rotate(360deg)" } },
      ];
  }
}

function boundedOffset(offset: number): number {
  return Math.round(Math.min(100, Math.max(0, offset)) * 10) / 10;
}

/** Pressing play at the end should replay the motion instead of immediately
 * stopping on its final frame. Other positions resume exactly where they are. */
export function designMotionPlaybackStartOffset(offset: number): number {
  const bounded = boundedOffset(offset);
  return bounded >= 100 ? 0 : bounded;
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

/** A draft is committable only when every animated property has enough points
 * to define an interval. Counting aggregate points lets a one-point track slip
 * through whenever another property happens to have extra points. */
export function designMotionTracksAreValid(
  keyframes: readonly DesignMotionKeyframe[],
): boolean {
  const points = designMotionPoints(keyframes);
  const properties = designMotionProperties(keyframes);
  return (
    properties.length > 0 &&
    properties.every(
      (property) =>
        points.filter((point) => point.property === property).length >= 2,
    )
  );
}

/** Convert an effect-local scrub time to Animation.currentTime. */
export function designMotionPreviewCurrentTime(
  currentTime: number,
  duration: number,
  delay: number,
): number {
  const boundedDuration = Math.max(0, duration);
  const boundedEffectTime = Math.min(boundedDuration, Math.max(0, currentTime));
  return delay + boundedEffectTime;
}

/** Convert an effect-local time to the timeline's percentage coordinate. */
export function designMotionOffsetAtTime(
  time: number,
  duration: number,
): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const boundedTime = Math.min(duration, Math.max(0, time));
  return Math.round((boundedTime / duration) * 1_000) / 10;
}

/** Convert a percentage coordinate to a stable, integer millisecond time. */
export function designMotionTimeAtOffset(
  offset: number,
  duration: number,
): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.round((boundedOffset(offset) / 100) * duration);
}

/** Parse a committed time field without treating the empty editing state as
 * JavaScript's numeric zero. */
export function designMotionTimeInputOffset(
  input: string,
  duration: number,
): number | null {
  if (input.trim() === "") return null;
  const time = Number(input);
  return Number.isFinite(time)
    ? designMotionOffsetAtTime(time, duration)
    : null;
}

export function designMotionNudgedOffset(
  offset: number,
  direction: -1 | 1,
  coarse = false,
): number {
  return boundedOffset(offset + direction * (coarse ? 10 : 1));
}

function readableTimelineStep(rawStep: number): number {
  const exponent = 10 ** Math.floor(Math.log10(Math.max(1, rawStep)));
  const normalized = rawStep / exponent;
  const factor = [1, 2, 2.5, 5, 10].find(
    (candidate) => candidate >= normalized,
  );
  return (factor ?? 10) * exponent;
}

/** Build a sparse millisecond ruler whose labels stay readable at short and
 * long durations. The exact end is always present, even when it is not on a
 * nice interval. */
export function designMotionRulerMarks(
  duration: number,
): DesignMotionRulerMark[] {
  const boundedDuration = Number.isFinite(duration)
    ? Math.min(60_000, Math.max(1, duration))
    : 300;
  const step = readableTimelineStep(boundedDuration / 5);
  const times: number[] = [0];
  for (let time = step; time < boundedDuration; time += step) {
    times.push(Math.round(time * 10) / 10);
  }
  times.push(boundedDuration);
  return times.map((time) => ({
    time,
    offset: designMotionOffsetAtTime(time, boundedDuration),
  }));
}

function motionPixel(value: string | undefined): number | null {
  const source = value?.trim() ?? "";
  if (/^[+-]?0(?:\.0+)?$/.test(source)) return 0;
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))px$/i.exec(source);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function motionFunctionArguments(value: string): string[] {
  return value
    .trim()
    .split(/\s*,\s*|\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function motionTranslation(
  styles: Readonly<Record<string, string>>,
): { x: number; y: number } | null {
  const hasTranslate = Object.hasOwn(styles, "translate");
  const hasTransform = Object.hasOwn(styles, "transform");
  if (!hasTranslate && !hasTransform) return null;
  let x = 0;
  let y = 0;
  if (hasTranslate && styles.translate && styles.translate !== "none") {
    const parts = motionFunctionArguments(styles.translate);
    const nextX = motionPixel(parts[0]);
    const nextY = motionPixel(parts[1] ?? "0");
    if (nextX === null || nextY === null) return null;
    x += nextX;
    y += nextY;
  }
  const transform = styles.transform?.trim() ?? "";
  if (hasTransform && transform && transform !== "none") {
    for (const match of transform.matchAll(/([A-Za-z0-9]+)\(([^)]*)\)/g)) {
      const name = match[1]?.toLocaleLowerCase();
      const parts = motionFunctionArguments(match[2] ?? "");
      if (name === "translate" || name === "translate3d") {
        const nextX = motionPixel(parts[0]);
        const nextY = motionPixel(parts[1] ?? "0");
        if (nextX === null || nextY === null) return null;
        x += nextX;
        y += nextY;
      } else if (name === "translatex") {
        const nextX = motionPixel(parts[0]);
        if (nextX === null) return null;
        x += nextX;
      } else if (name === "translatey") {
        const nextY = motionPixel(parts[0]);
        if (nextY === null) return null;
        y += nextY;
      } else if (name === "matrix" && parts.length === 6) {
        const nextX = Number(parts[4]);
        const nextY = Number(parts[5]);
        if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return null;
        x += nextX;
        y += nextY;
      } else if (name === "matrix3d" && parts.length === 16) {
        const nextX = Number(parts[12]);
        const nextY = Number(parts[13]);
        if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return null;
        x += nextX;
        y += nextY;
      }
    }
  }
  return { x, y };
}

/** Extract keyframe-local translation coordinates for a selectable canvas
 * motion path. Unsupported percentage/relative translations return no path
 * instead of drawing misleading geometry. */
export function designMotionTranslationPoints(
  keyframes: readonly DesignMotionKeyframe[],
): DesignMotionTranslationPoint[] {
  const points = normalizedFrames(keyframes).flatMap((keyframe) => {
    const translation = motionTranslation(keyframe.styles);
    return translation ? [{ offset: keyframe.offset, ...translation }] : [];
  });
  return points.length >= 2 && points.some((point) => point.x || point.y)
    ? points
    : [];
}

export function designMotionTranslationAtOffset(
  keyframes: readonly DesignMotionKeyframe[],
  offset: number,
): { x: number; y: number } | null {
  const points = designMotionTranslationPoints(keyframes);
  if (points.length === 0) return null;
  const target = boundedOffset(offset);
  const exact = points.find((point) => point.offset === target);
  if (exact) return { x: exact.x, y: exact.y };
  const before = [...points].reverse().find((point) => point.offset < target);
  const after = points.find((point) => point.offset > target);
  if (!before && after) return { x: after.x, y: after.y };
  if (before && !after) return { x: before.x, y: before.y };
  if (!before || !after) return null;
  const progress = (target - before.offset) / (after.offset - before.offset);
  return {
    x: Math.round((before.x + (after.x - before.x) * progress) * 10) / 10,
    y: Math.round((before.y + (after.y - before.y) * progress) * 10) / 10,
  };
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

/** Promote an inspector value into the timeline without creating an invalid
 * one-point track. Existing tracks receive only the requested playhead point;
 * a new track gets explicit boundary values so it is immediately scrubbable
 * and can be saved before either edge is adjusted. */
export function addDesignMotionPropertyKeyframe(
  keyframes: readonly DesignMotionKeyframe[],
  property: string,
  offset: number,
  value: string,
): DesignMotionKeyframe[] {
  let next = [...keyframes];
  if (!designMotionProperties(keyframes).includes(property)) {
    next = setDesignMotionPoint(next, property, 0, value);
    next = setDesignMotionPoint(next, property, 100, value);
  }
  return setDesignMotionPoint(next, property, offset, value);
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
