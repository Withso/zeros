// ──────────────────────────────────────────────────────────
// Bounded image-dimension probe
// ──────────────────────────────────────────────────────────
// Electron's macOS thumbnail service accepts an exact width + height. Asking
// it for a square can therefore bake distortion into the returned bitmap
// before CSS object-fit ever sees it. This parser reads only a small prefix of
// supported files so the IPC command can request a contained, aspect-correct
// thumbnail without decoding the full source image in the main process.

import fs from "node:fs";

const MAX_PROBE_BYTES = 256 * 1024;
const MAX_DIMENSION = 1_000_000;

export interface ImageDimensions {
  width: number;
  height: number;
  /** JPEG EXIF orientation when present; 5–8 swap display axes. */
  orientation?: number;
}

function dimensions(width: number, height: number): ImageDimensions | null {
  const roundedWidth = Math.round(width);
  const roundedHeight = Math.round(height);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    roundedWidth <= 0 ||
    roundedHeight <= 0 ||
    roundedWidth > MAX_DIMENSION ||
    roundedHeight > MAX_DIMENSION
  ) {
    return null;
  }
  return { width: roundedWidth, height: roundedHeight };
}

function parseJpeg(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  let width = 0;
  let height = 0;
  let orientation = 1;

  const parseExifOrientation = (start: number, end: number): number | null => {
    if (
      start + 14 > end ||
      buffer.toString("ascii", start, start + 6) !== "Exif\0\0"
    ) {
      return null;
    }
    const tiff = start + 6;
    const byteOrder = buffer.toString("ascii", tiff, tiff + 2);
    const littleEndian = byteOrder === "II";
    if (!littleEndian && byteOrder !== "MM") return null;
    const read16 = (at: number) =>
      littleEndian ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at);
    const read32 = (at: number) =>
      littleEndian ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);
    if (read16(tiff + 2) !== 42) return null;
    const ifd = tiff + read32(tiff + 4);
    if (ifd + 2 > end) return null;
    const entries = read16(ifd);
    for (let index = 0; index < entries; index += 1) {
      const entry = ifd + 2 + index * 12;
      if (entry + 12 > end) return null;
      if (read16(entry) !== 0x0112) continue;
      if (read16(entry + 2) !== 3 || read32(entry + 4) < 1) return null;
      return read16(entry + 8);
    }
    return null;
  };

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (marker === 0xe1) {
      orientation =
        parseExifOrientation(offset + 2, offset + length) ?? orientation;
    } else if (startOfFrame.has(marker) && length >= 7) {
      height = buffer.readUInt16BE(offset + 3);
      width = buffer.readUInt16BE(offset + 5);
    }
    offset += length;
  }

  const result =
    orientation >= 5 && orientation <= 8
      ? dimensions(height, width)
      : dimensions(width, height);
  return result && orientation !== 1 ? { ...result, orientation } : result;
}

function parseWebp(buffer: Buffer): ImageDimensions | null {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const kind = buffer.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return dimensions(width, height);
  }
  if (
    kind === "VP8 " &&
    buffer[23] === 0x9d &&
    buffer[24] === 0x01 &&
    buffer[25] === 0x2a
  ) {
    return dimensions(
      buffer.readUInt16LE(26) & 0x3fff,
      buffer.readUInt16LE(28) & 0x3fff,
    );
  }
  if (kind === "VP8L" && buffer[20] === 0x2f) {
    const b1 = buffer[21]!;
    const b2 = buffer[22]!;
    const b3 = buffer[23]!;
    const b4 = buffer[24]!;
    return dimensions(
      1 + (((b2 & 0x3f) << 8) | b1),
      1 + ((b4 & 0x0f) << 10) + (b3 << 2) + (b2 >> 6),
    );
  }
  return null;
}

function parseSvg(buffer: Buffer): ImageDimensions | null {
  const source = buffer.toString("utf8");
  if (!/<svg\b/i.test(source)) return null;
  const numberAttribute = (name: string): number | null => {
    const match = source.match(
      new RegExp(
        `\\b${name}\\s*=\\s*["']\\s*([0-9]+(?:\\.[0-9]+)?)(?:px)?\\s*["']`,
        "i",
      ),
    );
    return match?.[1] ? Number(match[1]) : null;
  };
  let width = numberAttribute("width");
  let height = numberAttribute("height");
  const viewBox = source.match(
    /\bviewBox\s*=\s*["']\s*[-+\d.eE]+[ ,]+[-+\d.eE]+[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)\s*["']/i,
  );
  const viewWidth = viewBox?.[1] ? Number(viewBox[1]) : null;
  const viewHeight = viewBox?.[2] ? Number(viewBox[2]) : null;
  if (width == null && height == null && viewWidth && viewHeight) {
    width = viewWidth;
    height = viewHeight;
  } else if (width != null && height == null && viewWidth && viewHeight) {
    height = width * (viewHeight / viewWidth);
  } else if (height != null && width == null && viewWidth && viewHeight) {
    width = height * (viewWidth / viewHeight);
  }
  return dimensions(width ?? 0, height ?? 0);
}

function parseAvif(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 16 || buffer.toString("ascii", 4, 8) !== "ftyp") {
    return null;
  }
  const ftypSize = buffer.readUInt32BE(0);
  if (ftypSize < 16 || ftypSize > buffer.length) return null;
  let avifBrand = ["avif", "avis"].includes(buffer.toString("ascii", 8, 12));
  for (let brandOffset = 16; brandOffset + 4 <= ftypSize; brandOffset += 4) {
    if (
      ["avif", "avis"].includes(
        buffer.toString("ascii", brandOffset, brandOffset + 4),
      )
    ) {
      avifBrand = true;
      break;
    }
  }
  if (!avifBrand) return null;

  let offset = 0;
  while ((offset = buffer.indexOf("ispe", offset, "ascii")) >= 0) {
    if (offset >= 4 && offset + 16 <= buffer.length) {
      const boxSize = buffer.readUInt32BE(offset - 4);
      if (boxSize >= 20) {
        const result = dimensions(
          buffer.readUInt32BE(offset + 8),
          buffer.readUInt32BE(offset + 12),
        );
        if (result) return result;
      }
    }
    offset += 4;
  }
  return null;
}

/** Parse dimensions from a bounded file prefix. Exported for fixture tests. */
export function parseImageDimensions(
  buffer: Buffer,
  extension: string,
): ImageDimensions | null {
  const ext = extension.toLowerCase();
  if (
    ext === ".png" &&
    buffer.length >= 24 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    buffer.readUInt32BE(8) === 13 &&
    buffer.toString("ascii", 12, 16) === "IHDR"
  ) {
    return dimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  }
  if (
    ext === ".gif" &&
    buffer.length >= 10 &&
    /^GIF8[79]a$/.test(buffer.toString("ascii", 0, 6))
  ) {
    return dimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
  }
  if (
    ext === ".bmp" &&
    buffer.length >= 22 &&
    buffer.toString("ascii", 0, 2) === "BM"
  ) {
    const dibHeaderSize = buffer.readUInt32LE(14);
    if (dibHeaderSize === 12) {
      return dimensions(buffer.readUInt16LE(18), buffer.readUInt16LE(20));
    }
    if (dibHeaderSize >= 40 && buffer.length >= 26) {
      return dimensions(
        Math.abs(buffer.readInt32LE(18)),
        Math.abs(buffer.readInt32LE(22)),
      );
    }
    return null;
  }
  if (
    ext === ".ico" &&
    buffer.length >= 22 &&
    buffer.readUInt16LE(0) === 0 &&
    buffer.readUInt16LE(2) === 1
  ) {
    const count = buffer.readUInt16LE(4);
    if (count === 0 || buffer.length < 6 + count * 16) return null;
    let largest: ImageDimensions | null = null;
    for (let index = 0; index < count; index += 1) {
      const offset = 6 + index * 16;
      const candidate = dimensions(
        buffer[offset] || 256,
        buffer[offset + 1] || 256,
      );
      if (
        candidate &&
        (!largest ||
          candidate.width * candidate.height > largest.width * largest.height)
      ) {
        largest = candidate;
      }
    }
    return largest;
  }
  if (ext === ".jpg" || ext === ".jpeg") return parseJpeg(buffer);
  if (ext === ".webp") return parseWebp(buffer);
  if (ext === ".svg") return parseSvg(buffer);
  if (ext === ".avif") return parseAvif(buffer);
  return null;
}

/** Read at most 256 KiB, regardless of source size. */
export function probeImageDimensions(
  filePath: string,
  sourceBytes: number,
): ImageDimensions | null {
  const length = Math.min(MAX_PROBE_BYTES, Math.max(0, sourceBytes));
  if (length === 0) return null;
  const buffer = Buffer.allocUnsafe(length);
  let handle: number | null = null;
  try {
    handle = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(handle, buffer, 0, length, 0);
    return parseImageDimensions(
      buffer.subarray(0, bytesRead),
      filePath.slice(filePath.lastIndexOf(".")).toLowerCase(),
    );
  } catch {
    return null;
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

/** Fit inside a square without upscaling or changing aspect ratio. */
export function containedThumbnailSize(
  source: ImageDimensions,
  maxSize: number,
): ImageDimensions {
  const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}
