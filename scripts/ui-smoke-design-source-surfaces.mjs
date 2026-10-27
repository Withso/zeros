import { expect } from "@playwright/test";

// These fixtures have opaque artboards. Verify their displayed pixels rather
// than the passive hit box: GPU-backed overview roots intentionally have no
// DOM area until pointer or keyboard intent admits their controls.
async function frameHasPixels(page, file) {
  const displayed = await page.evaluate(file => {
    const frame = [...document.querySelectorAll('[data-design-frame]')].find(node => node.dataset.designFrame === file);
    if (!frame || !frame.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
    const ready = [...frame.querySelectorAll('[data-design-source-ready], [data-design-document-ready], [data-design-frame-pixels-ready] img')]
      .find(node => { const image = node.designSourceImage ?? node; return node instanceof HTMLIFrameElement || image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0; });
    if (!ready) return false;
    if (!frame.hasAttribute('data-design-frame-tiled')) return ready.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
    if (!ready.hasAttribute('data-design-source-tiled')) return false;
    const world = frame.closest('[data-design-canvas-world]');
    const plane = world?.previousElementSibling;
    if (!(plane instanceof HTMLCanvasElement) || !plane.hasAttribute('data-design-source-plane') ||
      !plane.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
    const camera = new DOMMatrixReadOnly(world.style.transform);
    const x = (Number.parseFloat(frame.style.left) + Number.parseFloat(frame.style.width) / 2) * camera.a + camera.e;
    const y = (Number.parseFloat(frame.style.top) + Number.parseFloat(frame.style.height) / 2) * camera.d + camera.f;
    const width = Number.parseFloat(plane.style.width), height = Number.parseFloat(plane.style.height);
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const bounds = plane.getBoundingClientRect();
    return { x: Math.floor(bounds.x + x), y: Math.floor(bounds.y + y), width: 1, height: 1 };
  }, file);
  if (typeof displayed === 'boolean') return displayed;
  // preserveDrawingBuffer:false lets Chromium retire the WebGL drawing
  // buffer after presentation. Reading that buffer later can return transparent
  // pixels even while the compositor displays the correct image. Sample the
  // displayed white fixture interior, which differs from the dark canvas.
  const png = await page.screenshot({ clip: displayed, scale: 'css' });
  return page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const sample = new OffscreenCanvas(1, 1), context = sample.getContext('2d');
    context.drawImage(image, 0, 0);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return r > 240 && g > 240 && b > 240 && a === 255;
  }, png.toString('base64'));
}

async function runVectorChromeCompositorChecks({ page, check }) {
  const session = await page.context().newCDPSession(page);
  let layers = [];
  session.on("LayerTree.layerTreeDidChange", event => { layers = event.layers ?? []; });
  const previous = await page.evaluate(() => {
    const { zoom, panX, panY } = window.__zerosHarnessDesignSurface.ui.getState().byWorkspace.ws_design_harness;
    return { zoom, panX, panY };
  });
  try {
    await session.send("LayerTree.enable");
    await page.evaluate(async () => {
      // Just above the compact-control threshold, many artboards have visible
      // labels. Their source pixels already share the viewport GPU output.
      window.__zerosHarnessDesignSurface.ui.getState().setViewport("ws_design_harness", { zoom: .09, panX: 32, panY: 96 });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect.poll(() => layers.filter(layer => layer.drawsContent).length).toBeGreaterThan(20);
    const viewport = await page.locator("[data-design-canvas-viewport]").boundingBox();
    const drawArea = layers.filter(layer => layer.drawsContent).reduce((sum, layer) => sum + layer.width * layer.height, 0);
    // This is an allocation-geometry regression, not a RAM/FPS assertion.
    // Without bounded chrome layers the same 256-frame fixture asks Chromium
    // for about 134M backing pixels, mostly empty artboard hit rectangles.
    const areaBudget = viewport.width * viewport.height * 8;
    check("expanded overview controls keep compositor surfaces within eight viewport areas",
      drawArea <= areaBudget, JSON.stringify({ drawArea, areaBudget }));
    const hints = await page.evaluate(() => {
      const hidden = [...document.querySelectorAll("[data-design-frame-chrome-outside] > [data-design-frame-chrome]")];
      return { outside: hidden.length, promoted: hidden.filter(node => getComputedStyle(node).willChange !== "auto").length };
    });
    check("distant overview controls release compositor promotion", hints.outside > 0 && hints.promoted === 0, JSON.stringify(hints));
  } finally {
    await session.detach();
    await page.evaluate(view => window.__zerosHarnessDesignSurface.ui.getState().setViewport("ws_design_harness", view), previous);
  }
}

/** Exercise the real passive iframe and editing handoff. Only the authenticated
 * native resource transport is mapped to HTTP, as in frame-recovery smoke. */
export async function runDesignSourceSurfacesSmoke({ page: parent, check, vectorSurfaces = false }) {
  const origin = new URL(parent.url()).origin;
  const page = await parent.context().browser().newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let documents;
  let sourceNavigations = 0;
  let holdEditing = false;
  let corruptVector = false;
  let releaseEditing;
  const editingGate = new Promise(resolve => { releaseEditing = resolve; });
  let heldSourceVersion = null;
  let releaseSource;
  const sourceGate = new Promise(resolve => { releaseSource = resolve; });
  let releaseInitialSource;
  const initialSourceGate = new Promise(resolve => { releaseInitialSource = resolve; });
  let holdInitialSource = true;
  try {
    await page.route("**/platform/bridge/design-protocol-url.ts*", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("zeros-design://workspace/", `${origin}/__design-surface/`) });
    });
    await page.route("**/platform/runtime.ts*", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("function useNativeRuntime() {", 'function useNativeRuntime() { return { ready: true, expectedElectron: true, status: "ready" };') });
    });
    await page.route("**/__design-surface/**", async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("surface")) sourceNavigations++;
      if (holdInitialSource && url.searchParams.has("surface") && url.pathname.endsWith("/surface-1.html")) await initialSourceGate;
      if (!url.searchParams.has("surface") && holdEditing) await editingGate;
      if (url.searchParams.has("surface") && url.searchParams.get("v") === heldSourceVersion) await sourceGate;
      let source = (url.searchParams.has("surface") ? documents.passive : documents.runtime)
        .replaceAll(documents.version, url.searchParams.get("v"));
      if (corruptVector && url.searchParams.has("surface")) source = source.replace("message.svg=designSurfaceVector()", "message.svg=" + JSON.stringify('<svg xmlns="http://www.w3.org/2000/svg"><invalid'));
      // Hidden native child documents can suspend paint and image.decode
      // completion even after their image resources have fully loaded.
      // Readiness must not wait for the very visibility it is meant to admit.
      await route.fulfill({ status: 200, contentType: "text/html", body: url.searchParams.has("surface")
        ? source.replace("<head>", '<head><script>window.requestAnimationFrame = function(){return 1;};HTMLImageElement.prototype.decode=function(){return new Promise(function(){});};</script>') : source });
    });
    await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures&pictures`, { waitUntil: "networkidle" });
    await expect(page.locator('iframe[data-design-document-ready]').first()).toBeAttached();
    documents = await page.evaluate(async vectorSurfaces => {
      const { documents, documentKey, snapshots } = window.__zerosHarnessDesignSurface;
      const frame = snapshots.peekSnapshot("ws_design_harness").data.frames.find(frame => frame.file === "home.html");
      const document = documents.peekSnapshot(documentKey("ws_design_harness", frame.file, frame.sourceVersion)).data;
      const { designSurfaceReadyScript, DESIGN_SURFACE_STATIC_CSS } = await import("/packages/protocol/src/design-surface.ts");
      const parsed = new DOMParser().parseFromString(document.srcDoc, "text/html");
      for (const node of parsed.querySelectorAll("script,meta[http-equiv]")) node.remove();
      const image = parsed.createElement("img");
      image.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAVUlEQVR4nGMIqn/KQEtMU8NJseA/DkyxBbgMJtoiSg0maBE1DcdqCd0toNRwDEvoagG1DEexZNSCEWbB0M8Hw6MsoktxTZcKh1iLCOol1gKyMc0tAABSihSQfE70tAAAAABJRU5ErkJggg==";
      image.style.cssText = "position:absolute;right:0;bottom:0;width:24px;height:24px";
      image.loading = "lazy";
      parsed.body.append(image);
      const authored = parsed.createElement("style");
      authored.textContent = '@layer authored { [data-oid="home-heading"]{animation:surface-pulse 1s infinite!important} } @keyframes surface-pulse{from{opacity:.2}to{opacity:.8}}';
      parsed.head.prepend(authored);
      parsed.body.style.setProperty("animation", "surface-pulse 1s infinite", "important");
      const style = parsed.createElement("style"); style.textContent = DESIGN_SURFACE_STATIC_CSS; parsed.head.prepend(style);
      const script = parsed.createElement("script"); script.textContent = designSurfaceReadyScript(frame.sourceVersion, null, vectorSurfaces); parsed.head.append(script);
      return { runtime: document.srcDoc, passive: `<!doctype html>${parsed.documentElement.outerHTML}`, version: frame.sourceVersion,
        cost: { nodes: parsed.querySelectorAll("*").length, sourceBytes: new TextEncoder().encode(parsed.documentElement.outerHTML).length, imageBytes: 24 * 24 * 8 } };
    }, vectorSurfaces);
    const opened = Date.now();
    await page.evaluate(async cost => {
      const { stabilizeDesignWorkspaceSnapshot } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      const { snapshots, frames, ui, protocol } = window.__zerosHarnessDesignSurface;
      const workspace = snapshots.peekSnapshot("ws_design_harness").data;
      const template = workspace.frames.find(frame => frame.file === "home.html");
      protocol("e".repeat(64));
      frames(Array.from({ length: 256 }, (_, index) => ({ ...template, file: index === 0 ? "home.html" : `surface-${index}.html`,
        x: index % 16 * 1600, y: Math.floor(index / 16) * 1100, z: index, surfaceCost: undefined })));
      // Restored boot frames have the same source version but no trusted costs.
      // Exercise production sharing when authoritative preparation arrives.
      const restored = snapshots.peekSnapshot("ws_design_harness").data;
      frames(stabilizeDesignWorkspaceSnapshot(restored, {
        ...restored, frames: restored.frames.map(frame => ({ ...frame, surfaceCost: cost })),
      }).frames);
      ui.getState().setPanels("ws_design_harness", { layersVisible: false, inspectorVisible: false });
      ui.getState().setSelectedTargets("ws_design_harness", [], { activeFrame: null });
      ui.getState().setViewport("ws_design_harness", { zoom: 0.04, panX: 32, panY: 96 });
      const { resetDesignLayerDisclosureForTests } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-layer-disclosure.ts");
      resetDesignLayerDisclosureForTests();
    }, documents.cost);
    const sourceReadySelector = vectorSurfaces ? '[data-design-source-vector][data-design-source-ready]' : 'iframe[data-design-source-surface][data-design-source-ready]';
    // Cold admission now includes eight bounded layout slots for either wire
    // version. Allow that queue to drain on shared CI/browser workers.
    await expect(page.locator(sourceReadySelector)).toHaveCount(255, { timeout: 30000 });
    check("cold frames reveal individually after pixels are ready, without empty frame chrome",
      !await frameHasPixels(page, "surface-1.html") && await frameHasPixels(page, "surface-2.html"));
    holdInitialSource = false;
    releaseInitialSource();
    await expect(page.locator(sourceReadySelector)).toHaveCount(256, { timeout: 30000 });
    await expect.poll(() => frameHasPixels(page, "surface-1.html")).toBe(true);
    await expect(page.locator('iframe[data-design-document-buffer]')).toHaveCount(0);
    expect(await page.evaluate(() => (window.__zerosHarnessPreviewRequests ?? []).filter(request => request.frame.startsWith("surface-")).length)).toBe(0);
    check(vectorSurfaces ? "256 restored frames retain decoded vector surfaces without an unused editor" : "256 restored frames adopt live HTML without a native PNG queue or unused editor", true, `${Date.now() - opened} ms browser fixture`);
    if (vectorSurfaces) await runVectorChromeCompositorChecks({ page, check });
    await runOverviewEditorDemandChecks({ page, check, sourceReadySelector });
    if (vectorSurfaces) {
      const drawable = await page.locator(sourceReadySelector).first().evaluate(surface => {
        const image = surface.designSourceImage ?? surface;
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 24;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, 0, 0, 24, 24);
        try { return { readable: context.getImageData(0, 0, 1, 1).data.length === 4 }; }
        catch (error) { return { readable: false, error: error.name }; }
      });
      expect(drawable).toEqual({ readable: true });
      check("ready source vectors are origin-clean inputs for bounded GPU tiles", true);
      await runVectorNavigationChecks({ page, check, sourceNavigations: () => sourceNavigations });
      await runVectorSurfaceChecks({ page, check, corruptVector: (value = true) => { corruptVector = value; },
        holdEditing: value => { holdEditing = value; if (!value) releaseEditing(); } });
      expect(errors).toEqual([]);
      return;
    }

    const passiveHome = await (await page.locator('[data-design-frame="home.html"] iframe[data-design-source-surface]').elementHandle()).contentFrame();
    const overviewDensity = {
      parent: await page.evaluate(() => devicePixelRatio),
      child: await passiveHome.evaluate(() => devicePixelRatio),
    };
    // A tiny overview must not allocate every child at the maximum zoom's
    // backing resolution. Source/node/image counters do not see GPU surfaces.
    expect(overviewDensity.child, "overview documents amplify the backing pixel density").toBeLessThanOrEqual(overviewDensity.parent);
    check("overview HTML keeps ordinary backing density without a maximum-zoom pixel multiplier", true, JSON.stringify(overviewDensity));
    expect(await passiveHome.locator("img").evaluate(image => ({ complete: image.complete, width: image.naturalWidth, decoding: image.decoding, loading: image.loading })))
      .toEqual({ complete: true, width: 24, decoding: "sync", loading: "eager" });
    expect(await passiveHome.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
    check("authored important animation layers cannot keep passive HTML frames running", true);

    const stableSurface = await page.locator('[data-design-frame="surface-1.html"] iframe[data-design-source-surface]').elementHandle();
    const stableDocument = await stableSurface.contentFrame();
    const geometry = [];
    for (const zoom of [1, 1.01, 1.07, 1.2, 1.4142, 1.99, 2.01, 3.5, 4.001, 7.5, 8]) {
      await page.evaluate(async zoom => {
        window.__zerosHarnessDesignSurface.ui.getState().setViewport("ws_design_harness", { zoom, panX: 32 - 1600 * zoom, panY: 96 });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, zoom);
      geometry.push(await stableDocument.evaluate(() => ({
        width: innerWidth, height: innerHeight,
        nodes: [...document.querySelectorAll("[data-oid]")].slice(0,24).map(node => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, font: getComputedStyle(node).fontSize };
        }),
      })));
    }
    expect(geometry[0].nodes.length, "the geometry probe must measure actual authored elements").toBeGreaterThan(2);
    const maxDrift = Math.max(...geometry.flatMap(layout => layout.nodes.flatMap((node, index) =>
      ["x", "y", "width", "height"].map(key => Math.abs(node[key] - geometry[0].nodes[index][key])))));
    check("fractional camera zoom retains document identity and exact HTML layout through 800 percent",
      geometry.every(layout => JSON.stringify(layout) === JSON.stringify(geometry[0])) &&
      await stableSurface.evaluate(node => node.isConnected), `${maxDrift} CSS px maximum layout drift`);
    await page.evaluate(() => window.__zerosHarnessDesignSurface.ui.getState().setViewport("ws_design_harness", { zoom: 0.04, panX: 32, panY: 96 }));

    const continuity = await page.evaluate(async () => {
      const canvas = document.querySelector("[data-design-canvas-viewport]");
      const original = new Map([...document.querySelectorAll("iframe[data-design-source-surface]")].map(node => [node.closest("[data-design-frame]").dataset.designFrame, node]));
      const samples = [];
      for (const step of [{ factor: 2 }, { pan: 600 }, { pan: -600 }, { factor: 0.5 }]) {
        const bounds = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, metaKey: step.factor !== undefined,
          clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
          deltaX: step.pan ?? 0, deltaY: step.factor === undefined ? 0 : -Math.log(step.factor) / 0.002, deltaMode: 0 }));
        for (let index = 0; index < 30; index++) {
          await new Promise(requestAnimationFrame);
          const camera = new DOMMatrixReadOnly(getComputedStyle(document.querySelector("[data-design-canvas-world]")).transform);
          const frames = window.__zerosHarnessDesignSurface.snapshots.peekSnapshot("ws_design_harness").data.frames;
          const visible = frames.filter(frame => frame.x * camera.a + camera.e + frame.width * camera.a > 0 &&
            frame.y * camera.a + camera.f + frame.height * camera.a > 0 && frame.x * camera.a + camera.e < bounds.width && frame.y * camera.a + camera.f < bounds.height);
          const missing = visible.filter(frame => {
            const source = original.get(frame.file);
            const editor = source?.closest("[data-design-frame]")?.querySelector('iframe[data-design-document-buffer="displayed"][data-design-document-ready]');
            return !source?.isConnected || !source.hasAttribute("data-design-source-ready") ||
              (getComputedStyle(source).visibility !== "visible" && !editor);
          });
          samples.push({ visible: visible.length, missing: missing.map(frame => frame.file), documents: original.size });
        }
      }
      return samples;
    });
    expect(continuity.filter(sample => sample.missing.length), "a painted camera frame lost its HTML surface").toEqual([]);
    check("warm pan and zoom keep the same bounded HTML documents visible at every animation frame", true);

    holdEditing = true;
    await page.evaluate(() => {
      const { ui } = window.__zerosHarnessDesignSurface;
      ui.getState().setViewport("ws_design_harness", { zoom: 0.5, panX: -736, panY: 100 });
      ui.getState().setSelectedTargets("ws_design_harness", [{ frame: "surface-1.html" }], { activeFrame: "surface-1.html" });
    });
    const home = page.locator('[data-design-frame="surface-1.html"]');
    const source = home.locator('iframe[data-design-source-surface][data-design-source-ready]');
    await expect(source).toHaveCount(1);
    const child = await (await source.elementHandle()).contentFrame();
    const before = await child.evaluate(() => ({ height: innerHeight, width: innerWidth, font: getComputedStyle(document.querySelector('[data-oid="home-heading"]')).fontSize }));
    const handle = home.locator('[data-design-resize-edge="s"]').first();
    await expect(handle).toBeVisible();
    const point = await handle.boundingBox();
    await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
    await page.mouse.down();
    for (const distance of [30, 60, 90, 120]) {
      await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2 + distance);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const layout = await child.evaluate(() => ({ height: innerHeight, width: innerWidth, font: getComputedStyle(document.querySelector('[data-oid="home-heading"]')).fontSize }));
      const size = await home.evaluate(node => ({ width: node.offsetWidth, height: node.offsetHeight }));
      expect(Math.abs(layout.height - size.height)).toBeLessThanOrEqual(1);
      expect(layout.height).toBeGreaterThan(before.height);
      expect(layout.width).toBe(before.width);
      expect(layout.font).toBe(before.font);
      await expect(home.locator('img[data-design-frame-transition-cover]')).toHaveCount(0);
    }
    await page.keyboard.press("Escape"); await page.mouse.up();
    releaseEditing();
    await expect(home.locator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]')).toHaveCount(1);
    check("frame resizing reflows HTML while editing readiness is held, without a stretched image", true);

    await page.evaluate(() => window.__zerosHarnessDesignSurface.ui.getState().setViewport("ws_design_harness", { zoom: 8, panX: -13100, panY: -200 }));
    const zoomed = await child.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, font: getComputedStyle(document.querySelector('[data-oid="home-heading"]')).fontSize }));
    expect(zoomed.width).toBe(before.width);
    expect(zoomed.height).toBe(before.height);
    expect(zoomed.font).toBe(before.font);
    expect(zoomed.dpr).toBe(overviewDensity.parent);
    await expect(page.locator('[data-design-high-resolution-tile]')).toHaveCount(0);
    check("close zoom preserves HTML viewport, text size and ordinary display density", true);
    const oldDirectoryDocument = await source.elementHandle();
    await page.evaluate(() => window.__zerosHarnessDesignSurface.directory("design_replacement", "Replacement - Design"));
    await expect.poll(() => oldDirectoryDocument.evaluate(node => node.isConnected)).toBe(false);
    await expect(home.locator('iframe[data-design-source-surface][data-design-source-ready]')).toHaveCount(1);
    check("a different Design directory replaces same-named same-generation passive documents", true);
    await page.evaluate(() => window.__zerosHarnessDesignSurface.active(false));
    await expect(page.locator('[data-design-source-surface]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__zerosHarnessDesignSurface.resources().sourceSurfaces.frames)).toBe(0);
    expect(errors).toEqual([]);
    check("hiding the workspace releases all passive documents and source reservations", true);

    // A cached PNG must not cover responsive HTML while a newer document is
    // loading. Exercise the actual surface with both generations accounted.
    await page.evaluate(async () => {
      const controls = window.__zerosHarnessDesignSurface;
      const snapshot = controls.snapshots.peekSnapshot("ws_design_harness").data;
      const frame = snapshot.frames.find(frame => frame.file === "home.html");
      const owner = { scope: "local", workspaceId: "ws_design_harness", directoryId: snapshot.directoryId };
      const target = { owner, file: frame.file, sourceVersion: frame.sourceVersion, theme: null, level: "overview" };
      const token = {};
      controls.previews.setDemand(token, { owner, theme: null, items: [{ file: frame.file, sourceVersion: frame.sourceVersion, level: "overview", live: false }] });
      const { React, createRoot } = window.__zerosDesignHarnessRuntime;
      const { DesignFrameRenderSurface } = await import("/apps/desktop/src/renderer/features/design-workspace/design-frame-render-surface.tsx");
      const container = document.createElement("div");
      container.dataset.designSourceSwap = "";
      Object.assign(container.style, { position: "fixed", left: "0", top: "0", width: `${frame.width}px`, height: `${frame.height}px` });
      document.body.append(container);
      const root = createRoot(container);
      const show = (sourceVersion, surfaceCost) => root.render(React.createElement(DesignFrameRenderSurface, {
        workspaceId: "ws_design_harness", folder: snapshot.lint.workspacePath, designDirectory: snapshot.directory,
        protocolCapability: snapshot.protocolCapability, frame: { ...frame, sourceVersion, surfaceCost },
        active: true, selected: false, selectedNodeIds: [], live: false, theme: null,
        highResolutionTile: null, highResolutionDisabled: true, previewOwner: owner,
        sourceSurface: true, sourceVisible: true,
      }));
      window.__zerosSourceSwap = { show, frame, target, stop: () => { controls.previews.setDemand(token, null); root.unmount(); container.remove(); } };
      show(frame.sourceVersion, frame.surfaceCost);
    });
    const swap = page.locator("[data-design-source-swap]");
    await expect(swap.locator('iframe[data-design-source-ready]')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => Boolean(window.__zerosHarnessDesignSurface.previews.picture(window.__zerosSourceSwap.target)))).toBe(true);
    heldSourceVersion = "f".repeat(24);
    const replacementCost = { nodes: documents.cost.nodes + 10, sourceBytes: documents.cost.sourceBytes + 512, imageBytes: 1024 };
    await page.evaluate(({ version, cost }) => window.__zerosSourceSwap.show(version, cost), { version: heldSourceVersion, cost: replacementCost });
    await expect(swap.locator('iframe[data-design-source-buffer="incoming"]')).toHaveCount(1);
    await expect(swap.locator('iframe[data-design-source-buffer="displayed"][data-design-source-ready]')).toBeVisible();
    // Native protocol navigation can wait behind other frames. Its transport
    // time must not consume the loaded document's five-second ready deadline.
    await page.waitForTimeout(5_600);
    // Let the already-encoded fallback picture's display decoder settle too.
    await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    await expect(swap.locator("img")).toHaveCount(0);
    expect(await page.evaluate(() => window.__zerosHarnessDesignSurface.resources().sourceSurfaces)).toEqual({
      frames: 2, nodes: documents.cost.nodes + replacementCost.nodes,
      sourceBytes: documents.cost.sourceBytes + replacementCost.sourceBytes, imageBytes: documents.cost.imageBytes + replacementCost.imageBytes,
    });
    releaseSource();
    await expect(swap.locator(`iframe[data-design-source-buffer="displayed"][data-design-source-ready][data-design-source-version="${heldSourceVersion}"]`)).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.__zerosHarnessDesignSurface.resources().sourceSurfaces)).toEqual({ frames: 1, ...replacementCost });
    await page.evaluate(() => window.__zerosSourceSwap.stop());
    await expect.poll(() => page.evaluate(() => window.__zerosHarnessDesignSurface.resources().sourceSurfaces.frames)).toBe(0);
    expect(errors).toEqual([]);
    check("source replacement keeps responsive HTML above cached pictures and charges both documents until the swap", true);
  } finally {
    releaseInitialSource();
    releaseEditing();
    releaseSource();
    await page.close();
  }
  await runDesignSourceAlphaSmoke({ page: parent, check });
}

/** Compare real compositor pixels through passive -> editor -> passive. A
 * transparent iframe background and a single painted document both matter. */
export async function runDesignSourceAlphaSmoke({ page: parent, check }) {
  const origin = new URL(parent.url()).origin;
  const page = await parent.context().browser().newPage({ viewport: { width: 1440, height: 900 } });
  let documents;
  try {
    await page.route("**/platform/bridge/design-protocol-url.ts*", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("zeros-design://workspace/", `${origin}/__design-alpha/`) });
    });
    await page.route("**/platform/runtime.ts*", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("function useNativeRuntime() {", 'function useNativeRuntime() { return { ready: true, expectedElectron: true, status: "ready" };') });
    });
    await page.route("**/__design-alpha/**", route => route.fulfill({ status: 200, contentType: "text/html",
      body: new URL(route.request().url()).searchParams.has("surface") ? documents.passive : documents.runtime }));
    await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures`, { waitUntil: "networkidle" });
    documents = await page.evaluate(async () => {
      const controls = window.__zerosHarnessDesignSurface;
      controls.active(false);
      const snapshot = controls.snapshots.peekSnapshot("ws_design_harness").data;
      const frame = { ...snapshot.frames[0], kind: "text", width: 160, height: 120, surfaceCost: { nodes: 6, sourceBytes: 1000, imageBytes: 0 } };
      const { DESIGN_RUNTIME_SOURCE } = await import("/packages/protocol/src/design-runtime.ts");
      const { designSurfaceReadyScript } = await import("/packages/protocol/src/design-surface.ts");
      const html = '<!doctype html><html><head><style>html,body{margin:0;background:transparent}div{width:40px;height:40px;background:rgba(255,0,0,.5)}</style></head><body><div data-oid="alpha-box"></div></body></html>';
      const inject = script => html.replace("</body>", `<script>${script}</script></body>`);
      const { React, createRoot } = window.__zerosDesignHarnessRuntime;
      const { DesignFrameRenderSurface } = await import("/apps/desktop/src/renderer/features/design-workspace/design-frame-render-surface.tsx");
      const container = document.createElement("div"); container.dataset.designAlphaProof = "";
      Object.assign(container.style, { position: "fixed", zIndex: "100000", left: "0", top: "0", width: "160px", height: "120px", background: "rgb(0,255,0)" });
      document.body.append(container);
      const root = createRoot(container);
      window.__zerosAlphaProof = {
        show: live => root.render(React.createElement(DesignFrameRenderSurface, {
          workspaceId: "alpha-proof", folder: snapshot.lint.workspacePath, frame, protocolCapability: "a".repeat(64),
          active: true, selected: false, selectedNodeIds: [], live, theme: null,
          highResolutionTile: null, highResolutionDisabled: true, sourceSurface: true,
        })),
        stop: () => { root.unmount(); container.remove(); },
      };
      return { passive: inject(designSurfaceReadyScript(frame.sourceVersion, null)),
        runtime: inject(`window.__zerosDesignSourceVersion=${JSON.stringify(frame.sourceVersion)};${DESIGN_RUNTIME_SOURCE}`) };
    });
    const root = page.locator("[data-design-alpha-proof]");
    const pixel = async () => {
      const png = await page.screenshot({ clip: { x: 0, y: 0, width: 64, height: 64 }, scale: "css" });
      return page.evaluate(async base64 => {
        const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64;
        const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
        return Array.from(context.getImageData(8, 8, 1, 1).data);
      }, png.toString("base64"));
    };
    await page.evaluate(() => window.__zerosAlphaProof.show(false));
    await expect(root.locator('iframe[data-design-source-ready]')).toHaveCount(1);
    const passive = await pixel();
    expect(passive).toEqual([128, 127, 0, 255]);
    await page.evaluate(() => window.__zerosAlphaProof.show(true));
    await expect(root.locator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]')).toHaveCount(1);
    await expect(root.locator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]')).toBeVisible();
    expect(await pixel(), "editor activation must neither flatten alpha nor paint the source twice").toEqual(passive);
    await page.evaluate(() => window.__zerosAlphaProof.show(false));
    await expect(root.locator('iframe[data-design-document-buffer]')).toHaveCount(0);
    expect(await pixel()).toEqual(passive);
    await page.evaluate(() => window.__zerosAlphaProof.stop());
    check("transparent source pixels stay identical through editor activation and retirement", true);
  } finally { await page.close(); }
}


/** Same production component and protocol-ready payload; legacy surface mode
 * above remains a separate compatibility workload. */
export async function runDesignVectorSurfacesSmoke(context) {
  await runDesignSourceSurfacesSmoke({ ...context, vectorSurfaces: true });
  await runDesignVectorRetirementSmoke(context);
}

async function runOverviewEditorDemandChecks({ page, check, sourceReadySelector }) {
  const editors = page.locator('iframe[data-design-document-buffer]');
  const sources = await page.locator(sourceReadySelector).elementHandles();
  const panels = async value => page.evaluate(value => {
    window.__zerosHarnessDesignSurface.ui.getState().setPanels("ws_design_harness", value);
  }, value);
  await panels({ inspectorVisible: true });
  await expect(editors).toHaveCount(1);
  await panels({ inspectorVisible: false });
  await expect(editors).toHaveCount(0);
  await page.evaluate(async () => {
    const { useDesignLayerDisclosureStore } = await import('/apps/desktop/src/renderer/features/design-workspace/state/design-layer-disclosure.ts');
    useDesignLayerDisclosureStore.getState().updateFrame('ws_design_harness', 'surface-1.html', current => ({ ...current, treeExpanded: true }));
  });
  await expect(editors).toHaveCount(0);
  await panels({ layersVisible: true });
  await expect(page.locator('[data-design-frame="surface-1.html"] iframe[data-design-document-buffer]')).toHaveCount(1);
  await panels({ layersVisible: false });
  await expect(editors).toHaveCount(0);
  await page.evaluate(() => window.__zerosHarnessDesignSurface.ui.getState().setViewport('ws_design_harness', { zoom: .4, panX: 32, panY: 96 }));
  await page.locator('[data-design-frame="home.html"]').click({ position: { x: 130, y: 80 } });
  await expect(page.locator('[data-design-frame="home.html"] iframe[data-design-document-ready]')).toHaveCount(1);
  await page.evaluate(() => {
    const { ui } = window.__zerosHarnessDesignSurface;
    ui.getState().setSelectedTargets('ws_design_harness', [], { activeFrame: 'home.html' });
    ui.getState().setViewport('ws_design_harness', { zoom: .04, panX: 32, panY: 96 });
  });
  await expect(editors).toHaveCount(0);
  expect(await Promise.all(sources.map(source => source.evaluate(surface => { const node = surface.designSourceImage ?? surface; return (node.isConnected || node.designSourceAnchor?.isConnected) && node.hasAttribute('data-design-source-ready'); })))).toEqual(Array(256).fill(true));
  if (sourceReadySelector.startsWith('[data-design-source-vector]')) {
    await expect.poll(() => page.locator('[data-design-source-plane]').count()).toBe(1);
    expect(await page.locator('[data-design-source-tiled]').count()).toBeGreaterThan(1);
  }
  check('overview retires unused editors and hidden layer demand while panel opening and a real canvas selection still admit them', true);
}

async function runVectorNavigationChecks({ page, check, sourceNavigations }) {
  const revalidation = await page.evaluate(async () => {
    const { snapshots } = window.__zerosHarnessDesignSurface;
    const snapshot = snapshots.peekSnapshot('ws_design_harness').data;
    const original = [...document.querySelectorAll('[data-design-source-vector]')].map(node => node.designSourceImage ?? node);
    snapshots.setData('ws_design_harness', { ...snapshot, preparation: { revision: 'c'.repeat(64), epoch: 100,
      current: [], errors: {}, descriptions: snapshot.frames.map(({ file, frameId, pageId, title, kind, x, y, width, height, z }) =>
        ({ file, frameId, pageId, title, kind, x, y, width, height, z, preparation: 'unprepared' })) } });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const retained = original.filter(node => (node.isConnected || node.designSourceAnchor?.isConnected) && node.complete && node.naturalWidth > 0).length;
    const live = document.querySelectorAll('iframe[data-design-document-buffer]').length;
    snapshots.setData('ws_design_harness', snapshot);
    return { retained, live };
  });
  check('background revalidation preserves all confirmed vector nodes while fencing live editors', revalidation.retained === 256 && revalidation.live === 0, JSON.stringify(revalidation));
  const selector = '[data-design-source-vector][data-design-source-ready]';
  await expect(page.locator(selector)).toHaveCount(256, { timeout: 30000 });
  const urls = await page.locator(selector).evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.closest('[data-design-frame]').dataset.designFrame, (node.designSourceImage ?? node).src])));
  await page.clock.install();
  const cameraBeforeHide = await page.locator('[data-design-canvas-world]').evaluate(node => node.style.transform);
  // Browser coverage models the OS visibility event while leaving the tab
  // selected. Native qualification separately hides the actual BrowserWindow.
  const documentVisibility = async hidden => page.evaluate(hidden => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await documentVisibility(true);
  await expect.poll(() => page.evaluate(() => window.__zerosHarnessDesignSurface.resources().sourceVectorCache.leases)).toBe(0);
  await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute('inert', '');
  await page.clock.fastForward(11_000);
  const hiddenResources = await page.evaluate(() => window.__zerosHarnessDesignSurface.resources());
  expect(hiddenResources.sourceLoads).toEqual({ active: 0, waiting: 0 });
  expect(hiddenResources.documents).toEqual({ active: 0, warm: 0, protected: 0 });
  expect(hiddenResources.sourceVectorCache.warmImages).toBeGreaterThanOrEqual(256);
  check('hiding the app suspends its selected Design tab and retains completed frames without display leases', true);
  const beforeShow = sourceNavigations();
  await documentVisibility(false);
  const shown = await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    return [...document.querySelectorAll('[data-design-source-vector][data-design-source-ready]')]
      .filter(surface => { const node = surface.designSourceImage ?? surface; return node.complete && node.naturalWidth > 0; }).length;
  });
  expect(shown).toBe(256);
  expect(await page.locator('[data-design-canvas-world]').evaluate(node => node.style.transform)).toBe(cameraBeforeHide);
  expect(sourceNavigations() - beforeShow).toBeLessThanOrEqual(1);
  check('showing the app paints its cached overview on the first frame with the same camera', true);
  await page.evaluate(() => window.__zerosHarnessDesignSurface.active(false));
  await documentVisibility(true);
  await documentVisibility(false);
  await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute('inert', '');
  expect(await page.evaluate(() => window.__zerosHarnessDesignSurface.resources().sourceVectorCache.leases)).toBe(0);
  check('showing the app cannot activate a retained inactive Design tab', true);
  await page.evaluate(() => window.__zerosHarnessDesignSurface.active(false));
  await expect(page.locator('[data-design-source-surface]')).toHaveCount(0);
  const before = sourceNavigations();
  const firstPaint = await page.evaluate(async () => {
    window.__zerosDesignHarnessRuntime.flushSync(() => window.__zerosHarnessDesignSurface.active(true));
    await new Promise(requestAnimationFrame);
    const images = [...document.querySelectorAll('[data-design-source-vector][data-design-source-ready]')];
    return { mounted: images.length, complete: images.filter(surface => { const node = surface.designSourceImage ?? surface; return node.complete && node.naturalWidth > 0; }).length };
  });
  await expect(page.locator(selector)).toHaveCount(256, { timeout: 30000 });
  const returned = await page.locator(selector).evaluateAll((nodes, urls) => nodes.filter(node => (node.designSourceImage ?? node).src === urls[node.closest('[data-design-frame]').dataset.designFrame]).length, urls);
  check('returning to Design paints every completed frame from cache without rebuilding the overview', firstPaint.complete === 256 && returned === 256 && sourceNavigations() - before <= 1,
    JSON.stringify({ firstPaint, retainedUrls: returned, sourceLoads: sourceNavigations() - before }));
  await page.evaluate(() => window.__zerosDesignHarnessRuntime.flushSync(() => window.__zerosHarnessDesignSurface.active(false)));
  await page.evaluate(async () => (await import('/apps/desktop/src/renderer/features/design-workspace/design-source-vector.ts')).designSourceVectorCache.clearWarmImages());
  const afterPressure = sourceNavigations();
  await page.evaluate(() => window.__zerosHarnessDesignSurface.active(true));
  await expect(page.locator(selector)).toHaveCount(256, { timeout: 30000 });
  check('warm image eviction reuses encoded vectors without another HTML layout pass', sourceNavigations() - afterPressure <= 1);
}

async function runVectorSurfaceChecks({ page, check, corruptVector, holdEditing }) {
  await page.evaluate(() => window.__zerosHarnessDesignSurface.ui.getState().setSelectedTargets('ws_design_harness', [{ frame: 'home.html' }], { activeFrame: 'home.html' }));
  const resources = () => page.evaluate(async () => (await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts")).designRendererResources());
  await expect.poll(async () => (await resources()).sourceLoads).toEqual({ active: 0, waiting: 0 });
  const ready = await resources();
  expect(ready.sourceVectors.entries).toBe(256);
  expect(ready.sourceVectors.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(ready.counters.sourceDocumentBuffers.current).toBeLessThanOrEqual(1);
  expect(ready.counters.sourceDocumentBuffers.peak).toBeLessThanOrEqual(9);
  check("vector handoff retires temporary HTML with at most eight concurrent source loads and one retained editor underlay", true);

  const retained = await page.evaluate(async () => {
    const nodes = [...document.querySelectorAll('[data-design-source-vector]')];
    const originals = nodes.map(surface => { const node = surface.designSourceImage ?? surface; return { node, url: node.src }; });
    const problems = [];
    for (const zoom of [.04, .5, 1, 1.01, 1.4142, 2.01, 4.001, 7.5, 8, .04]) {
      window.__zerosHarnessDesignSurface.ui.getState().setViewport("ws_design_harness", { zoom, panX: 32, panY: 96 });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (const {node,url} of originals) if (!(node.isConnected || node.designSourceAnchor?.isConnected) || node.src !== url || !node.complete || !node.naturalWidth) problems.push(zoom);
    }
    return { count: originals.length, problems };
  });
  expect(retained).toEqual({ count: 256, problems: [] });
  check("fractional zoom through 800% and return retain the same decoded vector objects without reloading", true);

  const home = page.locator('[data-design-frame="home.html"] [data-design-frame-render-surface]');
  await page.evaluate(() => window.__zerosHarnessDesignSurface.ui.getState().setViewport("ws_design_harness", { zoom: 1, panX: 32, panY: 96 }));
  const html = home.locator('iframe[data-design-source-surface]');
  await expect(html).toHaveAttribute('data-design-source-ready', '');
  const vector = home.locator('[data-design-source-vector]');
  const markup = await vector.evaluate(async surface => fetch((surface.designSourceImage ?? surface).src).then(response => response.text()));
  expect(markup).toContain('<foreignObject');
  expect(markup).not.toContain('<script');
  expect(markup).not.toContain('zeros-design-surface-ready');
  // Compare the same clipped compositor surface with each buffer displayed
  // alone. A DOM/source comparison cannot establish canvas-background fidelity.
  await home.locator('iframe[data-design-document-buffer]').evaluateAll(nodes => nodes.forEach(node => node.style.setProperty('visibility', 'hidden', 'important')));
  await html.evaluate(node => node.style.setProperty('visibility', 'visible', 'important'));
  await vector.evaluate(node => node.style.setProperty('visibility', 'hidden', 'important'));
  const htmlPixels = await home.screenshot();
  await html.evaluate(node => node.style.setProperty('visibility', 'hidden', 'important'));
  await vector.evaluate(node => node.style.setProperty('visibility', 'visible', 'important'));
  const vectorPixels = await home.screenshot();
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  const require = createRequire(import.meta.url);
  const testRequire = createRequire(require.resolve('@playwright/test/package.json'));
  const pwRequire = createRequire(testRequire.resolve('playwright/package.json'));
  const core = path.dirname(pwRequire.resolve('playwright-core/package.json'));
  const { PNG } = require(path.join(core, 'lib/utilsBundle.js'));
  const a = PNG.sync.read(htmlPixels), b = PNG.sync.read(vectorPixels);
  expect([a.width,a.height]).toEqual([b.width,b.height]);
  let different = 0;
  for (let index = 0; index < a.data.length; index += 4) if ([0,1,2,3].some(channel => Math.abs(a.data[index+channel] - b.data[index+channel]) > 2)) different++;
  expect(different / (a.width*a.height), 'vector handoff changes the composed HTML pixels').toBeLessThan(.005);
  check("the decoded vector preserves HTML compositor pixels, including canvas background", true, `${different} differing pixels`);
  await html.evaluate(node => node.style.removeProperty('visibility'));
  await vector.evaluate(node => node.style.removeProperty('visibility'));
  await home.locator('iframe[data-design-document-buffer]').evaluateAll(nodes => nodes.forEach(node => node.style.removeProperty('visibility')));

  await page.evaluate(() => window.__zerosHarnessDesignSurface.ui.getState().setViewport("ws_design_harness", { zoom: 0.5, panX: -736, panY: 96 }));
  const passive = page.locator('[data-design-frame="surface-1.html"]');
  await expect(passive.locator('iframe')).toHaveCount(0);
  const bounds = await passive.boundingBox();
  const clip = { x: bounds.x + 24, y: bounds.y + 24, width: 200, height: 160 };
  const beforeResize = PNG.sync.read(await page.screenshot({ clip, scale: "css" }));
  const previousWidth = await passive.evaluate(node => {
    const previous = node.style.width;
    node.style.width = `${node.offsetWidth + 200}px`;
    return previous;
  });
  const duringResize = PNG.sync.read(await page.screenshot({ clip, scale: "css" }));
  expect(duringResize.data.equals(beforeResize.data), "pending HTML must not squeeze the retained vector when its frame is resized").toBe(true);
  await passive.evaluate((node, previous) => { node.style.width = previous; }, previousWidth);
  check("a retained vector keeps its authored geometry while the frame's responsive HTML is unavailable", true);

  await page.evaluate(() => {
    const { frames, snapshots } = window.__zerosHarnessDesignSurface;
    const snapshot = snapshots.peekSnapshot('ws_design_harness').data;
    frames(snapshot.frames.map(frame => ({ ...frame, sourceVersion: 'b'.repeat(24) })));
  });
  await expect(page.locator('[data-design-source-vector][data-design-source-version="bbbbbbbbbbbbbbbbbbbbbbbb"][data-design-source-ready]')).toHaveCount(256, { timeout: 30000 });
  await expect.poll(async () => (await resources()).sourceVectors.entries).toBe(256);
  check("source replacement keeps vector ownership bounded and retires every old generation", true);
  await runVectorReplacementFailureChecks({ page, check, corruptVector, holdEditing });
  await page.evaluate(() => window.__zerosHarnessDesignSurface.active(false));
  await expect.poll(async () => (await resources()).sourceLoads).toEqual({ active: 0, waiting: 0 });
  await expect.poll(async () => (await resources()).sourceVectorCache).toMatchObject({ entries: 256, leases: 0, requests: 0, warm: 256 });
  expect((await resources()).sourceVectorCache.warmImages).toBeLessThanOrEqual(512);
  expect((await resources()).sourceVectorCache.warmImageEstimatedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect((await resources()).sourceVectors.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  await expect(page.locator('[data-design-source-surface]')).toHaveCount(0);
  check("hidden workspaces retain bounded encoded vectors with no display leases, source documents or queued layout work", true);

  corruptVector();
  await page.evaluate(() => {
    const { frames, snapshots, active } = window.__zerosHarnessDesignSurface;
    const snapshot = snapshots.peekSnapshot("ws_design_harness").data;
    frames(snapshot.frames.slice(0, 2).map(frame => ({ ...frame, sourceVersion: "c".repeat(24) })));
    active(true);
  });
  await expect(page.locator('[data-design-frame="surface-1.html"]')).toBeVisible();
  await expect.poll(async () => (await resources()).sourceVectorCache.leases, { timeout: 10000 }).toBe(0);
  expect((await resources()).sourceVectorCache.entries).toBeLessThanOrEqual(2);
  await expect(page.locator('iframe[data-design-source-surface]')).toHaveCount(0);
  await expect(page.locator('[data-design-source-vector]')).toHaveCount(0);
  await expect.poll(async () => (await resources()).sourceLoads).toEqual({ active: 0, waiting: 0 });
  check("a failed vector decode uses the bounded preview path and releases its temporary HTML", true);
  await page.evaluate(() => window.__zerosHarnessDesignSurface.active(false));
}

async function runVectorReplacementFailureChecks({ page, check, corruptVector, holdEditing }) {
  const frame = page.locator('[data-design-frame="surface-1.html"]');
  const original = await frame.locator('[data-design-source-vector][data-design-source-ready]').elementHandle();
  corruptVector(true); holdEditing(true);
  await page.evaluate(async () => {
    const { getActiveBridge } = await import('/apps/desktop/src/renderer/platform/bridge/active-bridge.ts');
    const bridge = getActiveBridge(), request = bridge.request;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    window.__heldVectorFallbacks = 0;
    bridge.request = async function(message, ...args) {
      if (message.op === 'design.preview' && message.params?.frame === 'surface-1.html' && message.params?.sourceVersion === 'd'.repeat(24)) {
        window.__heldVectorFallbacks++;
        await barrier;
      }
      return request.call(this, message, ...args);
    };
    window.__releaseVectorFallback = () => { bridge.request = request; release(); };
    const { frames, snapshots } = window.__zerosHarnessDesignSurface;
    frames(snapshots.peekSnapshot('ws_design_harness').data.frames.map(frame => frame.file === 'surface-1.html'
      ? { ...frame, sourceVersion: 'd'.repeat(24) } : frame));
  });
  try {
    // Observe the failed generation's fallback request before checking paint;
    // neither a fast preview nor a newly mounted editor may conceal the gap.
    await expect.poll(() => page.evaluate(() => window.__heldVectorFallbacks)).toBeGreaterThan(0);
    expect(await original.evaluate(surface => { const node = surface.designSourceImage ?? surface; return (node.isConnected || node.designSourceAnchor?.isConnected) && node.complete && node.naturalWidth > 0; }) && await frameHasPixels(page, 'surface-1.html'),
      'a failed replacement must keep the last confirmed vector painted until its fallback is decoded').toBe(true);
    await page.evaluate(() => window.__releaseVectorFallback());
    await expect(frame.locator('[data-design-frame-pixels-ready] img[data-design-frame-picture="current"]')).toHaveCount(1);
    await expect(frame.locator('[data-design-source-vector]')).toHaveCount(0);
    check('a failed replacement preserves confirmed pixels until its exact-generation fallback is decoded', true);
  } finally {
    await page.evaluate(() => window.__releaseVectorFallback());
    corruptVector(false); holdEditing(false);
  }
  await page.evaluate(() => {
    const { frames, snapshots } = window.__zerosHarnessDesignSurface;
    frames(snapshots.peekSnapshot('ws_design_harness').data.frames.map(frame => ({ ...frame, sourceVersion: 'b'.repeat(24) })));
  });
  await expect(page.locator('[data-design-source-vector][data-design-source-ready]')).toHaveCount(256, { timeout: 30000 });
}

/** An owner may retire in the same event that a child publishes readiness,
 * before React commits the new image. The allocation must still be released. */
export async function runDesignVectorRetirementSmoke({ page: parent, check }) {
  const origin = new URL(parent.url()).origin;
  const page = await parent.context().browser().newPage({ viewport: { width: 800, height: 600 } });
  let documentSource;
  try {
    await page.route("**/platform/bridge/design-protocol-url.ts*", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("zeros-design://workspace/", `${origin}/__vector-retirement/`) });
    });
    await page.route("**/__vector-retirement/**", route => route.fulfill({ status: 200, contentType: "text/html", body: documentSource }));
    await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures`, { waitUntil: "networkidle" });
    documentSource = await page.evaluate(async () => {
      window.__zerosHarnessDesignSurface.active(false);
      const { designSurfaceReadyScript } = await import("/packages/protocol/src/design-surface.ts");
      return `<html><head><style>body{margin:0;background:#fff}</style></head><body>Owner retirement<script>${designSurfaceReadyScript("a".repeat(24), null, true)}</script></body></html>`;
    });
    await page.evaluate(async () => {
      const { React, createRoot } = window.__zerosDesignHarnessRuntime;
      const { DesignFrameSourceSurface } = await import("/apps/desktop/src/renderer/features/design-workspace/design-frame-source-surface.tsx");
      const container = document.createElement("div");
      Object.assign(container.style, { position: "fixed", left: "0", top: "0", width: "320px", height: "240px" });
      document.body.append(container);
      const root = createRoot(container);
      root.render(React.createElement(DesignFrameSourceSurface, {
        workspaceId: "vector-retirement", capability: "b".repeat(64), file: "frame.html", title: "Retirement",
        folder: "/fixture/vector-retirement", directoryId: "design-retirement", width: 320, height: 240,
        sourceVersion: "a".repeat(24), theme: null, cost: { sourceBytes: 1024, nodes: 4, imageBytes: 0 }, visible: true, retainHtml: false,
        onReady: () => { root.unmount(); container.remove(); window.__vectorOwnerRetired = true; },
        onUnavailable: () => { window.__vectorOwnerUnavailable = true; }, onRetired: () => {},
      }));
    });
    await expect.poll(() => page.evaluate(() => window.__vectorOwnerRetired)).toBe(true);
    const resources = await page.evaluate(async () => (await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts")).designRendererResources());
    expect(resources.sourceVectors).toEqual({ entries: 0, bytes: 0 });
    expect(resources.sourceSurfaces.frames).toBe(0);
    expect(resources.sourceLoads).toEqual({ active: 0, waiting: 0 });
    check("retiring an owner in the readiness event releases an allocated vector before its image can commit", true);
  } finally { await page.close(); }
}
