import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

describe("design capture logical viewport", () => {
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
  ])(
    "preserves $name",
    async ({ css, markup, crop, expected, captureNode }) => {
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
      } finally {
        await browser.close();
      }
    },
    20_000,
  );
});
