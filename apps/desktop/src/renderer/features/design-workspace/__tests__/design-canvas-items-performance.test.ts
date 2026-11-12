import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { build, type Plugin } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";

// 256 items on a page are chrome: no iframe or runtime, only those in the
// camera's view and overscan are mounted, a camera paint follows them without
// re-rendering the page, and a resting page adds no listener, timer or frame.
const root = path.resolve("apps/desktop/src/renderer/features/design-workspace");
// The layer's writes and file list are not under test; nothing here reaches a bridge.
const stubs: Plugin = {
  name: "stubs",
  setup(build) {
    build.onResolve({ filter: /(design-workspace-cache|workspace-files-cache)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", contents: `
      export const putDesignCanvasItemCached = async () => ({ snapshot: null });
      export const deleteDesignCanvasItemCached = async () => null;
      export const loadWorkspaceFiles = async () => [];
      export const peekWorkspaceFiles = () => null;` }));
  },
};
const bundle = () => build({ stdin: { resolveDir: root, loader: "tsx", contents: `
  import React, { Profiler, useRef } from "react";
  import { createRoot } from "react-dom/client";
  import { flushSync } from "react-dom";
  import { DesignCanvasItemsLayer } from "./design-canvas-items";
  import { paintDesignCanvasCamera } from "./design-canvas-camera";
  const kinds = ["section", "note", "link"];
  const many = Array.from({ length: 256 }, (_, i) => {
    const base = { id: "i" + i, x: (i % 16) * 600, y: Math.floor(i / 16) * 300, width: 240 };
    const kind = kinds[i % 3];
    return kind === "section" ? { ...base, kind, text: "Section " + i }
      : kind === "note" ? { ...base, kind, height: 120, text: "Note " + i } : { ...base, kind, target: "docs/file-" + i + ".md" };
  });
  const viewport = { width: 800, height: 600 };
  window.itemsMany = many;
  const state = window.items = { renders: 0, items: many, view: { zoom: 1, panX: 0, panY: 0 }, selectedId: null };
  function Canvas() {
    const world = useRef(null);
    state.world = world;
    return <div data-design-canvas-viewport="" tabIndex={0} style={{ position: "absolute", inset: 0 }}>
      <div data-design-canvas-world="" ref={world} style={{ position: "absolute", inset: 0, transformOrigin: "0 0" }}>
        <Profiler id="items" onRender={() => { state.renders++; }}>
          <DesignCanvasItemsLayer workspaceId="w" pageId="page" folder="/w" items={state.items} world={world}
            view={state.view} viewport={viewport} active editable selectedId={state.selectedId} onSelect={() => {}}
            zoom={() => state.view.zoom} panning={() => false} focusCanvas={() => {}} />
        </Profiler>
      </div>
    </div>;
  }
  const app = createRoot(document.querySelector("#viewport"));
  state.render = () => flushSync(() => app.render(<Canvas />));
  state.paint = (camera) => paintDesignCanvasCamera(state.world.current, camera, true, viewport);
` }, bundle: true, write: false, format: "iife", platform: "browser", plugins: [stubs],
  define: { "process.env.NODE_ENV": '"production"' } }).then((result) => result.outputFiles[0]!.text);
const css = readFileSync(path.join(root, "design-workspace-ui.css"), "utf8");
let browser: Browser;
let source: string;
// Plugins need esbuild's async API.
beforeAll(async () => { [browser, source] = await Promise.all([chromium.launch(), bundle()]); });
afterAll(async () => { await browser?.close(); });

const open = async () => {
  const page = await browser.newPage();
  await page.setContent('<div id="viewport" style="position:relative;width:800px;height:600px;overflow:hidden"></div>');
  await page.addStyleTag({ content: css });
  // Count what a resting page would leave running.
  await page.evaluate(() => {
    const counts = (window as any).resting = { listeners: 0, timers: 0, frames: 0 };
    for (const target of [window, document] as EventTarget[]) {
      const add = target.addEventListener.bind(target);
      target.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
        counts.listeners++;
        add(type, listener, options);
      };
    }
    const timeout = window.setTimeout.bind(window), interval = window.setInterval.bind(window), frame = window.requestAnimationFrame.bind(window);
    window.setTimeout = ((...args: Parameters<typeof timeout>) => { counts.timers++; return timeout(...args); }) as typeof setTimeout;
    window.setInterval = ((...args: Parameters<typeof interval>) => { counts.timers++; return interval(...args); }) as typeof setInterval;
    window.requestAnimationFrame = (callback) => { counts.frames++; return frame(callback); };
  });
  await page.addScriptTag({ content: source });
  return page;
};

it("mounts only the items in view of 256, with no iframe or runtime", async () => {
  const page = await open();
  try {
    await page.evaluate(() => (window as any).items.render());
    const mounted = await page.locator("[data-design-canvas-item]").count();
    // An 800×600 view plus 240px of overscan covers a few columns and rows.
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(24);
    expect(await page.locator("iframe, script[data-zeros-design-runtime]").count()).toBe(0);
    await page.evaluate(() => { const state = (window as any).items; state.view = { zoom: 1, panX: -50_000, panY: -50_000 }; state.render(); });
    expect(await page.locator("[data-design-canvas-item]").count()).toBe(0);
    // Zoomed out over the whole page, all of them are in view.
    await page.evaluate(() => { const state = (window as any).items; state.view = { zoom: 0.05, panX: 0, panY: 0 }; state.render(); });
    expect(await page.locator("[data-design-canvas-item]").count()).toBe(256);
  } finally { await page.close(); }
});

it("follows a camera paint without re-rendering for motion that keeps the same items", async () => {
  const page = await open();
  try {
    await page.evaluate(() => (window as any).items.render());
    const before = await page.evaluate(() => (window as any).items.renders);
    // A small pan inside the overscan changes nothing mounted.
    await page.evaluate(() => (window as any).items.paint({ zoom: 1, panX: -10, panY: -10 }));
    expect(await page.evaluate(() => (window as any).items.renders)).toBe(before);
    // A long pan brings other items in, before the settled view catches up.
    await page.evaluate(() => (window as any).items.paint({ zoom: 1, panX: -3_000, panY: -1_200 }));
    await page.waitForFunction(() => document.querySelector('[data-design-canvas-item="i69"]') !== null);
    expect(await page.locator('[data-design-canvas-item="i0"]').count()).toBe(0);
  } finally { await page.close(); }
});

it("leaves nothing running at rest, with items or without", async () => {
  const page = await open();
  try {
    const rest = () => page.evaluate(async () => {
      const counts = (window as any).resting; const start = { ...counts };
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The wait's own timer is not the page's.
      return { listeners: counts.listeners - start.listeners, frames: counts.frames - start.frames, timers: counts.timers - start.timers - 1 };
    });
    // A page without items mounts nothing and starts nothing, even while mounting.
    const empty = await page.evaluate(async () => {
      const counts = (window as any).resting; const start = { ...counts }; const state = (window as any).items;
      state.items = []; state.render();
      return { listeners: counts.listeners - start.listeners, frames: counts.frames - start.frames, timers: counts.timers - start.timers };
    });
    expect(empty).toEqual({ listeners: 0, frames: 0, timers: 0 });
    expect(await page.locator("[data-design-canvas-items]").count()).toBe(0);
    expect(await rest()).toEqual({ listeners: 0, frames: 0, timers: 0 });
    // With 256 items and nothing selected, a resting page is just as quiet.
    await page.evaluate(() => { const state = (window as any).items; state.items = (window as any).itemsMany; state.render(); });
    expect(await page.locator("[data-design-canvas-item]").count()).toBeGreaterThan(0);
    expect(await rest()).toEqual({ listeners: 0, frames: 0, timers: 0 });
  } finally { await page.close(); }
});
