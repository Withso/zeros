import { describe, expect, it } from "vitest";

import {
  CAPTURE_PLACEHOLDER_PX,
  CAPTURE_STACK_GAP_PX,
  CAPTURE_STACK_PEEK_PX,
  captureCardLabel,
  captureLabel,
  captureStackLayout,
  captureThumbnailSize,
  describeRecordingLength,
  formatRecordingElapsed,
  pngDataUrlSize,
} from "../simulator-capture-model";

const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

/** The start of a PNG: its signature and IHDR chunk. */
function pngDataUrl(width: number, height: number): string {
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32(13),
    0x49, 0x48, 0x44, 0x52,
    ...u32(width),
    ...u32(height),
    8, 6, 0, 0, 0,
  ];
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}

describe("capture thumbnail sizes", () => {
  it("reads a PNG's size from its header", () => {
    expect(pngDataUrlSize(pngDataUrl(147, 320))).toEqual({ width: 147, height: 320 });
    expect(pngDataUrlSize(pngDataUrl(70_000, 1))).toEqual({ width: 70_000, height: 1 });
  });

  it("reads nothing from another picture or a damaged header", () => {
    expect(pngDataUrlSize("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).toBeNull();
    expect(pngDataUrlSize("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
    expect(pngDataUrlSize("data:image/png;base64,%%%%")).toBeNull();
    const notPng = pngDataUrl(10, 10).replace("iVBOR", "AAAAA");
    expect(pngDataUrlSize(notPng)).toBeNull();
    expect(pngDataUrlSize(pngDataUrl(0, 10))).toBeNull();
  });

  it("fits a picture's longest edge, keeping its shape", () => {
    expect(captureThumbnailSize({ thumbnail: pngDataUrl(147, 320) })).toEqual({
      width: 74,
      height: 160,
    });
    expect(captureThumbnailSize({ thumbnail: pngDataUrl(320, 147) })).toEqual({
      width: 160,
      height: 74,
    });
    expect(captureThumbnailSize({ thumbnail: pngDataUrl(4_000, 1) })).toEqual({
      width: 160,
      height: 1,
    });
  });

  it("shows a square placeholder without a picture", () => {
    const square = { width: CAPTURE_PLACEHOLDER_PX, height: CAPTURE_PLACEHOLDER_PX };
    expect(captureThumbnailSize({ thumbnail: null })).toEqual(square);
    expect(captureThumbnailSize({ thumbnail: "data:image/png;base64,AAAA" })).toEqual(square);
  });
});

describe("capture stack layout", () => {
  const portrait = { width: 74, height: 160 };
  const landscape = { width: 160, height: 74 };

  it("is empty without thumbnails", () => {
    expect(captureStackLayout([], false)).toEqual({ width: 0, height: 0, lifts: [], scales: [] });
    expect(captureStackLayout([], true)).toEqual({ width: 0, height: 0, lifts: [], scales: [] });
  });

  it("stacks older thumbnails a little smaller, each peeking out above the one before", () => {
    const layout = captureStackLayout([portrait, portrait, portrait], false);
    expect(layout.scales).toEqual([1, 0.95, 0.9]);
    expect(layout.lifts).toEqual([0, 16, 32]);
    expect(layout).toMatchObject({ width: 74, height: 160 + 2 * CAPTURE_STACK_PEEK_PX });
  });

  it("lifts an older, shorter thumbnail just enough to peek out", () => {
    const layout = captureStackLayout([portrait, landscape], false);
    expect(layout.lifts[0]).toBe(0);
    expect(layout.lifts[1]).toBeCloseTo(160 + CAPTURE_STACK_PEEK_PX - 74 * 0.95);
    expect(layout).toMatchObject({ width: 160, height: 168 });

    const taller = captureStackLayout([landscape, portrait], false);
    expect(taller.lifts).toEqual([0, 0]);
    expect(taller.height).toBe(152);
  });

  it("spreads them into a column, full size", () => {
    expect(captureStackLayout([landscape, portrait, landscape], true)).toEqual({
      width: 160,
      height: 74 + 160 + 74 + 2 * CAPTURE_STACK_GAP_PX,
      lifts: [0, 74 + CAPTURE_STACK_GAP_PX, 74 + 160 + 2 * CAPTURE_STACK_GAP_PX],
      scales: [1, 1, 1],
    });
  });
});

describe("recording times", () => {
  it("reads like a clock, with hours once a recording runs that long", () => {
    expect(formatRecordingElapsed(0)).toBe("0:00");
    expect(formatRecordingElapsed(-50)).toBe("0:00");
    expect(formatRecordingElapsed(5_999)).toBe("0:05");
    expect(formatRecordingElapsed(60_000)).toBe("1:00");
    expect(formatRecordingElapsed(754_000)).toBe("12:34");
    expect(formatRecordingElapsed(3_600_000)).toBe("1:00:00");
    expect(formatRecordingElapsed(3_725_000)).toBe("1:02:05");
  });

  it("says a recording's length in words, to the same second as its clock", () => {
    expect(describeRecordingLength(400)).toBe("0 seconds");
    expect(describeRecordingLength(1_000)).toBe("1 second");
    expect(describeRecordingLength(5_999)).toBe("5 seconds");
    expect(describeRecordingLength(60_000)).toBe("1 minute");
    expect(describeRecordingLength(65_000)).toBe("1 minute 5 seconds");
    expect(describeRecordingLength(3_600_000)).toBe("1 hour");
    expect(describeRecordingLength(3_725_000)).toBe("1 hour 2 minutes 5 seconds");
  });
});

describe("capture labels", () => {
  it("names the kind and the device, and a recording's length", () => {
    const screenshot = { kind: "screenshot", deviceName: "iPhone 17 Pro" } as const;
    expect(captureLabel(screenshot)).toBe("Screenshot of iPhone 17 Pro");
    expect(captureCardLabel(screenshot)).toBe("Screenshot of iPhone 17 Pro");

    const recording = { kind: "recording", deviceName: "iPad Air", durationMs: 61_000 } as const;
    expect(captureLabel(recording)).toBe("Recording of iPad Air");
    expect(captureCardLabel(recording)).toBe("Recording of iPad Air, 1 minute 1 second");
    expect(captureCardLabel({ kind: "recording", deviceName: "iPad Air" })).toBe(
      "Recording of iPad Air",
    );
  });
});
