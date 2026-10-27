import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve("apps/desktop/src/renderer/features/design-workspace");
const source = buildSync({ entryPoints: [path.join(root, "design-canvas-camera.ts")], bundle: true,
  write: false, format: "iife", globalName: "camera", platform: "browser" }).outputFiles[0].text;
const css = readFileSync(path.join(root, "design-workspace-ui.css"), "utf8");
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function open() {
  const page = await browser.newPage();
  await page.setContent(`<div id="viewport" style="position:relative;width:500px;height:300px;overflow:hidden">
    <div id="world" data-design-canvas-world style="position:absolute;inset:0;transform-origin:0 0">
      <article data-design-frame="near" style="position:absolute;left:24px;top:40px;width:120px;height:80px;outline:calc(1px * var(--design-canvas-inverse-zoom)) solid">
        <div data-design-frame-chrome style="transform-origin:0 0;transform:scale(var(--design-canvas-inverse-zoom));height:28px"><button style="height:28px">Near frame</button></div>
        <div data-design-source-vector-host><img alt="" /></div>
      </article>
      <article data-design-frame="far" style="position:absolute;left:800px;top:40px;width:120px;height:80px;outline:calc(1px * var(--design-canvas-inverse-zoom)) solid">
        <div data-design-frame-chrome style="transform-origin:0 0;transform:scale(var(--design-canvas-inverse-zoom));height:28px"><button style="height:28px">Far frame</button></div>
      </article>
    </div></div>`);
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: source });
  await page.evaluate(() => { (window as any).stopChrome = (window as any).camera.observeDesignCanvasChrome(document.querySelector("#world")); });
  return page;
}

async function paint(page: Page, zoom: number, panX = 0, width?: number) {
  return page.evaluate(({ zoom, panX, width }) => {
    const world = document.querySelector<HTMLDivElement>("#world")!;
    (window as any).camera.paintDesignCanvasCamera(world, { zoom, panX, panY: 0 }, true,
      width === undefined ? undefined : { width, height: 300 });
    return [...world.querySelectorAll<HTMLElement>("[data-design-frame]")].map(frame => ({
      file: frame.dataset.designFrame,
      inverse: Number(getComputedStyle(frame).getPropertyValue("--design-canvas-inverse-zoom")),
      chromeHeight: frame.querySelector("[data-design-frame-chrome]")!.getBoundingClientRect().height,
    }));
  }, { zoom, panX, width });
}

it("stops propagating camera changes into offscreen frame trees and restores their scale before the return paint", async () => {
  const page = await open();
  try {
    const zoomed = await paint(page, 2, 0, 500);
    expect(zoomed[0]).toMatchObject({ inverse: .5, chromeHeight: 28 });
    expect(zoomed[1].inverse).toBe(1);
    const returned = await paint(page, 2, -1500);
    expect(returned[1]).toMatchObject({ inverse: .5, chromeHeight: 28 });
    expect(returned[0].inverse).toBe(1);
    expect(await page.locator("[data-design-frame]").count()).toBe(2);
  } finally { await page.close(); }
});

it("keeps active editing and chrome near the viewport boundary at the current camera scale", async () => {
  const page = await open();
  try {
    expect((await paint(page, 2, 0, 500))[1].inverse).toBe(1);
    await page.locator('[data-design-frame="far"]').evaluate(frame => frame.setAttribute("data-design-frame-chrome-protected", ""));
    // Selection/focus can arrive between camera events. Protection takes effect
    // immediately, including for an editor whose frame is still offscreen.
    expect(await page.locator('[data-design-frame="far"]').evaluate(frame =>
      Number(getComputedStyle(frame).getPropertyValue("--design-canvas-inverse-zoom")))).toBe(.5);
    expect((await paint(page, 2, 0, 500))[1].inverse).toBe(.5);
    await page.locator('[data-design-frame="far"]').evaluate(frame => {
      frame.removeAttribute("data-design-frame-chrome-protected"); (frame as HTMLElement).style.left = "260px";
    });
    // The frame is just outside the viewport but its label/handles may overlap.
    expect((await paint(page, 2))[1].inverse).toBe(.5);
  } finally { await page.close(); }
});

it("uses current resize geometry and viewport bounds without reading layout during camera painting", async () => {
  const page = await open();
  try {
    expect((await paint(page, 2, 0, 500))[1].inverse).toBe(1);
    expect((await paint(page, 2, 0, 2000))[1].inverse).toBe(.5);
    await page.locator('[data-design-frame="far"]').evaluate(frame => {
      (frame as HTMLElement).style.left = "-800px"; (frame as HTMLElement).style.width = "1000px";
    });
    expect((await paint(page, 2, 0, 500))[1].inverse).toBe(.5);
    await page.evaluate(() => {
      // A camera update must not synchronously flush the layout it just dirtied.
      Element.prototype.getBoundingClientRect = () => { throw new Error("Unexpected synchronous layout read"); };
      (window as any).camera.paintDesignCanvasCamera(document.querySelector("#world"), { zoom: 4, panX: 0, panY: 0 }, true);
    });
  } finally { await page.close(); }
});

it("keeps camera bounds scoped to each retained workspace and excludes pixels and screen-size chrome children from inheritance", async () => {
  const page = await open();
  try {
    await page.evaluate(() => {
      const world = document.querySelector("#world")!, other = world.cloneNode(true) as HTMLElement;
      other.id = "other"; document.body.appendChild(other);
      (window as any).camera.paintDesignCanvasCamera(world, { zoom: 2, panX: 0, panY: 0 }, true, { width: 500, height: 300 });
      (window as any).camera.paintDesignCanvasCamera(other, { zoom: 2, panX: 0, panY: 0 }, true, { width: 2000, height: 300 });
    });
    expect((await paint(page, 4))[1].inverse).toBe(1);
    const inherited = await page.locator('#world [data-design-frame="near"]').evaluate(frame => ({
      frame: Number(getComputedStyle(frame).getPropertyValue("--design-canvas-inverse-zoom")),
      button: Number(getComputedStyle(frame.querySelector("button")!).getPropertyValue("--design-canvas-inverse-zoom")),
      pixels: Number(getComputedStyle(frame.querySelector("img")!).getPropertyValue("--design-canvas-inverse-zoom")),
    }));
    expect(inherited).toEqual({ frame: .25, button: 1, pixels: 1 });
  } finally { await page.close(); }
});

it("updates ready source paint on direct geometry edits without hiding cold layout or protected editors", async () => {
  const page = await open();
  try {
    await page.locator('[data-design-frame="far"]').evaluate(frame => {
      frame.insertAdjacentHTML("beforeend", '<img data-design-source-ready="" alt="ready"><iframe title="cold" data-design-source-surface style="visibility:visible;opacity:0"></iframe><iframe title="editor" data-design-document-ready></iframe>');
    });
    await paint(page, 2, 0, 500);
    const ready = page.locator('[data-design-frame="far"] img');
    expect(await ready.evaluate(img => getComputedStyle(img).visibility)).toBe("hidden");
    const childVisibility = await page.locator('[data-design-frame="far"] iframe').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).visibility));
    expect(childVisibility).toEqual(["visible", "visible"]);
    await page.locator('[data-design-frame="far"]').evaluate(frame => {
      (frame as HTMLElement).style.left = "50px";
      (window as any).camera.paintDesignFrameVisibility(frame);
    });
    expect(await ready.evaluate(img => getComputedStyle(img).visibility)).toBe("visible");
    expect(await page.locator('[data-design-frame="far"]').evaluate(frame => frame.hasAttribute("data-design-frame-chrome-outside"))).toBe(false);
  } finally { await page.close(); }
});

it("keeps hidden overview controls independent of zoom and restores screen size on pointer or keyboard intent", async () => {
  const page = await open();
  try {
    const frame = page.locator('[data-design-frame="near"]');
    const chrome = frame.locator('[data-design-frame-chrome]');
    await frame.evaluate(element => element.setAttribute("data-design-frame-compact-controls", ""));
    await page.mouse.move(600, 400);
    await paint(page, 4, 0, 500);
    expect(await chrome.evaluate(element => ({
      clip: getComputedStyle(element).clip,
      inverse: Number(getComputedStyle(element).getPropertyValue("--design-canvas-inverse-zoom")),
    }))).toEqual({ clip: "rect(0px, 0px, 0px, 0px)", inverse: 1 });
    await page.mouse.move(150, 190);
    expect(await chrome.evaluate(element => element.getBoundingClientRect().height)).toBe(28);
    await page.mouse.move(600, 400);
    await frame.locator("button").focus();
    expect(await chrome.evaluate(element => ({
      opacity: getComputedStyle(element).opacity,
      clip: getComputedStyle(element).clip,
      height: element.getBoundingClientRect().height,
    }))).toEqual({ opacity: "1", clip: "auto", height: 28 });
    expect(await page.locator('[data-design-frame]').count()).toBe(2);
  } finally { await page.close(); }
});

it("keeps the world inheritance stable while updating only current chrome and newly focused frame controls", async () => {
  const page = await open();
  try {
    await page.mouse.move(600, 400);
    await page.locator('[data-design-frame="far"]').evaluate(element => {
      element.setAttribute("data-design-frame-tiled", "");
      element.setAttribute("data-design-frame-compact-controls", "");
    });
    await paint(page, 2, 0, 500);
    const worldStyle = await page.locator("#world").evaluate(element => ({
      zoom: (element as HTMLElement).style.getPropertyValue("--design-canvas-zoom"),
      inverse: (element as HTMLElement).style.getPropertyValue("--design-canvas-inverse-zoom"),
    }));
    expect((await paint(page, 4))[0].chromeHeight).toBe(28);
    expect(await page.locator("#world").evaluate(element => ({
      zoom: (element as HTMLElement).style.getPropertyValue("--design-canvas-zoom"),
      inverse: (element as HTMLElement).style.getPropertyValue("--design-canvas-inverse-zoom"),
    }))).toEqual(worldStyle);
    await page.locator('[data-design-frame="far"] button').focus();
    expect(await page.locator('[data-design-frame="far"] [data-design-frame-chrome]').evaluate(element => element.getBoundingClientRect().height)).toBe(28);
  } finally { await page.close(); }
});

it("coalesces hover transitions into the camera's pending paint and retires queued work when hidden", async () => {
  const page = await open();
  try {
    await paint(page, 1, 0, 500);
    const paints = await page.evaluate(async () => {
      const world = document.querySelector<HTMLDivElement>("#world")!;
      const api = (window as any).camera;
      let count = 0;
      const stop = api.observeDesignCanvasPaint(world, () => count++);
      count = 0;
      world.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
      world.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      api.paintDesignCanvasCamera(world, { zoom: 2, panX: 0, panY: 0 }, true);
      await new Promise(requestAnimationFrame);
      stop(); return count;
    });
    expect(paints).toBe(1);
    const retired = await page.evaluate(async () => {
      const world = document.querySelector<HTMLDivElement>("#world")!;
      let count = 0;
      const stop = (window as any).camera.observeDesignCanvasPaint(world, () => count++);
      count = 0;
      world.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      (window as any).stopChrome();
      await new Promise(requestAnimationFrame);
      stop(); return count;
    });
    expect(retired).toBe(0);
  } finally { await page.close(); }
});

it("updates automatic controls with the actual camera and resize geometry while preserving expanded controls", async () => {
  const page = await open();
  try {
    await page.mouse.move(600, 400);
    const frame = page.locator('[data-design-frame="near"]');
    await frame.evaluate(element => element.setAttribute("data-design-frame-controls", "automatic"));
    await paint(page, .5, 0, 500);
    expect(await frame.getAttribute("data-design-frame-compact-controls")).toBe("");
    await paint(page, 2);
    expect(await frame.getAttribute("data-design-frame-compact-controls")).toBe(null);
    await paint(page, .5);
    expect(await frame.getAttribute("data-design-frame-compact-controls")).toBe("");
    await frame.evaluate(element => {
      (element as HTMLElement).style.width = "300px";
      (window as any).camera.paintDesignFrameVisibility(element);
    });
    expect(await frame.getAttribute("data-design-frame-compact-controls")).toBe(null);
    await frame.evaluate(element => element.setAttribute("data-design-frame-controls", "expanded"));
    await paint(page, .1);
    expect(await frame.getAttribute("data-design-frame-compact-controls")).toBe(null);
  } finally { await page.close(); }
});

it("keeps distant automatic controls compact until the same camera paint brings their chrome nearby", async () => {
  const page = await open();
  try {
    await page.mouse.move(600, 400);
    const frame = page.locator('[data-design-frame="far"]');
    await frame.evaluate(element => element.setAttribute("data-design-frame-controls", "automatic"));
    await paint(page, 2, 0, 500);
    expect(await frame.getAttribute("data-design-frame-compact-controls")).toBe("");
    await paint(page, 2, -1500);
    expect(await frame.getAttribute("data-design-frame-compact-controls")).toBe(null);
    expect(await frame.locator("[data-design-frame-chrome]").evaluate(element => element.getBoundingClientRect().height)).toBe(28);
    await paint(page, 2, 0);
    expect(await frame.getAttribute("data-design-frame-compact-controls")).toBe("");
    await frame.locator("button").focus();
    expect(await frame.getAttribute("data-design-frame-compact-controls")).toBe(null);
    expect(await frame.locator("[data-design-frame-chrome]").evaluate(element => element.getBoundingClientRect().height)).toBe(28);
  } finally { await page.close(); }
});
