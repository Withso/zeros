import { describe, expect, it } from "vitest";
import type { DeviceAgentTouch } from "@zeros/protocol/device-tools";

import { STILL_TOUCH_MS, touchDots } from "../simulator-touch-motion";

const SCREEN = { width: 400, height: 800 };
const DEVICE = "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108";
const touch = (value: Omit<DeviceAgentTouch, "deviceId">): DeviceAgentTouch => ({
  deviceId: DEVICE,
  ...value,
});

const places = (keyframes: Keyframe[]) => keyframes.map(({ left, top }) => `${left} ${top}`);

describe("drawing an agent's touches", () => {
  it("places a tap in percent of the screen and fades it", () => {
    const [dot, ...rest] = touchDots(touch({ kind: "tap", at: { x: 100, y: 200 } }), SCREEN, false);
    expect(rest).toEqual([]);
    expect(new Set(places(dot!.keyframes))).toEqual(new Set(["25% 25%"]));
    expect(dot!.keyframes[0]).toMatchObject({ opacity: 0 });
    expect(dot!.keyframes.at(-1)).toMatchObject({ opacity: 0 });
    expect(dot!.options.duration).toBeGreaterThan(0);
  });

  it("keeps a touch past the edge on the screen", () => {
    const [dot] = touchDots(touch({ kind: "tap", at: { x: 900, y: 0 } }), SCREEN, false);
    expect(places(dot!.keyframes)[0]).toBe("100% 0%");
  });

  it("taps twice for a double tap and holds a long press", () => {
    const double = touchDots(touch({ kind: "double-tap", at: { x: 10, y: 10 } }), SCREEN, false);
    expect(double).toHaveLength(2);
    expect(double[1]!.options.delay).toBeGreaterThan(0);
    const [held] = touchDots(touch({ kind: "long-press", at: { x: 10, y: 10 } }), SCREEN, false);
    const [tap] = touchDots(touch({ kind: "tap", at: { x: 10, y: 10 } }), SCREEN, false);
    expect(held!.options.duration).toBeGreaterThan(tap!.options.duration as number);
  });

  it("glides a swipe from where it starts to where it ends", () => {
    const [dot] = touchDots(
      touch({ kind: "swipe", at: { x: 200, y: 600 }, to: { x: 200, y: 200 } }),
      SCREEN,
      false,
    );
    expect(places(dot!.keyframes)).toEqual(["50% 75%", "50% 75%", "50% 25%", "50% 25%"]);
  });

  it("spreads a pinch's fingers to zoom in and brings them together to zoom out", () => {
    const spread = (scale: number) => {
      const [first] = touchDots(
        touch({ kind: "pinch", at: { x: 200, y: 400 }, scale }),
        SCREEN,
        false,
      );
      const lefts = first!.keyframes.map((frame) => parseFloat(String(frame.left)));
      return lefts[0]! - lefts.at(-1)!;
    };
    expect(spread(2)).toBeGreaterThan(0);
    expect(spread(0.5)).toBeLessThan(0);
    expect(
      touchDots(touch({ kind: "pinch", at: { x: 200, y: 400 } }), SCREEN, false),
    ).toHaveLength(2);
  });

  it("shows touches still while reduce motion is on", () => {
    const kinds: Array<Omit<DeviceAgentTouch, "deviceId">> = [
      { kind: "tap", at: { x: 10, y: 10 } },
      { kind: "double-tap", at: { x: 10, y: 10 } },
      { kind: "long-press", at: { x: 10, y: 10 } },
      { kind: "swipe", at: { x: 10, y: 10 }, to: { x: 200, y: 400 } },
      { kind: "pinch", at: { x: 200, y: 400 }, scale: 2 },
    ];
    for (const value of kinds) {
      for (const dot of touchDots(touch(value), SCREEN, true)) {
        expect(dot.options).toEqual({ duration: STILL_TOUCH_MS });
        expect(new Set(places(dot.keyframes)).size).toBe(1);
        expect(dot.keyframes.every((frame) => frame.opacity === 1 && !frame.transform)).toBe(true);
      }
    }
    const [swiped] = touchDots(touch(kinds[3]!), SCREEN, true);
    expect(places(swiped!.keyframes)[0]).toBe("50% 50%");
  });
});
