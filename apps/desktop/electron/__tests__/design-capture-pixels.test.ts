import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ElectronApplication } from "@playwright/test";

const { launchNativeElectron } = createRequire(import.meta.url)(
  "../../../../scripts/design-native-electron.mjs",
);

interface PixelRequest {
  css: string;
  scaled: boolean;
  colorScheme: "light" | "dark";
}
interface PixelResult {
  size: { width: number; height: number };
  background: number[];
  paintedPixels: number;
  windows: number;
}

// BrowserWindow's default backing color is opaque even when the authored
// document is transparent. Qualify decoded pixels on a real native surface.
describe.runIf(process.platform === "darwin" || Boolean(process.env.DISPLAY))(
  "native Design capture canvas pixels",
  () => {
    let root: string;
    let app: ElectronApplication | undefined;
    beforeAll(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-capture-pixels-"));
      const entry = path.join(root, "probe.cjs");
      await build({
        stdin: {
          resolveDir: process.cwd(),
          contents: `
            const { app, BrowserWindow, nativeImage } = require("electron");
            const { startElectronDesignCapture } = require("./apps/desktop/electron/design-capture");
            app.setName("Zeros Capture Pixels Test");
            app.setPath("userData", ${JSON.stringify(root)});
            app.on("window-all-closed", () => {});
            const keepAlive = setInterval(() => {}, 1000);
            app.on("will-quit", () => clearInterval(keepAlive));
            globalThis.capturePixelsProbe = async ({ css, scaled, colorScheme }) => {
              const service = await startElectronDesignCapture();
              try {
                const response = await fetch(service.url + "/capture", {
                  method: "POST", signal: AbortSignal.timeout(10000),
                  headers: { Authorization: "Bearer " + service.token, "Content-Type": "application/json" },
                  body: JSON.stringify({ version: 1, revision: "canvas-pixels", colorScheme,
                    width: scaled ? 160 : 320, height: scaled ? 120 : 240,
                    ...(scaled ? { layoutViewport: { width: 320, height: 240 }, maxDimension: 160 } : {}),
                    html: '<!doctype html><html><head><style>body{margin:0}main{height:40px;color:rgb(20,40,60);font:20px monospace}' + css + '</style></head><body><main>Transparent text</main></body></html>' })
                });
                if (!response.ok) throw new Error("Capture failed: " + response.status);
                const reply = await response.json();
                const image = nativeImage.createFromBuffer(Buffer.from(reply.data, "base64"));
                const size = image.getSize(), pixels = image.toBitmap();
                const offset = ((size.height - 10) * size.width + size.width - 10) * 4;
                let paintedPixels = 0;
                for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) paintedPixels++;
                return { size, background: [...pixels.subarray(offset, offset + 4)], paintedPixels,
                  windows: BrowserWindow.getAllWindows().length };
              } finally { await service.stop(); }
            };
          `,
        },
        outfile: entry,
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron"],
        logLevel: "silent",
      });
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      app = await launchNativeElectron({
        args: [entry],
        env,
        timeout: 15_000,
      });
    }, 20_000);
    afterAll(async () => {
      await app?.close();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    const backgrounds = [
      { name: "transparent text", css: "html,body{background:transparent!important}", alpha: 0 },
      { name: "translucent body canvas", css: "body{background:rgba(200,40,20,.5)}", alpha: 128 },
      { name: "opaque body canvas", css: "body{background:blue}", alpha: 255, bgra: [255, 0, 0, 255] },
      { name: "root background precedence", css: "html{background:white}body{background:blue;height:40px}", alpha: 255, bgra: [255, 255, 255, 255] },
    ];
    for (const scaled of [false, true]) {
      for (const colorScheme of ["light", "dark"] as const) {
        it.each(backgrounds)(
          `preserves $name in ${colorScheme} ${scaled ? "scaled preview" : "native viewport"} capture`,
          async ({ css, alpha, bgra }) => {
            const result = await app!.evaluate(
              async (_electron, input: PixelRequest) => (
                globalThis as typeof globalThis & {
                  capturePixelsProbe(input: PixelRequest): Promise<PixelResult>;
                }
              ).capturePixelsProbe(input),
              { css, scaled, colorScheme },
            );
            expect(result.size).toEqual({ width: scaled ? 160 : 320, height: scaled ? 120 : 240 });
            expect(result.background[3]).toBe(alpha);
            if (bgra) expect(result.background).toEqual(bgra);
            expect(result.paintedPixels).toBeGreaterThan(0);
            if (alpha === 0) expect(result.paintedPixels).toBeLessThan(result.size.width * result.size.height / 4);
            expect(result.windows).toBe(0);
          },
          15_000,
        );
      }
    }
  },
);
