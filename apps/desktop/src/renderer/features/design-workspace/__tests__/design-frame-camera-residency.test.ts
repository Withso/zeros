import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve("apps/desktop/src/renderer/features/design-workspace");
const source = buildSync({ stdin: { resolveDir: root, loader: "tsx", contents: `
  import React, { useLayoutEffect, useRef } from "react";
  import { createRoot } from "react-dom/client";
  import { flushSync } from "react-dom";
  import { useDesignFrameResidency } from "./state/use-design-frame-residency";
  import { paintDesignCanvasCamera } from "./design-canvas-camera";
  const frames = Array.from({ length: 256 }, (_, i) => ({ file: String(i), x: i % 16 * 400,
    y: Math.floor(i / 16) * 200, width: 200, height: 100, sourceVersion: "a".repeat(24),
    surfaceCost: { nodes: 20, sourceBytes: 2000, imageBytes: 0 } }));
  const viewport = { width: 800, height: 600 }, camera = { current: { zoom: .1, panX: 0, panY: 0 } };
  const ready = new Map(frames.map(frame => [frame.file, frame.sourceVersion]));
  const empty = new Set(), geometry = new Map();
  const state = window.residency = { renders: 0, reads: 0, ready, camera, active: true, selected: null, owner: "personal/directory/page" };
  const pixel = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><path fill="black" d="M0 0h200v100H0z"/></svg>');
  function Canvas() {
    state.renders++;
    const world = useRef(null);
    const result = useDesignFrameResidency({ frames, owner: state.owner, active: state.active,
      viewport, camera, view: camera.current, selectedFrame: state.selected, requiredFiles: [],
      pictured: empty, covered: empty, devicePixelRatio: 1, sourceSurfacesEnabled: true,
      sourceReady: ready, geometry: () => { state.reads++; return geometry; } });
    state.refresh = result.refresh; state.live = [...result.live];
    state.paint = () => { paintDesignCanvasCamera(world.current, camera.current, true, viewport); result.refresh("camera"); };
    useLayoutEffect(() => { paintDesignCanvasCamera(world.current, camera.current, false, viewport); });
    return <div data-design-canvas-world ref={world} style={{ position: "absolute", inset: 0, transformOrigin: "0 0" }}>
      {result.frames.map(frame => <article key={frame.file} data-design-frame={frame.file}
        style={{ position: "absolute", left: frame.x, top: frame.y, width: frame.width, height: frame.height }}>
        <div data-design-source-vector-host><img src={pixel} data-design-source-ready="" data-design-source-buffer="displayed"
          style={{ width: "100%", height: "100%" }} /></div>
      </article>)}
    </div>;
  }
  const app = createRoot(document.querySelector("#viewport"));
  state.render = () => flushSync(() => app.render(<Canvas />)); state.render();
` }, bundle: true, write: false, format: "iife", platform: "browser", define: { "process.env.NODE_ENV": '"production"' } }).outputFiles[0].text;
const css = readFileSync(path.join(root, "design-workspace-ui.css"), "utf8");
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

it("paints warm viewport entry and exit without reconciling all 256 frame trees", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="viewport" style="position:relative;width:800px;height:600px;overflow:hidden"></div>');
    await page.addStyleTag({ content: css }); await page.addScriptTag({ content: source });
    await page.waitForFunction(() => [...document.images].length === 256 && [...document.images].every(img => img.complete));
    const renders = await page.evaluate(() => (window as any).residency.renders);
    const image = await page.locator('[data-design-frame="255"] img').elementHandle();
    await page.evaluate(async () => {
      const state = (window as any).residency;
      state.camera.current = { zoom: 8, panX: 0, panY: 0 }; state.paint();
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    });
    expect(await page.evaluate(() => (window as any).residency.renders)).toBe(renders);
    expect(await image!.evaluate(node => getComputedStyle(node).visibility)).toBe("hidden");
    // Return pixels are visible in the camera write, before React or the next
    // residency callback, and retain the same loaded image element.
    const returned = await page.evaluate(() => {
      const state = (window as any).residency;
      state.camera.current = { zoom: .1, panX: 0, panY: 0 }; state.paint();
      return getComputedStyle(document.querySelector('[data-design-frame="255"] img')!).visibility;
    });
    expect(returned).toBe("visible");
    expect(await image!.evaluate(node => node.isConnected && (node as HTMLImageElement).complete)).toBe(true);
    expect(await page.locator("[data-design-frame]").count()).toBe(256);
  } finally { await page.close(); }
});

it("continues to publish editor admission and cancel pending work when the exact owner hides", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="viewport" style="position:relative;width:800px;height:600px"></div>');
    await page.addStyleTag({ content: css }); await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      const state = (window as any).residency; state.selected = "255"; state.render();
    });
    expect(await page.evaluate(() => (window as any).residency.live)).toContain("255");
    await page.evaluate(async () => {
      const state = (window as any).residency; state.refresh(); state.active = false;
      state.owner = "organization/other-directory/page"; state.selected = null; state.render();
      await new Promise(requestAnimationFrame);
    });
    expect(await page.locator("[data-design-frame]").count()).toBe(0);
    expect(await page.evaluate(() => (window as any).residency.live)).toEqual([]);
  } finally { await page.close(); }
});

it("keeps fully cached camera motion out of residency work but rechecks cold and explicit demand", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="viewport" style="position:relative;width:800px;height:600px;overflow:hidden"></div>');
    await page.addStyleTag({ content: css }); await page.addScriptTag({ content: source });
    await page.waitForFunction(() => [...document.images].length === 256 && [...document.images].every(img => img.complete));
    const warm = await page.evaluate(async () => {
      const state = (window as any).residency, before = state.reads;
      for (const zoom of [1, 8, .1]) {
        state.camera.current = { zoom, panX: 0, panY: 0 }; state.paint();
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      }
      return { before, after: state.reads };
    });
    expect(warm.after).toBe(warm.before);
    // Readiness mutates independently of React. A camera must still reconsider
    // an unfinished source, while explicit demand always reaches admission.
    const changed = await page.evaluate(async () => {
      const state = (window as any).residency;
      state.ready.delete("0"); const before = state.reads; state.paint();
      await new Promise(requestAnimationFrame);
      const cold = state.reads;
      state.ready.set("0", "a".repeat(24)); state.refresh();
      await new Promise(requestAnimationFrame);
      return { before, cold, explicit: state.reads };
    });
    expect(changed.cold).toBeGreaterThan(changed.before);
    expect(changed.explicit).toBeGreaterThan(changed.cold);
    await page.evaluate(() => { const state = (window as any).residency; state.selected = "255"; state.render(); });
    expect(await page.evaluate(() => (window as any).residency.live)).toContain("255");
  } finally { await page.close(); }
});
