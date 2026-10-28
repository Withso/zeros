import { expect } from "@playwright/test";
import { runDesignSourceSurfacesSmoke, runDesignVectorSurfacesSmoke } from "./ui-smoke-design-source-surfaces.mjs";
import { runDesignWarmPreviewRefinementSmoke } from "./ui-smoke-design-preview-continuity.mjs";

async function openZoomedOut(page) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures&pictures`,
    { waitUntil: "networkidle" },
  );
  // Earlier scenarios on a shared page can leave another directory bound in
  // the persisted Design view and boot snapshot. Clear both in this document
  // (an unloading page would write them back) and mount once more.
  await page.evaluate(async () => {
    const { resetDesignWorkspaceUiForTests } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    resetDesignWorkspaceUiForTests();
    localStorage.removeItem("zeros-design-workspace-snapshots-v1");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const { useDesignWorkspaceUiStore } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    // 1,440 px frames at 10%: 144 device pixels, inside one overview picture.
    useDesignWorkspaceUiStore.getState().setViewport("ws_design_harness", {
      zoom: 0.1,
      panX: 200,
      panY: 200,
    });
  });
  await expect(page.locator('[data-design-frame="pricing.html"]')).toBeVisible();
}

const previewRequests = (page, frame) =>
  page.evaluate(
    (file) => (window.__zerosHarnessPreviewRequests ?? []).filter((request) => request.frame === file).length,
    frame,
  );

/** Zoomed out, a frame that is not selected paints its saved picture and
 * stops running its document; a reload paints the stored picture again
 * without asking the capture host. */
export async function runDesignPicturesSmoke({ page, check }) {
  await runDesignSourceSurfacesSmoke({ page, check });
  await runDesignVectorSurfacesSmoke({ page, check });
  await runDesignPictureDecodeHandoff({ page, check });
  await runDesignTextPicturesSmoke({ page, check });
  await runDesignOverviewChromeSmoke({ page, check });
  await runDesignOverviewContinuitySmoke({ page, check });
  await runDesignWarmPreviewRefinementSmoke({ page, check });
  await runDesignRetinaTileHandoffSmoke({ page, check });
  // This fixture persists a directory and camera, unlike the legacy fixtures
  // without a directory identity. Keep its reloads in one isolated context so
  // a later scenario cannot inherit an owner its snapshot does not describe.
  const control = await page.context().browser().newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors = [];
  control.on("pageerror", (error) => errors.push(error.message));
  try {
    await control.goto(
      `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures&pictures`,
      { waitUntil: "networkidle" },
    );
    await checkDesignPictures({ page: control, check });
    expect(errors).toEqual([]);
  } finally {
    await control.close();
  }
}

/** A full Retina viewport nearly fills the steady image budget. Its next
 * crop must replace the old pixels without becoming permanently stale. */
export async function runDesignRetinaTileHandoffSmoke({ page: parent, check }) {
  const page = await parent.context().browser().newPage({
    viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${new URL(parent.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures&pictures`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.__zerosHarnessDesignSurface);
    await page.evaluate(() => {
      const { snapshots, frames, ui } = window.__zerosHarnessDesignSurface;
      const workspaceId = "ws_design_harness";
      const frame = snapshots.peekSnapshot(workspaceId).data.frames.find((frame) => frame.file === "home.html");
      frames([{ ...frame, x: 0, y: 0 }]);
      ui.getState().setPanels(workspaceId, { layersVisible: false, inspectorVisible: false });
      ui.getState().setSelectedTargets(workspaceId, [], { activeFrame: frame.file });
      ui.getState().setViewport(workspaceId, { zoom: 8, panX: -800, panY: -400 });
    });
    const current = page.locator("[data-design-high-resolution-tile][data-design-tile-current]");
    await expect(current).toHaveCount(1, { timeout: 15000 });
    for (const delta of [180, -360, 180]) {
      const before = await current.getAttribute("data-design-tile-key");
      const samples = await page.evaluate(async (deltaX) => {
        const canvas = document.querySelector("[data-design-canvas-viewport]");
        const bounds = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
          clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
          deltaX, deltaY: 0, deltaMode: 0 }));
        const samples = [];
        for (let index = 0; index < 45; index++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const image = document.querySelector("[data-design-high-resolution-tile]");
          const bounds = image?.getBoundingClientRect();
          samples.push({ ready: !!image?.complete && image.naturalWidth > 0,
            scale: image && bounds ? image.naturalWidth / bounds.width : 0,
            images: window.__zerosHarnessDesignSurface.resources().images });
        }
        return samples;
      }, delta);
      expect(samples.every((sample) => sample.ready && sample.scale >= 1.99)).toBe(true);
      for (const { images } of samples) {
        expect(images.decodedBytes).toBeLessThanOrEqual(images.maxDecodedBytes + (images.transitionDecodedBytes ?? 0));
        expect(images.encodedBytes).toBeLessThanOrEqual(images.maxEncodedBytes + (images.transitionEncodedBytes ?? 0));
        expect(images.transitions ?? 0).toBeLessThanOrEqual(1);
      }
      await expect(current).toHaveCount(1, { timeout: 10000 });
      await expect(current).not.toHaveAttribute("data-design-tile-key", before);
      await expect.poll(() => page.evaluate(() => window.__zerosHarnessDesignSurface.resources().images.transitions ?? 0)).toBe(0);
    }
    await page.evaluate(() => window.__zerosHarnessDesignSurface.active(false));
    await expect.poll(() => page.evaluate(() => {
      const r = window.__zerosHarnessDesignSurface.resources();
      return { users: r.previewDecodes.users, pending: r.previewDecodes.pending,
        tileRequests: r.counters.tileRequests.current, captures: r.captures.running + r.captures.queued,
        transitions: r.images.transitions,
        otherImageLeases: r.images.leases - r.previewDecodes.entries };
    })).toEqual({ users: 0, pending: 0, tileRequests: 0, captures: 0, transitions: 0, otherImageLeases: 0 });
    const hidden = await page.evaluate(() => window.__zerosHarnessDesignSurface.resources());
    expect(hidden.previewDecodes.warmBytes).toBeLessThanOrEqual(32 * 1024 ** 2);
    expect(hidden.images.decodedBytes).toBe(hidden.previewDecodes.warmBytes);
    expect(hidden.images.encodedBytes).toBeLessThanOrEqual(hidden.images.maxEncodedBytes);
    expect(errors).toEqual([]);
    check("Retina close zoom keeps sharp pixels through repeated pans, retires hidden image work and bounds warm previews", true);
  } finally {
    await page.close();
  }
}

/** Count every source frame intersecting the painted camera, including any
 * missing DOM surface. A warm zoom must not expose empty frames for one paint. */
export async function runDesignOverviewContinuitySmoke({ page: parent, check }) {
  const page = await parent.context().browser().newPage({
    viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${new URL(parent.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures&pictures`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.__zerosHarnessDesignSurface);
    await page.evaluate(() => {
      const { snapshots, frames, ui } = window.__zerosHarnessDesignSurface;
      const workspaceId = "ws_design_harness";
      const template = snapshots.peekSnapshot(workspaceId).data.frames[0];
      frames(Array.from({ length: 256 }, (_, index) => ({ ...template,
        file: `overview-${index}.html`, title: `Frame ${index + 1}`,
        x: index % 16 * 1600, y: Math.floor(index / 16) * 1100, z: index,
      })));
      ui.getState().setPanels(workspaceId, { layersVisible: false, inspectorVisible: false });
      ui.getState().setSelectedTargets(workspaceId, [], { activeFrame: null });
      ui.getState().setViewport(workspaceId, { zoom: 0.04, panX: 32, panY: 96 });
      window.__readOverviewCoverage = () => {
        const viewport = document.querySelector("[data-design-canvas-viewport]").getBoundingClientRect();
        const camera = new DOMMatrixReadOnly(getComputedStyle(document.querySelector("[data-design-canvas-world]")).transform);
        const visible = snapshots.peekSnapshot(workspaceId).data.frames.filter((frame) => {
          const x = camera.e + frame.x * camera.a, y = camera.f + frame.y * camera.a;
          return x + frame.width * camera.a > 0 && y + frame.height * camera.a > 0 && x < viewport.width && y < viewport.height;
        });
        const mounted = new Map([...document.querySelectorAll("[data-design-frame]")].map((frame) => [frame.dataset.designFrame, frame]));
        const missing = visible.filter((frame) => {
          const node = mounted.get(frame.file);
          return !node || !(node.querySelector('iframe[data-design-document-buffer="displayed"][data-design-document-ready]') ||
            [...node.querySelectorAll("img[data-design-frame-picture], img[data-design-frame-screenshot], img[data-design-frame-transition-cover]")].some((image) =>
              image.complete && image.naturalWidth > 0 && getComputedStyle(image).display !== "none" && getComputedStyle(image).visibility === "visible"));
        }).map((frame) => frame.file);
        return { visible: visible.length, mounted: mounted.size, covered: visible.length - missing.length, missing, zoom: camera.a,
          missingDetails: missing.map((file) => ({ file, images: [...(mounted.get(file)?.querySelectorAll("img") ?? [])].map((image) => ({
            ready: image.complete && image.naturalWidth > 0, markers: Object.keys(image.dataset),
            display: getComputedStyle(image).display, visibility: getComputedStyle(image).visibility,
          })) })),
        };
      };
    });
    await expect.poll(() => page.evaluate(() => window.__readOverviewCoverage().covered), { timeout: 45000 }).toBe(256);
    let expectedZoom = 0.04;
    for (const step of [{ factor: 2 }, { pan: 600 }, { pan: -600 }, { factor: 0.5 }, { factor: 2 }, { factor: 0.5 }]) {
      expectedZoom *= step.factor ?? 1;
      const samples = await page.evaluate(async ({ factor, pan }) => {
        const canvas = document.querySelector("[data-design-canvas-viewport]");
        const bounds = canvas.getBoundingClientRect();
        const samples = [];
        canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, metaKey: factor !== undefined,
          clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
          deltaX: pan ?? 0, deltaY: factor === undefined ? 0 : -Math.log(factor) / 0.002, deltaMode: 0 }));
        for (let index = 0; index < 45; index++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          samples.push(window.__readOverviewCoverage());
        }
        return samples;
      }, step);
      expect(samples.at(-1).zoom).toBeCloseTo(expectedZoom);
      // Zooming in really retires offscreen wrappers; warm continuity must
      // come from bounded picture ownership, not keeping all frames mounted.
      if (expectedZoom === 0.08) expect(samples.at(-1).mounted).toBeLessThan(160);
      expect(samples.filter((sample) => sample.missing.length), `warm camera step ${JSON.stringify(step)} lost frame pixels`).toEqual([]);
    }
    check("256 overview frames keep pixels through every painted warm pan and zoom, with offscreen surfaces retired", true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}

/** Tiny overview frames expose their chrome on intent without covering the grid. */
export async function runDesignOverviewChromeSmoke({ page: parent, check }) {
  const page = await parent.context().browser().newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${new URL(parent.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures&pictures`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.__zerosHarnessDesignSurface);
    await page.evaluate(() => {
      const { ui, snapshots, frames } = window.__zerosHarnessDesignSurface;
      const workspaceId = "ws_design_harness";
      const template = snapshots.peekSnapshot(workspaceId).data.frames[0];
      frames(Array.from({ length: 24 }, (_, index) => ({ ...template,
        file: `overview-${index}.html`, title: `Overview ${index}`,
        x: index % 6 * 1600, y: Math.floor(index / 6) * 1100, z: index,
      })));
      ui.getState().setPanels(workspaceId, { layersVisible: false, inspectorVisible: false });
      ui.getState().setSelectedTargets(workspaceId, [], { activeFrame: null });
      ui.getState().setViewport(workspaceId, { zoom: 0.05, panX: 80, panY: 100 });
    });
    const frames = page.locator("[data-design-frame]");
    await expect(frames).toHaveCount(24);
    const frame = page.locator('[data-design-frame="overview-7.html"]');
    const play = frame.locator("[data-design-frame-play]");
    const chrome = () => play.evaluate(button => {
      const style = getComputedStyle(button.parentElement);
      return { clip: style.clip, pointerEvents: style.pointerEvents };
    });
    await expect.poll(() => frames.evaluateAll(frames => {
      const active = window.__zerosHarnessDesignSurface.ui.getState().byWorkspace.ws_design_harness.selectedFrame;
      return frames.filter(frame => frame.dataset.designFrame !== active).every(frame =>
        getComputedStyle(frame.querySelector("[data-design-frame-play]").parentElement).clip === "rect(0px, 0px, 0px, 0px)");
    })).toBe(true);
    await frame.hover({ position: { x: 30, y: 20 } });
    await expect.poll(chrome).toEqual({ clip: "auto", pointerEvents: "auto" });
    await page.mouse.move(2, 2);
    await expect.poll(chrome).toEqual({ clip: "rect(0px, 0px, 0px, 0px)", pointerEvents: "none" });
    await play.focus();
    await expect.poll(chrome).toEqual({ clip: "auto", pointerEvents: "auto" });
    await play.press("Enter");
    await expect(play).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(play).toHaveAttribute("aria-pressed", "false");
    check("overview chrome leaves frames visible and remains available by hover and keyboard", true);
  } finally { await page.close(); }
}

/** More transparent text frames than the live-document cap must all paint. */
export async function runDesignTextPicturesSmoke({ page: parent, check }) {
  const page = await parent.context().browser().newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${new URL(parent.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures&pictures`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.__zerosHarnessDesignSurface);
    await page.evaluate(() => {
      const { ui, snapshots, frames } = window.__zerosHarnessDesignSurface;
      const workspaceId = "ws_design_harness";
      const template = snapshots.peekSnapshot(workspaceId).data.frames[0];
      frames(Array.from({ length: 32 }, (_, index) => ({ ...template,
        kind: "text", file: `text-${index}.html`, title: `Text ${index}`,
        x: index % 8 * 1600, y: Math.floor(index / 8) * 1100, z: index,
      })));
      ui.getState().setPanels(workspaceId, { layersVisible: false, inspectorVisible: false });
      ui.getState().setSelectedTargets(workspaceId, [], { activeFrame: null });
      ui.getState().setViewport(workspaceId, { zoom: 0.06, panX: 80, panY: 100 });
    });
    await expect(page.locator("[data-design-frame-kind=text]")).toHaveCount(32);
    // The canvas may keep its automatically selected frame live. Every other
    // text frame still needs pixels beyond the twelve-document ceiling.
    await expect.poll(() => page.locator("[data-design-frame-kind=text]").evaluateAll(frames => frames.filter(frame =>
      frame.querySelector("iframe[data-design-document-ready]") ||
      [...frame.querySelectorAll('img[data-design-frame-picture="current"]')].some(image => image.complete && image.naturalWidth > 0),
    ).length), { timeout: 20_000 }).toBe(32);
    expect(await page.locator("[data-design-frame] iframe").count()).toBeLessThanOrEqual(12);
    expect(await page.locator('img[data-design-frame-picture="current"]').count()).toBeGreaterThanOrEqual(20);
    const alpha = await page.locator('img[data-design-frame-picture="current"]').evaluateAll(images => images.map(image => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return context.getImageData(canvas.width - 1, canvas.height - 1, 1, 1).data[3];
    }));
    expect(alpha).toEqual(Array(alpha.length).fill(0));
    check("every visible transparent text frame paints beyond the live-document cap", true);
  } finally { await page.close(); }
}

/** An encoded cache entry cannot retire a live frame before its replacement
 * has decoded. Hold that exact boundary, including a camera update. */
export async function runDesignPictureDecodeHandoff({ page: parent, check }) {
  const page = await parent.context().browser().newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      if (window !== window.top) return;
      const decode = HTMLImageElement.prototype.decode;
      const pending = [];
      window.__zerosHeldPreviewUrls = [];
      window.__zerosReleasePreviewDecodes = () => {
        window.__zerosHoldPreviewDecodes = false;
        for (const resolve of pending.splice(0)) resolve();
      };
      window.__zerosHoldPreviewDecodes = true;
      HTMLImageElement.prototype.decode = async function () {
        await decode.call(this);
        if (window.__zerosHoldPreviewDecodes && this.src.startsWith("blob:")) {
          window.__zerosHeldPreviewUrls.push(this.src);
          await new Promise(resolve => pending.push(resolve));
        }
      };
    });
    await page.goto(`${new URL(parent.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures&pictures`, { waitUntil: "networkidle" });
    await openZoomedOut(page);
    const frame = page.locator('[data-design-frame="pricing.html"]');
    await expect(frame.locator('iframe[data-design-document-ready]')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => {
      const { snapshots, previews } = window.__zerosHarnessDesignSurface;
      const snapshot = snapshots.peekSnapshot("ws_design_harness").data;
      const frame = snapshot.frames.find(frame => frame.file === "pricing.html");
      const picture = previews.picture({ owner: { scope: "local", workspaceId: "ws_design_harness", directoryId: snapshot.directoryId },
        file: frame.file, sourceVersion: frame.sourceVersion, theme: null, level: "overview" });
      return !!picture && window.__zerosHeldPreviewUrls.includes(picture.url);
    }), { timeout: 15_000 }).toBe(true);
    // Publish a camera change after the encoded picture is available. The
    // canvas recomputes admission while the display decoder is still held.
    await page.evaluate(async () => {
      const { ui } = window.__zerosHarnessDesignSurface;
      const view = ui.getState().byWorkspace.ws_design_harness;
      ui.getState().setViewport("ws_design_harness", { zoom: view.zoom, panX: view.panX + 1, panY: view.panY });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(frame.locator('iframe[data-design-document-ready]')).toHaveCount(1);
    check("an available encoded preview keeps the live document until the display decoder confirms its pixels", true);
    await page.evaluate(() => window.__zerosReleasePreviewDecodes());
    await expect(frame.locator('img[data-design-frame-picture="current"]')).toHaveCount(1);
    await expect(frame.locator("iframe")).toHaveCount(0);
    check("a decoded exact-generation preview replaces its live document without an empty handoff", true);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => window.__zerosReleasePreviewDecodes?.()).catch(() => {});
    await page.close();
  }
}

async function checkDesignPictures({ page, check }) {
  // Start from an empty picture store, then verify it survives a real reload.
  await openZoomedOut(page);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.deleteDatabase("zeros:design-previews:v1");
        request.onsuccess = request.onerror = request.onblocked = () => resolve(undefined);
      }),
  );
  await openZoomedOut(page);
  const pricing = page.locator('[data-design-frame="pricing.html"]');
  await expect(pricing.locator('img[data-design-frame-picture="current"]')).toHaveCount(1, { timeout: 15_000 });
  expect(await previewRequests(page, "pricing.html")).toBeGreaterThan(0);
  const [request] = await page.evaluate(() => window.__zerosHarnessPreviewRequests);
  expect(request).toMatchObject({ workspaceId: "ws_design_harness", maxDimension: 384 });
  await expect(pricing.locator("iframe")).toHaveCount(0, { timeout: 15_000 });
  check("a small frame on a zoomed-out canvas paints its saved picture instead of running its document", true);

  await page.reload({ waitUntil: "networkidle" });
  await openZoomedOut(page);
  await expect(pricing.locator('img[data-design-frame-picture="current"]')).toHaveCount(1, { timeout: 15_000 });
  expect(await previewRequests(page, "pricing.html")).toBe(0);
  check("a reopened canvas paints the stored picture without rendering it again", true);
}
