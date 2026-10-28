import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { designSourceTileColors } from "../../../../../../../scripts/fixtures/design-source-tile-colors";

const root = path.resolve("apps/desktop/src/renderer/features/design-workspace");
const source = buildSync({ stdin: { contents: `export * from './design-source-tiles'; export * from './design-source-scene';
  export * from './design-canvas-camera';`, resolveDir: root }, bundle: true,
  write: false, format: "iife", globalName: "tiles", platform: "browser" }).outputFiles[0].text;
const css = readFileSync(path.join(root, "design-workspace-ui.css"), "utf8");
const { readNativeDesignCoverage } = createRequire(import.meta.url)("../../../../../../../scripts/design-native-view.mjs");
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 480, height: 360 }, deviceScaleFactor: 2 });
  await page.setContent(`<style>body{margin:0;background:white} article{position:absolute;background:var(--fixture-background)} img{position:absolute;inset:0;width:100%;height:100%;object-fit:none;object-position:left top}</style>
    <div id="viewport" data-design-canvas-viewport style="position:relative;width:480px;height:360px;overflow:hidden">
      <div id="world" data-design-canvas-world style="position:absolute;inset:0;transform-origin:0 0"></div>
    </div>`);
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: source });
  await page.evaluate((colors) => {
    (window as any).tileColors = colors;
    const api = (window as any).tiles;
    (window as any).stopChrome = api.observeDesignCanvasChrome(document.querySelector("#world"));
    (window as any).releases = [];
    (window as any).paint = (view = { zoom: 1, panX: 0, panY: 0 }) => api.paintDesignCanvasCamera(
      document.querySelector("#world"), view, true, { width: 480, height: 360 });
    (window as any).add = async (row: any) => {
      const article = document.createElement("article");
      article.dataset.designFrame = row.key;
      article.style.cssText = `left:${row.x}px;top:${row.y}px;width:${row.width}px;height:${row.height}px;z-index:${row.z};--fixture-background:${row.background ?? "transparent"}`;
      if (row.protected) { article.dataset.designFrameChromeProtected = ""; article.dataset.designFrameStackProtected = ""; }
      if (row.compact) article.dataset.designFrameCompactControls = "";
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${btoa(row.svg ?? `<svg xmlns="http://www.w3.org/2000/svg" width="${row.width}" height="${row.height}"><rect x="8" y="8" width="${row.width - 16}" height="${row.height - 16}" fill="${row.color}"/></svg>`)}`;
      await image.decode(); article.append(image);
      if (row.chrome) {
        const chrome = document.createElement("div"); chrome.dataset.designFrameChrome = "";
        chrome.style.cssText = "position:absolute;left:0;bottom:100%;width:100%;height:30px;background:" + colors.chrome;
        article.append(chrome);
      }
      document.querySelector("#world")!.append(article);
      return { image, article };
    };
  }, designSourceTileColors);
  return page;
}

async function changed(page: Page, before: Buffer, after: Buffer): Promise<number> {
  return page.evaluate(async ({ before, after }) => {
    const read = async (data: string) => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const a = await read(before), b = await read(after);
    if (a.length !== b.length) throw new Error("Screenshot dimensions changed");
    let count = 0;
    for (let i = 0; i < a.length; i += 4)
      if ([0, 1, 2, 3].some(c => Math.abs(a[i + c] - b[i + c]) > 3)) count++;
    return count;
  }, { before: before.toString("base64"), after: after.toString("base64") });
}

it("batches disjoint frames while preserving DOM hit targets, alpha and the frame's themed background", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.rows = [await w.add({ key: "personal/a", x: 20, y: 55, width: 120, height: 160, z: 0, color: w.tileColors.blueAlpha, background: w.tileColors.lightBackground, chrome: true }),
        await w.add({ key: "org/b", x: 220, y: 55, width: 120, height: 160, z: 1, color: w.tileColors.orangeAlpha, chrome: true })];
      w.paint();
    });
    const before = await page.screenshot();
    await page.evaluate(() => {
      const w = window as any;
      w.releases = w.rows.map((row: any, i: number) => w.tiles.attachDesignSourceTiles(row.image, `owner-${i}`));
    });
    expect(await page.locator("[data-design-source-plane]").count()).toBe(1);
    expect(await page.locator("[data-design-source-tiled]").count()).toBe(2);
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(12);
    expect(await page.evaluate(() => document.elementFromPoint(40, 100)?.closest("article")?.dataset.designFrame)).toBe("personal/a");
  } finally { await page.close(); }
});

it("qualifies the displayed GPU output and exact source together, refusing a hidden or missing output", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      document.body.dataset.designRetainedWorkspace = "owner"; document.body.setAttribute("aria-hidden", "false");
      w.row = await w.add({ key: "coverage", x: 20, y: 55, width: 120, height: 160, z: 0, color: "blue" });
      w.row.image.dataset.designSourceReady = "";
      w.paint();
    });
    expect(await readNativeDesignCoverage(page)).toEqual({ id: "owner", frames: 1, covered: 1 });
    await page.evaluate(() => { const w = window as any; w.release = w.tiles.attachDesignSourceTiles(w.row.image, "owner/version"); });
    expect(await readNativeDesignCoverage(page)).toEqual({ id: "owner", frames: 1, covered: 1 });
    await page.evaluate(() => { const w = window as any; w.anchor = document.querySelector('[data-design-source-tiled]'); delete w.anchor.designSourceImage; });
    expect((await readNativeDesignCoverage(page)).covered).toBe(0);
    await page.evaluate(() => { const w = window as any; w.anchor.designSourceImage = w.row.image; });
    expect((await readNativeDesignCoverage(page)).covered).toBe(1);
    await page.locator("[data-design-source-plane]").evaluate(node => { (node as HTMLElement).hidden = true; });
    expect((await readNativeDesignCoverage(page)).covered).toBe(0);
    await page.locator("[data-design-source-plane]").evaluate(node => { (node as HTMLElement).hidden = false; });
    expect((await readNativeDesignCoverage(page)).covered).toBe(1);
    await page.locator("[data-design-source-plane]").evaluate(node => node.remove());
    expect((await readNativeDesignCoverage(page)).covered).toBe(0);
    await page.evaluate(() => (window as any).release());
    expect((await readNativeDesignCoverage(page)).covered).toBe(1);
    await page.locator("body").evaluate(node => node.setAttribute("aria-hidden", "true"));
    expect((await readNativeDesignCoverage(page)).covered).toBe(0);
  } finally { await page.close(); }
});

it("presents camera changes directly without allocating an intermediate bitmap for every displayed frame", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "direct", x: 20, y: 55, width: 120, height: 160, z: 0, color: "blue" });
      w.paint();
      w.bitmapTransfers = 0;
      const transfer = OffscreenCanvas.prototype.transferToImageBitmap;
      OffscreenCanvas.prototype.transferToImageBitmap = function() {
        w.bitmapTransfers++; return transfer.call(this);
      };
    });
    const before = await page.screenshot();
    await page.evaluate(() => {
      const w = window as any;
      w.release = w.tiles.attachDesignSourceTiles(w.row.image, "owner/direct");
      for (let i = 0; i < 10; i++) w.paint({ zoom: 1 + i / 10, panX: -i, panY: i });
      w.paint();
    });
    expect(await page.evaluate(() => (window as any).bitmapTransfers)).toBe(0);
    expect(await page.locator("[data-design-source-plane]").count()).toBe(1);
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(12);
  } finally { await page.close(); }
});

it("transfers the one display canvas between owners without displacing a simultaneously visible fallback", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.a = await w.add({ key: "personal/direct", x: 0, y: 0, width: 120, height: 160, z: 0, color: "blue" });
      w.b = await w.add({ key: "organization/direct", x: 0, y: 0, width: 120, height: 160, z: 0, color: "red" });
      const viewport = document.querySelector("#viewport")!.cloneNode(false) as HTMLElement;
      viewport.id = "second-viewport";
      viewport.style.cssText = "position:absolute;left:240px;top:0;width:240px;height:360px;overflow:hidden";
      const world = document.createElement("div");
      world.id = "second-world"; world.dataset.designCanvasWorld = "";
      world.style.cssText = "position:absolute;inset:0;transform-origin:0 0";
      viewport.append(world); document.body.append(viewport); world.append(w.b.article);
      w.tiles.observeDesignCanvasChrome(world);
      w.paint(); w.tiles.paintDesignCanvasCamera(world, { zoom: 1, panX: 0, panY: 0 }, false, { width: 240, height: 360 });
      w.releaseA = w.tiles.attachDesignSourceTiles(w.a.image, "personal/direct");
      w.releaseB = w.tiles.attachDesignSourceTiles(w.b.image, "organization/direct");
    });
    expect(await page.locator("[data-design-source-plane]").count()).toBe(1);
    expect(await page.locator("#second-world img").count()).toBe(1);
    const before = await page.screenshot();
    await page.evaluate(() => (window as any).releaseA());
    await page.waitForFunction(() => !!document.querySelector("#second-viewport [data-design-source-plane]"));
    expect(await page.locator("[data-design-source-plane]").count()).toBe(1);
    expect(await page.locator("#world img").count()).toBe(1);
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(12);
  } finally { await page.close(); }
});

it("reuses the viewport allocation and exact source anchors across warm owner handoffs, then retires hidden output", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.rows = [await w.add({ key: "personal/warm", x: 20, y: 55, width: 120, height: 160, z: 0, color: "blue" }),
        await w.add({ key: "organization/warm", x: 20, y: 55, width: 120, height: 160, z: 0, color: "red" })];
      const first = document.querySelector("#world") as HTMLDivElement;
      const second = first.cloneNode(false) as HTMLDivElement;
      second.id = "second-world"; second.hidden = true;
      first.parentElement!.append(second); second.append(w.rows[1].article);
      w.worlds = [first, second]; w.active = 0;
      for (const [index, world] of w.worlds.entries()) {
        w.rows[index].image.dataset.designSourceKey = w.rows[index].article.dataset.designFrame;
        w.tiles.paintDesignCanvasCamera(world, { zoom: 1, panX: 0, panY: 0 }, false, { width: 480, height: 360 });
      }
    });
    const personal = await page.screenshot();
    await page.evaluate(() => { const w = window as any; w.worlds[0].hidden = true; w.worlds[1].hidden = false; });
    const organization = await page.screenshot();
    await page.evaluate(async () => {
      const w = window as any;
      w.worlds[0].hidden = false; w.worlds[1].hidden = true;
      w.release = w.tiles.attachDesignSourceTiles(w.rows[0].image, "personal/warm");
      await Promise.resolve();
      w.anchors = [w.rows[0].image.designSourceAnchor, null];
      w.output = document.querySelector("[data-design-source-plane]"); w.dimensionWrites = [];
      for (const name of ["width", "height"]) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name)!;
        Object.defineProperty(w.output, name, { configurable: true,
          get() { return descriptor.get!.call(this); },
          set(value) { w.dimensionWrites.push([name, value]); descriptor.set!.call(this, value); },
        });
      }
      w.handoffs = [];
      w.switchOwner = async () => {
        const old = w.rows[w.active];
        w.release(); w.worlds[w.active].hidden = true;
        const restored = old.article.firstChild === old.image && !old.image.hasAttribute("data-design-source-tiled");
        w.active = 1 - w.active; w.worlds[w.active].hidden = false;
        // A destination can attach in the commit's remaining microtasks.
        await Promise.resolve();
        const row = w.rows[w.active];
        row.image.dataset.designSourceRevision = String(w.handoffs.length);
        w.release = w.tiles.attachDesignSourceTiles(row.image, row.article.dataset.designFrame);
        await Promise.resolve();
        const anchor = row.image.designSourceAnchor;
        w.anchors[w.active] ??= anchor;
        w.handoffs.push({ restored, sameOutput: document.querySelector("[data-design-source-plane]") === w.output,
          sameAnchor: anchor === w.anchors[w.active], exactImage: anchor.designSourceImage === row.image,
          key: anchor.dataset.designSourceKey, revision: anchor.dataset.designSourceRevision });
      };
      await w.switchOwner();
    });
    expect(await changed(page, organization, await page.screenshot())).toBeLessThan(12);
    await page.evaluate(async () => {
      const w = window as any;
      for (let i = 1; i < 12; i++) await w.switchOwner();
      w.foreignReleased = w.tiles.designSourceTiles.releaseOutput({});
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(await changed(page, personal, await page.screenshot())).toBeLessThan(12);
    const result = await page.evaluate(() => { const w = window as any; return {
      writes: w.dimensionWrites, handoffs: w.handoffs, foreignReleased: w.foreignReleased,
      output: w.tiles.designSourceSceneUsage(), backingBytes: w.tiles.designSourceTiles.usage().backingBytes,
    }; });
    expect(result.writes).toEqual([]);
    expect(result.handoffs).toEqual(Array.from({ length: 12 }, (_, index) => ({ restored: true, sameOutput: true,
      sameAnchor: true, exactImage: true, key: index % 2 ? "personal/warm" : "organization/warm", revision: String(index) })));
    expect(result.foreignReleased).toBe(false);
    expect(result.output).toMatchObject({ activeScenes: 1, outputPlanes: 1 });
    expect(result.backingBytes).toBe(480 * 360 * 2 ** 2 * 4);
    const retired = await page.evaluate(async () => {
      const w = window as any; w.release();
      await new Promise(resolve => setTimeout(resolve, 0));
      return { usage: w.tiles.designSourceTiles.usage(), scene: w.tiles.designSourceSceneUsage() };
    });
    expect(retired.usage).toMatchObject({ backingBytes: 4, scratchBytes: 4, waiting: 0, speculativeBytes: 0 });
    expect(retired.scene).toMatchObject({ activeScenes: 0, outputPlanes: 0, outputBytes: 0 });
  } finally { await page.close(); }
});

it("retains unchanged composed pixels across repeated camera and chrome notifications while applying same-task geometry", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "stable", x: 20, y: 55, width: 120, height: 160, z: 0, color: "blue", compact: true });
      w.paint(); w.releases.push(w.tiles.attachDesignSourceTiles(w.row.image, "owner/stable"));
    });
    const before = await page.screenshot();
    const draws = await page.evaluate(() => (window as any).tiles.designSourceTiles.usage().draws);
    await page.evaluate(() => {
      const w = window as any;
      w.paint(); w.paint(); w.tiles.repaintDesignCanvasPixels(document.querySelector("#world"));
    });
    expect(await page.evaluate(() => (window as any).tiles.designSourceTiles.usage().draws)).toBe(draws);
    expect(await changed(page, before, await page.screenshot())).toBe(0);
    await page.evaluate(() => {
      const w = window as any;
      w.row.article.style.left = "180px";
      // A resize/move is authoritative before any MutationObserver callback.
      w.paint();
    });
    expect(await changed(page, before, await page.screenshot())).toBeGreaterThan(1000);
    const moved = await page.evaluate(() => (window as any).tiles.designSourceTiles.usage().draws);
    expect(moved).toBe(draws + 1);
    await page.evaluate(() => (window as any).paint({ zoom: 2, panX: -180, panY: 0 }));
    expect(await page.evaluate(() => (window as any).tiles.designSourceTiles.usage().draws)).toBe(moved + 1);
  } finally { await page.close(); }
});

it("keeps offscreen completed sources in the tiled path until their display owner retires", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "return", x: 20, y: 55, width: 120, height: 160, z: 0, color: "blue", compact: true });
      w.paint(); w.release = w.tiles.attachDesignSourceTiles(w.row.image, "owner/return");
    });
    const before = await page.screenshot();
    await page.evaluate(() => (window as any).paint({ zoom: 1, panX: -1000, panY: 0 }));
    expect(await page.locator("[data-design-frame-tiled]").count()).toBe(1);
    expect(await page.locator("[data-design-source-tiled]").count()).toBe(1);
    expect(await page.locator("[data-design-source-plane]").count()).toBe(0);
    await page.evaluate(() => (window as any).paint());
    expect(await changed(page, before, await page.screenshot())).toBe(0);
    await page.evaluate(() => (window as any).release());
    expect(await page.locator("[data-design-source-tiled]").count()).toBe(0);
    expect(await page.locator("[data-design-frame-tiled]").count()).toBe(0);
  } finally { await page.close(); }
});

it("disconnects a composed SVG without adopting or reloading it, then restores the exact source for editing", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "parked", x: 20, y: 55, width: 120, height: 160, z: 0, color: "blue", chrome: true });
      w.row.image.dataset.designSourceReady = "";
      w.row.image.dataset.designSourceBuffer = "displayed";
      w.row.image.dataset.designSourceVersion = "confirmed-generation";
      w.loads = 0; w.row.image.addEventListener("load", () => w.loads++);
      w.paint();
    });
    const before = await page.screenshot();
    await page.evaluate(() => { const w = window as any; w.loads = 0; w.release = w.tiles.attachDesignSourceTiles(w.row.image, "personal/parked"); });
    expect(await page.evaluate(() => {
      const { image } = (window as any).row;
      return { connected: image.isConnected, document: image.ownerDocument === document, ready: image.complete, width: image.naturalWidth };
    })).toEqual({ connected: false, document: true, ready: true, width: 120 });
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(12);
    expect(await page.locator('[data-design-source-tiled][data-design-source-ready][data-design-source-version="confirmed-generation"]').count()).toBe(1);
    await page.evaluate(() => { const w = window as any; w.row.article.dataset.designFrameStackProtected = ""; w.paint(); });
    expect(await page.evaluate(() => { const w = window as any; return { first: w.row.article.firstChild === w.row.image, connected: w.row.image.isConnected, loads: w.loads }; })).toEqual({ first: true, connected: true, loads: 0 });
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(12);
    await page.evaluate(() => { const w = window as any; delete w.row.article.dataset.designFrameStackProtected; w.paint(); });
    expect(await page.evaluate(() => (window as any).row.image.isConnected)).toBe(false);
    await page.evaluate(() => (window as any).release());
    expect(await page.evaluate(() => { const w = window as any; return w.row.article.firstChild === w.row.image && w.row.image.isConnected && w.loads === 0; })).toBe(true);
    expect(await page.locator('[data-design-source-tiled]').count()).toBe(0);
  } finally { await page.close(); }
});

it("keeps compact frame pixels while admitting DOM hit geometry on pointer and keyboard intent", async () => {
  const page = await open();
  try {
    await page.mouse.move(470, 340);
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "compact", x: 20, y: 55, width: 120, height: 160, z: 0, color: "blue", compact: true });
      w.row.article.insertAdjacentHTML("beforeend", '<div data-design-frame-chrome data-design-controls style="position:absolute;bottom:100%;height:28px;transform-origin:0 100%;transform:scale(var(--design-canvas-inverse-zoom))"><button>Play compact</button></div>');
      w.paint(); w.releases.push(w.tiles.attachDesignSourceTiles(w.row.image, "owner/compact"));
    });
    const frame = page.locator('[data-design-frame="compact"]');
    expect(await frame.evaluate(element => element.getBoundingClientRect().width)).toBe(0);
    const before = await page.screenshot();
    await page.mouse.move(70, 110);
    expect(await frame.evaluate(element => element.getBoundingClientRect().width)).toBe(120);
    expect(await page.evaluate(() => document.elementFromPoint(70, 110)?.closest("article")?.dataset.designFrame)).toBe("compact");
    await page.mouse.move(470, 340);
    expect(await frame.evaluate(element => element.getBoundingClientRect().width)).toBe(0);
    expect(await changed(page, before, await page.screenshot())).toBe(0);
    await frame.locator("button").focus();
    expect(await frame.evaluate(element => element.getBoundingClientRect().width)).toBe(120);
    expect(await frame.locator("[data-design-frame-chrome]").evaluate(element => element.getBoundingClientRect().height)).toBe(28);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.evaluate(() => (window as any).stopChrome());
    expect(await frame.evaluate(element => element.getBoundingClientRect().width)).toBe(120);
  } finally { await page.close(); }
});

it("routes a first touch and context action to the front compact frame with native event coordinates", async () => {
  const page = await open();
  try {
    await page.mouse.move(470, 340);
    await page.evaluate(async () => {
      const w = window as any;
      w.rows = [await w.add({ key: "front", x: 20, y: 55, width: 120, height: 160, z: 10, color: "blue", compact: true }),
        await w.add({ key: "back", x: 20, y: 55, width: 120, height: 160, z: 0, color: "red", compact: true })];
      w.events = [];
      for (const row of w.rows) for (const name of ["pointerdown", "contextmenu", "dblclick"]) row.article.addEventListener(name, (event: PointerEvent) => {
        event.preventDefault(); w.events.push({ name, frame: row.article.dataset.designFrame, x: event.clientX, y: event.clientY,
          pointerId: event.pointerId, primary: event.isPrimary, pointerType: event.pointerType });
      });
      w.paint(); w.releases = w.rows.map((row: any, i: number) => w.tiles.attachDesignSourceTiles(row.image, `touch-${i}`));
    });
    const routed = await page.evaluate(() => {
      const viewport = document.querySelector("#viewport")!;
      const touch = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 70, clientY: 110,
        pointerId: 42, pointerType: "touch", isPrimary: true, button: 0, buttons: 1 });
      viewport.dispatchEvent(touch);
      viewport.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 70, clientY: 110 }));
      viewport.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 70, clientY: 110, detail: 2 }));
      return { cancelled: touch.defaultPrevented, events: (window as any).events };
    });
    expect(routed.cancelled).toBe(true);
    expect(routed.events).toEqual([
      { name: "pointerdown", frame: "front", x: 70, y: 110, pointerId: 42, primary: true, pointerType: "touch" },
      { name: "contextmenu", frame: "front", x: 70, y: 110 },
      { name: "dblclick", frame: "front", x: 70, y: 110 },
    ]);
    await page.evaluate(() => (window as any).stopChrome());
    await page.dispatchEvent("#viewport", "pointerdown", { clientX: 70, clientY: 110, isPrimary: true });
    expect(await page.evaluate(() => (window as any).events.length)).toBe(3);
  } finally { await page.close(); }
});

it("keeps a compact frame admitted while the pointer crosses its source host and controls", async () => {
  const page = await open();
  try {
    await page.mouse.move(470, 340);
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "nested-hit", x: 20, y: 55, width: 120, height: 160, z: 0, color: "blue", compact: true });
      const host = document.createElement("div");
      host.dataset.designFrameRenderSurface = "";
      host.style.cssText = "position:absolute;inset:0";
      host.append(w.row.image); w.row.article.append(host);
      w.row.article.insertAdjacentHTML("beforeend", '<div data-design-frame-chrome data-design-controls style="position:absolute;bottom:100%;height:28px"><button>Frame action</button></div>');
      w.paint(); w.releases.push(w.tiles.attachDesignSourceTiles(w.row.image, "owner/nested-hit"));
    });
    await page.mouse.move(70, 110);
    await page.mouse.move(71, 111);
    expect(await page.locator('[data-design-frame="nested-hit"]').getAttribute("data-design-frame-pointer")).toBe("");
    await page.getByRole("button", { name: "Frame action" }).hover();
    expect(await page.locator('[data-design-frame="nested-hit"]').getAttribute("data-design-frame-pointer")).toBe("");
    expect(await page.getByRole("button", { name: "Frame action" }).isVisible()).toBe(true);
  } finally { await page.close(); }
});

it("preserves each visible canvas's pixels across another owner's paints and a shared texture purge", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "first-owner", x: 20, y: 55, width: 120, height: 160, z: 0, color: "blue" });
      w.paint(); w.release = w.tiles.attachDesignSourceTiles(w.row.image, "first-owner/version");
    });
    const before = await page.screenshot();
    await page.evaluate(async () => {
      const w = window as any;
      w.output = document.querySelector("[data-design-source-plane]");
      const other = document.createElement("div");
      other.dataset.designCanvasWorld = "";
      other.style.cssText = "position:absolute;inset:0;transform-origin:0 0";
      w.other = other; document.querySelector("#viewport")!.append(other);
      const second = await w.add({ key: "second-owner", x: 260, y: 55, width: 120, height: 160, z: 0, color: "red" });
      other.append(second.article); w.second = second;
      w.tiles.paintDesignCanvasCamera(other, { zoom: 1, panX: 0, panY: 0 }, true, { width: 480, height: 360 });
      w.secondRelease = w.tiles.attachDesignSourceTiles(second.image, "second-owner/version");
    });
    expect(await page.locator("[data-design-source-plane]").count()).toBe(1);
    expect(await page.locator('[data-design-frame="first-owner"] [data-design-source-tiled]').count()).toBe(1);
    expect(await page.locator('[data-design-frame="second-owner"] img').count()).toBe(1);
    const both = await page.screenshot();
    await page.evaluate(() => (window as any).tiles.designSourceTiles.clear());
    expect(await changed(page, both, await page.screenshot())).toBe(0);
    await page.evaluate(() => {
      const w = window as any;
      w.release(); w.tiles.repaintDesignCanvasPixels(w.other);
    });
    expect(await page.locator("[data-design-source-plane]").count()).toBe(1);
    expect(await page.locator('[data-design-frame="second-owner"] [data-design-source-tiled]').count()).toBe(1);
    await page.evaluate(() => { const w = window as any; w.secondRelease(); w.other.remove(); });
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(12);
    expect(await page.evaluate(() => (window as any).tiles.designSourceSceneUsage().outputBytes)).toBe(0);
  } finally { await page.close(); }
});

it("updates the compact frame under a stationary pointer with the camera and leaves overlay controls in charge", async () => {
  const page = await open();
  try {
    await page.mouse.move(470, 340);
    await page.evaluate(async () => {
      const w = window as any;
      w.rows = [await w.add({ key: "first", x: 20, y: 55, width: 120, height: 160, z: 0, color: "blue", compact: true }),
        await w.add({ key: "second", x: 220, y: 55, width: 120, height: 160, z: 0, color: "red", compact: true })];
      w.paint(); w.releases = w.rows.map((row: any, i: number) => w.tiles.attachDesignSourceTiles(row.image, `pointer-${i}`));
    });
    await page.mouse.move(70, 110);
    expect(await page.locator("[data-design-frame-pointer]").getAttribute("data-design-frame")).toBe("first");
    await page.evaluate(() => (window as any).paint({ zoom: 1, panX: -200, panY: 0 }));
    expect(await page.locator("[data-design-frame-pointer]").getAttribute("data-design-frame")).toBe("second");
    expect(await page.evaluate(() => document.elementFromPoint(70, 110)?.closest("article")?.dataset.designFrame)).toBe("second");
    await page.evaluate(() => {
      const w = window as any;
      w.frameDown = 0; w.overlayDown = 0;
      for (const row of w.rows) row.article.addEventListener("pointerdown", () => w.frameDown++);
      const overlay = document.createElement("button"); overlay.textContent = "Overlay action";
      overlay.style.cssText = "position:absolute;left:240px;top:90px;width:80px;height:40px;z-index:100";
      overlay.addEventListener("pointerdown", () => w.overlayDown++);
      document.querySelector("#world")!.append(overlay);
    });
    await page.getByRole("button", { name: "Overlay action" }).click();
    expect(await page.evaluate(() => ({ frame: (window as any).frameDown, overlay: (window as any).overlayDown }))).toEqual({ frame: 0, overlay: 1 });
  } finally { await page.close(); }
});

it("keeps overlapping chrome in its original paint order instead of using source admission order", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      // Deliberately append the higher-z frame first; its transparent pixels
      // must still composite over the lower frame and that frame's label.
      w.rows = [await w.add({ key: "upper", x: 70, y: 70, width: 180, height: 160, z: 10, color: w.tileColors.upperAlpha, chrome: true }),
        await w.add({ key: "lower", x: 30, y: 120, width: 180, height: 180, z: 0, color: w.tileColors.lowerAlpha, background: w.tileColors.lightBackground, chrome: true })];
      w.paint();
    });
    const before = await page.screenshot();
    await page.evaluate(() => { const w = window as any; w.releases = w.rows.map((row: any, i: number) => w.tiles.attachDesignSourceTiles(row.image, `stack-${i}`)); });
    expect(await page.locator("[data-design-source-plane]").count()).toBe(1);
    expect(await page.locator('[data-design-frame="upper"] [data-design-source-tiled]').count()).toBe(0);
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(16);
  } finally { await page.close(); }
});

it("adopts same-task DOM order, stacking and visibility changes without waiting for an observer", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.rows = [await w.add({ key: "lower", x: 30, y: 50, width: 180, height: 160, z: 0, color: w.tileColors.upperAlpha, compact: true }),
        await w.add({ key: "upper", x: 60, y: 80, width: 180, height: 160, z: 0, color: w.tileColors.lowerAlpha, compact: true })];
      w.paint();
    });
    for (const operation of ["order", "stack", "hide", "show"]) {
      await page.evaluate(operation => {
        const w = window as any, [first] = w.rows;
        w.releases = w.rows.map((row: any, i: number) => w.tiles.attachDesignSourceTiles(row.image, `order-${i}`));
        w.paint();
        if (operation === "order") document.querySelector("#world")!.append(first.article);
        if (operation === "stack") first.article.style.zIndex = "-1";
        if (operation === "hide") first.article.hidden = true;
        if (operation === "show") first.article.hidden = false;
        w.paint();
      }, operation);
      const tiled = await page.screenshot();
      await page.evaluate(() => { const w = window as any; w.releases.forEach((release: () => void) => release()); });
      expect(await changed(page, tiled, await page.screenshot())).toBeLessThan(16);
    }
  } finally { await page.close(); }
});

it("keeps live editing between GPU groups and restores its exact fallback when a source retires", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.rows = [];
      for (let i = 0; i < 3; i++) w.rows.push(await w.add({ key: `frame-${i}`, x: 30 + i * 30, y: 50 + i * 30,
        width: 200, height: 200, z: i, color: w.tileColors.overlap[i], protected: i === 1 }));
      w.paint();
    });
    const before = await page.screenshot();
    await page.evaluate(() => { const w = window as any; w.releases = w.rows.map((row: any, i: number) => w.tiles.attachDesignSourceTiles(row.image, `editor-${i}`)); });
    expect(await page.locator("[data-design-source-tiled]").count()).toBe(1);
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(16);
    await page.evaluate(() => { const w = window as any; w.releases.forEach((release: () => void) => release()); });
    expect(await page.locator("[data-design-source-plane]").count()).toBe(0);
    expect(await changed(page, before, await page.screenshot())).toBe(0);
    expect(await page.evaluate(() => (window as any).tiles.designSourceSceneUsage())).toMatchObject({ outputBytes: 0, activeScenes: 0, outputPlanes: 0 });
    expect(await page.evaluate(() => (window as any).tiles.designSourceTiles.usage().waiting)).toBe(0);
  } finally { await page.close(); }
});

it("keeps neighboring cached sources on the GPU when an active frame has chrome but no editing overlay", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.rows = [await w.add({ key: "active", x: 20, y: 55, width: 120, height: 160, z: 0, color: "blue", chrome: true }),
        await w.add({ key: "neighbor", x: 220, y: 55, width: 120, height: 160, z: 1, color: "red", compact: true })];
      w.rows[0].article.dataset.designFrameChromeProtected = "";
      w.paint();
    });
    const before = await page.screenshot();
    await page.evaluate(() => { const w = window as any; w.releases = w.rows.map((row: any, i: number) => w.tiles.attachDesignSourceTiles(row.image, `active-${i}`)); });
    expect(await page.locator('[data-design-frame="neighbor"] [data-design-source-tiled]').count()).toBe(1);
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(12);
    await page.evaluate(() => { (window as any).rows[0].article.dataset.designFrameStackProtected = ""; });
    await page.waitForFunction(() => !document.querySelector('[data-design-source-tiled]'));
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(12);
  } finally { await page.close(); }
});

it("clips authored source during a resize and shares the exact camera without synchronous layout reads", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "responsive", x: 20, y: 50, width: 300, height: 200, z: 0, color: w.tileColors.responsive });
      w.row.article.style.width = "160px"; w.row.article.style.height = "120px";
      w.paint({ zoom: 1.25, panX: 10, panY: 10 });
    });
    const before = await page.screenshot();
    await page.evaluate(() => {
      const w = window as any;
      w.releases.push(w.tiles.attachDesignSourceTiles(w.row.image, "responsive-v1"));
      Element.prototype.getBoundingClientRect = () => { throw new Error("Unexpected wheel layout flush"); };
      w.paint({ zoom: 1.25, panX: 10, panY: 10 });
    });
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(16);
  } finally { await page.close(); }
});

it("keeps offscreen cached frame geometry at the camera scale while its chrome stops inheriting zoom", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.rows = [await w.add({ key: "near", x: 20, y: 50, width: 300, height: 200, z: 0, color: "blue" }),
        await w.add({ key: "far", x: 6000, y: 8000, width: 300, height: 200, z: 1, color: "red" })];
      w.paint({ zoom: .2, panX: 20, panY: 30 });
    });
    const before = await page.locator('[data-design-frame="far"]').boundingBox();
    await page.evaluate(() => { const w = window as any; w.releases = w.rows.map((row: any, i: number) => w.tiles.attachDesignSourceTiles(row.image, `offscreen-${i}`)); });
    expect(await page.locator('[data-design-frame="far"]').boundingBox()).toEqual(before);
    await page.evaluate(() => { const w = window as any; w.paint({ zoom: .2, panX: -1180, panY: -1570 }); });
    expect(await page.locator('[data-design-frame="far"]').boundingBox()).toEqual({ x: 20, y: 30, width: 60, height: 40 });
    expect(await page.evaluate(() => document.elementFromPoint(40, 50)?.closest("article")?.dataset.designFrame)).toBe("far");
  } finally { await page.close(); }
});

it("prepares a returning offscreen source at the next zoom density before it enters the viewport", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.rows = [await w.add({ key: "near", x: 20, y: 50, width: 100, height: 100, z: 0, color: "blue", compact: true }),
        await w.add({ key: "returning", x: 800, y: 50, width: 100, height: 100, z: 1, color: "red", compact: true })];
      w.paint(); w.releases = w.rows.map((row: any, i: number) => w.tiles.attachDesignSourceTiles(row.image, `predict-${i}`));
      w.paint();
      w.paint({ zoom: .8, panX: 0, panY: 0 });
    });
    await page.waitForFunction(() => (window as any).tiles.designSourceTiles.usage().waiting === 0);
    expect(await page.locator('[data-design-frame="returning"] [data-design-source-tiled]').count()).toBe(0);
    const result = await page.evaluate(() => {
      const w = window as any, before = w.tiles.designSourceTiles.usage().rasterized;
      w.paint({ zoom: .5, panX: 0, panY: 0 });
      return { before, after: w.tiles.designSourceTiles.usage().rasterized };
    });
    expect(result.after).toBe(result.before);
    expect(await page.locator('[data-design-frame="returning"] [data-design-source-tiled]').count()).toBe(1);
  } finally { await page.close(); }
});

it("rasterizes only visible high-density tiles, with continuous pixels across tile seams at 800%", async () => {
  const page = await open();
  try {
    const result = await page.evaluate(async () => {
      const w = window as any;
      const image = new Image();
      image.src = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="8000"><defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="8000" height="8000" fill="url(#g)"/><rect x="300" y="400" width="25" height="3" fill="green"/></svg>');
      await image.decode();
      const renderer = new w.tiles.DesignSourceTiles(8 * 1024 * 1024);
      const view = { zoom: 8, panX: -2400, panY: -3200 }, size = { width: 480, height: 360 };
      const bitmap = renderer.render([{ source: { key: "large-exact-source", image }, x: 0, y: 0, width: 8000, height: 8000, background: [0,0,0,0] }], view, size, 2);
      const output = new OffscreenCanvas(960, 720), context = output.getContext("2d")!;
      context.drawImage(bitmap, 0, 0); bitmap.close();
      const actual = context.getImageData(0, 0, 960, 720).data;
      context.clearRect(0,0,960,720);
      context.drawImage(image, 300, 400, 60, 45, 0, 0, 960, 720);
      const expected = context.getImageData(0, 0, 960, 720).data;
      let differences = 0;
      for (let i = 0; i < actual.length; i += 4) if ([0,1,2,3].some(c => Math.abs(actual[i+c] - expected[i+c]) > 3)) differences++;
      return { differences, usage: renderer.usage() };
    });
    expect(result.differences).toBeLessThan(12);
    expect(result.usage.bytes).toBeLessThan(8 * 1024 * 1024);
    expect(result.usage.scratchBytes).toBeLessThanOrEqual(514 * 514 * 4);
    expect(result.usage.rasterized).toBeLessThanOrEqual(9);
  } finally { await page.close(); }
});

it("uses immutable tile storage and reuses raster backing without carrying opaque pixels into transparent content", async () => {
  const page = await open();
  try {
    const result = await page.evaluate(async () => {
      const w = window as any;
      const allocations: number[] = [];
      const NativeCanvas = globalThis.OffscreenCanvas;
      // Dimension writes recreate the raster backing, even when unchanged.
      // Observe that allocation boundary, not JS object identity alone.
      for (const dimension of ["width", "height"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(NativeCanvas.prototype, dimension)!;
        Object.defineProperty(NativeCanvas.prototype, dimension, { ...descriptor,
          set(this: OffscreenCanvas, value: number) {
            if (this.getContext("2d")) allocations.push(value);
            descriptor.set!.call(this, value);
          },
        });
      }
      const renderer = new w.tiles.DesignSourceTiles(4 * 1024 * 1024);
      const pixels: number[][] = [];
      for (const [i, color] of ["red", "transparent", "blue", "transparent"].entries()) {
        const row = await w.add({ key: `scratch-${i}`, x: 0, y: 0, width: 120, height: 120, z: i, color });
        const bitmap = renderer.render([{ source: { key: `scratch-${i}`, image: row.image },
          x: 0, y: 0, width: 120, height: 120, background: [0, 0, 0, 0] }],
        { zoom: 1, panX: 0, panY: 0 }, { width: 480, height: 360 }, 2);
        const output = new NativeCanvas(960, 720), context = output.getContext("2d")!;
        context.drawImage(bitmap, 0, 0); bitmap.close();
        pixels.push([...context.getImageData(40, 40, 1, 1).data]);
      }
      const usage = renderer.usage();
      const gl = renderer.gl as WebGL2RenderingContext;
      const immutable = [...renderer.tiles.values()].every((tile: any) => {
        gl.bindTexture(gl.TEXTURE_2D, tile.texture);
        return gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_IMMUTABLE_FORMAT) === true;
      });
      return { allocations, pixels, usage, immutable };
    });
    expect(result.pixels).toEqual([[255, 0, 0, 255], [0, 0, 0, 0], [0, 0, 255, 255], [0, 0, 0, 0]]);
    expect(result.usage.rasterized).toBe(4);
    expect(result.allocations).toHaveLength(2);
    expect(result.immutable).toBe(true);
  } finally { await page.close(); }
});

it("prepares current-density pixels just beyond the viewport before pan and zoom-out expose them", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.renderer = new w.tiles.DesignSourceTiles(4 * 1024 * 1024);
      const rows = [await w.add({ key: "inside", x: 0, y: 10, width: 120, height: 80, z: 0, color: "blue" }),
        await w.add({ key: "arriving", x: 490, y: 10, width: 120, height: 80, z: 1, color: "green" })];
      w.frames = rows.map((row: any, index: number) => ({ source: { key: `owner/perimeter/${index}`, image: row.image },
        x: index ? 490 : 0, y: 10, width: 120, height: 80, background: [0, 0, 0, 0] }));
      w.size = { width: 480, height: 360 }; w.view = { zoom: 1, panX: 0, panY: 0 };
      w.renderer.render(w.frames, w.view, w.size, 1).close();
      w.renderer.prefetch(w.frames, w.view, w.size, 1, -1, { x: 240, y: 180 });
    });
    await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    const result = await page.evaluate(() => {
      const w = window as any, before = w.renderer.usage(), pixels = [];
      for (const view of [{ zoom: 1, panX: -30, panY: 0 }, { zoom: .94, panX: 0, panY: 0 }]) {
        const bitmap = w.renderer.render(w.frames, view, w.size, 1);
        const output = new OffscreenCanvas(480, 360), context = output.getContext("2d")!;
        context.drawImage(bitmap, 0, 0); bitmap.close();
        pixels.push([...context.getImageData(475, 35, 1, 1).data]);
      }
      return { before, after: w.renderer.usage(), pixels };
    });
    expect(result.pixels).toEqual([[0, 128, 0, 255], [0, 128, 0, 255]]);
    expect(result.after.rasterized).toBe(result.before.rasterized);
    expect(result.after.allocatedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  } finally { await page.close(); }
});

it("bounds outstanding speculative GPU uploads and cancels blocked work when the scene hides", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.renderer = new w.tiles.DesignSourceTiles(32 * 1024 * 1024);
      const row = await w.add({ key: "personal/gpu-queue", x: 0, y: 0, width: 2048, height: 1536, z: 0, color: "blue" });
      w.frames = [{ source: { key: "personal/gpu-queue/version", image: row.image },
        x: 0, y: 0, width: 2048, height: 1536, background: [0, 0, 0, 0] }];
      w.view = { zoom: .25, panX: 0, panY: 0 }; w.size = { width: 480, height: 360 };
      w.renderer.render(w.frames, w.view, w.size, 2).close();
      const gl = w.renderer.gl as WebGL2RenderingContext;
      w.uploads = 0; w.polls = 0; w.gpuReady = false; w.fences = new Set();
      const upload = gl.texSubImage2D, fence = gl.fenceSync, wait = gl.clientWaitSync, retire = gl.deleteSync;
      gl.texSubImage2D = function(this: WebGL2RenderingContext, ...args: unknown[]) {
        w.uploads++; Reflect.apply(upload, this, args);
      };
      gl.fenceSync = function(...args) { const value = fence.apply(this, args); if (value) w.fences.add(value); return value; };
      // Hold the real GPU completion boundary. The pixels remain renderable,
      // but optional preparation must not enqueue the entire next tier.
      gl.clientWaitSync = function(...args) { w.polls++; return w.gpuReady ? wait.apply(this, args) : gl.TIMEOUT_EXPIRED; };
      gl.deleteSync = function(value) { w.fences.delete(value); return retire.call(this, value); };
      w.renderer.prefetch(w.frames, w.view, w.size, 2, 1, { x: 240, y: 180 });
    });
    await page.waitForFunction(() => (window as any).uploads > 4 || (window as any).polls > 0);
    const blocked = await page.evaluate(() => {
      const w = window as any; return { uploads: w.uploads, polls: w.polls, fences: w.fences.size, usage: w.renderer.usage() };
    });
    expect(blocked.uploads).toBeGreaterThan(0);
    expect(blocked.uploads).toBeLessThanOrEqual(4);
    expect(blocked.polls).toBeGreaterThan(0);
    expect(blocked.fences).toBe(1);
    expect(blocked.usage.waiting).toBeGreaterThan(0);
    await page.evaluate(() => { (window as any).gpuReady = true; });
    await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    const displayed = await page.evaluate(() => {
      const w = window as any, before = w.renderer.usage();
      const bitmap = w.renderer.render(w.frames, { zoom: .5, panX: 0, panY: 0 }, w.size, 2);
      const output = new OffscreenCanvas(960, 720), context = output.getContext("2d")!;
      context.drawImage(bitmap, 0, 0); bitmap.close();
      return { before, after: w.renderer.usage(), pixel: [...context.getImageData(40, 40, 1, 1).data] };
    });
    expect(displayed.pixel).toEqual([0, 0, 255, 255]);
    expect(displayed.after.rasterized).toBe(displayed.before.rasterized);
    expect(displayed.after.allocatedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    const hidden = await page.evaluate(async () => {
      const w = window as any;
      w.gpuReady = false;
      const other = [{ ...w.frames[0], source: { ...w.frames[0].source, key: "organization/local/gpu-queue/version" } }];
      w.renderer.prefetch(other, w.view, w.size, 2, 1, { x: 240, y: 180 });
      const waiting = w.renderer.usage().waiting;
      w.renderer.suspendOutput();
      const polls = w.polls, uploads = w.uploads;
      await new Promise(resolve => setTimeout(resolve, 30));
      return { waiting, polls, afterPolls: w.polls, uploads, afterUploads: w.uploads,
        fences: w.fences.size, usage: w.renderer.usage() };
    });
    expect(hidden.waiting).toBeGreaterThan(0);
    expect(hidden.afterPolls).toBe(hidden.polls);
    expect(hidden.afterUploads).toBe(hidden.uploads);
    expect(hidden.fences).toBe(0);
    expect(hidden.usage).toMatchObject({ waiting: 0, speculativeBytes: 0, backingBytes: 4, scratchBytes: 4 });
  } finally { await page.close(); }
});

it("prepares only reachable perimeter pixels at the camera's 800 percent limit", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any, renderer = w.renderer = new w.tiles.DesignSourceTiles(16 * 1024 * 1024);
      const row = await w.add({ key: "ceiling", x: 0, y: 0, width: 480, height: 360, z: 0, color: "blue" });
      const frames = [{ source: { key: "ceiling/version", image: row.image }, x: 0, y: 0, width: 480, height: 360, background: [0, 0, 0, 0] }];
      const view = { zoom: 8, panX: 0, panY: 0 }, size = { width: 480, height: 360 };
      Object.assign(w, { frames, view, size });
      renderer.render(frames, view, size, 2).close();
      renderer.prefetch(frames, view, size, 2, 1, { x: 240, y: 180 });
    });
    await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    const result = await page.evaluate(() => {
      const w = window as any, before = w.renderer.usage();
      const bitmap = w.renderer.render(w.frames, { ...w.view, panX: -64 }, w.size, 2);
      const output = new OffscreenCanvas(960, 720), context = output.getContext("2d")!;
      context.drawImage(bitmap, 0, 0); bitmap.close();
      return { before, after: w.renderer.usage(), densities: [...w.renderer.tiles.values()].map((tile: any) => tile.density),
        pixel: [...context.getImageData(200, 200, 1, 1).data] };
    });
    expect(result.densities.every((density: number) => density === 16)).toBe(true);
    expect(result.pixel).toEqual([0, 0, 255, 255]);
    expect(result.after.rasterized).toBe(result.before.rasterized);
    expect(result.after.allocatedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  } finally { await page.close(); }
});

it("keeps already displayed tiles warm when speculative next-density work exceeds the cache", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.renderer = new w.tiles.DesignSourceTiles(1024 * 1024);
      const row = await w.add({ key: "protected-pixels", x: 0, y: 0, width: 320, height: 240, z: 0, color: "blue" });
      w.frames = [{ source: { key: "owner/version", image: row.image }, x: 0, y: 0, width: 320, height: 240, background: [0, 0, 0, 0] }];
      w.view = { zoom: 1, panX: 0, panY: 0 }; w.size = { width: 480, height: 360 };
      w.renderer.render(w.frames, w.view, w.size, 1).close();
      w.renderer.prefetch(w.frames, w.view, w.size, 1, 1, { x: 240, y: 180 });
    });
    await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    const warmed = await page.evaluate(() => (window as any).renderer.usage());
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.evaluate(() => {
        const w = window as any;
        w.renderer.prefetch(w.frames, w.view, w.size, 1, 1, { x: 240, y: 180 });
      });
      await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    }
    const result = await page.evaluate(() => {
      const w = window as any, before = w.renderer.usage();
      const bitmap = w.renderer.render(w.frames, w.view, w.size, 1);
      const output = new OffscreenCanvas(480, 360), context = output.getContext("2d")!;
      context.drawImage(bitmap, 0, 0); bitmap.close();
      return { before, after: w.renderer.usage(), pixel: [...context.getImageData(40, 40, 1, 1).data] };
    });
    expect(result.pixel).toEqual([0, 0, 255, 255]);
    expect(result.after.rasterized).toBe(result.before.rasterized);
    expect(result.after.rasterized).toBe(warmed.rasterized);
    expect(result.after.evicted).toBe(warmed.evicted);
    expect(result.after.bytes).toBeLessThanOrEqual(1024 * 1024);
  } finally { await page.close(); }
});

it("prepares the next zoom from inactive workspace capacity without evicting current pixels", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.renderer = new w.tiles.DesignSourceTiles(2 * 1024 * 1024);
      w.view = { zoom: 1, panX: 0, panY: 0 }; w.size = { width: 480, height: 360 };
      for (let i = 0; i < 3; i++) {
        const row = await w.add({ key: `previous-owner-${i}`, x: 0, y: 0, width: 480, height: 360, z: 0, color: "red" });
        w.renderer.render([{ source: { key: `previous-owner-${i}/version`, image: row.image }, x: 0, y: 0,
          width: 480, height: 360, background: [0, 0, 0, 0] }], w.view, w.size, 1).close();
      }
      const row = await w.add({ key: "active-owner", x: 0, y: 0, width: 320, height: 240, z: 0, color: "blue" });
      w.frames = [{ source: { key: "active-owner/version", image: row.image }, x: 0, y: 0,
        width: 320, height: 240, background: [0, 0, 0, 0] }];
      w.renderer.render(w.frames, w.view, w.size, 1).close();
      w.renderer.prefetch(w.frames, w.view, w.size, 1, 1, { x: 240, y: 180 });
    });
    await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    const result = await page.evaluate(() => {
      const w = window as any, before = w.renderer.usage();
      w.renderer.render(w.frames, w.view, w.size, 1).close();
      const current = w.renderer.usage();
      const bitmap = w.renderer.render(w.frames, { zoom: 2, panX: 0, panY: 0 }, w.size, 1);
      const output = new OffscreenCanvas(480, 360), context = output.getContext("2d")!;
      context.drawImage(bitmap, 0, 0); bitmap.close();
      return { before, current, after: w.renderer.usage(), pixel: [...context.getImageData(40, 40, 1, 1).data] };
    });
    expect(result.pixel).toEqual([0, 0, 255, 255]);
    expect(result.current.rasterized).toBe(result.before.rasterized);
    expect(result.after.rasterized).toBe(result.before.rasterized);
    expect(result.after.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  } finally { await page.close(); }
});

it("reclaims inactive owner tiles before losing the active document's larger zoom history", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.renderer = new w.tiles.DesignSourceTiles(3 * 1024 * 1024);
      w.size = { width: 480, height: 360 };
      const row = await w.add({ key: "active-history", x: 0, y: 0, width: 320, height: 240, z: 0, color: "blue" });
      w.frames = [{ source: { key: "personal/active/version", image: row.image }, x: 0, y: 0,
        width: 320, height: 240, background: [0, 0, 0, 0] }];
      w.renderer.render(w.frames, { zoom: 4, panX: 0, panY: 0 }, w.size, 1).close();
      // Another owner's small overview tiles are individually cheaper than
      // this active document's old crop, but collectively can supply capacity.
      for (let index = 0; index < 32; index++) {
        const other = await w.add({ key: `inactive-${index}`, x: 0, y: 0, width: 80, height: 80, z: 0, color: "red" });
        w.renderer.render([{ source: { key: `organization/inactive-${index}/version`, image: other.image },
          x: 0, y: 0, width: 80, height: 80, background: [0, 0, 0, 0] }],
        { zoom: 1, panX: 0, panY: 0 }, w.size, 1).close();
      }
      for (const zoom of [.5, 1]) w.renderer.render(w.frames, { zoom, panX: 0, panY: 0 }, w.size, 1).close();
      w.renderer.prefetch(w.frames, { zoom: 1, panX: 0, panY: 0 }, w.size, 1, 1, { x: 0, y: 0 });
    });
    await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    const result = await page.evaluate(() => {
      const w = window as any, before = w.renderer.usage(), pixels = [];
      for (const zoom of [.5, 1, 2, 4]) {
        const bitmap = w.renderer.render(w.frames, { zoom, panX: 0, panY: 0 }, w.size, 1);
        const output = new OffscreenCanvas(480, 360), context = output.getContext("2d")!;
        context.drawImage(bitmap, 0, 0); bitmap.close();
        pixels.push([...context.getImageData(40, 40, 1, 1).data]);
      }
      return { before, after: w.renderer.usage(), pixels };
    });
    expect(result.pixels).toEqual(Array.from({ length: 4 }, () => [0, 0, 255, 255]));
    expect(result.after.rasterized).toBe(result.before.rasterized);
    expect(result.after.allocatedBytes).toBeLessThanOrEqual(3 * 1024 * 1024);
  } finally { await page.close(); }
});

it("does not evict a displayed document's previous zoom tier to prepare an optional next tier", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.renderer = new w.tiles.DesignSourceTiles(1450 * 1024);
      const row = await w.add({ key: "zoom-history", x: 0, y: 0, width: 320, height: 240, z: 0, color: "blue" });
      w.frames = [{ source: { key: "owner/history", image: row.image }, x: 0, y: 0, width: 320, height: 240, background: [0, 0, 0, 0] }];
      w.size = { width: 480, height: 360 }; w.view = { zoom: 1, panX: 0, panY: 0 };
      w.renderer.render(w.frames, { zoom: 2, panX: 0, panY: 0 }, w.size, 1).close();
      w.renderer.render(w.frames, { zoom: .5, panX: 0, panY: 0 }, w.size, 1).close();
      w.renderer.render(w.frames, w.view, w.size, 1).close();
      w.warmed = w.renderer.usage().rasterized;
      // A different focal point needs optional tiles outside the previously
      // displayed high-density crop. It must not destroy that return crop.
      w.renderer.prefetch(w.frames, w.view, w.size, 1, 1, { x: 0, y: 0 });
    });
    await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    const result = await page.evaluate(() => {
      const w = window as any, before = w.renderer.usage().rasterized;
      w.renderer.render(w.frames, { zoom: .5, panX: 0, panY: 0 }, w.size, 1).close();
      w.renderer.render(w.frames, { zoom: 2, panX: 0, panY: 0 }, w.size, 1).close();
      return { before, after: w.renderer.usage().rasterized };
    });
    expect(result.after).toBe(result.before);
  } finally { await page.close(); }
});

it("reclaims distant zoom history to prepare the next tier without displacing current or adjacent pixels", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.renderer = new w.tiles.DesignSourceTiles(2 * 1024 * 1024);
      const row = await w.add({ key: "distant-zoom-history", x: 0, y: 0, width: 320, height: 240, z: 0, color: "blue" });
      w.frames = [{ source: { key: "owner/zoom-history", image: row.image }, x: 0, y: 0,
        width: 320, height: 240, background: [0, 0, 0, 0] }];
      w.size = { width: 480, height: 360 };
      for (const zoom of [8, .5, 1])
        w.renderer.render(w.frames, { zoom, panX: 0, panY: 0 }, w.size, 1).close();
      w.renderer.prefetch(w.frames, { zoom: 1, panX: 0, panY: 0 }, w.size, 1, 1, { x: 0, y: 0 });
    });
    await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    const result = await page.evaluate(() => {
      const w = window as any, before = w.renderer.usage(), pixels = [];
      for (const zoom of [.5, 1, 2]) {
        const bitmap = w.renderer.render(w.frames, { zoom, panX: 0, panY: 0 }, w.size, 1);
        const output = new OffscreenCanvas(480, 360), context = output.getContext("2d")!;
        context.drawImage(bitmap, 0, 0); bitmap.close();
        pixels.push([...context.getImageData(40, 40, 1, 1).data]);
      }
      return { before, after: w.renderer.usage(), pixels };
    });
    expect(result.pixels).toEqual([[0, 0, 255, 255], [0, 0, 255, 255], [0, 0, 255, 255]]);
    expect(result.after.rasterized).toBe(result.before.rasterized);
    expect(result.after.allocatedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  } finally { await page.close(); }
});

it("keeps inexpensive overview pixels when a larger obsolete tile can supply the next tier's capacity", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.renderer = new w.tiles.DesignSourceTiles(3 * 1024 * 1024);
      const row = await w.add({ key: "overview-history", x: 0, y: 0, width: 320, height: 240, z: 0, color: "blue" });
      w.frames = [{ source: { key: "owner/overview-history", image: row.image }, x: 0, y: 0,
        width: 320, height: 240, background: [0, 0, 0, 0] }];
      w.size = { width: 480, height: 360 };
      for (const zoom of [.125, 8, 4, .5, 1])
        w.renderer.render(w.frames, { zoom, panX: 0, panY: 0 }, w.size, 1).close();
      w.renderer.prefetch(w.frames, { zoom: 1, panX: 0, panY: 0 }, w.size, 1, 1, { x: 0, y: 0 });
    });
    await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    const result = await page.evaluate(() => {
      const w = window as any, before = w.renderer.usage(), pixels = [];
      for (const zoom of [.125, .5, 1, 2]) {
        const bitmap = w.renderer.render(w.frames, { zoom, panX: 0, panY: 0 }, w.size, 1);
        const output = new OffscreenCanvas(480, 360), context = output.getContext("2d")!;
        context.drawImage(bitmap, 0, 0); bitmap.close();
        pixels.push([...context.getImageData(20, 20, 1, 1).data]);
      }
      return { before, after: w.renderer.usage(), pixels };
    });
    expect(result.pixels).toEqual(Array.from({ length: 4 }, () => [0, 0, 255, 255]));
    expect(result.after.rasterized).toBe(result.before.rasterized);
    expect(result.after.allocatedBytes).toBeLessThanOrEqual(3 * 1024 * 1024);
  } finally { await page.close(); }
});

it("checks a saturated prefetch cache once for its batch instead of rescanning it for every rejected tile", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.renderer = new w.tiles.DesignSourceTiles(200 * 1024);
      const frames = [];
      for (let i = 0; i < 7; i++) {
        const row = await w.add({ key: `frame-${i}`, x: i * 60, y: 0, width: 80, height: 80, z: 0, color: "blue" });
        frames.push({ source: { key: `current/${i}`, image: row.image }, x: i * 60, y: 0, width: 80, height: 80, background: [0, 0, 0, 0] });
      }
      const view = { zoom: 1, panX: 0, panY: 0 }, size = { width: 480, height: 360 };
      w.renderer.render(frames, view, size, 1).close();
      w.scans = 0;
      const iterate = w.renderer.tiles[Symbol.iterator].bind(w.renderer.tiles);
      w.renderer.tiles[Symbol.iterator] = () => { w.scans++; return iterate(); };
      w.renderer.prefetch(frames, view, size, 1, 1, { x: 0, y: 0 });
    });
    await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    const result = await page.evaluate(() => ({ scans: (window as any).scans, usage: (window as any).renderer.usage() }));
    expect(result.usage.rasterized).toBe(7);
    expect(result.usage.evicted).toBe(0);
    expect(result.scans).toBe(1);
  } finally { await page.close(); }
});

it("does not repeatedly schedule impossible predictions while panning a full cache, and resumes after capacity returns", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.renderer = new w.tiles.DesignSourceTiles(200 * 1024);
      w.frames = [];
      for (let i = 0; i < 7; i++) {
        const row = await w.add({ key: `owner/frame-${i}`, x: i * 60, y: 0, width: 80, height: 80, z: 0, color: "blue" });
        w.frames.push({ source: { key: `owner/${i}/version`, image: row.image }, x: i * 60, y: 0,
          width: 80, height: 80, background: [0, 0, 0, 0] });
      }
      w.size = { width: 480, height: 360 };
      w.renderer.render(w.frames, { zoom: 1, panX: 0, panY: 0 }, w.size, 1).close();
      const post = w.scheduler.postTask.bind(w.scheduler);
      w.scheduled = 0;
      w.scheduler.postTask = (callback: () => void, options: any) => {
        if (options?.priority === "background") w.scheduled++;
        return post(callback, options);
      };
    });
    for (let attempt = 0; attempt < 12; attempt++) {
      await page.evaluate(attempt => {
        const w = window as any, view = { zoom: 1, panX: -attempt / 10, panY: 0 };
        w.renderer.render(w.frames, view, w.size, 1).close();
        w.renderer.prefetch(w.frames, view, w.size, 1, 1, { x: 0, y: 0 });
      }, attempt);
      await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    }
    const full = await page.evaluate(() => ({ scheduled: (window as any).scheduled, usage: (window as any).renderer.usage() }));
    expect(full.scheduled).toBe(0);
    expect(full.usage.rasterized).toBe(7);
    expect(full.usage.evicted).toBe(0);
    await page.evaluate(() => {
      const w = window as any;
      w.renderer.clear();
      w.renderer.prefetch(w.frames, { zoom: 1, panX: 0, panY: 0 }, w.size, 1, 1, { x: 0, y: 0 });
    });
    await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    const resumed = await page.evaluate(() => ({ scheduled: (window as any).scheduled, usage: (window as any).renderer.usage() }));
    expect(resumed.scheduled).toBeGreaterThan(0);
    expect(resumed.usage.prefetched).toBeGreaterThan(0);
    expect(resumed.usage.allocatedBytes).toBeLessThanOrEqual(200 * 1024);
  } finally { await page.close(); }
});

it("culls offscreen frame bounds before accessing the loaded SVG document", async () => {
  const page = await open();
  try {
    const result = await page.evaluate(() => {
      const w = window as any;
      let documentReads = 0;
      const image = { get naturalWidth() { documentReads++; return 80; }, get naturalHeight() { documentReads++; return 80; } };
      const tiles = w.tiles.designVisibleTiles({ source: { key: "offscreen", image }, x: 800, y: 800, width: 80, height: 80 },
        { zoom: 1, panX: 0, panY: 0 }, { width: 480, height: 360 }, 2);
      return { documentReads, tiles };
    });
    expect(result.tiles).toEqual([]);
    expect(result.documentReads).toBe(0);
  } finally { await page.close(); }
});

it("reuses retired texture storage under pressure without retaining the previous owner's pixels", async () => {
  const page = await open();
  try {
    const result = await page.evaluate(async () => {
      const w = window as any;
      const renderer = new w.tiles.DesignSourceTiles(310 * 1024);
      const original = WebGL2RenderingContext.prototype.texStorage2D;
      let allocations = 0;
      WebGL2RenderingContext.prototype.texStorage2D = function(...args) {
        allocations++; return original.apply(this, args);
      };
      const a = await w.add({ key: "personal", x: 0, y: 0, width: 120, height: 160, z: 0, color: "blue" });
      const b = await w.add({ key: "organization", x: 0, y: 0, width: 120, height: 160, z: 0, color: "red" });
      const output = new OffscreenCanvas(480, 360), context = output.getContext("2d")!;
      const pixels: number[][] = [];
      try {
        for (let i = 0; i < 8; i++) {
          const row = i % 2 ? b : a;
          const bitmap = renderer.render([{ source: { key: i % 2 ? "organization/version" : "personal/version", image: row.image },
            x: 0, y: 0, width: 120, height: 160, background: [0, 0, 0, 0] }],
          { zoom: 1, panX: 0, panY: 0 }, { width: 480, height: 360 }, 2);
          context.clearRect(0, 0, 480, 360); context.drawImage(bitmap, 0, 0, 480, 360); bitmap.close();
          pixels.push([...context.getImageData(50, 50, 1, 1).data]);
        }
        return { allocations, pixels, bytes: renderer.usage().bytes, entries: renderer.usage().entries };
      } finally { renderer.clear(); WebGL2RenderingContext.prototype.texStorage2D = original; }
    });
    expect(result.pixels).toEqual(Array.from({ length: 8 }, (_, i) => i % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    expect(result.entries).toBe(1);
    expect(result.bytes).toBeLessThanOrEqual(310 * 1024);
    expect(result.allocations).toBe(1);
  } finally { await page.close(); }
});

it("isolates same-name source versions and workspaces and bounds texture retention under pressure", async () => {
  const page = await open();
  try {
    const result = await page.evaluate(async () => {
      const w = window as any, renderer = new w.tiles.DesignSourceTiles(2 * 1024 * 1024);
      const colors: number[][] = [];
      for (let i = 0; i < 12; i++) {
        const row = await w.add({ key: `owner-${i}/same.html`, x: 0, y: 0, width: 480, height: 360, z: i, color: i % 2 ? "red" : "blue" });
        const bitmap = renderer.render([{ source: { key: `owner-${i}/version-${i}`, image: row.image }, x: 0, y: 0, width: 480, height: 360, background: [0,0,0,0] }],
          { zoom: 1, panX: 0, panY: 0 }, { width: 480, height: 360 }, 1);
        const output = new OffscreenCanvas(480,360), ctx = output.getContext("2d")!;
        ctx.drawImage(bitmap,0,0); bitmap.close(); colors.push([...ctx.getImageData(40,40,1,1).data]);
      }
      const usage = renderer.usage(); renderer.clear();
      return { colors, usage, cleared: renderer.usage() };
    });
    expect(result.colors).toEqual(Array.from({ length: 12 }, (_, i) => i % 2 ? [255,0,0,255] : [0,0,255,255]));
    expect(result.usage.evicted).toBeGreaterThan(0);
    expect(result.usage.peakBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.cleared).toMatchObject({ bytes: 0, entries: 0, waiting: 0 });
  } finally { await page.close(); }
});

it("retires hidden viewport buffers and unused predictions while retaining displayed tiles for a warm return", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "suspend", x: 20, y: 40, width: 320, height: 240, z: 0, color: "blue" });
      w.paint(); w.release = w.tiles.attachDesignSourceTiles(w.row.image, "owner/suspend");
    });
    await page.waitForFunction(() => !!document.querySelector("[data-design-source-plane]"));
    await page.waitForFunction(() => (window as any).tiles.designSourceTiles.usage().waiting === 0);
    const before = await page.screenshot();
    const suspended = await page.evaluate(async () => {
      const w = window as any;
      w.tiles.designSourceTiles.cancelPrefetch();
      const before = w.tiles.designSourceTiles.usage();
      w.release();
      const immediate = w.tiles.designSourceTiles.usage();
      await new Promise(resolve => setTimeout(resolve, 0));
      return { before, immediate, after: w.tiles.designSourceTiles.usage(), scene: w.tiles.designSourceSceneUsage() };
    });
    expect(suspended.immediate).toMatchObject({ waiting: 0, speculativeBytes: 0 });
    expect(suspended.before.backingBytes).toBeGreaterThan(4);
    expect(suspended.after.backingBytes).toBe(4);
    expect(suspended.after.scratchBytes).toBe(4);
    expect(suspended.before.speculativeBytes).toBeGreaterThan(0);
    expect(suspended.after.speculativeBytes).toBe(0);
    expect(suspended.after.bytes).toBe(suspended.before.bytes - suspended.before.speculativeBytes);
    expect(suspended.scene).toMatchObject({ activeScenes: 0, outputPlanes: 0, outputBytes: 0 });
    const returned = await page.evaluate(async () => {
      const w = window as any;
      w.release = w.tiles.attachDesignSourceTiles(w.row.image, "owner/suspend");
      await Promise.resolve();
      w.tiles.designSourceTiles.cancelPrefetch();
      return w.tiles.designSourceTiles.usage();
    });
    expect(returned.rasterized).toBe(suspended.after.rasterized);
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(12);
  } finally { await page.close(); }
});

it("reuses bounded retired prediction storage across owner returns and releases it completely on pressure", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.renderer = new w.tiles.DesignSourceTiles(2 * 1024 * 1024);
      w.rows = [await w.add({ key: "personal/prediction", x: 0, y: 0, width: 120, height: 160, z: 0, color: "blue" }),
        await w.add({ key: "organization/prediction", x: 0, y: 0, width: 120, height: 160, z: 1, color: "red" })];
      w.allocations = 0;
      const allocate = WebGL2RenderingContext.prototype.texStorage2D;
      WebGL2RenderingContext.prototype.texStorage2D = function(...args) { w.allocations++; return allocate.apply(this, args); };
      w.frames = (owner: number) => [{ source: { key: w.rows[owner].article.dataset.designFrame, image: w.rows[owner].image },
        x: 0, y: 0, width: 120, height: 160, background: [0, 0, 0, 0] }];
      w.predict = (owner: number) => w.renderer.prefetch(w.frames(owner), { zoom: 1, panX: 0, panY: 0 },
        { width: 480, height: 360 }, 1, 1, { x: 0, y: 0 });
      w.renderer.render(w.frames(0), { zoom: 1, panX: 0, panY: 0 }, { width: 480, height: 360 }, 1).close();
      w.predict(0);
    });
    await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
    const warmed = await page.evaluate(() => (window as any).allocations);
    const pixels: number[][] = [];
    for (let i = 0; i < 12; i++) {
      const hidden = await page.evaluate((owner) => {
        const w = window as any; w.renderer.suspendOutput();
        const hidden = w.renderer.usage(); w.predict(owner); return hidden;
      }, i % 2);
      expect(hidden).toMatchObject({ waiting: 0, speculativeBytes: 0, backingBytes: 4, scratchBytes: 4 });
      expect(hidden.bytes + (hidden.reusableBytes ?? 0)).toBeLessThanOrEqual(hidden.limit);
      expect(hidden.reusableEntries ?? 0).toBeLessThanOrEqual(64);
      await page.waitForFunction(() => (window as any).renderer.usage().waiting === 0);
      pixels.push(await page.evaluate((owner) => {
        const w = window as any;
        const bitmap = w.renderer.render(w.frames(owner), { zoom: 2, panX: 0, panY: 0 }, { width: 480, height: 360 }, 1);
        const surface = new OffscreenCanvas(480, 360), context = surface.getContext("2d")!;
        context.drawImage(bitmap, 0, 0); bitmap.close();
        const pixel = [...context.getImageData(40, 40, 1, 1).data];
        // The next owner cannot inherit these pixels; only empty storage is reusable.
        w.renderer.forget(w.frames(owner)[0].source.key);
        return pixel;
      }, i % 2));
    }
    expect(pixels).toEqual(Array.from({ length: 12 }, (_, i) => i % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const result = await page.evaluate(() => {
      const w = window as any, before = w.renderer.usage(), allocations = w.allocations;
      w.renderer.clear(); return { allocations, before, cleared: w.renderer.usage() };
    });
    expect(result.allocations).toBeLessThanOrEqual(warmed + 2);
    expect(result.before.bytes + result.before.reusableBytes).toBeLessThanOrEqual(result.before.limit);
    expect(result.cleared).toMatchObject({ bytes: 0, entries: 0, reusableBytes: 0, reusableEntries: 0, waiting: 0 });
  } finally { await page.close(); }
});

it("charges reusable GPU storage to the same allocation ceiling across different source sizes", async () => {
  const page = await open();
  try {
    const result = await page.evaluate(async () => {
      const w = window as any, limit = 2 * 1024 * 1024, renderer = new w.tiles.DesignSourceTiles(limit);
      const storage = WebGL2RenderingContext.prototype.texStorage2D, remove = WebGL2RenderingContext.prototype.deleteTexture;
      const allocated = new Map<WebGLTexture, number>();
      let peak = 0, accountingMatches = true, entriesBounded = true;
      WebGL2RenderingContext.prototype.texStorage2D = function(...args) {
        const texture = this.getParameter(this.TEXTURE_BINDING_2D);
        allocated.set(texture, args[3] * args[4] * 4);
        peak = Math.max(peak, [...allocated.values()].reduce((a, b) => a + b, 0));
        return storage.apply(this, args);
      };
      WebGL2RenderingContext.prototype.deleteTexture = function(texture) {
        if (texture) allocated.delete(texture);
        return remove.call(this, texture);
      };
      try {
        for (let i = 0; i < 96; i++) {
          const row = await w.add({ key: `sized-owner-${i}`, x: 0, y: 0, width: 96 + i, height: 120, z: i, color: "blue" });
          const key = row.article.dataset.designFrame;
          renderer.render([{ source: { key, image: row.image }, x: 0, y: 0, width: 96 + i, height: 120, background: [0, 0, 0, 0] }],
            { zoom: 1, panX: 0, panY: 0 }, { width: 480, height: 360 }, 1).close();
          renderer.forget(key); row.article.remove(); renderer.suspendOutput();
          const usage = renderer.usage();
          accountingMatches &&= usage.allocatedBytes === [...allocated.values()].reduce((a, b) => a + b, 0);
          entriesBounded &&= usage.reusableEntries <= 64 && usage.reusableBytes <= 16 * 1024 * 1024;
        }
        renderer.clear();
        return { peak, limit, accountingMatches, entriesBounded, remaining: allocated.size };
      } finally {
        renderer.clear(); WebGL2RenderingContext.prototype.texStorage2D = storage; WebGL2RenderingContext.prototype.deleteTexture = remove;
      }
    });
    expect(result.peak).toBeLessThanOrEqual(result.limit);
    expect(result.accountingMatches).toBe(true);
    expect(result.entriesBounded).toBe(true);
    expect(result.remaining).toBe(0);
  } finally { await page.close(); }
});

it("restores source paint atomically on GPU context loss and leaves no hidden output or queued work", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "loss", x: 20, y: 50, width: 300, height: 200, z: 0, color: w.tileColors.contextLoss, background: w.tileColors.contextLossBackground });
      w.paint();
    });
    const before = await page.screenshot();
    await page.evaluate(() => {
      const w = window as any;
      w.releases.push(w.tiles.attachDesignSourceTiles(w.row.image, "loss"));
    });
    await page.waitForFunction(() => !!document.querySelector("[data-design-source-plane]"));
    await page.evaluate(() => {
      const w = window as any;
      w.tiles.designSourceTiles.gl.getExtension("WEBGL_lose_context").loseContext();
    });
    await page.waitForFunction(() => !document.querySelector("[data-design-source-plane]"));
    expect(await changed(page, before, await page.screenshot())).toBe(0);
    expect(await page.evaluate(() => (window as any).tiles.designSourceTiles.usage())).toMatchObject({ bytes: 0, entries: 0, waiting: 0, contexts: 0 });
    expect(await page.evaluate(() => (window as any).tiles.designSourceSceneUsage())).toMatchObject({ outputBytes: 0, outputPlanes: 0 });
  } finally { await page.close(); }
});

it("keeps overview outlines at one screen pixel without redundant DOM paint or pixel snapping as zoom changes", async () => {
  const page = await open();
  try {
    await page.addStyleTag({ content: `[data-design-frame]{outline:calc(1px * var(--design-canvas-inverse-zoom)) solid ${designSourceTileColors.outline}}` });
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "overview", x: 30, y: 50, width: 240, height: 190, z: 0, color: "transparent", compact: true });
      w.paint({ zoom: .4, panX: 30.25, panY: 30.25 });
      // Chromium rounds a CSS outline width before its ancestor transforms
      // it. Use the intended one-screen-pixel outline as the reference; its
      // width must not jump as inverse zoom crosses a rounded CSS pixel.
      w.row.article.style.outline = "none";
      const reference = document.createElement("div"); reference.id = "outline-reference";
      reference.style.cssText = "position:absolute;inset:0;pointer-events:none";
      reference.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect x="41.75" y="49.75" width="97" height="77" fill="none" stroke="' + w.tileColors.outline + '" stroke-width="1"/></svg>';
      document.querySelector("#viewport")!.append(reference);
    });
    const before = await page.screenshot();
    await page.evaluate(() => {
      const w = window as any; document.querySelector("#outline-reference")!.remove(); w.row.article.style.outline = "";
      w.releases.push(w.tiles.attachDesignSourceTiles(w.row.image, "overview"));
    });
    expect(await page.locator("[data-design-frame]").evaluate(node => getComputedStyle(node).outlineWidth)).toBe("0px");
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(16);
    await page.mouse.move(60, 80);
    expect(await page.evaluate(() => document.elementFromPoint(60, 80)?.closest("article")?.dataset.designFrame)).toBe("overview");
  } finally { await page.close(); }
});

it("keeps compact controls keyboard reachable without inheriting every camera update until focus reveals them", async () => {
  const page = await open();
  try {
    await page.addStyleTag({ content: '[data-design-frame-chrome]{transform-origin:left bottom;transform:translateY(calc(-8px * var(--design-canvas-inverse-zoom))) scale(var(--design-canvas-inverse-zoom))}' });
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "keyboard", x: 60, y: 150, width: 240, height: 190, z: 0, color: "blue", compact: true, chrome: true });
      const button = document.createElement("button"); button.textContent = "Frame title";
      w.row.article.querySelector('[data-design-frame-chrome]').append(button);
      w.paint({ zoom: .4, panX: 20, panY: 20 });
      w.releases.push(w.tiles.attachDesignSourceTiles(w.row.image, "keyboard-owner/version"));
    });
    const state = () => page.locator('[data-design-frame]').evaluate(node => {
      const root = getComputedStyle(node), chrome = getComputedStyle(node.querySelector('[data-design-frame-chrome]')!);
      return { inverse: root.getPropertyValue('--design-canvas-inverse-zoom').trim(), chrome: chrome.clip, opacity: root.opacity };
    });
    expect(await state()).toMatchObject({ inverse: "1", chrome: "rect(0px, 0px, 0px, 0px)", opacity: "1" });
    await page.evaluate(() => (window as any).paint({ zoom: .5, panX: 20, panY: 20 }));
    expect(await state()).toMatchObject({ inverse: "1", chrome: "rect(0px, 0px, 0px, 0px)" });
    await page.keyboard.press('Tab');
    expect(await page.locator('button').evaluate(node => document.activeElement === node)).toBe(true);
    expect(await state()).toMatchObject({ inverse: "2", chrome: "auto", opacity: "1" });
    const box = await page.locator('[data-design-frame-chrome]').boundingBox();
    expect(box?.height).toBe(30);
    expect(box?.x).toBe(50);
  } finally { await page.close(); }
});

it("preserves a non-frame ghost's stack slot and camera coordinates between ordinary frames", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.rows = [await w.add({ key: "back", x: 0, y: 0, width: 180, height: 180, z: 0, color: "blue" }),
        await w.add({ key: "front", x: 220, y: 0, width: 180, height: 180, z: 10, color: w.tileColors.frontAlpha })];
      const ghost = document.createElement("div");
      ghost.style.cssText = "position:absolute;left:180px;top:0;width:100px;height:100px;z-index:5;background:lime;transform:translate3d(10px,5px,0)";
      document.querySelector("#world")!.append(ghost);
      w.paint({ zoom: .75, panX: 30, panY: 50 });
    });
    const before = await page.screenshot();
    await page.evaluate(() => { const w = window as any; w.releases = w.rows.map((row: any, i: number) => w.tiles.attachDesignSourceTiles(row.image, `ghost-${i}`)); });
    expect(await page.locator("[data-design-source-plane]").count()).toBe(1);
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(16);
  } finally { await page.close(); }
});

it("repartitions a protected frame and updates frame geometry without needing another camera event", async () => {
  const page = await open();
  try {
    await page.evaluate(async () => {
      const w = window as any;
      w.row = await w.add({ key: "selected", x: 30, y: 50, width: 180, height: 180, z: 0, color: "blue" });
      w.paint(); w.releases.push(w.tiles.attachDesignSourceTiles(w.row.image, "selected"));
    });
    expect(await page.locator("[data-design-source-tiled]").count()).toBe(1);
    await page.evaluate(async () => {
      const w = window as any;
      w.row.article.dataset.designFrameChromeProtected = "";
      w.row.article.dataset.designFrameStackProtected = "";
      await Promise.resolve();
    });
    expect(await page.locator("[data-design-source-tiled]").count()).toBe(0);
    await page.evaluate(async () => {
      const w = window as any;
      delete w.row.article.dataset.designFrameChromeProtected;
      delete w.row.article.dataset.designFrameStackProtected;
      w.row.article.style.left = "80px";
      await Promise.resolve();
    });
    const before = await page.screenshot();
    await page.evaluate(() => { const w = window as any; w.releases.forEach((release: () => void) => release()); });
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(12);
  } finally { await page.close(); }
});

it("reuses bounded CSS color resolution across warm returns and preserves transparent theme changes", async () => {
  const page = await open();
  try {
    await page.addStyleTag({ content: `.changed-theme article { background-color: transparent; outline: 1px solid ${designSourceTileColors.upperAlpha}; }` });
    await page.evaluate(async () => {
      const w = window as any;
      w.rows = [await w.add({ key: "colors/a", x: 20, y: 55, width: 120, height: 160, z: 0, color: "blue", background: w.tileColors.blueAlpha }),
        await w.add({ key: "colors/b", x: 220, y: 55, width: 120, height: 160, z: 1, color: "red", background: w.tileColors.orangeAlpha })];
      w.paint();
      const create = document.createElement.bind(document);
      w.canvasAllocations = 0;
      (document as any).createElement = (...args: any[]) => {
        if (args[0] === "canvas") w.canvasAllocations++;
        return (create as (...values: any[]) => HTMLElement)(...args);
      };
    });
    const before = await page.screenshot();
    await page.evaluate(async () => {
      const w = window as any;
      for (let i = 0; i < 12; i++) {
        for (const release of w.releases) release();
        w.releases = w.rows.map((row: any) => w.tiles.attachDesignSourceTiles(row.image, row.article.dataset.designFrame));
        await Promise.resolve();
      }
    });
    expect(await changed(page, before, await page.screenshot())).toBeLessThan(12);
    expect(await page.evaluate(() => (window as any).canvasAllocations)).toBeLessThanOrEqual(2);
    await page.evaluate(() => document.documentElement.classList.add("changed-theme"));
    const themed = await page.screenshot();
    await page.evaluate(() => { const w = window as any; for (const release of w.releases) release(); });
    expect(await changed(page, themed, await page.screenshot())).toBeLessThan(12);
    expect(await page.evaluate(() => (window as any).canvasAllocations)).toBeLessThanOrEqual(2);
  } finally { await page.close(); }
});

it("preserves queued source pixels when a later frame recycles their texture storage", async () => {
  const page = await open();
  try {
    const result = await page.evaluate(async () => {
      const w = window as any;
      const renderer = new w.tiles.DesignSourceTiles(310 * 1024);
      const a = await w.add({ key: "personal/queued", x: 0, y: 0, width: 120, height: 160, z: 0, color: "blue" });
      const b = await w.add({ key: "organization/queued", x: 160, y: 0, width: 120, height: 160, z: 1, color: "red" });
      const output = new OffscreenCanvas(480, 360), context = output.getContext("2d")!;
      const pixels: number[][] = [];
      try {
        for (const reverse of [false, true]) {
          const rows = reverse ? [b, a] : [a, b];
          const bitmap = renderer.render(rows.map((row: any, index: number) => ({
            source: { key: row.article.dataset.designFrame, image: row.image },
            x: index * 160, y: 0, width: 120, height: 160, background: [0, 0, 0, 0],
          })), { zoom: 1, panX: 0, panY: 0 }, { width: 480, height: 360 }, 2);
          context.clearRect(0, 0, 480, 360); context.drawImage(bitmap, 0, 0, 480, 360); bitmap.close();
          pixels.push([...context.getImageData(50, 50, 1, 1).data], [...context.getImageData(210, 50, 1, 1).data]);
        }
        return { pixels, bytes: renderer.usage().bytes, entries: renderer.usage().entries };
      } finally { renderer.clear(); }
    });
    expect(result.pixels).toEqual([[0, 0, 255, 255], [255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 255, 255]]);
    expect(result.entries).toBe(1);
    expect(result.bytes).toBeLessThanOrEqual(310 * 1024);
  } finally { await page.close(); }
});
