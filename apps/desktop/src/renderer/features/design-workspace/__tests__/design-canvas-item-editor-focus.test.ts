import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, expect as playwrightExpect, type Browser, type Page } from "@playwright/test";
import { build, type Plugin } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";

// Leaving a canvas item editor, by click-away or keyboard, never moves focus
// after a failed commit, an empty section writes nothing, and a slow write
// closes only the draft it committed. `focusCanvas` focuses the viewport, as
// the real canvas does.
const root = path.resolve("apps/desktop/src/renderer/features/design-workspace");
const stubs: Plugin = {
  name: "stubs",
  setup(build) {
    build.onResolve({ filter: /(design-workspace-cache|workspace-files-cache)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", contents: `
      export const putDesignCanvasItemCached = async (...args) => window.itemWrite ? window.itemWrite(...args) : ({ snapshot: null });
      export const deleteDesignCanvasItemCached = async (...args) => window.itemDelete ? window.itemDelete(...args) : null;
      export const loadWorkspaceFiles = async () => [];
      export const peekWorkspaceFiles = () => null;` }));
  },
};
const bundle = () => build({ stdin: { resolveDir: root, loader: "tsx", contents: `
  import React, { useRef } from "react";
  import { createRoot } from "react-dom/client";
  import { flushSync } from "react-dom";
  import { DesignCanvasItemsLayer } from "./design-canvas-items";
  const viewport = { width: 800, height: 600 };
  const state = window.items = { items: [], view: { zoom: 1, panX: 0, panY: 0 }, selectedId: null, writes: [] };
  function Canvas() {
    const world = useRef(null);
    const layer = useRef(null);
    state.layer = layer;
    return <div data-design-canvas-viewport="" tabIndex={0} style={{ position: "absolute", inset: 0 }}>
      <div data-design-canvas-world="" ref={world} style={{ position: "absolute", inset: 0, transformOrigin: "0 0" }}>
        <DesignCanvasItemsLayer ref={layer} workspaceId="w" pageId="page" folder="/w" items={state.items} world={world}
          view={state.view} viewport={viewport} active editable selectedId={state.selectedId} onSelect={() => {}}
          zoom={() => state.view.zoom} panning={() => false}
          focusCanvas={() => document.querySelector("[data-design-canvas-viewport]").focus({ preventScroll: true })} />
      </div>
    </div>;
  }
  const app = createRoot(document.querySelector("#viewport"));
  state.render = () => flushSync(() => app.render(<Canvas />));
  state.place = (kind) => flushSync(() => state.layer.current.place(kind, { x: 20, y: 20 }));
` }, bundle: true, write: false, format: "iife", platform: "browser", plugins: [stubs],
  define: { "process.env.NODE_ENV": '"production"' } }).then((result) => result.outputFiles[0]!.text);
const css = readFileSync(path.join(root, "design-workspace-ui.css"), "utf8");
let browser: Browser;
let source: string;
beforeAll(async () => { [browser, source] = await Promise.all([chromium.launch(), bundle()]); });
afterAll(async () => { await browser?.close(); });

const open = async () => {
  const page = await browser.newPage();
  await page.setContent('<div id="viewport" style="position:relative;width:800px;height:600px;overflow:hidden"></div><button id="elsewhere">Elsewhere</button>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: source });
  return page;
};
const startPlaced = async (page: Page, kind: "section" | "note") => {
  await page.evaluate((itemKind) => {
    const state = (window as any).items;
    state.items = []; state.writes = [];
    (window as any).itemWrite = async (...args: unknown[]) => { state.writes.push(args); return { snapshot: null, itemId: "created" }; };
    state.render(); state.place(itemKind);
  }, kind);
  return page.locator("[data-design-canvas-item-draft] textarea, [data-design-canvas-item-draft] input");
};
const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);

it("clicking away from a new empty section closes it without a write or an error", async () => {
  const page = await open();
  try {
    const field = await startPlaced(page, "section");
    await playwrightExpect(field).toBeFocused();
    await page.click("#elsewhere");
    await playwrightExpect(field).toHaveCount(0);
    await playwrightExpect(page.getByRole("alert")).toHaveCount(0);
    expect(await activeId(page)).toBe("elsewhere");
    expect(await page.evaluate(() => (window as any).items.writes)).toHaveLength(0);
  } finally { await page.close(); }
});

it("Enter on a new empty section closes it without a write or an error", async () => {
  const page = await open();
  try {
    const field = await startPlaced(page, "section");
    await field.press("Enter");
    await playwrightExpect(field).toHaveCount(0);
    await playwrightExpect(page.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).items.writes)).toHaveLength(0);
  } finally { await page.close(); }
});

it("Enter on an existing section cleared to empty keeps its confirmed title, like Layers rename", async () => {
  const page = await open();
  try {
    await page.evaluate(() => {
      const state = (window as any).items; state.writes = [];
      state.items = [{ id: "sec_1", kind: "section", x: 0, y: 0, width: 240, text: "Hero" }];
      state.selectedId = "sec_1"; state.render();
      (window as any).itemWrite = async (...args: unknown[]) => { state.writes.push(args); return { snapshot: null, itemId: "sec_1" }; };
    });
    await page.locator("[data-design-canvas-viewport]").focus(); await page.keyboard.press("Enter");
    const field = page.locator('[data-design-canvas-item="sec_1"] input');
    await playwrightExpect(field).toHaveValue("Hero");
    await field.fill("   "); await field.press("Enter");
    await playwrightExpect(field).toHaveCount(0);
    await playwrightExpect(page.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).items.writes)).toHaveLength(0);
  } finally { await page.close(); }
});

it("an invalid draft left by clicking away keeps its error without pulling focus back", async () => {
  const page = await open();
  try {
    const field = await startPlaced(page, "section");
    await field.fill("x".repeat(121));
    await page.click("#elsewhere");
    await playwrightExpect(page.getByRole("alert")).toBeVisible();
    await page.waitForTimeout(100);
    expect(await activeId(page)).toBe("elsewhere");
    await playwrightExpect(field).toHaveValue("x".repeat(121));
  } finally { await page.close(); }
});

it("a write rejected after clicking away does not pull focus back", async () => {
  const page = await open();
  try {
    const field = await startPlaced(page, "note");
    await page.evaluate(() => { (window as any).itemWrite = () => new Promise((_, reject) => setTimeout(() => reject(new Error("Disk is read-only")), 50)); });
    await field.fill("Keep this draft");
    await page.click("#elsewhere");
    await playwrightExpect(page.getByRole("alert")).toContainText("Disk is read-only");
    await page.waitForTimeout(100);
    expect(await activeId(page)).toBe("elsewhere");
    await playwrightExpect(field).toHaveValue("Keep this draft");
  } finally { await page.close(); }
});

it("a slow write from a previous editor does not close the editor opened after it", async () => {
  const page = await open();
  try {
    await page.evaluate(() => {
      const state = (window as any).items; state.writes = [];
      state.items = [
        { id: "note_a", kind: "note", x: 0, y: 0, width: 240, height: 120, text: "A" },
        { id: "note_b", kind: "note", x: 300, y: 0, width: 240, height: 120, text: "B" },
      ];
      state.selectedId = "note_a"; state.render();
      (window as any).itemWrite = (...args: unknown[]) => { state.writes.push(args);
        return new Promise((resolve) => { (window as any).release = () => resolve({ snapshot: null, itemId: "note_a" }); }); };
    });
    const viewport = page.locator("[data-design-canvas-viewport]");
    await viewport.focus(); await page.keyboard.press("Enter");
    const first = page.locator('[data-design-canvas-item="note_a"] textarea');
    await first.fill("A2");
    // As on the real canvas: pressing another item focuses the canvas (A commits), and the double-click edits it.
    await page.locator('[data-design-canvas-item="note_b"]').dblclick();
    expect(await page.evaluate(() => (window as any).items.writes.length)).toBe(1);
    const second = page.locator('[data-design-canvas-item="note_b"] textarea');
    await playwrightExpect(second).toBeVisible();
    await page.evaluate(() => (window as any).release());
    await page.waitForTimeout(100);
    await playwrightExpect(second).toBeVisible();
  } finally { await page.close(); }
});
