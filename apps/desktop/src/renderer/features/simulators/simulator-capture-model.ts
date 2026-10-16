import type { SimulatorCapture } from "@zeros/protocol/simulator-captures";

import type { Size } from "./simulator-geometry";

// How capture thumbnails are sized and stacked, and how a recording's time
// reads. Free of React so the rules can be tested on their own.

/** A thumbnail's longest edge on screen. */
export const CAPTURE_THUMBNAIL_EDGE_PX = 160;
/** A capture without a picture shows its kind's icon in a square this big. */
export const CAPTURE_PLACEHOLDER_PX = 96;
/** How much of each older thumbnail shows above the newest, stacked. */
export const CAPTURE_STACK_PEEK_PX = 8;
/** The space between thumbnails spread out. */
export const CAPTURE_STACK_GAP_PX = 8;
/** How much smaller each older thumbnail is, stacked. */
export const CAPTURE_STACK_SHRINK = 0.05;

const PNG_PREFIX = "data:image/png;base64,";
// The signature and IHDR header end with the width and height at bytes
// 16-23, the first 24 bytes, which are 32 base64 characters.
const PNG_HEADER_CHARS = 32;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The pixel size of a PNG data URL, read from its header. */
export function pngDataUrlSize(dataUrl: string): Size | null {
  if (!dataUrl.startsWith(PNG_PREFIX)) return null;
  let header: string;
  try {
    header = atob(dataUrl.slice(PNG_PREFIX.length, PNG_PREFIX.length + PNG_HEADER_CHARS));
  } catch {
    return null;
  }
  if (header.length < 24) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (header.charCodeAt(index) !== PNG_SIGNATURE[index]) return null;
  }
  const read = (offset: number) =>
    ((header.charCodeAt(offset) << 24) |
      (header.charCodeAt(offset + 1) << 16) |
      (header.charCodeAt(offset + 2) << 8) |
      header.charCodeAt(offset + 3)) >>>
    0;
  const width = read(16);
  const height = read(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** How big a capture's thumbnail shows: its picture fitted to the longest
 * edge, or a square placeholder. */
export function captureThumbnailSize(capture: Pick<SimulatorCapture, "thumbnail">): Size {
  const picture = capture.thumbnail ? pngDataUrlSize(capture.thumbnail) : null;
  if (!picture) return { width: CAPTURE_PLACEHOLDER_PX, height: CAPTURE_PLACEHOLDER_PX };
  const scale = CAPTURE_THUMBNAIL_EDGE_PX / Math.max(picture.width, picture.height);
  return {
    width: Math.max(1, Math.round(picture.width * scale)),
    height: Math.max(1, Math.round(picture.height * scale)),
  };
}

export interface CaptureStackLayout {
  width: number;
  height: number;
  /** Each thumbnail's lift above the stack's bottom edge, newest first. */
  lifts: number[];
  scales: number[];
}

/** Thumbnails anchored at the bottom right, newest in front. Stacked, older
 * ones peek out above it, a little smaller; spread out, they stand in a
 * column so each can be dragged. */
export function captureStackLayout(sizes: readonly Size[], spread: boolean): CaptureStackLayout {
  const width = Math.max(0, ...sizes.map((size) => size.width));
  if (sizes.length === 0) return { width: 0, height: 0, lifts: [], scales: [] };
  if (spread) {
    const lifts: number[] = [];
    let lift = 0;
    for (const size of sizes) {
      lifts.push(lift);
      lift += size.height + CAPTURE_STACK_GAP_PX;
    }
    return {
      width,
      height: lift - CAPTURE_STACK_GAP_PX,
      lifts,
      scales: sizes.map(() => 1),
    };
  }
  const scales = sizes.map((_, index) => 1 - index * CAPTURE_STACK_SHRINK);
  // An older, shorter thumbnail is lifted just enough to peek out above the
  // ones in front of it.
  const lifts: number[] = [];
  let top = 0;
  sizes.forEach((size, index) => {
    const height = size.height * scales[index]!;
    top = index === 0 ? height : Math.max(top + CAPTURE_STACK_PEEK_PX, height);
    lifts.push(top - height);
  });
  return { width, height: Math.ceil(top), lifts, scales };
}

/** `0:05`, `12:34` or `1:00:00`: how long a recording has run. */
export function formatRecordingElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** How a recording's length reads aloud, to the same second as its clock:
 * "12 seconds", "1 minute 5 seconds". */
export function describeRecordingLength(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const parts: Array<[number, string]> = [
    [Math.floor(total / 3600), "hour"],
    [Math.floor((total % 3600) / 60), "minute"],
    [total % 60, "second"],
  ];
  const said = parts
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}${count === 1 ? "" : "s"}`);
  return said.length > 0 ? said.join(" ") : "0 seconds";
}

export function captureLabel(capture: Pick<SimulatorCapture, "kind" | "deviceName">): string {
  return `${capture.kind === "screenshot" ? "Screenshot" : "Recording"} of ${capture.deviceName}`;
}

/** What a thumbnail is called: a recording's also says how long it runs,
 * which its picture shows. */
export function captureCardLabel(
  capture: Pick<SimulatorCapture, "kind" | "deviceName" | "durationMs">,
): string {
  const label = captureLabel(capture);
  return capture.kind === "recording" && capture.durationMs !== undefined
    ? `${label}, ${describeRecordingLength(capture.durationMs)}`
    : label;
}
