import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  pngSize,
  scaleScreenImage,
  screenReader,
  type ScreenImages,
  type ScreenPixels,
  type ScreenSize,
} from "../devices/screen-images";

function pngHeader(width: number, height: number): Buffer {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

const pixels = (width: number, height: number): ScreenPixels => ({
  pixels: Buffer.alloc(width * height * 4),
  width,
  height,
});

const POINTS: ScreenSize = { width: 402, height: 874 };

describe("pngSize", () => {
  it("reads a PNG's size from its header", () => {
    expect(pngSize(pngHeader(1206, 2622))).toEqual({ width: 1206, height: 2622 });
  });

  it("reads nothing from what isn't a PNG", () => {
    expect(pngSize(Buffer.from("not a png, and long enough to have a header"))).toBeNull();
    expect(pngSize(pngHeader(0, 2622))).toBeNull();
    expect(pngSize(pngHeader(1206, 2622).subarray(0, 20))).toBeNull();
  });
});

describe("screenReader", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "zeros-screens-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function reader(options: { frame?: ScreenPixels; capture?: Buffer | Error } = {}) {
    const scale = vi.fn((source: Buffer | ScreenPixels, size: ScreenSize) =>
      Buffer.from(`${Buffer.isBuffer(source) ? "capture" : "frame"} ${size.width}x${size.height}`),
    );
    const capture = vi.fn(async (_deviceId: string, file: string) => {
      if (options.capture instanceof Error) throw options.capture;
      await writeFile(file, options.capture ?? pngHeader(1206, 2622));
    });
    const read = screenReader({
      frame: () => options.frame ?? null,
      capture,
      scale,
      workDir: path.join(dir, "screens"),
    });
    return { read, scale, capture };
  }

  it("scales the frame the Simulator tab shows, without a capture", async () => {
    const { read, capture } = reader({ frame: pixels(603, 1311) });
    expect((await read("A", POINTS))?.toString()).toBe("frame 402x874");
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures the screen when no tab shows it, or its frame has fewer pixels than points", async () => {
    const { read, capture } = reader();
    expect((await read("A", POINTS))?.toString()).toBe("capture 402x874");
    expect(capture).toHaveBeenCalledWith("A", expect.stringMatching(/\.png$/));
    expect(path.dirname(capture.mock.calls[0]![1])).toBe(path.join(dir, "screens"));
    expect(await readdir(path.join(dir, "screens"))).toEqual([]);
    const small = reader({ frame: pixels(201, 437) });
    expect((await small.read("A", POINTS))?.toString()).toBe("capture 402x874");
  });

  it("leaves a turned screen to agent-device", async () => {
    const turnedFrame = reader({ frame: pixels(1311, 603) });
    expect(await turnedFrame.read("A", POINTS)).toBeNull();
    expect(turnedFrame.capture).not.toHaveBeenCalled();
    const turnedCapture = reader({ capture: pngHeader(2622, 1206) });
    expect(await turnedCapture.read("A", POINTS)).toBeNull();
    expect(turnedCapture.scale).not.toHaveBeenCalled();
    expect(await reader({ capture: Buffer.from("not a png") }).read("A", POINTS)).toBeNull();
  });

  it("removes a capture that failed", async () => {
    const { read } = reader({ capture: new Error("simctl failed") });
    await expect(read("A", POINTS)).rejects.toThrow("simctl failed");
    expect(await readdir(path.join(dir, "screens"))).toEqual([]);
  });
});

describe("scaleScreenImage", () => {
  function fakeImages(empty = false) {
    const resized: unknown[] = [];
    const image = {
      isEmpty: () => empty,
      resize: (options: unknown) => {
        resized.push(options);
        return { toPNG: () => Buffer.from("scaled") };
      },
    };
    const images = {
      createFromBuffer: vi.fn(() => image),
      createFromBitmap: vi.fn(() => image),
    };
    return { images: images as unknown as ScreenImages, calls: images, resized };
  }

  it("scales captures and BGRA frames to a PNG of the screen in points", () => {
    const { images, calls, resized } = fakeImages();
    const png = pngHeader(1206, 2622);
    expect(scaleScreenImage(images, png, POINTS).toString()).toBe("scaled");
    expect(calls.createFromBuffer).toHaveBeenCalledWith(png);
    const frame = pixels(6, 13);
    expect(scaleScreenImage(images, frame, POINTS).toString()).toBe("scaled");
    expect(calls.createFromBitmap).toHaveBeenCalledWith(frame.pixels, { width: 6, height: 13 });
    expect(resized).toEqual([
      { width: 402, height: 874, quality: "best" },
      { width: 402, height: 874, quality: "best" },
    ]);
  });

  it("refuses an image it can't read", () => {
    const { images } = fakeImages(true);
    expect(() => scaleScreenImage(images, Buffer.from("x"), POINTS)).toThrow(
      "The screen image could not be read.",
    );
  });
});
