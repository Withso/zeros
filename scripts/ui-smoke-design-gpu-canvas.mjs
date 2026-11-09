import { expect } from "@playwright/test";

// The recorded GPU Design canvas (internal flag) draws a page of recorded
// frames through its real CanvasKit worker, chunk cache and compositor. Pixels
// are read back from the composited page, not from the GPU canvas itself.
const HARNESS = "harness-design-gpu-canvas.html";
const VIEWPORT = { x: 0, y: 0, width: 1040, height: 520 };

async function snapshotUntil(page, predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.__zerosDesignGpu?.snapshot() ?? null);
    if (last && predicate(last)) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`${label}: ${JSON.stringify(last?.visible ?? last)}`);
}

async function pixels(page, points) {
  const png = await page.screenshot({ clip: VIEWPORT, scale: "css" });
  return page.evaluate(async ({ base64, points }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3));
  }, { base64: png.toString("base64"), points });
}

const near = (actual, expected, tolerance = 3) => actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);

export async function runDesignGpuCanvasSmoke({ page, harnessBase }) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${harnessBase}/${HARNESS}`);
  const opened = await snapshotUntil(page, (snapshot) => snapshot.allVisibleCrispAt !== null, "every visible frame drawn crisp");
  expect(opened.visible).toMatchObject({ frames: 24, crisp: 24, stretched: 0, missing: 0 });
  expect(opened.firstFrameDrawnMs).toBeLessThanOrEqual(opened.allVisibleCrispMs);
  // One render reply carried the shared font once; it is registered, not
  // embedded in each of the 24 pictures.
  expect(opened.worker.typefaces.registered).toBe(1);
  expect(opened.worker.pictures.count).toBe(24);

  // Each frame's own fill, read where the camera puts it (zoom 0.5, pan 20).
  const frames = await page.evaluate(() => window.designGpuHarness.frames.map((frame, index) =>
    ({ x: frame.x * 0.5 + 20 + 150, y: frame.y * 0.5 + 20 + 5, fill: window.designGpuHarness.fill(index) })));
  const onScreen = frames.filter((frame) => frame.x < VIEWPORT.width && frame.y < VIEWPORT.height);
  expect(onScreen.length).toBeGreaterThan(12);
  const fills = await pixels(page, onScreen.map((frame) => [frame.x, frame.y]));
  onScreen.forEach((frame, index) => expect(near(fills[index], frame.fill), `fill at ${frame.x},${frame.y}`).toBe(true));

  // A selected frame keeps its selection stroke while the plane paints it:
  // the tiled attribute hides the DOM box-shadow, so the plane draws it.
  const resting = (await pixels(page, [[19, 70]]))[0];
  await page.evaluate(() => window.designGpuHarness.select(0));
  const stroke = await page.evaluate(() => {
    const value = getComputedStyle(document.querySelector("[data-design-frame]")).getPropertyValue("--design-stroke-color").trim();
    const probe = document.createElement("canvas").getContext("2d");
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    return Array.from(probe.getImageData(0, 0, 1, 1).data).slice(0, 3);
  });
  await expect.poll(async () => {
    const [outer, inner] = await pixels(page, [[18, 70], [19, 70]]);
    return near(outer, stroke, 8) && near(inner, stroke, 8);
  }, { message: "selection stroke on the plane" }).toBe(true);
  expect(near(resting, stroke, 8)).toBe(false);
  await page.evaluate(() => window.designGpuHarness.select(null));

  // Another owner (here a theme) ends the previous owner's requests, and
  // returning shows its retained recordings at once: A → B → A.
  await page.evaluate(() => window.designGpuHarness.setTheme("held"));
  await expect.poll(() => page.evaluate(() => window.designGpuHarness.requests.some((request) =>
    request.theme === "held" && request.op === "render"))).toBe(true);
  await page.evaluate(() => window.designGpuHarness.setTheme(null));
  await expect.poll(() => page.evaluate(() => window.designGpuHarness.requests.filter((request) =>
    request.theme === "held" && request.op === "render").every((request) => request.aborted))).toBe(true);
  await snapshotUntil(page, (snapshot) => snapshot.visible.frames > 0 && snapshot.visible.crisp === snapshot.visible.frames,
    "the first owner's frames drawn again");

  // Zooming in re-rasterizes at the new density: at rest the box edge is a
  // one-pixel step, never a stretched overview picture.
  await page.evaluate(() => window.designGpuHarness.setView({ zoom: 4, panX: -40, panY: -40 }));
  const zoomed = await snapshotUntil(page, (snapshot) => snapshot.visible.frames > 0 &&
    snapshot.visible.crisp === snapshot.visible.frames && snapshot.visible.stretched === 0, "crisp at 4x");
  expect(zoomed.worker.raster.tile.count).toBeGreaterThan(0);
  const [inside, outside] = await pixels(page, [[121, 460], [118, 460]]);
  expect(near(inside, [250, 250, 250])).toBe(true);
  expect(near(outside, frames[0].fill)).toBe(true);

  // A lost context on either side recovers from the worker's pictures.
  await page.evaluate(() => window.__zerosDesignGpu.loseContext("compositor"));
  await snapshotUntil(page, (snapshot) => snapshot.contextLosses.compositor === 1 && snapshot.gpu.pages > 0 &&
    snapshot.visible.crisp === snapshot.visible.frames, "compositor context recovered");
  await page.evaluate(() => window.__zerosDesignGpu.loseContext("rasterizer"));
  await snapshotUntil(page, (snapshot) => snapshot.contextLosses.rasterizer === 1, "rasterizer context lost");
  await page.evaluate(() => window.designGpuHarness.setView({ zoom: 1, panX: 0, panY: 0 }));
  await snapshotUntil(page, (snapshot) => snapshot.visible.crisp === snapshot.visible.frames, "rasterizer context recovered");
  const [restored] = await pixels(page, [[300, 10]]);
  expect(near(restored, frames[0].fill)).toBe(true);
  expect(errors).toEqual([]);

  // Flag off: no plane, no instrumentation, and frames keep their DOM surface.
  await page.goto(`${harnessBase}/${HARNESS}?enabled=0`);
  await page.waitForSelector("[data-design-frame]");
  expect(await page.locator("[data-design-gpu-plane]").count()).toBe(0);
  expect(await page.locator("[data-design-frame-tiled]").count()).toBe(0);
  expect(await page.evaluate(() => "__zerosDesignGpu" in window)).toBe(false);
}
