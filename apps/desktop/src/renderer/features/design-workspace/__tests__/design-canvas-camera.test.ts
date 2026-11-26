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

async function paint(page: Page, zoom: number, panX = 0, width?: number, gesture = true) {
  return page.evaluate(({ zoom, panX, width, gesture }) => {
    const world = document.querySelector<HTMLDivElement>("#world")!;
    (window as any).camera.paintDesignCanvasCamera(world, { zoom, panX, panY: 0 }, gesture,
      width === undefined ? undefined : { width, height: 300 });
    return [...world.querySelectorAll<HTMLElement>("[data-design-frame]")].map(frame => ({
      file: frame.dataset.designFrame,
      inverse: Number(getComputedStyle(frame).getPropertyValue("--design-canvas-inverse-zoom")),
      chromeHeight: frame.querySelector("[data-design-frame-chrome]")!.getBoundingClientRect().height,
    }));
  }, { zoom, panX, width, gesture });
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
    await paint(page, .15, 0, 500);
    expect(await frame.getAttribute("data-design-frame-compact-controls")).toBe("");
    await paint(page, 2);
    expect(await frame.getAttribute("data-design-frame-compact-controls")).toBe(null);
    await paint(page, .15);
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

it("paints a camera change that compacts frame controls once, never again for its own attribute writes", async () => {
  // Each repeat was a second pass over every mounted frame per zoom step.
  const page = await open();
  try {
    await page.mouse.move(600, 400);
    const frame = page.locator('[data-design-frame="near"]');
    await frame.evaluate(element => element.setAttribute("data-design-frame-controls", "automatic"));
    await paint(page, 2, 0, 500);
    const result = await page.evaluate(async () => {
      const world = document.querySelector<HTMLDivElement>("#world")!;
      const api = (window as any).camera;
      let count = 0;
      const stop = api.observeDesignCanvasPaint(world, () => count++);
      count = 0;
      api.paintDesignCanvasCamera(world, { zoom: .15, panX: 0, panY: 0 }, true);
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      stop();
      return { count, compact: document.querySelector('[data-design-frame="near"]')!.hasAttribute("data-design-frame-compact-controls") };
    });
    expect(result).toEqual({ count: 1, compact: true });
  } finally { await page.close(); }
});

it("holds frame chrome scale through small steps of a live camera gesture and settles it exactly at rest", async () => {
  // Rewriting every visible frame's scale on each zoom step restyled every
  // frame subtree per frame; small drifts inside a gesture are not visible.
  const page = await open();
  try {
    const inverse = () => page.locator('[data-design-frame="near"]').evaluate(element =>
      Number(getComputedStyle(element).getPropertyValue("--design-canvas-inverse-zoom")));
    await paint(page, 2, 0, 500);
    expect(await inverse()).toBeCloseTo(0.5);
    await paint(page, 2.1);
    expect(await inverse()).toBeCloseTo(0.5);
    // A large step inside the gesture is written at once.
    await paint(page, 3);
    expect(await inverse()).toBeCloseTo(1 / 3);
    await paint(page, 3.2);
    expect(await inverse()).toBeCloseTo(1 / 3);
    // At rest every frame has its exact scale.
    await page.evaluate(() => (window as any).camera.paintDesignCanvasCamera(document.querySelector("#world"), { zoom: 3.2, panX: 0, panY: 0 }, false));
    expect(await inverse()).toBeCloseTo(1 / 3.2);
  } finally { await page.close(); }
});

it("hides automatic frame names and Play through a camera gesture without restyling them, and restores their exact size at rest", async () => {
  // An exact scale per step re-laid out every visible name, enough work to
  // miss the display deadline; a held scale grew and shrank names, then snapped.
  const page = await open();
  try {
    await page.locator('[data-design-frame="near"]').evaluate(frame => frame.setAttribute("data-design-frame-controls", "automatic"));
    await page.evaluate(() => (window as any).camera.paintDesignCanvasCamera(document.querySelector("#world"), { zoom: 2, panX: 0, panY: 0 }, false, { width: 500, height: 300 }));
    const chrome = page.locator('[data-design-frame="near"] > [data-design-frame-chrome]');
    const state = () => chrome.evaluate(root => ({ opacity: getComputedStyle(root).opacity,
      pointer: getComputedStyle(root.querySelector("button")!).pointerEvents, style: root.getAttribute("style") }));
    const rest = await state();
    expect(rest).toMatchObject({ opacity: "1", pointer: "auto" });
    for (const zoom of [2.1, 2.2, 1.9, 1.75, 2.05]) {
      await paint(page, zoom);
      expect(await state()).toEqual({ opacity: "0", pointer: "none", style: rest.style });
    }
    await page.evaluate(() => (window as any).camera.paintDesignCanvasCamera(document.querySelector("#world"), { zoom: 2.05, panX: 0, panY: 0 }, false));
    expect(await state()).toMatchObject({ opacity: "1", pointer: "auto" });
    expect(await chrome.evaluate(root => root.getBoundingClientRect().height)).toBeCloseTo(28, 3);
    expect(await chrome.evaluate(root => Number(root.style.getPropertyValue("--design-canvas-inverse-zoom")))).toBeCloseTo(1 / 2.05);
  } finally { await page.close(); }
});

it("keeps expanded and focused frame names at their exact screen size through every gesture step while frame bodies hold their scale", async () => {
  const page = await open();
  try {
    await page.locator('[data-design-frame="near"]').evaluate(frame => frame.setAttribute("data-design-frame-controls", "expanded"));
    await page.locator('[data-design-frame="far"]').evaluate(frame => {
      frame.setAttribute("data-design-frame-controls", "automatic"); (frame as HTMLElement).style.left = "200px";
    });
    await paint(page, 2, 0, 500);
    await page.locator('[data-design-frame="far"] button').focus();
    for (const zoom of [2.1, 2.2, 1.9, 1.75, 2.05]) {
      const [near, far] = await paint(page, zoom);
      for (const frame of [near, far]) {
        expect(frame.chromeHeight).toBeCloseTo(28, 3);
        // The frame body keeps the held scale: restyling its subtree per step is
        // the cost the hold avoids.
        expect(frame.inverse).toBeCloseTo(.5);
      }
    }
    expect(await page.locator("[data-design-frame-gesture-hidden]").count()).toBe(0);
  } finally { await page.close(); }
});

it("paints a protected frame's whole chrome at the exact scale during a gesture", async () => {
  const page = await open();
  try {
    await page.locator('[data-design-frame="near"]').evaluate(frame => frame.setAttribute("data-design-frame-chrome-protected", ""));
    await paint(page, 2, 0, 500);
    expect((await paint(page, 2.1))[0].inverse).toBeCloseTo(1 / 2.1);
  } finally { await page.close(); }
});
it("shows Play only for a frame with a selection, under the pointer, with keyboard focus or playing", async () => {
  // The frame an empty selection leaves active kept Play visible after a
  // click on empty canvas; a click's leftover focus must not hold it either.
  const page = await open();
  try {
    await page.mouse.move(600, 400);
    // The real token values come from the app's token sheets; any two distinct
    // colors prove which one the control takes.
    await page.addStyleTag({ content: ":root { --design-selection-stroke: blue; --design-selection-label-fg: white; --fg3: gray; }" });
    const token = (color: string) => page.evaluate(color => {
      const probe = document.body.appendChild(document.createElement("i"));
      probe.style.color = color.startsWith("--") ? `var(${color})` : color;
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    }, color);
    const blue = await token("--design-selection-stroke"), grey = await token("--fg3"), white = await token("--design-selection-label-fg"),
      clear = await token("transparent");
    const frame = page.locator('[data-design-frame="near"]');
    await frame.evaluate(element => element.insertAdjacentHTML("beforeend",
      '<div data-design-frame-chrome data-design-frame-play-chrome style="position:absolute;right:0;bottom:100%;height:28px"><button class="zd-canvas-tool zd-frame-play" style="height:28px">Play</button></div>'));
    await paint(page, 2, 0, 500);
    const shown = () => frame.evaluate(element => getComputedStyle(element.querySelector("[data-design-frame-play-chrome]")!).clip === "auto");
    const color = () => frame.evaluate(element => getComputedStyle(element.querySelector(".zd-frame-play")!).color);
    const fill = () => frame.evaluate(element => getComputedStyle(element.querySelector(".zd-frame-play")!).backgroundColor);
    expect(await shown()).toBe(false);
    await frame.evaluate(element => element.setAttribute("data-design-frame-selected", ""));
    expect(await shown()).toBe(true);
    expect(await color()).toBe(blue);
    expect(await fill()).toBe(clear);
    await frame.evaluate(element => element.removeAttribute("data-design-frame-selected"));
    expect(await shown()).toBe(false);
    await page.mouse.move(80, 90);
    expect(await shown()).toBe(true);
    await page.mouse.move(600, 400);
    expect(await shown()).toBe(false);
    const play = frame.locator(".zd-frame-play");
    await play.evaluate(button => { button.setAttribute("data-zeros-focus-visible", "false"); (button as HTMLElement).focus(); });
    expect(await shown()).toBe(false);
    await play.evaluate(button => button.setAttribute("data-zeros-focus-visible", "true"));
    expect(await shown()).toBe(true);
    await play.evaluate(button => (button as HTMLElement).blur());
    // Stop is a white glyph on a fill: grey while its frame plays unattended,
    // blue under the pointer.
    await frame.evaluate(element => {
      element.setAttribute("data-design-frame-playing", "");
      element.querySelector(".zd-frame-play")!.setAttribute("aria-pressed", "true");
    });
    expect(await shown()).toBe(true);
    await expect.poll(fill).toBe(grey);
    expect(await color()).toBe(white);
    await page.mouse.move(80, 90);
    await expect.poll(fill).toBe(blue);
    expect(await color()).toBe(white);
  } finally { await page.close(); }
});

it("draws a selected frame's edge at one screen pixel and two only while the pointer is inside the frame", async () => {
  const page = await open();
  try {
    await page.mouse.move(600, 400);
    const frame = page.locator('[data-design-frame="near"]');
    await frame.evaluate(element => {
      element.classList.add("zd-design-frame", "zd-design-stroke", "zd-design-selection-outline");
      // The canvas renders frames with `pointer-events-auto`; ready pixels
      // reveal their chrome.
      (element as HTMLElement).style.pointerEvents = "auto";
      element.insertAdjacentHTML("beforeend", "<div data-design-frame-pixels-ready></div>");
    });
    await paint(page, 2, 0, 500);
    const width = () => frame.evaluate(element => getComputedStyle(element).getPropertyValue("--design-stroke-width").trim());
    expect(await width()).toBe("1");
    await page.mouse.move(120, 150);
    expect(await width()).toBe("2");
    // The name above the frame is not inside it.
    const name = await frame.locator("[data-design-frame-chrome] button").boundingBox();
    await page.mouse.move(name!.x + 4, name!.y + name!.height / 2);
    expect(await width()).toBe("1");
  } finally { await page.close(); }
});
it("keeps a small frame's name on an uncrowded page, hides only its Play control, and keeps crowded overviews compact", async () => {
  const page = await open();
  try {
    await page.mouse.move(600, 400);
    const frame = page.locator('[data-design-frame="near"]');
    await frame.evaluate(element => {
      element.setAttribute("data-design-frame-controls", "automatic");
      element.insertAdjacentHTML("beforeend", '<div data-design-frame-chrome data-design-frame-play-chrome style="position:absolute;right:0;bottom:100%;height:28px"><button style="height:28px">Play</button></div>');
    });
    const state = () => frame.evaluate(element => ({
      compact: element.hasAttribute("data-design-frame-compact-controls"),
      play: element.hasAttribute("data-design-frame-compact-play"),
      label: getComputedStyle(element.querySelector("[data-design-frame-chrome]:not([data-design-frame-play-chrome])")!).clip,
      control: getComputedStyle(element.querySelector("[data-design-frame-play-chrome]")!).clip,
    }));
    // 60 px on screen: the name stays, the 16 px Play control waits for intent.
    await paint(page, .5, 0, 500, false);
    expect(await state()).toEqual({ compact: false, play: true, label: "auto", control: "rect(0px, 0px, 0px, 0px)" });
    // The name row can lie over the frame above: only the name takes the pointer.
    expect(await frame.evaluate(element => {
      const row = element.querySelector("[data-design-frame-chrome]:not([data-design-frame-play-chrome])")!;
      return [getComputedStyle(row).pointerEvents, getComputedStyle(row.querySelector("button")!).pointerEvents];
    })).toEqual(["none", "auto"]);
    await page.mouse.move(40, 40);
    expect((await state()).control).toBe("auto");
    await page.mouse.move(600, 400);
    // 18 px: too small for a name.
    await paint(page, .15, 0, undefined, false);
    expect(await state()).toMatchObject({ compact: true, play: false });
    // Wide enough for both; Play still waits for intent.
    await paint(page, 2, 0, undefined, false);
    expect(await state()).toEqual({ compact: false, play: false, label: "auto", control: "rect(0px, 0px, 0px, 0px)" });
    // A crowded page keeps the cheap overview path at the old threshold.
    await page.locator("#world").evaluate(world => {
      for (let index = 0; index < 70; index++) world.insertAdjacentHTML("beforeend",
        `<article data-design-frame="extra-${index}" data-design-frame-controls="automatic" style="position:absolute;left:${3000 + index * 200}px;top:40px;width:120px;height:80px"><div data-design-frame-chrome style="height:28px"><button style="height:28px">Extra</button></div></article>`);
    });
    await paint(page, .5, 0, undefined, false);
    expect(await state()).toMatchObject({ compact: true, play: false });
  } finally { await page.close(); }
});

