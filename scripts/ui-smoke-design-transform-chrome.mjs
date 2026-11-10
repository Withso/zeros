import { expect } from "@playwright/test";
import { designFrameElementBox, openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// Selection chrome on turned, mirrored and deeply zoomed layers, driven through
// the production canvas with real pointer input. Each check failed before the
// fix it names: a mirrored layer's handles resized the opposite edge, the size
// badge read upside down and drifted by half its width times the zoom, a
// resized frame left its padding ticks at the old size, strokes thickened with
// zoom, and a turned layer dragged out of its frame lost its outline.

const harness = (page, query) =>
  `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?${query}`;

const setCamera = (page, view) =>
  page.evaluate(async (view) => {
    const { useDesignWorkspaceUiStore } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    useDesignWorkspaceUiStore.getState().setViewport("ws_design_harness", view);
  }, view);

// The camera is remembered per page; every check starts from the same one.
const START_CAMERA = { zoom: 0.25, panX: 64, panY: 136 };

async function openFixture(page, query) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(harness(page, query), { waitUntil: "networkidle" });
  await openLayersDrawer(page);
  await setCamera(page, START_CAMERA);
  await expect(
    page.locator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]'),
  ).toHaveCount(1);
}

const runtime = (page) =>
  page.frameLocator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]');

async function selectLayer(page, oid) {
  const row = page.locator(`[data-design-sidebar-panel] [data-design-layer-id="${oid}"]`);
  if (!(await row.count())) await page.locator('[data-design-frame-row="home.html"]').click();
  await row.click();
  await expect(page.locator(`[data-design-element-overlay="${oid}"]`)).toBeVisible();
}

const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance;

const chromeOf = (page, oid) =>
  page.evaluate((id) => {
    const overlay = document.querySelector(`[data-design-element-overlay="${id}"]`);
    const label = overlay?.querySelector("[data-design-selection-size]");
    const readout = overlay?.querySelector("[data-design-rotation-feedback]");
    const box = overlay?.getBoundingClientRect();
    const badge = label?.getBoundingClientRect();
    // The badge's own text axis on screen: the composed transform maps its
    // local x axis; a mirrored or upside-down badge points it leftward.
    let textAxis = null;
    if (label) {
      const start = new DOMPoint(0, 0).matrixTransform(new DOMMatrix(getComputedStyle(label).transform));
      const end = new DOMPoint(1, 0).matrixTransform(new DOMMatrix(getComputedStyle(label).transform));
      let matrix = new DOMMatrix();
      for (let node = label.parentElement; node && node !== document.body; node = node.parentElement) {
        const value = getComputedStyle(node).transform;
        if (value && value !== "none") matrix = new DOMMatrix(value).multiply(matrix);
      }
      const a = start.matrixTransform(matrix), b = end.matrixTransform(matrix);
      textAxis = { x: b.x - a.x, y: b.y - a.y };
    }
    return {
      box: box && { x: box.x, y: box.y, width: box.width, height: box.height },
      badge: badge && { x: badge.x, y: badge.y, width: badge.width, height: badge.height },
      text: label?.textContent ?? null,
      textAxis,
      readoutDisplay: readout ? getComputedStyle(readout).display : null,
    };
  }, oid);

export async function runDesignMirroredSelectionChromeSmoke({ page, check }) {
  await openFixture(page, "mixedParents");
  await selectLayer(page, "home-panel");
  const painted = await designFrameElementBox(
    page.locator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]'),
    runtime(page).locator('[data-oid="home-panel"]'),
  );
  const chrome = await chromeOf(page, "home-panel");
  check(
    "a mirrored layer's outline is its painted box",
    near(chrome.box.x, painted.x) && near(chrome.box.y, painted.y) &&
      near(chrome.box.width, painted.width) && near(chrome.box.height, painted.height),
    JSON.stringify({ chrome: chrome.box, painted }),
  );
  check(
    "a mirrored layer's size badge is centred below it and reads left to right",
    chrome.badge.y >= chrome.box.y + chrome.box.height - 0.5 &&
      near(chrome.badge.x + chrome.badge.width / 2, chrome.box.x + chrome.box.width / 2) &&
      chrome.textAxis.x > 0 && Math.abs(chrome.textAxis.y) < 1e-6,
    JSON.stringify(chrome),
  );
  check(
    "the rotation readout stays hidden until a rotation starts",
    chrome.readoutDisplay === "none",
    String(chrome.readoutDisplay),
  );
  const upright = await (async () => {
    await selectLayer(page, "home-hero");
    return chromeOf(page, "home-hero");
  })();
  check(
    "an upright selection's size badge is centred on it at every zoom",
    near(upright.badge.x + upright.badge.width / 2, upright.box.x + upright.box.width / 2),
    JSON.stringify(upright),
  );

  // Dragging the handle at the mirrored layer's painted bottom-right grows it
  // toward the pointer: its painted top-left corner holds still.
  await selectLayer(page, "home-panel");
  const corner = await page.evaluate(() => {
    const handles = [...document.querySelectorAll('[data-design-element-overlay="home-panel"] .zd-design-selection-handle')]
      .map((handle) => handle.getBoundingClientRect())
      .map((rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }));
    return handles.reduce((best, handle) => (handle.x + handle.y > best.x + best.y ? handle : best));
  });
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 20, corner.y + 10, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await designFrameElementBox(
      page.locator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]'),
      runtime(page).locator('[data-oid="home-panel"]'),
    )).width)
    .toBeGreaterThan(painted.width + 10);
  const resized = await designFrameElementBox(
    page.locator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]'),
    runtime(page).locator('[data-oid="home-panel"]'),
  );
  check(
    "resizing a mirrored layer by its corner keeps the opposite corner still",
    near(resized.x, painted.x) && near(resized.y, painted.y) &&
      near(resized.width, painted.width + 20, 2.5) && near(resized.height, painted.height + 10, 2.5),
    JSON.stringify({ painted, resized }),
  );
}

export async function runDesignFrameResizeLayoutToolsSmoke({ page, check }) {
  await openFixture(page, "layoutGestures");
  const frame = page.locator('[data-design-frame="home.html"]');
  await frame.locator("[data-design-frame-label]").click();
  await page.getByRole("button", { name: "Auto layout: Vertical", exact: true }).click();
  await expect(frame.locator("[data-design-frame-layout-owner] [data-design-inline-padding-control]")).toHaveCount(4);
  const ticksInside = () =>
    page.evaluate(() => {
      const article = document.querySelector('[data-design-frame="home.html"]');
      const bounds = article.getBoundingClientRect();
      const owner = article.querySelector("[data-design-frame-layout-owner]")?.getBoundingClientRect();
      const ticks = [...article.querySelectorAll("[data-design-frame-layout-owner] [data-design-inline-spacing-line]")]
        .map((line) => line.getBoundingClientRect())
        .map((rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }));
      return {
        inside: ticks.length === 4 && ticks.every((tick) => tick.x >= bounds.left - 1 && tick.x <= bounds.right + 1 && tick.y >= bounds.top - 1 && tick.y <= bounds.bottom + 1),
        owner: owner && [owner.width, owner.height].map(Math.round),
        frame: [bounds.width, bounds.height].map(Math.round),
      };
    });
  const box = await frame.boundingBox();
  await page.mouse.move(box.x + box.width, box.y + box.height);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 120, box.y + box.height - 80, { steps: 10 });
  const during = await ticksInside();
  check(
    "a frame's padding tools follow its root on every resize sample",
    during.inside && JSON.stringify(during.owner) === JSON.stringify(during.frame),
    JSON.stringify(during),
  );
  await page.mouse.up();
  await expect.poll(async () => (await frame.boundingBox()).width).toBeLessThan(box.width - 60);
  // Reselecting renders the tools from the confirmed runtime readback alone.
  await page.mouse.click(1000, 760);
  await frame.locator("[data-design-frame-label]").click();
  await expect.poll(async () => (await ticksInside()).inside).toBe(true);
  const after = await ticksInside();
  check(
    "a resized frame's root is measured again at its new size",
    after.inside && JSON.stringify(after.owner) === JSON.stringify(after.frame),
    JSON.stringify(after),
  );
}

export async function runDesignDeepZoomStrokeSmoke({ page, check }) {
  await openFixture(page, "layoutGestures");
  await selectLayer(page, "home-heading");
  await setCamera(page, { zoom: 8, panX: -400, panY: -500 });
  const overlay = page.locator('[data-design-element-overlay="home-heading"]');
  await expect.poll(() => page.evaluate(() => document.querySelector("[data-design-canvas-world]")?.style.transform ?? "")).toContain("scale(8)");
  await page.mouse.move(4, 4);
  const box = await overlay.boundingBox();
  const shot = await page.screenshot();
  const stroke = await page.evaluate(async ({ data, box }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const ratio = image.width / innerWidth;
    const x = Math.round((box.x + Math.min(box.width / 3, 300)) * ratio);
    const top = Math.max(0, Math.round((box.y - 20) * ratio));
    let run = 0;
    let longest = 0;
    for (let y = top; y < top + 40 * ratio; y += 1) {
      const [r, g, b] = context.getImageData(x, y, 1, 1).data;
      run = b > 180 && r < 90 && g > 90 && g < 190 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    return longest / ratio;
  }, { data: shot.toString("base64"), box });
  check(
    "the selection stroke stays two screen pixels at 800%",
    stroke >= 1.5 && stroke <= 2.5,
    String(stroke),
  );
  await setCamera(page, START_CAMERA);
}

export async function runDesignTurnedLayerDragOutSmoke({ page, check }) {
  await openFixture(page, "emptyFrame");
  const frame = page.locator('[data-design-frame="home.html"]');
  await frame.locator("[data-design-frame-label]").click();
  await page.getByRole("button", { name: "Frame tool", exact: true }).click();
  const bounds = await frame.boundingBox();
  await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.6, { steps: 6 });
  await page.mouse.up();
  const child = runtime(page).locator('[data-oid="home-main"] > [data-oid]');
  await expect(child).toHaveCount(1);
  const childId = await child.getAttribute("data-oid");
  await expect(page.locator(`[data-design-element-overlay="${childId}"]`)).toBeVisible();
  const rotation = page.locator('[data-design-position-section] input[aria-label="Rotation"]');
  await rotation.click();
  await rotation.fill("-66");
  await rotation.press("Enter");
  await expect(child).toHaveAttribute("style", /rotate: -66deg/);
  const size = (await chromeOf(page, childId)).text;
  const start = await designFrameElementBox(
    page.locator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]'),
    child,
  );
  const grab = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
  // Every value the badge takes while the layer moves, including the painted
  // prediction a measurement replaces before the next frame.
  await page.evaluate((id) => {
    const label = document.querySelector(`[data-design-element-overlay="${id}"] [data-design-selection-size]`);
    const seen = new Set([label.textContent]);
    const observer = new MutationObserver(() => seen.add(label.textContent));
    observer.observe(label, { characterData: true, childList: true, subtree: true });
    window.__designTurnedBadge = { seen, stop: () => observer.disconnect() };
  }, childId);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 30, grab.y + 20, { steps: 8 });
  const seen = await page.evaluate(() => {
    window.__designTurnedBadge.stop();
    return [...window.__designTurnedBadge.seen];
  });
  check(
    "a turned layer keeps its own size while it moves inside its frame",
    seen.length === 1 && seen[0] === size,
    JSON.stringify({ size, seen }),
  );
  await page.mouse.move(grab.x + 30, bounds.y + bounds.height + start.height, { steps: 10 });
  const ghost = page.locator(`[data-design-drag-preview="${childId}"]`);
  await expect(ghost).toBeVisible();
  await expect(ghost.locator("[data-design-drag-selection]")).toHaveCount(1);
  await expect.poll(() => ghost.locator("[data-design-drag-pixels] img").evaluate(async (image) => {
    await image.decode().catch(() => {});
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    let clear = 0;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] > 200) opaque += 1;
      else if (data[index] < 20) clear += 1;
    }
    // The turned layer, alone: its pixels and the transparent corners around
    // it, never the frame behind its bounding box.
    return opaque > 0 && clear > 0;
  }).catch(() => false)).toBe(true);
  const detached = await page.evaluate((id) => ({
    overlayHidden: getComputedStyle(document.querySelector(`[data-design-element-overlay="${id}"]`)).visibility === "hidden",
    label: document.querySelector(`[data-design-drag-preview="${id}"] [data-design-drag-selection] .zd-design-selection-label`)?.textContent,
  }), childId);
  check(
    "a turned layer outside its frame shows only its own pixels with its own outline",
    detached.overlayHidden && detached.label === size,
    JSON.stringify({ size, ...detached }),
  );
  await page.mouse.move(grab.x + 30, grab.y + 20, { steps: 10 });
  await page.mouse.up();
  await expect(ghost).toHaveCount(0);
  await expect.poll(async () => {
    const painted = await designFrameElementBox(
      page.locator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]'),
      child,
    );
    const chrome = await chromeOf(page, childId);
    return near(chrome.box.x, painted.x) && near(chrome.box.y, painted.y) &&
      near(chrome.box.width, painted.width) && near(chrome.box.height, painted.height) && chrome.text === size;
  }).toBe(true);
  check("a turned layer's outline settles on the dropped layer", true);
}

async function cameraOnto(page, target, zoom) {
  // Centre a painted box at (500, 400) at this zoom.
  const viewport = await page.locator("[data-design-canvas-viewport]").boundingBox();
  const current = await page.evaluate(() => document.querySelector("[data-design-canvas-world]").style.transform);
  const [, panX, panY, scale] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(current).map(Number);
  const worldX = (target.x + target.width / 2 - viewport.x - panX) / scale;
  const worldY = (target.y + target.height / 2 - viewport.y - panY) / scale;
  await setCamera(page, { zoom, panX: 500 - worldX * zoom, panY: 400 - worldY * zoom });
  await expect.poll(() => page.evaluate(() => document.querySelector("[data-design-canvas-world]").style.transform)).toContain(`scale(${zoom})`);
}

// The saved size of a canvas frame. The harness holds canvas saves for 700 ms,
// and a gesture that starts before its save lands works from the old size.
const savedFrameSize = (page, file = "home.html") =>
  page.evaluate(async (file) => {
    const { designWorkspaceSnapshotCache } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const frame = designWorkspaceSnapshotCache
      .peekSnapshot("ws_design_harness")
      .data?.frames.find((item) => item.file === file);
    return frame ? `${frame.width} × ${frame.height}` : null;
  }, file);

async function typeSize(page, width, height) {
  const layout = page.locator("[data-design-layout-section]");
  for (const [label, value] of [["W", width], ["H", height]]) {
    const input = layout.locator(`input[aria-label="${label}"]`);
    await input.click();
    await input.fill(String(value));
    await input.press("Enter");
  }
}

// A 10 × 10 selection is smaller on screen than one resize square at most
// zooms. Pressing its middle must move it, never resize, rotate or reshape it.
export async function runDesignTinySelectionSmoke({ page, check }) {
  await openFixture(page, "emptyFrame");
  const frame = page.locator('[data-design-frame="home.html"]');
  await frame.locator("[data-design-frame-label]").click();
  await page.getByRole("button", { name: "Frame tool", exact: true }).click();
  const bounds = await frame.boundingBox();
  await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.6, { steps: 6 });
  await page.mouse.up();
  const child = runtime(page).locator('[data-oid="home-main"] > [data-oid]');
  await expect(child).toHaveCount(1);
  const childId = await child.getAttribute("data-oid");
  await typeSize(page, 10, 10);
  await expect(child).toHaveAttribute("style", /width: 10px/);
  await expect(child).toHaveAttribute("style", /height: 10px/);
  const painted = () => designFrameElementBox(
    page.locator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]'), child);
  for (const zoom of [0.25, 1]) {
    await cameraOnto(page, await painted(), zoom);
    const box = await painted();
    const chrome = await chromeOf(page, childId);
    const controls = await page.evaluate((id) => {
      const overlay = document.querySelector(`[data-design-element-overlay="${id}"]`);
      return overlay.querySelectorAll(".zd-design-selection-handle, [data-design-resize-edge]").length;
    }, childId);
    check(
      `a 10 × 10 layer at ${zoom * 100}% keeps its outline, a centred badge and its body for moving`,
      near(chrome.box.x, box.x) && near(chrome.box.width, box.width) && chrome.text === "10 × 10" &&
        near(chrome.badge.x + chrome.badge.width / 2, chrome.box.x + chrome.box.width / 2) && controls === 0,
      JSON.stringify({ chrome, box, controls }),
    );
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await painted()).x).toBeGreaterThan(box.x + 25);
    const moved = await painted();
    check(
      `pressing a 10 × 10 layer's middle at ${zoom * 100}% moves it without resizing it`,
      near(moved.x, box.x + 30) && near(moved.y, box.y + 20) && near(moved.width, box.width, 0.5) &&
        near(moved.height, box.height, 0.5),
      JSON.stringify({ box, moved }),
    );
  }

  await openFixture(page, "layoutGestures");
  const canvasFrame = page.locator('[data-design-frame="home.html"]');
  await canvasFrame.locator("[data-design-frame-label]").click();
  await typeSize(page, 10, 10);
  await expect.poll(() => savedFrameSize(page), { timeout: 10_000 }).toBe("10 × 10");
  await expect.poll(async () => (await canvasFrame.boundingBox()).width).toBeLessThan(5);
  const geometry = () => canvasFrame.evaluate((node) => ({
    x: Number.parseFloat(node.style.left), y: Number.parseFloat(node.style.top),
    width: Number.parseFloat(node.style.width), height: Number.parseFloat(node.style.height),
  }));
  const before = await geometry();
  const box = await canvasFrame.boundingBox();
  const handles = await canvasFrame.locator(".zd-design-selection-handle").count();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await geometry()).x).not.toBe(before.x);
  const after = await geometry();
  check(
    "a selected 10 × 10 canvas frame at 25% moves from its body and keeps its size",
    handles === 0 && near(after.x - before.x, 160, 2) && near(after.y - before.y, 120, 2) &&
      after.width === 10 && after.height === 10,
    JSON.stringify({ handles, before, after }),
  );

  // Modifier presses keep their meaning on a tiny frame's body. At 110 × 110
  // and 20% the frame is 22 screen pixels; world (85, 100) is over the hero
  // layer and clear of the lower-right corner handle.
  await typeSize(page, 110, 110);
  await expect.poll(() => savedFrameSize(page), { timeout: 10_000 }).toBe("110 × 110");
  const zoom = 0.2;
  const resized = await geometry();
  await setCamera(page, {
    zoom,
    panX: 500 - (resized.x + 55) * zoom,
    panY: 400 - (resized.y + 55) * zoom,
  });
  await expect.poll(async () => (await canvasFrame.boundingBox()).width).toBeLessThan(23);
  const targets = () =>
    page.evaluate(async () => {
      const { useDesignWorkspaceUiStore } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
      return useDesignWorkspaceUiStore.getState().byWorkspace.ws_design_harness?.selectedTargets ?? [];
    });
  const small = await canvasFrame.boundingBox();
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(small.x + 85 * zoom, small.y + 100 * zoom);
  await page.keyboard.up("ControlOrMeta");
  await expect.poll(async () => (await targets())[0]?.nodeId ?? null).not.toBeNull();
  const deep = await targets();
  check(
    "Ctrl/Cmd-click inside a selected tiny frame deep-selects the layer under the pointer",
    deep.length === 1 && deep[0].nodeId === "home-hero",
    JSON.stringify(deep),
  );
}

export async function runDesignTransformChromeSmoke(options) {
  await runDesignMirroredSelectionChromeSmoke(options);
  await runDesignFrameResizeLayoutToolsSmoke(options);
  await runDesignDeepZoomStrokeSmoke(options);
  await runDesignTurnedLayerDragOutSmoke(options);
  await runDesignTinySelectionSmoke(options);
}
