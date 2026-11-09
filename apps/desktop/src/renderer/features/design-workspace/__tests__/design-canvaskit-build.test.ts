import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CanvasKit } from "canvaskit-wasm";

import { externalizeDesignPictureTypefaces } from "../../../../../shared/design-picture-typefaces";
import type { DesignCanvasKit } from "../gpu/canvaskit/canvaskit";
import {
  DESIGN_CANVASKIT_BUILD_FLAGS,
  DESIGN_CANVASKIT_SHA256,
  DESIGN_CANVASKIT_SKIA_REVISION,
  DESIGN_CANVASKIT_STOCK_SHA256,
} from "../gpu/canvaskit/design-canvaskit-build";

const require = createRequire(import.meta.url);
const vendored = path.resolve(__dirname, "../gpu/canvaskit");
const stockBin = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const geist = readFileSync(require.resolve("@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"));
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

type Init<T> = (options: { locateFile(file: string): string }) => Promise<T>;
let design: DesignCanvasKit;
let stock: CanvasKit;
beforeAll(async () => {
  design = await (require(path.join(vendored, "canvaskit.js")) as Init<DesignCanvasKit>)({ locateFile: (file) => path.join(vendored, file) });
  stock = await (require(path.join(stockBin, "canvaskit.js")) as Init<CanvasKit>)({ locateFile: (file) => path.join(stockBin, file) });
});

function textPicture(ck: CanvasKit): Uint8Array {
  const manager = ck.FontMgr.FromData(geist.buffer.slice(geist.byteOffset, geist.byteOffset + geist.byteLength))!;
  const font = new ck.Font(manager.matchFamilyStyle(manager.getFamilyName(0), {})!, 22);
  const paint = new ck.Paint();
  paint.setAntiAlias(true);
  const recorder = new ck.PictureRecorder();
  recorder.beginRecording(ck.LTRBRect(0, 0, 260, 60)).drawText("Recorded frame", 6, 40, paint, font);
  const picture = recorder.finishRecordingAsPicture();
  const bytes = picture.serialize()!;
  picture.delete(); recorder.delete(); paint.delete(); font.delete(); manager.delete();
  return bytes;
}

function pixels(ck: CanvasKit, bytes: Uint8Array): string | null {
  const picture = ck.MakePicture(bytes);
  if (!picture) return null;
  const surface = ck.MakeSurface(260, 60)!;
  surface.getCanvas().clear(ck.WHITE);
  surface.getCanvas().drawPicture(picture);
  const data = surface.getCanvas().readPixels(0, 0, { width: 260, height: 60, colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB })!;
  surface.delete(); picture.delete();
  return createHash("sha256").update(data).digest("hex");
}

function register(id: string, bytes: Uint8Array): boolean {
  const pointer = design._malloc(bytes.length);
  design.HEAPU8.set(bytes, pointer);
  return design._RegisterDesignTypeface(id, pointer, bytes.length);
}

describe("Vendored CanvasKit build", () => {
  it("is exactly the pinned build, and its stock pins describe the published npm package", () => {
    for (const [name, digest] of Object.entries(DESIGN_CANVASKIT_SHA256)) expect(sha256(path.join(vendored, name)), name).toBe(digest);
    for (const [name, digest] of Object.entries(DESIGN_CANVASKIT_STOCK_SHA256)) expect(sha256(path.join(stockBin, name)), name).toBe(digest);
    const script = readFileSync(path.join(vendored, "build.sh"), "utf8");
    expect(script).toContain(`SKIA_REVISION=${DESIGN_CANVASKIT_SKIA_REVISION}`);
    expect(script).toContain(`FLAGS="${DESIGN_CANVASKIT_BUILD_FLAGS.join(" ")}"`);
  });

  it("shares one typeface across every picture that embeds the same font", () => {
    design.ClearTypefaceCache();
    const bytes = textPicture(design);
    const pictures = Array.from({ length: 20 }, () => design.MakePicture(bytes));
    expect(pictures.every(Boolean)).toBe(true);
    expect(design.TypefaceCacheCount()).toBe(1);
    expect(pixels(design, bytes)).toBe(pixels(stock, bytes));
    for (const picture of pictures) picture!.delete();
  });

  it("draws an externalized picture from its registered font exactly like the stock picture, and fails it whole without one", async () => {
    const original = textPicture(stock);
    const { skp, typefaces } = await externalizeDesignPictureTypefaces(original);
    expect(typefaces).toHaveLength(1);
    const [{ id, bytes }] = typefaces as [{ id: string; bytes: Uint8Array }];
    design.UnregisterDesignTypeface(id);
    expect(design.MakePicture(skp)).toBeNull();
    expect(register(id, bytes)).toBe(true);
    expect(design.HasDesignTypeface(id)).toBe(true);
    expect(design.DesignTypefaceRegistryBytes()).toBeGreaterThanOrEqual(bytes.length);
    expect(pixels(design, skp)).toBe(pixels(stock, original));
    design.UnregisterDesignTypeface(id);
    expect(design.HasDesignTypeface(id)).toBe(false);
    expect(design.MakePicture(skp)).toBeNull();
  });
});
