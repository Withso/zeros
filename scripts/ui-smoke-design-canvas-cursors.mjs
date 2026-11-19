import { expect } from "@playwright/test";
import { designFrameElementBox, openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// Figma's canvas cursors: one arrow everywhere on the canvas, including over
// layers and a selection's body, a double-headed resize arrow along each
// handle's screen direction, and a corner rotation arrow at each corner. Each
// cursor image names itself (`zd-cursor-<kind>[-<angle>]`), so the computed
// `cursor` says which glyph the browser was given and how it is turned.

const harness = (page, query = "") =>
  `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html${query}`;

const cursorKind = (cursor) => {
  const match = /zd-cursor-([a-z]+(?:-\d+)?)/.exec(cursor ?? "");
  return match ? match[1] : `keyword:${cursor}`;
};

export async function runDesignCanvasCursorSmoke({ page, check }) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(harness(page, "?mixedParents"), { waitUntil: "networkidle" });
  await openLayersDrawer(page);
  const iframe = page.locator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]');
  await expect(iframe).toHaveCount(1);
  const runtime = page.frameLocator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]');
  const centre = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const cursorAt = (point) =>
    page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return element ? getComputedStyle(element).cursor : null;
    }, point).then(cursorKind);
  const cursorOf = (selector) =>
    page.locator(selector).first().evaluate((element) => getComputedStyle(element).cursor).then(cursorKind);
  const settle = () => page.waitForTimeout(250);

  const viewport = await page.locator("[data-design-canvas-viewport]").boundingBox();
  const frameBox = await page.locator('[data-design-frame="home.html"]').boundingBox();
  const empty = { x: frameBox.x + frameBox.width + 40, y: Math.min(frameBox.y + frameBox.height / 2, viewport.y + viewport.height - 40) };
  const heading = centre(await designFrameElementBox(iframe, runtime.locator('[data-oid="home-heading"]')));
  await page.mouse.move(heading.x, heading.y, { steps: 3 });
  await settle();
  const resting = {
    empty: await cursorAt(empty),
    layer: await cursorAt(heading),
    label: await cursorOf('[data-design-frame="home.html"] [data-design-frame-label]'),
  };
  check(
    "the canvas, a hovered layer and a frame's name all show the arrow",
    Object.values(resting).every((kind) => kind === "arrow"),
    JSON.stringify(resting),
  );

  await page.locator('[data-design-frame-row="home.html"]').click();
  await page.locator('[data-design-sidebar-panel] [data-design-layer-id="home-hero"]').click();
  const overlay = '[data-design-element-overlay="home-hero"]';
  await expect(page.locator(`${overlay} .zd-design-selection-handle`)).toHaveCount(4);
  const hero = centre(await page.locator(overlay).first().boundingBox());
  await page.mouse.move(hero.x, hero.y, { steps: 3 });
  await settle();
  const handle = (corner) => `${overlay} .zd-design-selection-handle[aria-label$=" from ${corner}"]`;
  const selected = {
    body: await cursorAt(hero),
    nw: await cursorOf(handle("nw")),
    ne: await cursorOf(handle("ne")),
    se: await cursorOf(handle("se")),
    sw: await cursorOf(handle("sw")),
    n: await cursorOf(`${overlay} [data-design-resize-edge="n"]`),
    e: await cursorOf(`${overlay} [data-design-resize-edge="e"]`),
    s: await cursorOf(`${overlay} [data-design-resize-edge="s"]`),
    w: await cursorOf(`${overlay} [data-design-resize-edge="w"]`),
  };
  check(
    "a selection's body shows the arrow and its handles show resize arrows along each handle",
    JSON.stringify(selected) === JSON.stringify({
      body: "arrow", nw: "resize-45", ne: "resize-135", se: "resize-45", sw: "resize-135",
      n: "resize-90", e: "resize-0", s: "resize-90", w: "resize-0",
    }),
    JSON.stringify(selected),
  );
  const nwHandle = centre(await page.locator(handle("nw")).boundingBox());
  check(
    "the pointer over a corner square gets that corner's resize arrow",
    (await cursorAt(nwHandle)) === "resize-45",
    await cursorAt(nwHandle),
  );
  const rotate = (corner) => cursorOf(`${overlay} [data-design-rotate-corner="${corner}"]`);
  const rotation = { nw: await rotate("nw"), ne: await rotate("ne"), se: await rotate("se"), sw: await rotate("sw") };
  check(
    "each rotation corner shows a corner arrow that wraps that corner",
    JSON.stringify(rotation) === JSON.stringify({ nw: "rotate-0", ne: "rotate-90", se: "rotate-180", sw: "rotate-270" }),
    JSON.stringify(rotation),
  );

  // Sweep the whole canvas with the layer selected: nothing under the pointer
  // falls back to a system move, pointer, text or grab cursor.
  const sweep = await page.evaluate(() => {
    const viewport = document.querySelector("[data-design-canvas-viewport]").getBoundingClientRect();
    const found = {};
    for (let y = viewport.top + 4; y < viewport.bottom; y += 12) {
      for (let x = viewport.left + 4; x < viewport.right; x += 12) {
        const element = document.elementFromPoint(x, y);
        if (!element?.closest("[data-design-canvas-viewport]")) continue;
        const cursor = getComputedStyle(element).cursor;
        const kind = /zd-cursor-([a-z]+)/.exec(cursor)?.[1] ?? cursor;
        found[kind] ??= element.outerHTML.slice(0, 120);
      }
    }
    return found;
  });
  const strays = Object.keys(sweep).filter((kind) => !["arrow", "resize", "rotate"].includes(kind));
  check(
    "every point of the canvas shows the arrow, a resize or a rotation cursor",
    strays.length === 0 && "arrow" in sweep,
    JSON.stringify(Object.fromEntries(strays.map((kind) => [kind, sweep[kind]]))),
  );

  await page.mouse.down();
  await page.mouse.move(hero.x + 24, hero.y + 12, { steps: 4 });
  const dragging = cursorKind(await page.evaluate(() => document.body.style.cursor));
  await page.keyboard.press("Escape");
  await page.mouse.up();
  check("moving a layer keeps the arrow", dragging === "arrow", dragging);

  // A mirrored layer's handle sits on the other side on screen; its cursor and
  // its rotation corner follow where it is painted.
  await page.locator('[data-design-sidebar-panel] [data-design-layer-id="home-panel"]').click();
  const panel = '[data-design-element-overlay="home-panel"]';
  await expect(page.locator(`${panel} .zd-design-selection-handle`)).toHaveCount(4);
  const mirrored = {
    nw: await cursorOf(`${panel} .zd-design-selection-handle[aria-label$=" from nw"]`),
    rotateNw: await cursorOf(`${panel} [data-design-rotate-corner="nw"]`),
  };
  check(
    "a mirrored layer's cursors follow the painted corner",
    mirrored.nw === "resize-135" && mirrored.rotateNw === "rotate-90",
    JSON.stringify(mirrored),
  );

  // Turning from the bottom-right corner keeps that corner's arrow, carried
  // round by the angle the drag has turned.
  await page.locator('[data-design-sidebar-panel] [data-design-layer-id="home-hero"]').click();
  const zone = centre(await page.locator(`${overlay} [data-design-rotate-corner="se"]`).boundingBox());
  const radius = Math.hypot(zone.x - hero.x, zone.y - hero.y);
  const start = Math.atan2(zone.y - hero.y, zone.x - hero.x);
  await page.mouse.move(zone.x, zone.y);
  await page.mouse.down();
  const turned = [];
  for (const degrees of [10, 30]) {
    const angle = start + (degrees * Math.PI) / 180;
    await page.mouse.move(hero.x + radius * Math.cos(angle), hero.y + radius * Math.sin(angle), { steps: 4 });
    await page.waitForTimeout(50);
    turned.push({
      cursor: cursorKind(await page.evaluate(() => document.body.style.cursor)),
      degrees: Number.parseFloat(await page.locator(`${overlay} [data-design-rotation-feedback]`).textContent()),
    });
  }
  await page.mouse.move(zone.x, zone.y, { steps: 4 });
  await page.mouse.up();
  check(
    "a rotation drag keeps the pressed corner's arrow and turns it with the layer",
    turned.length === 2 && turned[1].degrees > turned[0].degrees + 5 &&
      turned.every(({ cursor, degrees }) => cursor === `rotate-${Math.round((180 + degrees) / 15) * 15}`),
    JSON.stringify(turned),
  );
}
