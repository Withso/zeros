import { describe, expect, it } from "vitest";
import {
  designCaptureRequestSchema,
  designCaptureRasterSize,
} from "../design-capture";

const request = {
  version: 1,
  html: "<main>Frame</main>",
  revision: "revision",
  width: 390,
  height: 844,
};

describe("bounded Design capture viewports", () => {
  it("keeps existing capture requests valid without a separate layout viewport", () => {
    expect(designCaptureRequestSchema.parse(request)).toEqual({
      ...request,
      colorScheme: "light",
    });
  });

  it.each([
    [390, 844, 390, 844],
    [390.5, 844.25, 391, 845],
    [390, 3000, 266, 2048],
    [3000, 390, 2048, 266],
    [16384, 16384, 2048, 2048],
    [1, 16384, 1, 2048],
  ])(
    "bounds the %s × %s raster while preserving the separate layout",
    (width, height, rasterWidth, rasterHeight) => {
      const raster = designCaptureRasterSize({ width, height });
      expect(raster).toMatchObject({
        width: rasterWidth,
        height: rasterHeight,
      });
      expect(
        designCaptureRequestSchema.safeParse({
          ...request,
          width: raster.width,
          height: raster.height,
          layoutViewport: {
            width: Math.ceil(width),
            height: Math.ceil(height),
          },
        }).success,
      ).toBe(true);
    },
  );

  it.each([
    { width: 2049 },
    { width: 390.5 },
    { layoutViewport: { width: 390, height: 16385 } },
    { layoutViewport: { width: 390.5, height: 844 } },
    { width: 390, height: 2048, layoutViewport: { width: 390, height: 3000 } },
  ])("rejects unsupported or mismatched raster/layout bounds", (change) => {
    expect(
      designCaptureRequestSchema.safeParse({ ...request, ...change }).success,
    ).toBe(false);
  });
});
