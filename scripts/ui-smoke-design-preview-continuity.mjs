import { expect } from "@playwright/test";

/** A returning frame must reuse its decoded cover while a sharper encoded
 * picture waits for decoding. Hold that boundary instead of racing the host. */
export async function runDesignWarmPreviewRefinementSmoke({ page: parent, check }) {
  const page = await parent.context().browser().newPage({
    viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2,
  });
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
      HTMLImageElement.prototype.decode = async function () {
        await decode.call(this);
        if (window.__zerosHoldPreviewDecodes && this.src.startsWith("blob:")) {
          window.__zerosHeldPreviewUrls.push(this.src);
          await new Promise(resolve => pending.push(resolve));
        }
      };
    });
    await page.goto(`${new URL(parent.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures&pictures`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.__zerosHarnessDesignSurface);
    await page.evaluate(() => {
      const { snapshots, frames, ui } = window.__zerosHarnessDesignSurface;
      const workspaceId = "ws_design_harness";
      const template = snapshots.peekSnapshot(workspaceId).data.frames[0];
      frames(Array.from({ length: 24 }, (_, index) => ({ ...template,
        file: `warm-${index}.html`, title: `Warm ${index}`,
        x: index % 6 * 1600, y: Math.floor(index / 6) * 1100, z: index,
      })));
      ui.getState().setPanels(workspaceId, { layersVisible: false, inspectorVisible: false });
      ui.getState().setSelectedTargets(workspaceId, [], { activeFrame: null });
      ui.getState().setViewport(workspaceId, { zoom: 0.04, panX: 32, panY: 96 });
    });
    await expect.poll(() => page.locator('img[data-design-frame-picture="current"]').evaluateAll(images =>
      images.filter(image => image.complete && image.naturalWidth > 0 && image.naturalWidth <= 128).length),
    { timeout: 45_000 }).toBe(24);
    const target = page.locator('[data-design-frame="warm-0.html"]');
    const originalUrl = await target.locator('img[data-design-frame-picture="current"]').getAttribute("src");
    await page.evaluate(() => {
      window.__zerosHoldPreviewDecodes = true;
      window.__zerosHarnessDesignSurface.ui.getState().setViewport("ws_design_harness", { zoom: 0.08, panX: 32, panY: 96 });
    });
    await expect.poll(() => page.evaluate(() => {
      const { snapshots, previews } = window.__zerosHarnessDesignSurface;
      const snapshot = snapshots.peekSnapshot("ws_design_harness").data;
      const frame = snapshot.frames.find(frame => frame.file === "warm-0.html");
      const picture = previews.picture({ owner: { scope: "local", workspaceId: "ws_design_harness", directoryId: snapshot.directoryId },
        file: frame.file, sourceVersion: frame.sourceVersion, theme: null, level: "overview" });
      return picture?.level === "overview" && window.__zerosHeldPreviewUrls.includes(picture.url);
    }), { timeout: 15_000 }).toBe(true);
    await page.evaluate(() => window.__zerosHarnessDesignSurface.ui.getState().setViewport("ws_design_harness", {
      zoom: 0.08, panX: -10_000, panY: 96,
    }));
    await expect(target).toHaveCount(0);
    const samples = await page.evaluate(async () => {
      window.__zerosHarnessDesignSurface.ui.getState().setViewport("ws_design_harness", { zoom: 0.08, panX: 32, panY: 96 });
      const samples = [];
      for (let index = 0; index < 8; index++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const image = document.querySelector('[data-design-frame="warm-0.html"] img[data-design-frame-picture]');
        samples.push({ ready: !!image?.complete && image.naturalWidth > 0, url: image?.getAttribute("src") ?? null });
      }
      return samples;
    });
    expect(samples).toEqual(Array.from({ length: 8 }, () => ({ ready: true, url: originalUrl })));
    await page.evaluate(() => window.__zerosReleasePreviewDecodes());
    await expect.poll(() => target.locator('img[data-design-frame-picture="current"]').evaluate(image => image.naturalWidth)).toBe(384);
    await expect(target.locator('img[data-design-frame-picture="current"]')).not.toHaveAttribute("src", originalUrl);
    check("a culled frame paints its warm thumbnail on every return paint while a sharper decode is held, then adopts the sharper image", true);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => window.__zerosReleasePreviewDecodes?.()).catch(() => {});
    await page.close();
  }
}
