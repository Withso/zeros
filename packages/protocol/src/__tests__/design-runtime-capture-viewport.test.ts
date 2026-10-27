import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

describe("design capture logical viewport", () => {
  it("acknowledges cancelled capture only after its pending encoder releases its resources", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
      await page.evaluate((source) => {
        document.body.innerHTML = '<main data-oid="target">Capture cleanup</main>';
        const host = window as typeof window & {
          __zerosDesignSourceVersion?: string;
          captureTest?: { messages: Array<{ type: string; requestId?: string; ok?: boolean; error?: { code: string } }>; port: MessagePort; release?: () => void };
        };
        host.__zerosDesignSourceVersion = "c".repeat(24);
        const channel = new MessageChannel();
        const state = host.captureTest = { messages: [], port: channel.port1 } as NonNullable<typeof host.captureTest>;
        const encode = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
          encode.call(this, (blob) => { state.release = () => callback(blob); }, ...args);
        };
        channel.port1.onmessage = ({ data }) => state.messages.push(data);
        channel.port1.start();
        new Function(source)();
        window.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake", sourceVersion: host.__zerosDesignSourceVersion }, "*", [channel.port2]);
        channel.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request", sourceVersion: host.__zerosDesignSourceVersion, requestId: "capture", method: "captureScreenshot", args: {} });
      }, DESIGN_RUNTIME_SOURCE);
      await page.waitForFunction(() => !!(window as unknown as { captureTest: { release?: () => void } }).captureTest.release);
      await page.evaluate(() => {
        const state = (window as unknown as { captureTest: { port: MessagePort } }).captureTest;
        const base = { protocol: "zeros-design-runtime", version: 2, sourceVersion: "c".repeat(24) };
        state.port.postMessage({ ...base, type: "cancel", requestId: "capture" });
        state.port.postMessage({ ...base, type: "request", requestId: "barrier", method: "getSnapshot", args: {} });
      });
      await page.waitForFunction(() => (window as unknown as { captureTest: { messages: Array<{ requestId?: string }> } }).captureTest.messages.some((message) => message.requestId === "barrier"));
      expect(await page.evaluate(() => (window as unknown as { captureTest: { messages: Array<{ requestId?: string }> } }).captureTest.messages.some((message) => message.requestId === "capture"))).toBe(false);
      await page.evaluate(() => (window as unknown as { captureTest: { release: () => void } }).captureTest.release());
      await page.waitForFunction(() => (window as unknown as { captureTest: { messages: Array<{ requestId?: string }> } }).captureTest.messages.some((message) => message.requestId === "capture"), undefined, { timeout: 1500 });
      expect(await page.evaluate(() => (window as unknown as { captureTest: { messages: Array<{ requestId?: string }> } }).captureTest.messages.find((message) => message.requestId === "capture"))).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    } finally {
      await browser.close();
    }
  }, 20_000);

  it.each([
    {
      name: "width and height media queries",
      css: "body{margin:0;background:rgb(20,90,190)}@media(max-width:900px),(max-height:500px){body{background:rgb(190,30,40)}}",
      markup:
        "<main data-oid='target' style='width:1280px;height:800px'></main>",
      crop: { x: 900, y: 600, width: 200, height: 100 },
      expected: [20, 90, 190],
      captureNode: false,
    },
    {
      name: "viewport-relative layout units",
      css: "body{margin:0;background:white}.surface{width:100vw;height:100vh;background:rgb(30,140,80)}",
      markup: "<main data-oid='target' class='surface'></main>",
      crop: { x: 900, y: 600, width: 200, height: 100 },
      expected: [30, 140, 80],
      captureNode: false,
    },
    {
      name: "media queries in a selected-node thumbnail",
      css: "body{margin:0}main{background:rgb(20,90,190)}@media(max-width:900px),(max-height:500px){main{background:rgb(190,30,40)}}",
      markup:
        "<main data-oid='target' style='position:absolute;left:900px;top:600px;width:200px;height:100px'></main>",
      crop: { x: 900, y: 600, width: 200, height: 100 },
      expected: [20, 90, 190],
      captureNode: true,
    },
    {
      name: "CSS geometry at extreme zoom",
      css: "body{margin:0;background:white}.hairline{position:absolute;left:101px;top:100px;width:1px;height:2px;background:black}",
      markup: "<main data-oid='target' class='hairline'></main>",
      crop: { x: 99.5, y: 100, width: 4, height: 2 },
      expected: [0, 0, 0],
      captureNode: false,
      highZoom: true,
    },
    {
      name: "root inherited colors and rem units with authored SVG styles",
      css: ":root{font-size:20px;color:rgb(20,90,190)}body{margin:0;background:white}svg{font-size:1px;color:red;width:1px;height:1px;position:absolute}main{position:absolute;left:100px;top:100px;width:1rem;height:1rem;background:currentColor}",
      markup: "<main data-oid='target'></main>",
      crop: { x: 110, y: 100, width: 16, height: 8 },
      expected: [20, 90, 190],
      captureNode: false,
    },
    {
      name: "capture geometry under important foreignObject style rules",
      css: "body{margin:0;background:white}svg{position:absolute;left:100px;top:100px}@layer authored{foreignObject{x:100px!important;y:100px!important;width:1px!important;height:1px!important;transform:translate(20px,20px)!important}}",
      markup: "<svg data-oid='target' xmlns='http://www.w3.org/2000/svg' width='2' height='1' viewBox='0 0 2 1'><rect x='.75' y='0' width='.5' height='1' fill='black'/></svg>",
      crop: { x: 100, y: 100, width: 2, height: 1 },
      expected: [0, 0, 0],
      captureNode: false,
      highZoom: true,
    },
    {
      name: "root canvas paint when capture wrappers resist authored SVG styles",
      css: ":root{background:rgb(20,90,190)}body{margin:0}svg{position:absolute;left:100px;top:100px;background:red}",
      markup: "<main data-oid='target'></main>",
      crop: { x: 0, y: 0, width: 200, height: 100 },
      expected: [20, 90, 190],
      captureNode: false,
    },
    {
      name: "subpixel SVG geometry at extreme zoom",
      css: "body{margin:0;background:white}svg{position:absolute;left:100px;top:100px}",
      markup: "<svg data-oid='target' xmlns='http://www.w3.org/2000/svg' width='2' height='1' viewBox='0 0 2 1'><rect x='.75' y='0' width='.5' height='1' fill='black'/></svg>",
      crop: { x: 100, y: 100, width: 2, height: 1 },
      expected: [0, 0, 0],
      captureNode: false,
      highZoom: true,
    },
  ])(
    "preserves $name",
    async ({ css, markup, crop, expected, captureNode, highZoom }) => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 800 },
        });
        const result = await page.evaluate(
          async ({ source, css, markup, crop, captureNode }) => {
            document.head.innerHTML = `<style>${css}</style>`;
            document.body.innerHTML = markup;
            const sourceVersion = "c".repeat(24);
            (
              window as Window & { __zerosDesignSourceVersion?: string }
            ).__zerosDesignSourceVersion = sourceVersion;
            const channel = new MessageChannel();
            const response = new Promise<{
              dataUrl: string;
              width: number;
              height: number;
            }>((resolve, reject) => {
              const timeout = window.setTimeout(
                () => reject(new Error("Capture timed out")),
                5000,
              );
              channel.port1.onmessage = (event) => {
                const message = event.data;
                if (
                  message.type !== "response" ||
                  message.requestId !== "logical-viewport"
                )
                  return;
                window.clearTimeout(timeout);
                if (message.ok) resolve(message.result);
                else
                  reject(new Error(message.error?.message ?? "Capture failed"));
              };
            });
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
              requestId: "logical-viewport",
              method: "captureScreenshot",
              args: captureNode
                ? { nodeId: "target", scale: 2 }
                : { crop, outputSize: { width: 800, height: 400 } },
            });
            const captured = await response;
            const image = new Image();
            image.src = captured.dataUrl;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0);
            const pixel = Array.from(
              context.getImageData(image.width / 2, image.height / 2, 1, 1)
                .data,
            );
            channel.port1.postMessage({
              protocol: "zeros-design-runtime",
              version: 2,
              type: "teardown",
              sourceVersion,
            });
            channel.port1.close();
            return {
              width: captured.width,
              height: captured.height,
              pixel,
              edges: [0.1, 0.9].map((fraction) => Array.from(context.getImageData(image.width * fraction, image.height / 2, 1, 1).data)),
              // Interpolating a small bitmap produces a wide gray band. A
              // source rerender has at most the two antialiased edge pixels.
              transitionPixels: Array.from(context.getImageData(0, image.height / 2, image.width, 1).data)
                .filter((value, index) => index % 4 === 0 && value > 0 && value < 255).length,
              layoutWidth: innerWidth,
              layoutHeight: innerHeight,
            };
          },
          { source: DESIGN_RUNTIME_SOURCE, css, markup, crop, captureNode },
        );
        expect(result.layoutWidth).toBe(1280);
        expect(result.layoutHeight).toBe(800);
        expect(result.width).toBe(captureNode ? 400 : 800);
        expect(result.height).toBe(captureNode ? 200 : 400);
        expect(result.pixel.slice(0, 3)).toEqual(expected);
        expect(result.pixel[3]).toBe(255);
        if (highZoom) {
          // Both the CSS box and subpixel SVG stroke paint 200 sharp output
          // pixels. CSS boxes keep Chromium's normal pixel-snapping semantics.
          expect(result.edges).toEqual([[255, 255, 255, 255], [255, 255, 255, 255]]);
          expect(result.transitionPixels).toBeLessThanOrEqual(2);
        }
      } finally {
        await browser.close();
      }
    },
    20_000,
  );
});
