import { describe, expect, it } from "vitest";
import type {
  SimulatorDevice,
  SimulatorDeviceFrame,
  SimulatorFrameImage,
  SimulatorScreen,
} from "@zeros/protocol/simulators";

import {
  defaultSimulatorDevice,
  deviceBoxRect,
  deviceBoxSize,
  drawnDeviceLayout,
  fitDeviceScale,
  frameMask,
  framePieces,
  framedDeviceLayout,
  keystroke,
  mirroredFinger,
  nextTurnAngle,
  orientationTurns,
  pointOnScreen,
  rotatedOrientation,
  screenSize,
  scrollInput,
  SETUP_PHONE_SCREEN,
  simulatorPickerSections,
  turnedArea,
  unturn,
} from "../simulator-geometry";

const IPHONE: SimulatorScreen = { widthPx: 1206, heightPx: 2622, scale: 3, cornerRadius: 55 };
const PIXEL: SimulatorScreen = { widthPx: 1080, heightPx: 2424, scale: 2.625, cornerRadius: 33 };

function image(width: number, height: number): SimulatorFrameImage {
  return { url: "data:image/png;base64,AA==", width, height };
}

function kitFrame(): SimulatorDeviceFrame {
  return {
    width: 442,
    height: 914,
    screen: { x: 20, y: 20, width: 402, height: 874 },
    slices: {
      topLeft: image(60, 60),
      top: image(1, 20),
      topRight: image(60, 60),
      right: image(20, 1),
      bottomRight: image(60, 60),
      bottom: image(1, 20),
      bottomLeft: image(60, 60),
      left: image(20, 1),
    },
    buttons: [{ name: "power", image: image(6, 100), x: 442, y: 200, onTop: false }],
    outset: { top: 0, left: 4, bottom: 0, right: 6 },
  };
}

function device(
  id: string,
  state: SimulatorDevice["state"],
  formFactor: SimulatorDevice["formFactor"] = "phone",
  platform: SimulatorDevice["platform"] = "ios",
): SimulatorDevice {
  return {
    id,
    platform,
    name: id,
    osLabel: "iOS 27.0",
    formFactor,
    state,
    bootedByZeros: false,
  };
}

describe("device layout", () => {
  it("draws a bezel around the screen in points", () => {
    expect(screenSize(IPHONE)).toEqual({ width: 402, height: 874 });
    const layout = drawnDeviceLayout(IPHONE, "phone");
    expect(layout.screen).toEqual({ x: 16, y: 16, width: 402, height: 874 });
    expect(layout).toMatchObject({ width: 434, height: 906, screenRadius: 55, frameRadius: 71 });
  });

  it("uses Xcode's frame as laid out by main", () => {
    const layout = framedDeviceLayout(kitFrame(), IPHONE);
    expect(layout).toMatchObject({
      width: 442,
      height: 914,
      screen: { x: 20, y: 20, width: 402, height: 874 },
      outset: { left: 4, right: 6 },
      screenRadius: 55,
    });
  });

  it("keeps corners at their size and stretches the edges between them", () => {
    const pieces = Object.fromEntries(framePieces(kitFrame()).map((piece) => [piece.key, piece.rect]));
    expect(pieces.topLeft).toEqual({ x: 0, y: 0, width: 60, height: 60 });
    expect(pieces.top).toEqual({ x: 60, y: 0, width: 322, height: 20 });
    expect(pieces.right).toEqual({ x: 422, y: 60, width: 20, height: 794 });
    expect(pieces.bottomRight).toEqual({ x: 382, y: 854, width: 60, height: 60 });
    expect(pieces.left).toEqual({ x: 0, y: 60, width: 20, height: 794 });
    expect(frameMask(kitFrame())).toBeNull();
  });

  it("draws Android Studio's picture from the corner, and its mask over the screen", () => {
    const picture = image(456, 964);
    const mask = { url: "data:image/webp;base64,BB==", width: 411, height: 923 };
    const frame: SimulatorDeviceFrame = {
      width: 456,
      height: 964,
      screen: { x: 21, y: 22, width: 411.4, height: 923.4 },
      image: picture,
      mask,
      buttons: [],
      outset: { top: 0, left: 0, bottom: 0, right: 0 },
    };
    expect(framePieces(frame)).toEqual([
      { key: "image", url: picture.url, rect: { x: 0, y: 0, width: 456, height: 964 } },
    ]);
    expect(frameMask(frame)).toEqual({ url: mask.url, rect: frame.screen });
    const { mask: _mask, ...unmasked } = frame;
    expect(frameMask(unmasked)).toBeNull();
    expect(framedDeviceLayout(frame, PIXEL)).toMatchObject({
      width: 456,
      height: 964,
      screen: frame.screen,
      screenRadius: 33,
    });
  });

  it("fits the device and its buttons without enlarging it", () => {
    const layout = framedDeviceLayout(kitFrame(), IPHONE);
    expect(fitDeviceScale(layout, { width: 226, height: 2_000 })).toBeCloseTo(0.5);
    expect(fitDeviceScale(layout, { width: 5_000, height: 457 })).toBeCloseTo(0.5);
    expect(fitDeviceScale(layout, { width: 5_000, height: 5_000 })).toBe(1);
    expect(fitDeviceScale(layout, { width: 0, height: 500 })).toBe(0);
  });

  it("places frame pieces on whole pixels so neighbours never open a seam", () => {
    const layout = framedDeviceLayout(kitFrame(), IPHONE);
    const scale = 0.37;
    expect(deviceBoxSize(layout, scale)).toEqual({ width: 167, height: 338 });
    const pieces = framePieces(kitFrame()).map((piece) => deviceBoxRect(layout, scale, piece.rect));
    const [topLeft, top, topRight] = pieces;
    expect(topLeft.left + topLeft.width).toBe(top.left);
    expect(top.left + top.width).toBe(topRight.left);
    for (const rect of pieces) {
      expect(Number.isInteger(rect.left) && Number.isInteger(rect.width)).toBe(true);
    }
    // Buttons outside the frame sit inside the box, past the outset.
    expect(deviceBoxRect(layout, 1, { x: -4, y: 200, width: 4, height: 100 })).toEqual({
      left: 0,
      top: 200,
      width: 4,
      height: 100,
    });
  });

  it("draws a generic phone around the setup screen", () => {
    expect(screenSize(SETUP_PHONE_SCREEN)).toEqual({ width: 402, height: 874 });
  });
});

describe("live view input", () => {
  const size = { width: 402, height: 874 };
  const rect = { left: 100, top: 50, width: 201, height: 437 };

  it("maps a pointer to device points and keeps it on the screen", () => {
    expect(pointOnScreen({ x: 200.5, y: 268.5 }, rect, size)).toEqual({ x: 201, y: 437 });
    expect(pointOnScreen({ x: 0, y: 2_000 }, rect, size)).toEqual({ x: 0, y: 874 });
    expect(pointOnScreen({ x: 1, y: 1 }, { ...rect, width: 0 }, size)).toBeNull();
  });

  it("maps a pointer on a turned device back to its upright screen", () => {
    // Landscape left turns the drawn device a quarter turn counterclockwise,
    // so the screen's top edge runs down its left side.
    const sideways = { left: 100, top: 50, width: 437, height: 201 };
    expect(pointOnScreen({ x: 100, y: 251 }, sideways, size, 3)).toEqual({ x: 0, y: 0 });
    expect(pointOnScreen({ x: 100, y: 50 }, sideways, size, 3)).toEqual({ x: 402, y: 0 });
    expect(pointOnScreen({ x: 537, y: 251 }, sideways, size, 3)).toEqual({ x: 0, y: 874 });
    expect(pointOnScreen({ x: 100, y: 50 }, sideways, size, 1)).toEqual({ x: 0, y: 874 });
    expect(pointOnScreen({ x: 100, y: 50 }, rect, size, 2)).toEqual({ x: 402, y: 874 });
    // A scroll down the turned screen runs along its upright width.
    expect(unturn({ x: 0, y: 100 }, 3)).toEqual({ x: -100, y: 0 });
    expect(unturn({ x: 0, y: 100 }, 1)).toEqual({ x: 100, y: 0 });
    expect(unturn({ x: 30, y: 100 }, 0)).toEqual({ x: 30, y: 100 });
  });

  it("turns the device the short way round to show each orientation upright", () => {
    expect(orientationTurns(undefined)).toBe(0);
    expect(orientationTurns("portrait")).toBe(0);
    expect(orientationTurns("landscape-right")).toBe(1);
    expect(orientationTurns("portrait-upside-down")).toBe(2);
    expect(orientationTurns("landscape-left")).toBe(3);
    expect(nextTurnAngle(0, 3)).toBe(-90);
    expect(nextTurnAngle(-90, 0)).toBe(0);
    expect(nextTurnAngle(-90, 2)).toBe(-180);
    expect(nextTurnAngle(270, 0)).toBe(360);
    expect(nextTurnAngle(0, 0)).toBe(0);
    expect(turnedArea({ width: 300, height: 500 }, 3)).toEqual({ width: 500, height: 300 });
    expect(turnedArea({ width: 300, height: 500 }, 2)).toEqual({ width: 300, height: 500 });
  });

  it("rotates a quarter turn left from portrait, and back from any other turn", () => {
    expect(rotatedOrientation(undefined)).toBe("landscape-left");
    expect(rotatedOrientation("portrait")).toBe("landscape-left");
    expect(orientationTurns(rotatedOrientation("portrait"))).toBe(3);
    for (const turned of ["landscape-left", "landscape-right", "portrait-upside-down"] as const) {
      expect(rotatedOrientation(turned)).toBe("portrait");
    }
  });

  it("mirrors a pinch's other finger through the screen's center", () => {
    expect(mirroredFinger({ x: 100, y: 200 }, size)).toEqual({ x: 302, y: 674 });
    expect(mirroredFinger({ x: 201, y: 437 }, size)).toEqual({ x: 201, y: 437 });
  });

  it("turns a scroll into a swipe that fits on the screen", () => {
    expect(scrollInput({ x: 200, y: 100 }, { x: 0, y: 300 }, size)).toEqual({
      kind: "drag",
      from: { x: 200, y: 300 },
      to: { x: 200, y: 0 },
      durationMs: 200,
    });
    expect(scrollInput({ x: 200, y: 800 }, { x: 0, y: -5_000 }, size)).toMatchObject({
      from: { x: 200, y: 174.8 },
      to: { x: 200, y: 874 },
    });
    expect(scrollInput({ x: 10, y: 10 }, { x: 0.2, y: 0.3 }, size)).toBeNull();
  });

  it("sends typing and editing keys, and leaves shortcuts to Zeros", () => {
    const plain = { metaKey: false, ctrlKey: false };
    expect(keystroke({ ...plain, key: "a" })).toEqual({ kind: "text", text: "a" });
    expect(keystroke({ ...plain, key: "é" })).toEqual({ kind: "text", text: "é" });
    expect(keystroke({ ...plain, key: "😀" })).toEqual({ kind: "text", text: "😀" });
    expect(keystroke({ ...plain, key: "Enter" })).toEqual({ kind: "key", key: "enter" });
    expect(keystroke({ ...plain, key: "ArrowLeft" })).toEqual({ kind: "key", key: "arrow-left" });
    expect(keystroke({ ...plain, key: "Shift" })).toBeNull();
    // Tab moves focus on, so the keyboard is never trapped on the screen.
    expect(keystroke({ ...plain, key: "Tab" })).toBeNull();
    expect(keystroke({ ...plain, key: "Dead" })).toBeNull();
    expect(keystroke({ ...plain, key: "a", isComposing: true })).toBeNull();
    expect(keystroke({ metaKey: true, ctrlKey: false, key: "w" })).toBeNull();
    expect(keystroke({ metaKey: false, ctrlKey: true, key: "c" })).toBeNull();
  });
});

describe("device picker", () => {
  const devices = [
    device("ipad", "booted", "tablet"),
    device("iphone-17", "shutdown"),
    device("iphone-air", "booting"),
    device("ipad-mini", "shutting-down", "tablet"),
    device("pixel", "booted", "phone", "android"),
  ];

  it("splits running devices from ones that will boot, per platform", () => {
    const sections = simulatorPickerSections(devices, "ios");
    expect(sections.booted.map((entry) => entry.id)).toEqual(["ipad", "iphone-air"]);
    expect(sections.available.map((entry) => entry.id)).toEqual(["iphone-17", "ipad-mini"]);
    expect(simulatorPickerSections(devices, "android").booted.map((entry) => entry.id)).toEqual([
      "pixel",
    ]);
  });

  it("attaches a running device first, unless another tab shows it", () => {
    expect(defaultSimulatorDevice(devices, "ios", new Set())?.id).toBe("ipad");
    expect(defaultSimulatorDevice(devices, "ios", new Set(["ipad"]))?.id).toBe("iphone-17");
    expect(
      defaultSimulatorDevice([device("ipad-2", "shutdown", "tablet")], "ios", new Set())?.id,
    ).toBe("ipad-2");
    expect(defaultSimulatorDevice([], "ios", new Set())).toBeNull();
  });
});
