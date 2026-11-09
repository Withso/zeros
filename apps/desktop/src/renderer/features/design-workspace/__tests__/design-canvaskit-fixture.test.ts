import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CanvasKit } from "canvaskit-wasm";

import {
  designPictureTypefaceReferences,
  designTypefaceContentId,
  inspectDesignPictureTypefaces,
  internalizeDesignPictureTypefaces,
} from "../../../../../shared/design-picture-typefaces";
import type { DesignCanvasKit } from "../gpu/canvaskit/canvaskit";

// A frame recorded by Chromium 150 (Electron 43.8.3); provenance in the fixture's README.
const require = createRequire(import.meta.url);
const vendored = path.resolve(__dirname, "../gpu/canvaskit");
const stockBin = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const fixture = path.resolve(__dirname, "fixtures/chromium-150-recording");
const recording = new Uint8Array(readFileSync(path.join(fixture, "changes-conflicts.skp")));
const font = new Uint8Array(readFileSync(path.join(fixture, "LiberationSerif-Regular.ttf")));
const FONT_ID = "8e23ee1f0b1cce384c9d3f7c39b9ccda";
const WIDTH = 1434, HEIGHT = 1384;

type Init<T> = (options: { locateFile(file: string): string }) => Promise<T>;
let design: DesignCanvasKit;
let stock: CanvasKit;
beforeAll(async () => {
  design = await (require(path.join(vendored, "canvaskit.js")) as Init<DesignCanvasKit>)({ locateFile: (file) => path.join(vendored, file) });
  stock = await (require(path.join(stockBin, "canvaskit.js")) as Init<CanvasKit>)({ locateFile: (file) => path.join(stockBin, file) });
});

/** The picture drawn over white, and how many pixels it changed. */
function draw(ck: CanvasKit, bytes: Uint8Array): { digest: string; inked: number } | null {
  const picture = ck.MakePicture(bytes);
  if (!picture) return null;
  const surface = ck.MakeSurface(WIDTH, HEIGHT)!;
  surface.getCanvas().clear(ck.WHITE);
  surface.getCanvas().drawPicture(picture);
  const data = surface.getCanvas().readPixels(0, 0, { width: WIDTH, height: HEIGHT, colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
  surface.delete();
  picture.delete();
  let inked = 0;
  for (let index = 0; index < data.length; index += 4) if (data[index] !== 255 || data[index + 1] !== 255 || data[index + 2] !== 255) inked++;
  return { digest: createHash("sha256").update(data).digest("hex"), inked };
}

describe("Vendored CanvasKit and a real Chromium 150 recording", () => {
  it("is the recorder's single-layer format: SKP version 109 with one externalized font", async () => {
    expect(new TextDecoder().decode(recording.subarray(0, 8))).toBe("skiapict");
    expect(new DataView(recording.buffer, recording.byteOffset).getUint32(8, true)).toBe(109);
    expect(designPictureTypefaceReferences(recording)).toEqual([FONT_ID]);
    expect(inspectDesignPictureTypefaces(recording).map(({ familyName, reference }) => ({ familyName, reference })))
      .toEqual([{ familyName: "Liberation Serif", reference: FONT_ID }]);
    expect(await designTypefaceContentId(font)).toBe(FONT_ID);
  });

  it("draws it from the registered font exactly as stock CanvasKit draws it with the font embedded again", () => {
    design.UnregisterDesignTypeface(FONT_ID);
    // An unresolved reference fails the picture whole, never with fallback glyphs.
    expect(design.MakePicture(recording)).toBeNull();
    const pointer = design._malloc(font.length);
    design.HEAPU8.set(font, pointer);
    expect(design._RegisterDesignTypeface(FONT_ID, pointer, font.length)).toBe(true);
    try {
      const recorded = draw(design, recording)!;
      const embedded = internalizeDesignPictureTypefaces(recording, (id) => (id === FONT_ID ? font : null))!;
      expect(embedded.length).toBeGreaterThan(font.length);
      expect(designPictureTypefaceReferences(embedded)).toEqual([]);
      const reference = draw(stock, embedded)!;
      expect(recorded.digest).toBe(reference.digest);
      // The frame's text and fills, not an empty picture.
      expect(recorded.inked).toBeGreaterThan(10_000);
    } finally {
      design.UnregisterDesignTypeface(FONT_ID);
    }
  });
});
