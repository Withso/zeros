import { expect } from "@playwright/test";

/** Offscreen frames are still real semantic frames. The fixture keeps source
 * for every one, but only the admitted set should mount renderer surfaces. */
export async function installDesignResidencyFixture(page, count = 256) {
  return page.evaluate(async (count) => {
    const control = window.__zerosHarnessDesignSurface;
    const workspaceId = "ws_design_harness";
    const base = control.snapshots.peekSnapshot(workspaceId).data;
    const frames = base.frames.slice(0, 2);
    for (let index = 2; index < count; index++) {
      frames.push({
        ...base.frames[0], file: `performance-${index}.html`, title: `Frame ${index}`,
        x: 10000 + (index % 16) * 1600, y: 10000 + Math.floor(index / 16) * 1100,
        z: index,
      });
    }
    // Use the fixture's engine-facing state as well as its renderer cache.
    // This lets real frame reads and multi-frame geometry commits run.
    control.frames(frames);
    control.ui.getState().setViewport(workspaceId, { zoom: 0.5, panX: 80, panY: 100 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return frames.length;
  }, count);
}

export async function runDesignResidencySmoke({ page: parent, check }) {
  const page = await parent.context().browser().newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${new URL(parent.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.__zerosHarnessDesignSurface);
    await installDesignResidencyFixture(page);
    await expect.poll(() => page.evaluate(() => window.__zerosHarnessDesignSurface.snapshots.peekSnapshot("ws_design_harness").data.frames.length)).toBe(256);
    await expect(page.locator("[data-design-frame]")).toHaveCount(2);
    check("256 semantic frames with two nearby frames mount only two surfaces", true);

    // A held hand-pan never commits the durable camera until release. A frame
    // entering the viewport must mount while that gesture is still running.
    const viewport = page.locator("[data-design-canvas-viewport]");
    const bounds = await viewport.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(bounds.x + bounds.width / 2 - 6600, bounds.y + bounds.height / 2 - 5000);
    await expect(page.locator('[data-design-frame="performance-2.html"]')).toHaveCount(1);
    expect(await page.evaluate(() => window.__zerosHarnessDesignSurface.ui.getState().byWorkspace.ws_design_harness?.panX)).not.toBe(-6520);
    await page.mouse.up({ button: "middle" });
    check("continuous hand-pan admits newly visible frames before release", true);

    await page.evaluate(() => {
      const { ui } = window.__zerosHarnessDesignSurface;
      ui.getState().setViewport("ws_design_harness", { zoom: 0.5, panX: 80, panY: 100 });
      ui.getState().setSelectedTargets("ws_design_harness", [{ frame: "home.html" }, { frame: "performance-255.html" }], { activeFrame: "home.html" });
    });
    await expect(page.locator('[data-design-frame="performance-255.html"]')).toHaveCount(0);
    const before = await page.evaluate(() => window.__zerosHarnessDesignSurface.snapshots.peekSnapshot("ws_design_harness").data.frames.filter((frame) => ["home.html", "performance-255.html"].includes(frame.file)).map((frame) => ({ file: frame.file, x: frame.x })));
    await viewport.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => page.evaluate(() => (window.__zerosHarnessFrameMoves ?? []).length)).toBe(1);
    const after = await page.evaluate(() => window.__zerosHarnessDesignSurface.snapshots.peekSnapshot("ws_design_harness").data.frames.filter((frame) => ["home.html", "performance-255.html"].includes(frame.file)).map((frame) => ({ file: frame.file, x: frame.x })));
    expect(after).toEqual(before.map((frame) => ({ ...frame, x: frame.x + 1 })));
    await expect(page.locator('[data-design-frame="performance-255.html"]')).toHaveCount(0);
    check("group keyboard movement commits offscreen members without mounting them", true);

    const label = page.locator('[data-design-frame="home.html"] [data-design-frame-label]');
    const labelBounds = await label.boundingBox();
    await page.keyboard.down("Control");
    await page.mouse.move(labelBounds.x + labelBounds.width / 2, labelBounds.y + labelBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(labelBounds.x + labelBounds.width / 2 + 20, labelBounds.y + labelBounds.height / 2 + 10, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect.poll(() => page.evaluate(() => (window.__zerosHarnessFrameMoves ?? []).length)).toBe(2);
    const moved = await page.evaluate(() => window.__zerosHarnessDesignSurface.snapshots.peekSnapshot("ws_design_harness").data.frames.filter((frame) => ["home.html", "performance-255.html"].includes(frame.file)).map((frame) => ({ file: frame.file, x: frame.x })));
    expect(moved).toEqual(after.map((frame) => ({ ...frame, x: frame.x + 40 })));
    check("group pointer movement commits offscreen members in the same transaction", true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}
