import { createRequire } from "node:module";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { DesignCanvasKit } from "../gpu/canvaskit/canvaskit";
import { DesignGpuPictures, DesignGpuRasterizer } from "../gpu/design-gpu-rasterizer";
import { designGpuGrid, designGpuUnitRaster } from "../gpu/design-gpu-plan";
import type { DesignGpuRasterPicture, DesignGpuRasterUnit } from "../gpu/design-gpu-protocol";

const require = createRequire(import.meta.url);
const vendored = path.resolve(__dirname, "../gpu/canvaskit");
let ck: DesignCanvasKit;
beforeAll(async () => {
  const init = require(path.join(vendored, "canvaskit.js")) as (options: { locateFile(file: string): string }) => Promise<DesignCanvasKit>;
  ck = await init({ locateFile: (file) => path.join(vendored, file) });
});

const BLUE = [0, 0, 255, 255], RED = [255, 0, 0, 255], CLEAR = [0, 0, 0, 0];

/** A 200×100 CSS frame recorded at scale 2: blue fill, a red box at CSS
 * (50, 25)–(150, 75) and green drawing that spills past the frame's right edge. */
function frameRecording(key: string, layerOffset = { x: 0, y: 0 }): DesignGpuRasterPicture {
  const recorder = new ck.PictureRecorder();
  const canvas = recorder.beginRecording(ck.LTRBRect(0, 0, 400, 200));
  const paint = new ck.Paint();
  paint.setColor(ck.Color(0, 0, 255, 1)); canvas.drawRect(ck.LTRBRect(0, 0, 400, 200), paint);
  paint.setColor(ck.Color(255, 0, 0, 1)); canvas.drawRect(ck.LTRBRect(100, 50, 300, 150), paint);
  paint.setColor(ck.Color(0, 255, 0, 1)); canvas.drawRect(ck.LTRBRect(400, 0, 600, 200), paint);
  const picture = recorder.finishRecordingAsPicture();
  const bytes = picture.serialize()!;
  picture.delete(); paint.delete(); recorder.delete();
  return { key, scale: 2, width: 200, height: 100, layers: [{ ...layerOffset, bytes: bytes.slice().buffer }] };
}

function cpuBackend() {
  return {
    surface: (width: number, height: number) => ck.MakeSurface(width, height),
    finish: (surface: NonNullable<ReturnType<typeof ck.MakeSurface>>, width: number, height: number) => {
      const pixels = surface.getCanvas().readPixels(0, 0, { width, height, colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
      surface.delete();
      return { width, pixels };
    },
  };
}
const at = (output: { width: number; pixels: Uint8Array }, x: number, y: number) =>
  Array.from(output.pixels.subarray((y * output.width + x) * 4, (y * output.width + x) * 4 + 4));

function unit(picture: string, density: number, col: number, row: number, place = { x: 0, y: 0 }): DesignGpuRasterUnit {
  const grid = designGpuGrid({ width: 200, height: 100 }, density);
  return { key: `${picture}\0${density}\0${col}:${row}`, picture, kind: grid.kind === "sprite" ? "sprite" : "tile", density,
    raster: designGpuUnitRaster(grid, col, row), at: place };
}

describe("Design GPU pictures", () => {
  it("keeps deserialized pictures within a byte budget and deletes each evicted one", () => {
    const one = frameRecording("one"), size = one.layers[0]!.bytes.byteLength;
    const pictures = new DesignGpuPictures(ck, size * 2);
    expect(pictures.put([one, frameRecording("two")]).evicted).toEqual([]);
    const native = pictures.get("one")!.layers[0]!.picture as unknown as { isDeleted(): boolean };
    pictures.get("two");
    const release = pictures.pin(["one"]);
    // "one" is older, but a raster job is drawing it.
    expect(pictures.put([frameRecording("three")]).evicted).toEqual(["two"]);
    release();
    expect(pictures.put([frameRecording("four")]).evicted).toEqual(["one"]);
    expect(native.isDeleted()).toBe(true);
    expect(pictures.usage()).toMatchObject({ count: 2, bytes: size * 2, evicted: 2 });
    const broken = pictures.put([{ key: "broken", scale: 2, width: 1, height: 1, layers: [{ x: 0, y: 0, bytes: new Uint8Array(64).buffer }] }]);
    expect(broken.failed).toEqual([{ key: "broken", error: expect.stringMatching(/could not be read/) }]);
    pictures.dispose();
    expect(pictures.usage()).toMatchObject({ count: 0, bytes: 0 });
  });
});

describe("Design GPU rasterizer", () => {
  it("draws a frame's recording at the unit's density and staging position, clipped to the frame and the unit", () => {
    const pictures = new DesignGpuPictures(ck);
    pictures.put([frameRecording("frame")]);
    const rasterizer = new DesignGpuRasterizer(ck, pictures, cpuBackend());
    // A sprite at 0.5 device px per CSS px is the whole 100×50 frame.
    const result = rasterizer.raster({ width: 128, height: 96, units: [unit("frame", 0.5, 0, 0, { x: 10, y: 20 })], budgetMs: 1_000 });
    expect(result.done).toEqual(["frame\u00000.5\u00000:0"]);
    const output = result.output!;
    expect(at(output, 10 + 50, 20 + 25)).toEqual(RED);
    expect(at(output, 10 + 5, 20 + 5)).toEqual(BLUE);
    // The spill past the frame's right edge is clipped away, as is anything
    // outside the unit's own rectangle.
    expect(at(output, 10 + 99, 20 + 25)).toEqual(BLUE);
    expect(at(output, 10 + 101, 20 + 25)).toEqual(CLEAR);
    expect(at(output, 5, 5)).toEqual(CLEAR);
  });

  it("draws a gutter tile from the frame's device pixels at a high density", () => {
    const pictures = new DesignGpuPictures(ck);
    pictures.put([frameRecording("frame")]);
    const rasterizer = new DesignGpuRasterizer(ck, pictures, cpuBackend());
    // Density 4: the frame is 800×400 device px; tile (1, 0) starts one
    // gutter texel left of x = 510.
    const tile = unit("frame", 4, 1, 0);
    expect(tile.raster).toMatchObject({ x: 509, y: 0, width: 291, height: 400 });
    const output = rasterizer.raster({ width: 291, height: 400, units: [tile], budgetMs: 1_000 }).output!;
    expect(at(output, 0, 0)).toEqual(BLUE);
    // Frame device (590, 200) is CSS (147.5, 50): inside the red box.
    expect(at(output, 590 - 509, 200)).toEqual(RED);
    expect(at(output, 610 - 509, 200)).toEqual(BLUE);
  });

  it("places a layer at its recorded offset", () => {
    const pictures = new DesignGpuPictures(ck);
    pictures.put([frameRecording("offset", { x: 40, y: 20 })]);
    const output = new DesignGpuRasterizer(ck, pictures, cpuBackend())
      .raster({ width: 100, height: 50, units: [unit("offset", 0.5, 0, 0)], budgetMs: 1_000 }).output!;
    // Shifted by (20, 10) device px at density 0.5: the frame's top-left is
    // now clear (the layer starts there) and the red box moved with it.
    expect(at(output, 5, 5)).toEqual(CLEAR);
    expect(at(output, 50 + 20, 25 + 10)).toEqual(RED);
  });

  it("stops a burst at its time budget after the first unit and reports pictures it does not hold", () => {
    const pictures = new DesignGpuPictures(ck);
    pictures.put([frameRecording("frame")]);
    let clock = 0;
    const rasterizer = new DesignGpuRasterizer(ck, pictures, cpuBackend(), () => (clock += 5));
    const result = rasterizer.raster({ width: 256, height: 64, budgetMs: 1,
      units: [unit("frame", 0.5, 0, 0), unit("frame", 0.5, 0, 0, { x: 120, y: 0 }), unit("gone", 0.5, 0, 0)] });
    expect(result.done).toHaveLength(1);
    expect(result.missing).toEqual(["gone"]);
    expect(rasterizer.rasterMs.sprite).toHaveLength(1);
  });
});
