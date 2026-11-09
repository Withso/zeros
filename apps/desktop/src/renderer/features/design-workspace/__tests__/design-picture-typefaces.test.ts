import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CanvasKit, SkPicture } from "canvaskit-wasm";

import {
  DESIGN_TYPEFACE_REFERENCE_BYTES,
  designPictureTypefaceReferences,
  externalizeDesignPictureTypefaces,
  inspectDesignPictureTypefaces,
  internalizeDesignPictureTypefaces,
} from "../../../../../shared/design-picture-typefaces";

const require = createRequire(import.meta.url);
const canvasKitBin = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const geist = readFileSync(require.resolve("@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"));

let ck: CanvasKit;
beforeAll(async () => {
  const init = require("canvaskit-wasm/bin/canvaskit.js") as (options: { locateFile(file: string): string }) => Promise<CanvasKit>;
  ck = await init({ locateFile: (file) => path.join(canvasKitBin, file) });
});

/** A picture that draws text in Geist, optionally through a nested picture. */
function textPicture(options: { nested?: boolean } = {}): Uint8Array {
  const manager = ck.FontMgr.FromData(geist.buffer.slice(geist.byteOffset, geist.byteOffset + geist.byteLength))!;
  const typeface = manager.matchFamilyStyle(manager.getFamilyName(0), {})!;
  const paint = new ck.Paint();
  paint.setColor(ck.BLACK);
  paint.setAntiAlias(true);
  const draw = (canvas: ReturnType<InstanceType<typeof ck.PictureRecorder>["beginRecording"]>) => {
    for (const [index, size] of [20, 14].entries()) {
      const font = new ck.Font(typeface, size);
      canvas.drawText(`Recorded ${size}`, 8, 28 + index * 26, paint, font);
      font.delete();
    }
  };
  const recorder = new ck.PictureRecorder();
  let inner: SkPicture | null = null;
  if (options.nested) {
    // SkCanvas inlines a one-op picture; more ops keep it a nested picture,
    // which Skia serializes with its own copy of every typeface.
    const innerRecorder = new ck.PictureRecorder();
    const innerCanvas = innerRecorder.beginRecording(ck.LTRBRect(0, 0, 240, 80));
    draw(innerCanvas);
    innerCanvas.drawRect(ck.LTRBRect(0, 0, 4, 4), paint);
    inner = innerRecorder.finishRecordingAsPicture();
    innerRecorder.delete();
  }
  const canvas = recorder.beginRecording(ck.LTRBRect(0, 0, 240, 80));
  if (inner) { canvas.drawPicture(inner); canvas.drawRect(ck.LTRBRect(5, 5, 9, 9), paint); }
  else draw(canvas);
  const picture = recorder.finishRecordingAsPicture();
  const bytes = picture.serialize()!;
  picture.delete(); inner?.delete(); recorder.delete(); paint.delete(); manager.delete();
  return bytes;
}

function pixelsOf(bytes: Uint8Array): string {
  const picture = ck.MakePicture(bytes)!;
  const surface = ck.MakeSurface(240, 80)!;
  surface.getCanvas().clear(ck.WHITE);
  surface.getCanvas().drawPicture(picture);
  const pixels = surface.getCanvas().readPixels(0, 0, { width: 240, height: 80, colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB })!;
  surface.delete(); picture.delete();
  return createHash("sha256").update(pixels).digest("hex");
}

describe("Externalized typefaces in recorded pictures", () => {
  it("finds each embedded font file in the picture's typeface section", () => {
    const skp = textPicture();
    const records = inspectDesignPictureTypefaces(skp);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ reference: null, dataLength: geist.byteLength });
    expect(Buffer.from(skp.subarray(records[0]!.dataStart, records[0]!.dataStart + records[0]!.dataLength)).equals(geist)).toBe(true);
  });

  it("replaces font files with content-id references and restores them byte for byte", async () => {
    const skp = textPicture();
    const { skp: external, typefaces, skipped } = await externalizeDesignPictureTypefaces(skp);
    expect(skipped).toBeUndefined();
    const id = createHash("sha256").update(geist).digest("hex").slice(0, 32);
    expect(typefaces.map((typeface) => typeface.id)).toEqual([id]);
    expect(Buffer.from(typefaces[0]!.bytes).equals(geist)).toBe(true);
    expect(external.length).toBe(skp.length - geist.byteLength - 2 + DESIGN_TYPEFACE_REFERENCE_BYTES);
    expect(designPictureTypefaceReferences(external)).toEqual([id]);
    // Stock CanvasKit still parses the descriptor-only picture (its glyphs
    // need the font), and the inverse reproduces the original exactly.
    expect(ck.MakePicture(external)).not.toBeNull();
    const restored = internalizeDesignPictureTypefaces(external, (wanted) => wanted === id ? typefaces[0]!.bytes : null)!;
    expect(Buffer.from(restored).equals(Buffer.from(skp))).toBe(true);
    expect(pixelsOf(restored)).toBe(pixelsOf(skp));
    expect(internalizeDesignPictureTypefaces(external, () => null)).toBeNull();
  });

  it("uses a caller's content ids, so a recorder can skip hashing fonts it has seen", async () => {
    const skp = textPicture({ nested: true });
    const expected = createHash("sha256").update(geist).digest("hex").slice(0, 32);
    const seen: number[] = [];
    const cached = await externalizeDesignPictureTypefaces(skp, {
      contentId: async (bytes) => { seen.push(bytes.length); return expected; },
    });
    // Both records of the font asked once each; the default hashes the same.
    expect(seen).toEqual([geist.byteLength, geist.byteLength]);
    expect(cached.typefaces.map((typeface) => typeface.id)).toEqual([expected]);
    const hashed = await externalizeDesignPictureTypefaces(skp);
    expect(Buffer.from(cached.skp).equals(Buffer.from(hashed.skp))).toBe(true);
  });

  it("names every record of one font file by the same id, nested pictures included", async () => {
    const nested = textPicture({ nested: true });
    const records = inspectDesignPictureTypefaces(nested);
    expect(records.length).toBeGreaterThanOrEqual(2);
    const external = await externalizeDesignPictureTypefaces(nested);
    expect(external.typefaces).toHaveLength(1);
    expect(inspectDesignPictureTypefaces(external.skp).every((record) => record.dataLength === 0 || record.reference)).toBe(true);
    const restored = internalizeDesignPictureTypefaces(external.skp, () => external.typefaces[0]!.bytes)!;
    expect(Buffer.from(restored).equals(Buffer.from(nested))).toBe(true);
  });

  it("returns pictures without fonts, already externalized pictures and unknown structures unchanged", async () => {
    const recorder = new ck.PictureRecorder();
    const paint = new ck.Paint();
    recorder.beginRecording(ck.LTRBRect(0, 0, 10, 10)).drawRect(ck.LTRBRect(1, 1, 9, 9), paint);
    const picture = recorder.finishRecordingAsPicture();
    const plain = picture.serialize()!;
    picture.delete(); recorder.delete(); paint.delete();
    expect(await externalizeDesignPictureTypefaces(plain)).toEqual({ skp: plain, typefaces: [] });
    const once = await externalizeDesignPictureTypefaces(textPicture());
    const twice = await externalizeDesignPictureTypefaces(once.skp);
    expect(twice.typefaces).toEqual([]);
    expect(twice.skp).toBe(once.skp);
    const corrupt = textPicture().slice(0, 200);
    const result = await externalizeDesignPictureTypefaces(corrupt);
    expect(result.skp).toBe(corrupt);
    expect(result.skipped).toMatch(/truncated/i);
  });
});
