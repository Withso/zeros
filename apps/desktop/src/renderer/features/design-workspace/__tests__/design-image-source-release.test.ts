import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, chromium, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve("apps/desktop/src/renderer/features/design-workspace");
const source = buildSync({ stdin: { contents: "export * from './design-source-vector'; export { rasterizeDesignVector } from './design-source-preview';", resolveDir: root }, bundle: true,
  write: false, format: "iife", globalName: "vectors", platform: "browser" }).outputFiles[0].text;

// Chromium 148+ (ImageSrcsetReselection) registers a document viewport
// listener for an img with no source candidate, even a detached one, and
// drops it only on insertion/removal or when a source returns. Playwright's
// Chromium 147 predates that, so every case also runs in the app's Electron.
async function openChromium() {
  const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
  return { page: await browser.newPage(), close: () => browser.close() };
}

async function openElectron() {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-image-release-"));
  const main = path.join(directory, "main.cjs");
  writeFileSync(main, `
    const { app, BrowserWindow } = require("electron");
    app.setPath("userData", ${JSON.stringify(path.join(directory, "user-data"))});
    app.commandLine.appendSwitch("js-flags", "--expose-gc");
    app.whenReady().then(() => {
      new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } }).loadURL("about:blank");
    });
  `);
  const env = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined));
  const app = await _electron.launch({
    executablePath: createRequire(import.meta.url)("electron") as unknown as string,
    args: [...(process.platform === "linux" ? ["--no-sandbox", "--ozone-platform=headless"] : []), main],
    env,
    timeout: 30_000,
  });
  return {
    page: await app.firstWindow(),
    close: async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

describe.each([
  ["Playwright Chromium", openChromium],
  ["the app's Electron", openElectron],
])("released source pictures in %s", (_engine, open) => {
  let page: Page;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ page, close } = await open());
    await page.setContent("<!doctype html><body></body>");
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      const w = window as any;
      w.svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="red"/></svg>';
      w.collected = async (refs: WeakRef<object>[]) => {
        for (let attempt = 0; attempt < 20 && refs.some(ref => ref.deref()); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 20));
          (globalThis as any).gc();
        }
        return refs.filter(ref => ref.deref()).length;
      };
      // A displayed source: decoded while attached, then detached by its display.
      w.displayed = async (url: string) => {
        const image = new Image();
        image.src = url; document.body.append(image); await image.decode(); image.remove();
        return image;
      };
    });
  }, 40_000);
  afterAll(async () => { await close?.(); });

  it("a picture the vector cache drops can be collected once nothing displays it", async () => {
    expect(await page.evaluate(async () => {
      const w = window as any, api = w.vectors;
      const cache = new api.DesignSourceVectorCache(new api.DesignSourceVectorBudget());
      const refs: WeakRef<object>[] = [];
      for (let index = 0; index < 4; index++) {
        const target = { workspaceId: "local-workspace", folder: "/repo", directoryId: "design", capability: "cap",
          file: `frames/${index}.html`, sourceVersion: `v${index}`, theme: null, width: 40, height: 30 };
        const request = cache.open(target);
        const lease = request.publish(w.svg);
        const image = await w.displayed(lease.url);
        lease.confirm(image); lease.release(); request.close();
        refs.push(new WeakRef(image));
      }
      cache.clear();
      await Promise.resolve();
      return w.collected(refs);
    })).toBe(0);
  });
  it("a rasterized preview's temporary picture can be collected", async () => {
    expect(await page.evaluate(async () => {
      const w = window as any, api = w.vectors, refs: WeakRef<object>[] = [];
      const NativeImage = window.Image;
      w.Image = function () { const image = new NativeImage(); refs.push(new WeakRef(image)); return image; };
      try {
        const url = api.designSourceVectorDataUrl(w.svg);
        for (let index = 0; index < 4; index++) await api.rasterizeDesignVector(url, 20, 15);
      } finally { w.Image = NativeImage; }
      return refs.length === 4 ? w.collected(refs) : -1;
    })).toBe(0);
  });
});
