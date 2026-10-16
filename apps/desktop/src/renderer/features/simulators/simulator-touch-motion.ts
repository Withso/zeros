import type { DeviceAgentTouch } from "@zeros/protocol/device-tools";

import type { Size } from "./simulator-geometry";

// How an agent's touches are drawn on the screen: soft dots that show where
// it touched and fade, placed in percent of the screen so they stay put
// whatever size the screen is drawn at.

export interface TouchDot {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

export interface Spot {
  left: number;
  top: number;
}

/** Shown this long, without movement, while reduce motion is on. */
export const STILL_TOUCH_MS = 600;

/** How far apart a pinch's fingers start and end, in points from its center. */
const PINCH_NEAR = 30;
const PINCH_FAR = 110;

/** Where `point` sits on the screen, in percent of its width and height. */
export function screenSpot(point: { x: number; y: number }, screen: Size): Spot {
  const percent = (value: number, size: number) =>
    size > 0 ? Math.round(Math.min(1, Math.max(0, value / size)) * 1000) / 10 : 0;
  return { left: percent(point.x, screen.width), top: percent(point.y, screen.height) };
}

function at(place: Spot): Keyframe {
  return { left: `${place.left}%`, top: `${place.top}%` };
}

function pulse(place: Spot, options: KeyframeAnimationOptions, hold = false): TouchDot {
  return {
    keyframes: [
      { ...at(place), opacity: 0, transform: "scale(0.6)" },
      { ...at(place), opacity: 1, transform: "scale(1)", offset: hold ? 0.15 : 0.3 },
      ...(hold ? [{ ...at(place), opacity: 1, transform: "scale(1.2)", offset: 0.8 }] : []),
      { ...at(place), opacity: 0, transform: hold ? "scale(1.2)" : "scale(1)" },
    ],
    options: { easing: "ease-out", ...options },
  };
}

function glide(from: Spot, to: Spot, durationMs: number): TouchDot {
  return {
    keyframes: [
      { ...at(from), opacity: 0 },
      { ...at(from), opacity: 1, offset: 0.15 },
      { ...at(to), opacity: 1, offset: 0.75 },
      { ...at(to), opacity: 0 },
    ],
    options: { duration: durationMs, easing: "ease-in-out" },
  };
}

function still(place: Spot): TouchDot {
  return {
    keyframes: [
      { ...at(place), opacity: 1 },
      { ...at(place), opacity: 1 },
    ],
    options: { duration: STILL_TOUCH_MS },
  };
}

/** The fingers of a pinch on the diagonal through its center, `reach`
 * points out each way. */
function pinchFingers(
  center: { x: number; y: number },
  reach: number,
  screen: Size,
): [Spot, Spot] {
  const offset = reach / Math.SQRT2;
  return [
    screenSpot({ x: center.x - offset, y: center.y - offset }, screen),
    screenSpot({ x: center.x + offset, y: center.y + offset }, screen),
  ];
}

/** The dots one touch draws, each with its own animation. */
export function touchDots(
  touch: DeviceAgentTouch,
  screen: Size,
  reducedMotion: boolean,
): TouchDot[] {
  const start = screenSpot(touch.at, screen);
  switch (touch.kind) {
    case "tap":
      return [reducedMotion ? still(start) : pulse(start, { duration: 500 })];
    case "double-tap":
      return reducedMotion
        ? [still(start)]
        : [pulse(start, { duration: 400 }), pulse(start, { duration: 400, delay: 180 })];
    case "long-press":
      return [reducedMotion ? still(start) : pulse(start, { duration: 900 }, true)];
    case "swipe": {
      const end = screenSpot(touch.to ?? touch.at, screen);
      return [reducedMotion ? still(end) : glide(start, end, 600)];
    }
    case "pinch": {
      const scale = touch.scale ?? 1;
      const from = scale > 1 ? PINCH_NEAR : scale < 1 ? PINCH_FAR : (PINCH_NEAR + PINCH_FAR) / 2;
      const to = Math.min(PINCH_FAR, Math.max(PINCH_NEAR, from * scale));
      const opening = pinchFingers(touch.at, from, screen);
      const closing = pinchFingers(touch.at, to, screen);
      return reducedMotion
        ? closing.map(still)
        : [glide(opening[0], closing[0], 700), glide(opening[1], closing[1], 700)];
    }
  }
}
