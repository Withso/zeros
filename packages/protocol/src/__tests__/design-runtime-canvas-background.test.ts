import { beforeAll, afterAll, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});
const source = DESIGN_RUNTIME_SOURCE;

it.each([
  { name: "short opaque body", css: "body{background:rgb(250,250,250)}" },
  {
    name: "short translucent body",
    css: "body{background:rgba(200,40,20,.5)}",
  },
  { name: "transparent frame", css: "body{background:transparent}" },
  {
    name: "root background precedence",
    css: "html{background:rgb(20,90,190)}body{background:rgb(190,30,40)}",
  },
  {
    name: "zero-alpha colored root",
    css: "html{background:rgba(30,200,90,0)}body{background:rgb(20,90,190)}",
  },
  {
    name: "child inherits a translucent body background",
    css: "body{background:rgba(200,40,20,.5)}main{background:inherit}",
  },
  {
    name: "pseudo-element inherits the body background",
    css: 'body{background:rgba(200,40,20,.5)}body::before{content:"";position:absolute;left:0;top:0;width:40px;height:40px;background:inherit}',
  },
  {
    name: "important pseudo-element inherits the body background",
    css: 'body{background:rgba(200,40,20,.5)}#frame-body::before{content:"";position:absolute;left:0;top:0;width:40px;height:40px;background:inherit!important}',
  },
  {
    name: "layered important pseudo-element inherits the body background",
    css: 'body{background:rgba(200,40,20,.5)}@layer authored{#frame-body::after{content:"";position:absolute;left:0;top:0;width:40px;height:40px;background:inherit!important}}',
  },
  {
    name: "root pseudo-element inherits the transparent root",
    css: 'body{background:rgba(200,40,20,.5)}html::before{content:"";position:absolute;left:0;top:0;width:40px;height:40px;background:inherit}',
  },
  {
    name: "plain text body",
    css: "body{background:rgba(200,40,20,.5);font:40px/40px monospace;color:transparent}",
    body: "AAAA",
  },
  {
    name: "first letter inherits the body background",
    css: "body{background:rgba(200,40,20,.5);font:40px/40px monospace;color:transparent}body::first-letter{background:inherit}",
    body: "AAAA",
  },
  {
    name: "first line inherits the body background",
    css: "body{background:rgba(200,40,20,.5);font:40px/40px monospace;color:transparent}body::first-line{background:inherit}",
    body: "AAAA",
  },
  {
    name: "paint-contained body",
    css: "body{contain:paint;background:rgb(20,90,190)}",
  },
  {
    name: "paint-contained root",
    css: "html{contain:paint}body{background:rgb(20,90,190)}",
  },
  { name: "hidden body", css: "body{display:none;background:rgb(20,90,190)}" },
])(
  "preserves canvas pixels for $name",
  async ({ css, body }) => {
    const page = await browser.newPage({
      viewport: { width: 320, height: 240 },
    });
    try {
      await page.setContent(
        `<!doctype html><html><head><style>body{margin:0}main{width:100%;height:40px}${css}</style></head><body id="frame-body">${body ?? '<main data-oid="frame"></main>'}</body></html>`,
      );
      const reference = (
        await page.screenshot({ omitBackground: true })
      ).toString("base64");
      const result = await page.evaluate(
        async ({ source, reference }) => {
          const sourceVersion = "c".repeat(24);
          (
            window as Window & { __zerosDesignSourceVersion?: string }
          ).__zerosDesignSourceVersion = sourceVersion;
          const channel = new MessageChannel();
          const response = new Promise<{ dataUrl: string }>(
            (resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error("Capture timed out")),
                5000,
              );
              channel.port1.onmessage = ({ data }) => {
                if (
                  data.type !== "response" ||
                  data.requestId !== "background-contract"
                )
                  return;
                clearTimeout(timer);
                if (data.ok) resolve(data.result);
                else reject(new Error(data.error?.message));
              };
            },
          );
          new Function(source)();
          channel.port1.start();
          window.postMessage(
            {
              protocol: "zeros-design-runtime",
              version: 2,
              type: "handshake",
              sourceVersion,
            },
            "*",
            [channel.port2],
          );
          channel.port1.postMessage({
            protocol: "zeros-design-runtime",
            version: 2,
            type: "request",
            sourceVersion,
            requestId: "background-contract",
            method: "captureScreenshot",
            args: {},
          });
          const captured = await response;
          channel.port1.close();
          const pixels = async (url: string) => {
            const image = new Image();
            image.src = url;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0);
            return [
              [10, 10],
              [100, 80],
              [10, 230],
            ].map(([x, y]) =>
              Array.from(context.getImageData(x, y, 1, 1).data),
            );
          };
          return {
            browser: await pixels("data:image/png;base64," + reference),
            captured: await pixels(captured.dataUrl),
          };
        },
        { source, reference },
      );
      expect(result.captured).toEqual(result.browser);
    } finally {
      await page.close();
    }
  },
  20_000,
);
