// What an agent sees of a simulator without agent-device: the frame the
// Simulator tab shows, or a capture when no tab shows the device, scaled to
// the screen's size in points.
//
// Frames and captures show the device's upright screen. One of another
// shape is turned, as an app can turn an Android display while the device
// stays upright, and is left to agent-device, which knows how it turned.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { nativeImage as NativeImageModule } from "electron";

import type { LiveFrame } from "./live-view";

export type ScreenImages = Pick<typeof NativeImageModule, "createFromBuffer" | "createFromBitmap">;

export type ScreenPixels = LiveFrame;

export interface ScreenSize {
  width: number;
  height: number;
}

/** A PNG of a capture or packed BGRA frame at `size`. */
export type ScaleScreen = (source: Buffer | ScreenPixels, size: ScreenSize) => Buffer;

export interface ScreenReaderOptions {
  /** The frame the device's live view shows, or null when none is current. */
  frame(deviceId: string): ScreenPixels | null;
  /** Saves a PNG of the device's screen to `file`. */
  capture(deviceId: string, file: string): Promise<void>;
  scale: ScaleScreen;
  /** Where captures wait until they are read. */
  workDir: string;
}

/** A PNG of the device's screen at `size`, or null when it came out turned
 * or unreadable. */
export type ReadScreen = (deviceId: string, size: ScreenSize) => Promise<Buffer | null>;

/** How far an image's shape may differ from the screen's, which a size in
 * whole points rounds. */
const SHAPE_SLACK = 0.02;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngSize(png: Buffer): ScreenSize | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (png.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function upright(image: ScreenSize, size: ScreenSize): boolean {
  const shape = size.width / size.height;
  return Math.abs(image.width / image.height - shape) <= shape * SHAPE_SLACK;
}

export function screenReader(options: ScreenReaderOptions): ReadScreen {
  return async (deviceId, size) => {
    const frame = options.frame(deviceId);
    if (frame) {
      if (!upright(frame, size)) return null;
      // A smaller frame would blur the screenshot; a capture has every pixel.
      if (frame.width >= size.width) return options.scale(frame, size);
    }
    await mkdir(options.workDir, { recursive: true, mode: 0o700 });
    const file = path.join(options.workDir, `${randomUUID()}.png`);
    try {
      await options.capture(deviceId, file);
      const png = await readFile(file);
      const captured = pngSize(png);
      return captured && upright(captured, size) ? options.scale(png, size) : null;
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  };
}

export function scaleScreenImage(
  images: ScreenImages,
  source: Buffer | ScreenPixels,
  size: ScreenSize,
): Buffer {
  const image = Buffer.isBuffer(source)
    ? images.createFromBuffer(source)
    : images.createFromBitmap(source.pixels, { width: source.width, height: source.height });
  if (image.isEmpty()) throw new Error("The screen image could not be read.");
  return image.resize({ width: size.width, height: size.height, quality: "best" }).toPNG();
}
