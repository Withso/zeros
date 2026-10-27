/** A held engine batch exercises the production navigation adapter, cache,
 * residency, Layers and editing authority. Native source I/O is covered by
 * navigation-preparation.test.ts with real files. */
export async function runDesignLazyPreparationSmoke({ page: parent, check, capture }) {
  const origin = new URL(parent.url()).origin;
  // This catalog has a durable directory identity while the older interaction
  // fixtures do not. Its retained owner must not contaminate their shared page.
  const page = await parent.context().browser().newPage({ viewport: { width: 1440, height: 900 } });
  try {
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?lazyPreparation=1`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface?.lazy?.calls.length > 0);
  const initial = await page.evaluate(() => {
    const c = window.__zerosHarnessDesignSurface;
    return { snapshot: c.snapshots.peekSnapshot("ws_design_harness").data, calls: c.lazy.calls,
      iframes: document.querySelectorAll("[data-design-frame] iframe").length, resources: c.resources() };
  });
  check("256 frame descriptions are navigable before any source preparation completes",
    initial.snapshot.preparation.descriptions.length === 256 && initial.snapshot.frames.length === 0 && initial.iframes === 0);
  check("fixed-view opening requests only visible/nearby sources", initial.calls.length === 1 &&
    initial.calls[0].files.every((file) => ["home.html", "pricing.html"].includes(file)));
  check("unprepared surfaces are included in resource accounting", initial.resources.counters.frameSurfaces.current > 0);
  check("cold metadata keeps its bounds without painting placeholder frames", await page.evaluate(() =>
    [...document.querySelectorAll('[data-design-frame]')].every(frame => getComputedStyle(frame).visibility === "hidden")));
  // Hold a same-epoch revalidation across the first preparation reply. The
  // reply must not publish during that read, but finishing the read must wake
  // the unchanged demand without a click, camera change or new catalog epoch.
  await page.evaluate(() => {
    const c = window.__zerosHarnessDesignSurface;
    const previous = c.snapshots.peekSnapshot("ws_design_harness").data;
    const held = new Promise(resolve => { window.__finishDesignPreparationRefresh = () => resolve(previous); });
    window.__designPreparationRefresh = c.snapshots.load("ws_design_harness", () => held, { force: true });
    c.lazy.release();
  });
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface.resources().preparation.running === 0);
  check("preparation cannot publish over an in-flight same-owner revalidation", await page.evaluate(() => {
    const read = window.__zerosHarnessDesignSurface.snapshots.peekSnapshot("ws_design_harness");
    return read.refreshing && read.data.preparation.current.length === 0;
  }));
  await page.evaluate(async () => {
    window.__finishDesignPreparationRefresh();
    await window.__designPreparationRefresh;
    delete window.__finishDesignPreparationRefresh;
    delete window.__designPreparationRefresh;
  });
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface.snapshots.peekSnapshot("ws_design_harness").data.preparation.current.length > 0, undefined, { timeout: 5000 });
  check("same-epoch read completion resumes the cold preparation queue without further input", true);
  const home = page.locator('[data-design-frame="home.html"]');
  await home.locator('iframe[data-design-document-ready]').waitFor();
  check("a prepared frame reveals its chrome with its ready document", await home.isVisible());
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface.resources().preparation.running === 0);
  check("ready runtimes keep offscreen frames unprepared instead of triggering an aggregate audit scan", await page.evaluate(() => {
    const c = window.__zerosHarnessDesignSurface;
    const value = c.snapshots.peekSnapshot("ws_design_harness").data;
    return value.preparation?.current.length <= 2 && !c.lazy.operations.includes("design.snapshot");
  }));
  await capture?.();
  // Layers selects/reveals using metadata while a fresh source is still held.
  await page.evaluate(() => window.__zerosHarnessDesignSurface.lazy.hold());
  await page.locator('[data-design-frame-row="distant-0.html"]').click();
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface.ui.getState().byWorkspace.ws_design_harness.selectedFrame === "distant-0.html");
  await page.locator('[data-design-frame="distant-0.html"][data-design-preparing]').waitFor({ state: "attached" });
  check("Layers can navigate to a cold frame without exposing its placeholder", await page.locator('[data-design-frame="distant-0.html"]').isHidden());
  await page.waitForFunction(() => {
    const rect = document.querySelector('[data-design-frame="distant-0.html"]').getBoundingClientRect();
    return rect.left < innerWidth && rect.right > 0 && rect.top < innerHeight && rect.bottom > 0;
  });
  check("Layers reveals an unloaded frame synchronously and waits to authorize editing", await page.evaluate(() => {
    const c = window.__zerosHarnessDesignSurface;
    return c.snapshots.peekSnapshot("ws_design_harness").data.preparation.current.includes("distant-0.html") === false &&
      !document.querySelector('[data-design-frame="distant-0.html"] iframe');
  }));
  await page.locator('[data-design-canvas-viewport]').focus();
  const beforeFit = await page.evaluate(() => window.__zerosHarnessDesignSurface.ui.getState().byWorkspace.ws_design_harness.zoom);
  await page.keyboard.press("Shift+Digit2");
  check("Fit selection uses unloaded frame bounds without waiting for source", await page.evaluate((zoom) => {
    const c = window.__zerosHarnessDesignSurface;
    return c.ui.getState().byWorkspace.ws_design_harness.zoom > zoom &&
      !c.snapshots.peekSnapshot("ws_design_harness").data.preparation.current.includes("distant-0.html");
  }, beforeFit));
  await page.keyboard.press("Escape");
  check("Escape deselects an unloaded frame while keeping its Layers activation", await page.evaluate(() => {
    const view = window.__zerosHarnessDesignSurface.ui.getState().byWorkspace.ws_design_harness;
    return view.selectedFrame === "distant-0.html" && view.frameSelected === false;
  }));
  await page.locator('[data-design-frame-row="distant-0.html"]').click();
  const emptyPoint = await page.evaluate(() => {
    const viewport = document.querySelector('[data-design-canvas-viewport]');
    const rect = viewport.getBoundingClientRect();
    for (let y = rect.bottom - 20; y > rect.top; y -= 40)
      for (let x = rect.right - 20; x > rect.left; x -= 40)
        if (document.elementFromPoint(x, y) === viewport) return { x, y };
    throw new Error("No empty canvas point is available for the selection check.");
  });
  await page.mouse.click(emptyPoint.x, emptyPoint.y);
  check("An empty-canvas press deselects an unloaded frame without forgetting it", await page.evaluate(() => {
    const view = window.__zerosHarnessDesignSurface.ui.getState().byWorkspace.ws_design_harness;
    return view.selectedFrame === "distant-0.html" && view.frameSelected === false;
  }));
  await page.evaluate(() => window.__zerosHarnessDesignSurface.lazy.release());
  await page.locator('[data-design-frame="distant-0.html"] iframe[data-design-document-ready]').waitFor();
  // An unchanged metadata revision cannot carry the prior source authority.
  await page.evaluate(() => {
    const c = window.__zerosHarnessDesignSurface;
    c.lazy.hold();
    window.__zerosHarnessAgentDrafts.save('<html><body><h1 data-oid="home-heading">Changed source</h1></body></html>', "d".repeat(24));
    c.lazy.refresh();
  });
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface.snapshots.peekSnapshot("ws_design_harness").data?.preparation?.current.length === 0);
  check("watcher revalidation clears source authority even with identical catalog metadata", await page.evaluate(() => {
    const value = window.__zerosHarnessDesignSurface.snapshots.peekSnapshot("ws_design_harness").data;
    return value.preparation.revision === "a".repeat(64) && value.frames.length > 0 && value.preparation.current.length === 0;
  }));
  await page.evaluate(() => window.__zerosHarnessDesignSurface.owner("org_local"));
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface.snapshots.peekSnapshot("org_local").data?.preparation);
  await page.evaluate(() => window.__zerosHarnessDesignSurface.lazy.release());
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface.snapshots.peekSnapshot("org_local").data?.preparation?.current.length > 0);
  check("late Personal preparation cannot publish into an organization-local destination", await page.evaluate(() => {
    const c = window.__zerosHarnessDesignSurface;
    return c.snapshots.peekSnapshot("ws_design_harness").data.preparation.current.length === 0 &&
      c.snapshots.peekSnapshot("org_local").data.lint.workspacePath.endsWith("-org_local");
  }));
  await page.evaluate(() => window.__zerosHarnessDesignSurface.active(false));
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface.resources().preparation.running === 0);
  check("hidden canvas retires preparation demand", await page.evaluate(() => window.__zerosHarnessDesignSurface.resources().preparation.demanded === 0));
  } finally { await page.close(); }
}
