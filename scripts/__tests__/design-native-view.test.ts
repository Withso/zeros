import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import path from "node:path";
import { designWheelZoomFactor, zoomDesignViewportAtPoint } from "../../apps/desktop/src/renderer/features/design-workspace/design-canvas-math";

// Node loads the operator script directly; Vite's SSR transform must not rewrite
// the import() expressions that Playwright evaluates inside the browser.
const { prepareNativeDesignView, readNativeDesignView, assertNativeDesignView, nativeDesignWheelDelta,
  startNativeDesignCameraObservation, finishNativeDesignCameraObservation, nativeDesignHiddenResourcesRetired,
  readNativeDesignProvenance } = createRequire(import.meta.url)("../design-native-view.mjs");

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

function hiddenResources() {
  return {
    documents: { active: 0, warm: 0, protected: 0 },
    counters: { documentBuffers: { current: 0 }, sourceDocumentBuffers: { current: 0 } },
    sourceSurfaces: { frames: 0 }, sourceLoads: { active: 0, waiting: 0 },
    captures: { running: 0, queued: 0, cancelling: 0 },
    sourceVectors: { entries: 256, bytes: 1024 * 1024 },
    sourceVectorCache: { entries: 256, leases: 0, requests: 0, warm: 256,
      warmImages: 256, images: 256, warmImageEstimatedBytes: 8 * 1024 * 1024, imageEstimatedBytes: 8 * 1024 * 1024 },
    sourceTiles: { waiting: 0, uploadPending: false, activeScenes: 0, outputPlanes: 0, outputBytes: 0,
      allocatedBytes: 32 * 1024 * 1024, limit: 224 * 1024 * 1024 },
    previewDecodes: { entries: 2, users: 0, pending: 0, warmBytes: 1024 * 1024 },
    images: { leases: 2, decodedBytes: 1024 * 1024, transitions: 0 },
  };
}

it("accepts bounded completed source and preview caches after all hidden display work retires", () => {
  const resources = hiddenResources();
  expect(nativeDesignHiddenResourcesRetired(resources)).toBe(true);
});

it("rejects hidden work, display leases, unknown counters and unbounded warm retention", () => {
  const leaks = [
    ["documents", "active"], ["documents", "warm"], ["documents", "protected"],
    ["sourceSurfaces", "frames"], ["sourceLoads", "active"], ["sourceLoads", "waiting"],
    ["captures", "running"], ["captures", "queued"], ["captures", "cancelling"],
    ["sourceVectorCache", "leases"], ["sourceVectorCache", "requests"],
    ["sourceTiles", "waiting"], ["sourceTiles", "activeScenes"], ["sourceTiles", "outputPlanes"],
    ["sourceTiles", "outputBytes"], ["previewDecodes", "users"], ["previewDecodes", "pending"], ["images", "transitions"],
  ];
  for (const [group, field] of leaks) {
    const resources = hiddenResources() as any;
    resources[group][field] = 1;
    expect(nativeDesignHiddenResourcesRetired(resources), `${group}.${field}`).toBe(false);
  }
  for (const change of [
    { sourceVectors: { entries: 256, bytes: 16 * 1024 * 1024 + 1 } },
    { sourceVectorCache: { ...hiddenResources().sourceVectorCache, entries: 2049 } },
    { sourceVectorCache: { ...hiddenResources().sourceVectorCache, images: 513 } },
    { sourceVectorCache: { ...hiddenResources().sourceVectorCache, imageEstimatedBytes: 32 * 1024 * 1024 + 1 } },
    { sourceVectorCache: { ...hiddenResources().sourceVectorCache, warm: 255 } },
    { sourceTiles: { ...hiddenResources().sourceTiles, uploadPending: true } },
    { sourceTiles: { ...hiddenResources().sourceTiles, allocatedBytes: 224 * 1024 * 1024 + 1 } },
    { previewDecodes: { ...hiddenResources().previewDecodes, warmBytes: 32 * 1024 * 1024 + 1 } },
    { images: { ...hiddenResources().images, leases: 3 } },
    { images: { ...hiddenResources().images, decodedBytes: 2 * 1024 * 1024 } },
    { counters: { ...hiddenResources().counters, documentBuffers: { current: 1 } } },
    { counters: { ...hiddenResources().counters, sourceDocumentBuffers: { current: 1 } } },
    { sourceLoads: undefined }, { sourceVectors: { entries: 0, bytes: NaN } },
  ]) expect(nativeDesignHiddenResourcesRetired({ ...hiddenResources(), ...change }), JSON.stringify(change)).toBe(false);
});

it("qualifies passive native source pixels without opening an editor or changing resource ownership", async () => {
  const bundle = await build({ entryPoints: [path.resolve(import.meta.dirname, "../../apps/desktop/src/renderer/features/design-workspace/design-source-vector.ts")],
    bundle: true, write: false, format: "esm", platform: "browser", logLevel: "silent" });
  const page = await browser.newPage();
  try {
    await page.route("http://native-provenance.test/**", async route => {
      const url = route.request().url();
      const body = url.endsWith("design-source-vector.ts") ? bundle.outputFiles[0].text
        : url.endsWith("design-workspace-cache.ts") ? `export const designWorkspaceSnapshotCache = { peekSnapshot: id => ({data: id === "workspace" ? window.fixture.snapshot : undefined}) };`
        : url.endsWith("fixture.js") ? `
          import {designSourceVectorCache as cache} from "/apps/desktop/src/renderer/features/design-workspace/design-source-vector.ts";
          const target = {workspaceId:"workspace",folder:"/fixture",directoryId:"design_fixture",capability:"a".repeat(64),file:"page/frame.html",sourceVersion:"b".repeat(24),theme:null,width:560,height:360};
          const snapshot = {directoryId:target.directoryId,protocolCapability:target.capability,lint:{workspacePath:target.folder},frames:[{file:target.file,sourceVersion:target.sourceVersion}]};
          const request = cache.open(target), lease = request.publish('<svg xmlns="http://www.w3.org/2000/svg" width="560" height="360"><rect width="560" height="360" fill="red"/></svg>');
          const image = new Image(); image.src=lease.url; await image.decode(); lease.confirm(image);
          image.dataset.designSourceVector=""; image.dataset.designSourceReady=""; image.dataset.designSourceBuffer="displayed"; image.dataset.designSourceVersion=target.sourceVersion;
          document.querySelector("[data-design-frame]").append(image);
          window.fixture={cache,target,snapshot,image,lease,request};
        ` : `<main data-design-retained-workspace="workspace" aria-hidden="false"><div data-design-canvas-viewport><div data-design-canvas-world><div data-design-frame="page/frame.html"></div></div></div></main><script type="module" src="/fixture.js"></script>`;
      await route.fulfill({ contentType: /\.(?:js|ts)$/.test(url) ? "text/javascript" : "text/html", body });
    });
    await page.goto("http://native-provenance.test/");
    await page.waitForFunction(() => Boolean((window as any).fixture));
    const before = await page.evaluate(() => (window as any).fixture.cache.usage());
    const read = () => readNativeDesignProvenance(page, { workspaceId: "workspace", file: "page/frame.html" });
    expect(await read()).toMatchObject({ nativeDocuments: 0, nativeVectors: 1 });
    expect(await page.locator("iframe").count()).toBe(0);
    expect(await page.evaluate(() => (window as any).fixture.cache.usage())).toEqual(before);
    for (const delta of [{ protocolCapability: null }, { protocolCapability: "c".repeat(64) },
      { directoryId: "other" }, { lint: { workspacePath: "/other" } },
      { frames: [{ file: "page/frame.html", sourceVersion: "c".repeat(24) }] }]) {
      const original = await page.evaluate(delta => { const f = (window as any).fixture; const old = f.snapshot; f.snapshot = {...old, ...delta}; return old; }, delta);
      expect((await read()).nativeVectors).toBe(0);
      await page.evaluate(original => { (window as any).fixture.snapshot = original; }, original);
    }
    expect((await readNativeDesignProvenance(page, { workspaceId: "other" })).nativeVectors).toBe(0);
    await page.evaluate(() => { (window as any).fixture.image.style.visibility = "hidden"; });
    expect((await read()).nativeVectors).toBe(0);
    await page.evaluate(() => {
      const { image } = (window as any).fixture; image.style.visibility = "";
      const frame = image.parentElement, world = frame.parentElement, plane = document.createElement("canvas");
      plane.dataset.designSourcePlane = ""; plane.width = 560; plane.height = 360; world.before(plane);
      const anchor = Object.assign(document.createElement("span"), { designSourceImage: image });
      for (const {name,value} of image.attributes) anchor.setAttribute(name,value);
      anchor.dataset.designSourceTiled = ""; frame.dataset.designFrameTiled = ""; image.replaceWith(anchor);
    });
    expect((await read()).nativeVectors).toBe(1);
    await page.locator("canvas").evaluate(node => { node.style.display = "none"; });
    expect((await read()).nativeVectors).toBe(0);
    await page.locator("canvas").evaluate(node => { node.style.display = ""; });
    await page.evaluate(() => (window as any).fixture.cache.forgetWorkspaces(["workspace"]));
    expect((await read()).nativeVectors).toBe(0);
    await page.locator("[data-design-frame]").evaluate(node => { node.innerHTML = '<iframe data-design-document-ready srcdoc="<p>browser fixture</p>"></iframe>'; });
    expect(await read()).toMatchObject({ nativeDocuments: 0, nativeVectors: 0 });
    await page.locator("iframe").evaluate(node => {
      node.removeAttribute("srcdoc"); node.setAttribute("data-design-document-buffer", "displayed");
      node.src = `zeros-design://workspace/workspace/${"a".repeat(64)}/page/frame.html?v=${"b".repeat(24)}`;
    });
    expect((await read()).nativeDocuments).toBe(1);
    await page.locator("iframe").evaluate(node => { node.src = node.src.replace("/workspace/", "/other/"); });
    expect((await read()).nativeDocuments).toBe(0);
    await page.locator("iframe").evaluate(node => { node.src = `zeros-design://workspace/workspace/${"a".repeat(64)}/page/frame.html?v=${"c".repeat(24)}`; });
    expect((await read()).nativeDocuments).toBe(0);
  } finally { await page.close(); }
});

it("counts changed camera transforms, not repeated style writes or unrelated chrome changes", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<main data-design-retained-workspace="workspace" aria-hidden="false"><div data-design-canvas-world style="transform:scale(1)"></div></main>');
    await startNativeDesignCameraObservation(page, "probe");
    await page.locator("[data-design-canvas-world]").evaluate(node => {
      const world = node as HTMLElement;
      world.style.transform = "scale(1)"; world.style.setProperty("--design-canvas-zoom", "1");
      world.style.backgroundColor = "red";
    });
    expect(await finishNativeDesignCameraObservation(page, "probe")).toBe(0);
    await startNativeDesignCameraObservation(page, "moving");
    await page.locator("[data-design-canvas-world]").evaluate(node => {
      const world = node as HTMLElement;
      world.style.transform = "scale(2)"; world.style.setProperty("--design-canvas-zoom", "2");
      world.style.setProperty("--design-canvas-inverse-zoom", ".5");
    });
    expect(await finishNativeDesignCameraObservation(page, "moving")).toBe(1);
  } finally { await page.close(); }
});

it("refuses camera evidence after another retained workspace becomes visible", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<main data-design-retained-workspace="workspace" aria-hidden="false"><div data-design-canvas-world></div></main>');
    await startNativeDesignCameraObservation(page, "probe");
    await page.locator("main").evaluate(node => node.setAttribute("aria-hidden", "true"));
    await expect(finishNativeDesignCameraObservation(page, "probe")).rejects.toThrow(/camera.*changed/i);
  } finally { await page.close(); }
});

it.each([0.05, 0.5, 2])("keeps a %s-to-800-percent zoom workload moving without dwelling at either clamp", startZoom => {
  let camera = { zoom: startZoom, panX: 32, panY: 96 };
  let peak = startZoom;
  for (let step = 0; step < 720; step++) {
    const { deltaY } = nativeDesignWheelDelta({ name: "zoom", step, steps: 720, startZoom });
    const factor = designWheelZoomFactor({ deltaY, deltaMode: 0, ctrlKey: true, metaKey: false, pageHeight: 1000 });
    const next = zoomDesignViewportAtPoint(camera, camera.zoom * factor, { x: 500, y: 300 });
    expect(Math.abs(next.zoom - camera.zoom)).toBeGreaterThan(0.00001);
    expect(next.zoom).toBeGreaterThanOrEqual(startZoom - 0.00001);
    expect(next.zoom).toBeLessThanOrEqual(8);
    camera = next; peak = Math.max(peak, camera.zoom);
  }
  expect(peak).toBeCloseTo(8, 8);
  expect(camera.zoom).toBeCloseTo(startZoom, 8);
});

it.each(["eager", "lazy"])("applies the benchmark view after a cold %s directory publication, without retrying writes", async mode => {
  const page = await browser.newPage();
  const camera = { zoom: 0.5, panX: 64, panY: 96 };
  try {
    await page.route("http://native-fixture.test/**", async route => {
      const url = route.request().url();
      const body = url.endsWith("design-workspace-ui.ts") ? `export const useDesignWorkspaceUiStore = { getState: () => globalThis.fixture };`
        : url.endsWith("design-workspace-cache.ts") ? `export const designWorkspaceSnapshotCache = { peekSnapshot: () => { globalThis.fixture.probes++; return { data: globalThis.fixture.snapshot }; } };`
        : `<main data-design-retained-workspace="workspace" aria-hidden="false"><div data-design-canvas-viewport></div></main><script>
          globalThis.fixture = { byWorkspace: {}, probes: 0, writes: 0,
            setPanels(id, panels) { this.writes++; this.byWorkspace[id] = { ...this.byWorkspace[id], ...panels }; },
            setViewport(id, camera) { this.writes++; this.byWorkspace[id] = { ...this.byWorkspace[id], ...camera }; }
          };
        </script>`;
      await route.fulfill({ contentType: url.endsWith(".ts") ? "text/javascript" : "text/html", body });
    });
    await page.goto("http://native-fixture.test/");
    const prepared = prepareNativeDesignView(page, "workspace", camera, 3_000)
      .then(() => null, (error: Error) => error);
    await expect.poll(() => page.evaluate(() => (globalThis as any).fixture.probes)).toBeGreaterThan(0);
    // The new directory's first publication can replace the remembered view.
    // Hold that publication until the driver has actually observed the cold state.
    await page.evaluate(mode => {
      const fixture = (globalThis as any).fixture;
      fixture.byWorkspace.workspace = { directoryId: "directory", activePageId: "page", zoom: 0.2, panX: 0, panY: 0, layersVisible: true, inspectorVisible: true };
      fixture.snapshot = mode === "lazy"
        ? { directoryId: "directory", frames: [], preparation: { descriptions: [{ file: "frame.html" }] } }
        : { directoryId: "directory", frames: [{ file: "frame.html" }] };
    }, mode);
    expect(await prepared).toBeNull();
    expect(await page.evaluate(() => (globalThis as any).fixture.byWorkspace.workspace))
      .toMatchObject({ ...camera, layersVisible: false, inspectorVisible: false });
    expect(await page.evaluate(() => (globalThis as any).fixture.writes)).toBe(2);
  } finally { await page.close(); }
});

it("rejects an overview camera changed by input before its durable store catches up", async () => {
  const page = await browser.newPage();
  try {
    await page.route("http://native-view.test/**", async route => {
      const module = route.request().url().endsWith("design-workspace-ui.ts");
      await route.fulfill({ contentType: module ? "text/javascript" : "text/html", body: module
        ? `export const useDesignWorkspaceUiStore = { getState: () => ({ byWorkspace: { workspace: { directoryId: "directory", activePageId: "page", zoom: 0.05, panX: 32, panY: 96, layersVisible: false, inspectorVisible: false } } }) };`
        : `<main data-design-retained-workspace="workspace" aria-hidden="false"><div data-design-canvas-viewport style="width:1000px;height:800px"><div data-design-canvas-world style="transform:translate(32px,96px) scale(.05)"></div></div></main>` });
    });
    await page.goto("http://native-view.test/");
    const before = await readNativeDesignView(page);
    const expected = { workspaceId: "workspace", directoryId: "directory", pageId: "page",
      camera: { zoom: 0.05, panX: 32, panY: 96 }, viewport: { width: 1000, height: 800 } };
    expect(() => assertNativeDesignView(before, expected)).not.toThrow();
    // Real gestures paint their transform before publishing their settled
    // camera. Reading the store alone silently accepts this disturbed view.
    await page.locator("[data-design-canvas-world]").evaluate(node => {
      (node as HTMLElement).style.transform = "translate(40px,80px) scale(.08)";
    });
    const changed = await readNativeDesignView(page);
    expect(changed.storedCamera).toEqual(before.storedCamera);
    expect(changed.camera).toEqual({ zoom: 0.08, panX: 40, panY: 80 });
    expect(() => assertNativeDesignView(changed, expected)).toThrow(/camera/i);
    await page.locator("[data-design-canvas-world]").evaluate(node => {
      (node as HTMLElement).style.transform = "translate(32px,96px) scale(.05)";
    });
    await page.locator("[data-design-canvas-viewport]").evaluate(node => {
      (node as HTMLElement).style.width = "1200px";
    });
    const resized = await readNativeDesignView(page);
    expect(() => assertNativeDesignView(resized, expected)).toThrow(/viewport/i);
    await page.locator("[data-design-retained-workspace]").evaluate(node => node.setAttribute("data-design-retained-workspace", "other"));
    const otherOwner = await readNativeDesignView(page);
    expect(() => assertNativeDesignView(otherOwner, expected)).toThrow(/owner/i);
  } finally { await page.close(); }
});
