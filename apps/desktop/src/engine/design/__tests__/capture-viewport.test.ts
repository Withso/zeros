import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  designCaptureRasterSize,
  designCaptureRequestSchema,
} from "@zeros/protocol/design-capture";
import {
  captureScaledDesignPng,
  prepareDesignCaptureViewport,
} from "../capture-viewport";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

it.each([
  { width: 390, height: 3000 },
  { width: 3000, height: 390 },
  { width: 16384, height: 16384 },
  { width: 1, height: 16384 },
  { width: 16384, height: 1 },
])(
  "captures the complete $width × $height layout in a bounded PNG",
  async (viewport) => {
    const { width, height } = designCaptureRasterSize(viewport);
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    try {
      const input = designCaptureRequestSchema.parse({
        version: 1,
        revision: "revision",
        html: "<main>Frame</main>",
        width,
        height,
        layoutViewport: viewport,
      });
      const session = await page.context().newCDPSession(page);
      await prepareDesignCaptureViewport(input, (params) =>
        session.send("Emulation.setDeviceMetricsOverride", params),
      );
      await page.setContent(
        "<style>html,body{margin:0}main{height:100vh;background:lime}@media(min-width:380px){main{background:linear-gradient(red 0 50%,blue 50% 100%)}}</style><main></main>",
      );
      expect(
        await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      ).toEqual(viewport);
      const bytes = await captureScaledDesignPng(input, (params) =>
        session.send("Page.captureScreenshot", params),
      );
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([
        width,
        height,
      ]);
      if (width > 1 && height > 1) {
        const pixels = await page.evaluate(async (data) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return [2, image.height - 3].flatMap((y) =>
            [2, Math.floor(image.width / 2), image.width - 3].map((x) => [
              ...context.getImageData(x, y, 1, 1).data,
            ]),
          );
        }, bytes.toString("base64"));
        // Red/blue proves both responsive layout and the bottom of the frame
        // survive: resizing its viewport to 266px would instead paint lime.
        expect(pixels).toEqual([
          [255, 0, 0, 255],
          [255, 0, 0, 255],
          [255, 0, 0, 255],
          [0, 0, 255, 255],
          [0, 0, 255, 255],
          [0, 0, 255, 255],
        ]);
      }
    } finally {
      await page.close();
    }
  },
);
