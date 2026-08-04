import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  containedThumbnailSize,
  parseImageDimensions,
  probeImageDimensions,
} from "../image-dimensions";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function rotatedJpeg(width: number, height: number): Buffer {
  const exif = Buffer.alloc(32);
  exif.write("Exif\0\0", 0, "ascii");
  exif.write("II", 6, "ascii");
  exif.writeUInt16LE(42, 8);
  exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(1, 14);
  exif.writeUInt16LE(0x0112, 16);
  exif.writeUInt16LE(3, 18);
  exif.writeUInt32LE(1, 20);
  exif.writeUInt16LE(6, 24);

  const app1 = Buffer.alloc(4);
  app1.set([0xff, 0xe1]);
  app1.writeUInt16BE(exif.length + 2, 2);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0]);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, exif, sof]);
}

describe("parseImageDimensions", () => {
  it("reads common raster headers without decoding the source", () => {
    expect(parseImageDimensions(png(1_600, 900), ".png")).toEqual({
      width: 1_600,
      height: 900,
    });

    const gif = Buffer.from("GIF89a0000", "ascii");
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(200, 8);
    expect(parseImageDimensions(gif, ".gif")).toEqual({
      width: 320,
      height: 200,
    });

    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    webp.write("VP8X", 12, "ascii");
    webp.writeUIntLE(1_023, 24, 3);
    webp.writeUIntLE(511, 27, 3);
    expect(parseImageDimensions(webp, ".webp")).toEqual({
      width: 1_024,
      height: 512,
    });
  });

  it("uses EXIF orientation for portrait JPEG thumbnails", () => {
    expect(parseImageDimensions(rotatedJpeg(800, 600), ".jpg")).toEqual({
      width: 600,
      height: 800,
      orientation: 6,
    });
  });

  it("derives scalable-image dimensions from SVG and AVIF metadata", () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" viewBox="0 0 800 600"/>',
    );
    expect(parseImageDimensions(svg, ".svg")).toEqual({
      width: 400,
      height: 300,
    });

    const avif = Buffer.alloc(40);
    avif.writeUInt32BE(20, 0);
    avif.write("ftyp", 4, "ascii");
    avif.write("avif", 8, "ascii");
    avif.writeUInt32BE(20, 20);
    avif.write("ispe", 24, "ascii");
    avif.writeUInt32BE(3_840, 32);
    avif.writeUInt32BE(2_160, 36);
    expect(parseImageDimensions(avif, ".avif")).toEqual({
      width: 3_840,
      height: 2_160,
    });
  });

  it("rejects corrupt, zero, and implausible dimensions", () => {
    expect(
      parseImageDimensions(Buffer.from("not an image"), ".png"),
    ).toBeNull();
    expect(parseImageDimensions(png(0, 100), ".png")).toBeNull();
    expect(parseImageDimensions(png(1_000_001, 100), ".png")).toBeNull();

    const fakeBmp = Buffer.alloc(26);
    fakeBmp.writeInt32LE(320, 18);
    fakeBmp.writeInt32LE(200, 22);
    expect(parseImageDimensions(fakeBmp, ".bmp")).toBeNull();

    const fakeIco = Buffer.alloc(8);
    fakeIco[6] = 64;
    fakeIco[7] = 64;
    expect(parseImageDimensions(fakeIco, ".ico")).toBeNull();

    const fakeAvif = Buffer.alloc(20);
    fakeAvif.writeUInt32BE(20, 0);
    fakeAvif.write("ispe", 4, "ascii");
    fakeAvif.writeUInt32BE(640, 12);
    fakeAvif.writeUInt32BE(360, 16);
    expect(parseImageDimensions(fakeAvif, ".avif")).toBeNull();

    expect(
      parseImageDimensions(
        Buffer.from('<svg width="0.1" height="0.1"/>'),
        ".svg",
      ),
    ).toBeNull();
  });

  it("selects the largest embedded ICO representation", () => {
    const ico = Buffer.alloc(6 + 16 * 2);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(2, 4);
    ico[6] = 16;
    ico[7] = 16;
    ico[22] = 0;
    ico[23] = 0;

    expect(parseImageDimensions(ico, ".ico")).toEqual({
      width: 256,
      height: 256,
    });
  });
});

describe("probeImageDimensions", () => {
  it("finds a JPEG frame after more than 256 KiB of leading metadata", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zeros-image-probe-"));
    tempDirs.push(dir);
    const metadata = Array.from({ length: 5 }, () => {
      const segment = Buffer.alloc(60_004);
      segment.set([0xff, 0xe2]);
      segment.writeUInt16BE(60_002, 2);
      return segment;
    });
    const sof = Buffer.alloc(19);
    sof.set([0xff, 0xc0]);
    sof.writeUInt16BE(17, 2);
    sof[4] = 8;
    sof.writeUInt16BE(900, 5);
    sof.writeUInt16BE(1_600, 7);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), ...metadata, sof]);
    const file = path.join(dir, "large-metadata.jpg");
    writeFileSync(file, jpeg);

    expect(probeImageDimensions(file, jpeg.length, ".jpg")).toEqual({
      width: 1_600,
      height: 900,
    });
  });
});

describe("containedThumbnailSize", () => {
  it("fits landscape and portrait sources without changing their ratios", () => {
    expect(containedThumbnailSize({ width: 1_600, height: 900 }, 256)).toEqual({
      width: 256,
      height: 144,
    });
    expect(containedThumbnailSize({ width: 900, height: 1_600 }, 256)).toEqual({
      width: 144,
      height: 256,
    });
  });

  it("does not upscale small sources", () => {
    expect(containedThumbnailSize({ width: 80, height: 40 }, 256)).toEqual({
      width: 80,
      height: 40,
    });
  });
});
