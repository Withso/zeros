import { createHash } from "node:crypto";
import { parse, serialize } from "parse5";
import { DESIGN_SURFACE_STATIC_CSS, designSurfaceReadyScript, type DesignSurfaceCost } from "@zeros/protocol/design-surface";
import { elementRecords, insertDesignHeadMarkup, sanitizeDesignFrameMarkup, withDesignTheme } from "./source";

/** Read dimensions without decoding image pixels. An unknown format is a
 * compatibility fallback, never an uncharged browser allocation. */
function rasterPixels(mime: string, bytes: Buffer): number | null {
  let width = 0, height = 0;
  if (mime === "png" && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mime === "gif" && bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) {
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
    // Animated raster assets need the existing still capture path.
    return null;
  } else if (mime === "webp" && bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      if (bytes[20]! & 2) return null;
      width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1;
    } else if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
  } else if ((mime === "jpeg" || mime === "jpg") && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 8 < bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1]!;
      if (marker === 0xff) { at++; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      const size = bytes.readUInt16BE(at + 2);
      if (size < 2) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        height = bytes.readUInt16BE(at + 5); width = bytes.readUInt16BE(at + 7); break;
      }
      at += size + 2;
    }
  }
  const pixels = width * height;
  return width > 0 && height > 0 && Number.isSafeInteger(pixels) ? pixels : null;
}

/** Metadata preparation can use stylesheet fragments without composing a
 * second full document. Source/DOM bounds are conservative estimates; native
 * RSS/CPU acceptance still qualifies the browser's real resource costs. */
export function designSurfaceCost(source: string, sheets: readonly { css: string; bytes?: number }[] = []): DesignSurfaceCost | null {
  // Imported styles can expose only their identity and byte count here. Their
  // image costs are unknown until composed; never treat an empty placeholder
  // as proof that a document has no raster assets.
  if (sheets.some(sheet => sheet.bytes !== undefined && sheet.bytes !== Buffer.byteLength(sheet.css))) return null;
  const sourceBytes = Buffer.byteLength(source) + sheets.reduce((sum, sheet) => sum + (sheet.bytes ?? Buffer.byteLength(sheet.css)), 0);
  if (sourceBytes > 1024 * 1024) return null;
  const document = parse(source);
  const records = elementRecords(document);
  if (records.some(({ element }) => ["video", "audio", "canvas"].includes(element.tagName))) return null;
  let imageBytes = 0;
  for (const raw of [serialize(document), ...sheets.map(sheet => sheet.css)]) {
    // Attribute entities and CSS escapes must not conceal a decoded image.
    const text = raw.replace(/\\([0-9a-f]{1,6})(?:[\t\n\r\f ])?|\\([^\n\r\f])/gi,
      (_match, hex: string | undefined, literal: string | undefined) => hex
        ? String.fromCodePoint(Math.min(0x10ffff, parseInt(hex, 16))) : literal!);
    const images = [...text.matchAll(/data:image\//gi)];
    const data = [...text.matchAll(/data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/=]+)/gi)];
    if (images.length !== data.length) return null;
    for (const match of data) {
      const bytes = Buffer.from(match[2]!, "base64");
      // APNG has no static display guarantee under the passive document.
      if (match[1]!.toLowerCase() === "png" && bytes.includes(Buffer.from("acTL"))) return null;
      const pixels = rasterPixels(match[1]!.toLowerCase(), bytes);
      if (pixels === null) return null;
      imageBytes += pixels * 8;
      if (!Number.isSafeInteger(imageBytes)) return null;
    }
  }
  return { sourceBytes, nodes: records.length, imageBytes };
}

export function prepareDesignSurfaceDocument(source: string, sourceVersion: string, theme: string | null): { html: string; csp: string } {
  const script = designSurfaceReadyScript(sourceVersion, theme, true);
  const csp = `default-src 'none'; script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'; ` +
    "style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; connect-src 'none'; " +
    "worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
  let html = sanitizeDesignFrameMarkup(source);
  if (theme !== null) html = withDesignTheme(html, theme);
  else {
    const root = elementRecords(parse(html, { sourceCodeLocationInfo: true })).find(({ element }) => element.tagName === "html")?.element;
    const attribute = root?.sourceCodeLocation?.attrs?.["data-zd-theme"];
    if (attribute) html = html.slice(0, attribute.startOffset) + html.slice(attribute.endOffset);
  }
  html = insertDesignHeadMarkup(html, `<style data-zeros-design-surface>${DESIGN_SURFACE_STATIC_CSS}</style><script data-zeros-design-surface>${script}</script>`);
  return { html, csp };
}
