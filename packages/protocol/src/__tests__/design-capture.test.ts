import { describe, expect, it } from "vitest";
import {
  DESIGN_STATIC_RENDER_SCRIPT,
  DESIGN_STILL_TIMELINES_SOURCE,
  designCaptureRequestSchema,
  designCaptureRasterSize,
} from "../design-capture";
import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

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

describe("preview-sized Design capture rasters", () => {
  it.each([
    [1600, 1000, 384, 384, 240],
    [1040, 1648, 384, 242, 384],
    [200, 120, 384, 200, 120],
    [1600, 1000, 1280, 1280, 800],
  ])(
    "fits a %s × %s frame into a %s px preview raster",
    (width, height, maxDimension, rasterWidth, rasterHeight) => {
      const raster = designCaptureRasterSize({ width, height }, maxDimension);
      expect(raster).toMatchObject({ width: rasterWidth, height: rasterHeight });
      expect(
        designCaptureRequestSchema.safeParse({
          ...request,
          width: raster.width,
          height: raster.height,
          layoutViewport: { width, height },
          maxDimension,
        }).success,
      ).toBe(true);
    },
  );

  it("rejects a preview raster that does not match its maximum dimension", () => {
    expect(
      designCaptureRequestSchema.safeParse({
        ...request,
        width: 2048,
        height: 1280,
        layoutViewport: { width: 1600, height: 1000 },
        maxDimension: 384,
      }).success,
    ).toBe(false);
    expect(
      designCaptureRequestSchema.safeParse({ ...request, maxDimension: 4096 })
        .success,
    ).toBe(false);
  });
});

it("stills SVG SMIL timelines, marquees and media the way the canvas runtime does", async () => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<svg width="100" height="20"><rect width="10" height="20"><animate attributeName="x" from="0" to="90" dur="1s" repeatCount="indefinite"/></rect></svg>' +
      '<marquee>Loop</marquee><video muted loop></video>',
    );
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => (document.querySelector("svg") as SVGSVGElement).getCurrentTime());
    expect(before).toBeGreaterThan(0);
    await page.evaluate(() => {
      const state = window as unknown as { stopped: number; paused: number };
      state.stopped = 0;
      state.paused = 0;
      const stop = HTMLMarqueeElement.prototype.stop;
      HTMLMarqueeElement.prototype.stop = function () { state.stopped += 1; return stop.call(this); };
      const pause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.pause = function () { state.paused += 1; return pause.call(this); };
    });
    await page.evaluate(DESIGN_STATIC_RENDER_SCRIPT);
    const still = await page.evaluate(() => {
      const svg = document.querySelector("svg") as SVGSVGElement;
      const state = window as unknown as { stopped: number; paused: number };
      return { paused: svg.animationsPaused(), time: svg.getCurrentTime(), stopped: state.stopped, media: state.paused };
    });
    expect(still).toEqual({ paused: true, time: 0, stopped: 1, media: 1 });
  } finally {
    await browser.close();
  }
}, 20_000);


it("stills timelines with one definition in both capture hosts and the canvas runtime", () => {
  // A frame swaps between its picture and its live document on zoom and
  // reload; two copies could drift and show two different moments.
  expect(DESIGN_STATIC_RENDER_SCRIPT).toBe(`(${DESIGN_STILL_TIMELINES_SOURCE})()`);
  expect(DESIGN_RUNTIME_SOURCE).toContain(DESIGN_STILL_TIMELINES_SOURCE);
  expect(DESIGN_RUNTIME_SOURCE.match(/pauseAnimations\(\)/g)).toHaveLength(1);
});
