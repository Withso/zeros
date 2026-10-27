// Control the camera only after the destination has published its directory.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { waitForNativeRenderer } from "./design-native-renderer.mjs";

/** Hidden displays retire work and leases, while completed source and decoded
 * previews may remain in their bounded warm pools. Missing readings fail. */
export function nativeDesignHiddenResourcesRetired(resources) {
  const { documents, counters, captures, sourceSurfaces, sourceLoads, sourceVectors,
    sourceVectorCache, sourceTiles, previewDecodes, images } = resources ?? {};
  const bounded = (value, limit) => Number.isSafeInteger(value) && value >= 0 && value <= limit;
  return [documents?.active, documents?.warm, documents?.protected,
    counters?.documentBuffers?.current, counters?.sourceDocumentBuffers?.current,
    captures?.running, captures?.queued, captures?.cancelling, sourceSurfaces?.frames,
    sourceLoads?.active, sourceLoads?.waiting, sourceVectorCache?.leases, sourceVectorCache?.requests,
    sourceTiles?.waiting, sourceTiles?.activeScenes, sourceTiles?.outputPlanes, sourceTiles?.outputBytes,
    previewDecodes?.users, previewDecodes?.pending, images?.transitions].every(value => value === 0) &&
    sourceTiles?.uploadPending === false && bounded(sourceTiles?.allocatedBytes, 224 * 1024 * 1024) &&
    bounded(sourceVectors?.entries, 2048) && bounded(sourceVectors?.bytes, 16 * 1024 * 1024) &&
    sourceVectorCache?.entries === sourceVectors.entries && sourceVectorCache.warm === sourceVectorCache.entries &&
    bounded(sourceVectorCache.images, 512) && sourceVectorCache.warmImages === sourceVectorCache.images &&
    bounded(sourceVectorCache.imageEstimatedBytes, 32 * 1024 * 1024) &&
    sourceVectorCache.warmImageEstimatedBytes === sourceVectorCache.imageEstimatedBytes &&
    bounded(previewDecodes?.entries, Number.MAX_SAFE_INTEGER) && bounded(previewDecodes.warmBytes, 32 * 1024 * 1024) &&
    images.leases === previewDecodes.entries && images.decodedBytes === previewDecodes.warmBytes;
}

/** Confirm the active owner's authenticated source without opening an editor,
 * fetching a document or mutating cache ownership. Return counts, never the
 * capability, authored source or workspace path. */
export async function readNativeDesignProvenance(page, expected = {}) {
  return page.evaluate(async expected => {
    const result = { nativeDocuments: 0, nativeVectors: 0, devicePixelRatio: globalThis.devicePixelRatio };
    const owners = document.querySelectorAll('[data-design-retained-workspace][aria-hidden="false"]');
    if (owners.length !== 1) return result;
    const owner = owners[0], workspaceId = owner.getAttribute("data-design-retained-workspace");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId) || expected.workspaceId && workspaceId !== expected.workspaceId) return result;
    const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const snapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    if (!/^[a-f0-9]{64}$/.test(snapshot?.protocolCapability ?? "")) return result;
    const sources = new Map(snapshot.frames.map(frame => [frame.file, frame.sourceVersion]));
    const visible = node => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    let vectors;
    for (const frame of owner.querySelectorAll("[data-design-frame]")) {
      const file = frame.getAttribute("data-design-frame"), sourceVersion = sources.get(file);
      if (expected.file && file !== expected.file || !/^[a-f0-9]{24}$/.test(sourceVersion ?? "") ||
          snapshot.preparation && !snapshot.preparation.current.includes(file)) continue;
      const nativeUrl = `zeros-design://workspace/${encodeURIComponent(workspaceId)}/${snapshot.protocolCapability}/${file.split("/").map(encodeURIComponent).join("/")}`;
      for (const surface of frame.querySelectorAll('iframe[data-design-document-buffer="displayed"][data-design-document-ready],iframe[data-design-source-buffer="displayed"][data-design-source-ready]')) {
        const url = new URL(surface.src, document.baseURI);
        if (visible(surface) && !surface.hasAttribute("srcdoc") &&
            url.href.split("?")[0] === nativeUrl && url.searchParams.get("v") === sourceVersion) result.nativeDocuments++;
      }
      for (const surface of frame.querySelectorAll('[data-design-source-vector][data-design-source-buffer="displayed"][data-design-source-ready]')) {
        const image = surface instanceof HTMLImageElement ? surface : surface.designSourceImage;
        if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth <= 0 ||
            surface.getAttribute("data-design-source-version") !== sourceVersion) continue;
        if (surface.hasAttribute("data-design-source-tiled")) {
          const world = frame.parentElement, plane = world?.previousElementSibling;
          if (!world?.hasAttribute("data-design-canvas-world") || !frame.hasAttribute("data-design-frame-tiled") ||
              !plane?.matches("canvas[data-design-source-plane]") || plane.width <= 0 || plane.height <= 0 || !visible(plane)) continue;
        } else if (!visible(image)) continue;
        vectors ??= (await import("/apps/desktop/src/renderer/features/design-workspace/design-source-vector.ts")).designSourceVectorCache;
        if (vectors.hasDisplayedImage({ workspaceId, folder: snapshot.lint.workspacePath, directoryId: snapshot.directoryId,
          capability: snapshot.protocolCapability, file, sourceVersion }, image)) result.nativeVectors++;
      }
    }
    if (document.querySelector('[data-design-retained-workspace][aria-hidden="false"]') !== owner ||
        designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data !== snapshot)
      return { ...result, nativeDocuments: 0, nativeVectors: 0 };
    return result;
  }, expected);
}

/** Four equal legs: overview → 800% → overview, twice. A fixed large delta
 * dwells at a clamp, turning stationary time into alleged dropped frames. */
export function nativeDesignWheelDelta({ name, step, steps = 720, startZoom }) {
  assert(["pan", "zoom"].includes(name) && Number.isSafeInteger(steps) && steps > 0 && steps % 4 === 0);
  assert(Number.isSafeInteger(step) && step >= 0 && step < steps);
  const direction = Math.floor(step / (steps / 4)) % 2 ? -1 : 1;
  if (name === "pan") return { deltaX: direction, deltaY: direction, modifiers: 0 };
  assert(Number.isFinite(startZoom) && startZoom > 0 && startZoom < 8);
  // Chromium's pinch wheel encoding is deltaY = -100 * ln(scale).
  return { deltaX: 0, deltaY: -direction * 100 * Math.log(8 / startZoom) / (steps / 4), modifiers: 2 };
}

/** Native input acknowledgements can wait for a renderer frame. Serially
 * awaiting each one manufactures idle gaps in the workload. Keep a bounded
 * stream in flight, preserving the requested pacing even after backpressure;
 * never dump overdue input in a catch-up burst or abandon outstanding sends. */
export async function dispatchNativeDesignGesture(cdp, {
  name, startZoom, x, y, steps = 720, rateHz = 120, maxPending = 8,
}, { now = () => performance.now(), pause = delay } = {}) {
  assert(Number.isFinite(rateHz) && rateHz > 0 && rateHz <= 240);
  assert(Number.isSafeInteger(maxPending) && maxPending > 0 && maxPending <= 8);
  assert(Number.isFinite(x) && Number.isFinite(y));
  // Validate the trajectory before submitting any native work.
  nativeDesignWheelDelta({ name, step: 0, steps, startZoom });
  const started = now(), interval = 1000 / rateHz, pending = new Set();
  let nextAt = started, error, dispatched = 0, peak = 0, backpressure = 0;
  try {
    for (let step = 0; step < steps; step++) {
      await pause(Math.max(0, nextAt - now()));
      if (pending.size >= maxPending) { backpressure++; await Promise.race(pending); }
      if (error) throw error;
      nextAt = now() + interval;
      let request;
      request = Promise.resolve(cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, ...nativeDesignWheelDelta({ name, step, steps, startZoom }),
      })).catch(failure => { error ??= failure; }).finally(() => pending.delete(request));
      pending.add(request); dispatched++; peak = Math.max(peak, pending.size);
    }
  } catch (failure) { error ??= failure; }
  await Promise.all(pending);
  if (error) throw error;
  return { dispatched, rateHz, maxPending: peak, backpressure, durationMs: now() - started };
}

export async function startNativeDesignCameraObservation(page, prefix) {
  await page.evaluate(prefix => {
    const world = document.querySelector('[data-design-retained-workspace][aria-hidden="false"] [data-design-canvas-world]');
    if (!world || globalThis.__designBenchmark) throw new Error("Native camera observation is unavailable or already owned.");
    const observation = { world, changes: 0, transform: world.style.transform };
    observation.record = () => {
      const transform = world.style.transform;
      if (transform !== observation.transform) { observation.transform = transform; observation.changes++; }
    };
    observation.observer = new MutationObserver(observation.record);
    observation.observer.observe(world, { attributes: true, attributeFilter: ["style"] });
    globalThis.__designBenchmark = observation;
    performance.mark(prefix + ":start");
  }, prefix);
}

export async function finishNativeDesignCameraObservation(page, prefix) {
  return page.evaluate(prefix => {
    const observation = globalThis.__designBenchmark;
    if (!observation) throw new Error("Native camera observation is missing.");
    observation.record(); observation.observer.disconnect(); delete globalThis.__designBenchmark;
    if (document.querySelector('[data-design-retained-workspace][aria-hidden="false"] [data-design-canvas-world]') !== observation.world)
      throw new Error("The observed native camera owner changed.");
    performance.mark(prefix + ":end");
    return observation.changes;
  }, prefix);
}

/** Inspect the active owner's confirmed pixels, independently of readiness
 * flags on retained but hidden documents. */
export async function readNativeDesignCoverage(page) {
  return page.evaluate(() => {
    const owner = document.querySelector('[data-design-retained-workspace][aria-hidden="false"]');
    const frames = [...(owner?.querySelectorAll('[data-design-frame]') ?? [])];
    return { id: owner?.dataset.designRetainedWorkspace, frames: frames.length,
      covered: frames.filter(frame => {
        const visibility = { checkOpacity: true, checkVisibilityCSS: true };
        if ([...frame.querySelectorAll('img[data-design-source-ready], [data-design-frame-pixels-ready] img, iframe[data-design-document-ready], iframe[data-design-source-ready]')]
          .some(surface => surface.checkVisibility(visibility) &&
            (surface.tagName === "IFRAME" || (surface.complete && surface.naturalWidth > 0)))) return true;
        // A tiled image deliberately has no DOM paint. Admission marks it
        // only after its pixels transfer to this world's visible output; a
        // missing plane or another retained owner's plane is not coverage.
        const world = frame.parentElement, plane = world?.previousElementSibling;
        return world?.hasAttribute("data-design-canvas-world") && frame.hasAttribute("data-design-frame-tiled") &&
          plane?.matches("canvas[data-design-source-plane]") && plane.width > 0 && plane.height > 0 &&
          plane.checkVisibility(visibility) && [...frame.querySelectorAll('[data-design-source-tiled][data-design-source-ready]')]
            .some(surface => {
              const image = surface instanceof HTMLImageElement ? surface : surface.designSourceImage;
              return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
            });
      }).length };
  });
}

/** Read the painted transform as well as durable state: an in-progress gesture
 * can change pixels before the store publishes its settled camera. */
export async function readNativeDesignView(page) {
  return page.evaluate(async () => {
    const owner = document.querySelector('[data-design-retained-workspace][aria-hidden="false"]');
    const viewport = owner?.querySelector("[data-design-canvas-viewport]");
    const world = owner?.querySelector("[data-design-canvas-world]");
    if (!viewport || !world) return null;
    const workspaceId = owner.getAttribute("data-design-retained-workspace");
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const view = useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId];
    const transform = new DOMMatrixReadOnly(getComputedStyle(world).transform);
    const bounds = viewport.getBoundingClientRect();
    return { workspaceId, directoryId: view?.directoryId, pageId: view?.activePageId,
      camera: { zoom: transform.a, panX: transform.e, panY: transform.f },
      storedCamera: view ? { zoom: view.zoom, panX: view.panX, panY: view.panY } : null,
      panels: { layersVisible: view?.layersVisible, inspectorVisible: view?.inspectorVisible },
      viewport: { width: bounds.width, height: bounds.height } };
  });
}

export function assertNativeDesignView(observed, expected) {
  assert(observed, "The qualified Design view disappeared.");
  for (const field of ["workspaceId", "directoryId", "pageId"]) {
    if (expected[field] !== undefined)
      assert.equal(observed[field], expected[field], "The qualified Design owner changed.");
  }
  for (const camera of [observed.camera, observed.storedCamera]) {
    for (const field of ["zoom", "panX", "panY"])
      assert(camera && Math.abs(camera[field] - expected.camera[field]) < 0.00001,
        `The qualified Design camera changed (${field}).`);
  }
  for (const field of ["width", "height"])
    assert(Math.abs(observed.viewport[field] - expected.viewport[field]) < 1, "The qualified Design viewport changed.");
  assert(!observed.panels.layersVisible && !observed.panels.inspectorVisible, "The qualified Design panels changed.");
}

export async function prepareNativeDesignView(page, workspaceId, camera, timeout = 30_000) {
  await waitForNativeRenderer(page, async workspaceId => {
    const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const snapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const view = useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId];
    const described = snapshot?.preparation?.descriptions.length ?? snapshot?.frames.length;
    return Boolean(described && snapshot.directoryId === view?.directoryId && view?.activePageId);
  }, workspaceId, timeout);
  // Cold directory/page publication can replace an earlier remembered camera.
  // Set the benchmark's view once, after publication; retries only read state.
  await page.evaluate(async ({ workspaceId, camera }) => {
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const store = useDesignWorkspaceUiStore.getState();
    store.setPanels(workspaceId, { layersVisible: false, inspectorVisible: false });
    store.setViewport(workspaceId, camera);
  }, { workspaceId, camera });
}

/** Passive documents deliberately have no editing/capture connection. An
 * explicit capture selects its frame before asking the editor for pixels. */
export async function selectNativeDesignFrame(page, workspaceId, file) {
  const selected = await page.evaluate(async ({ workspaceId, file }) => {
    const owner = document.querySelector(`[data-design-retained-workspace="${workspaceId}"][aria-hidden="false"]`);
    const frame = file ?? owner?.querySelector("[data-design-frame]")?.getAttribute("data-design-frame");
    if (!frame) throw new Error("The native capture fixture has no frame.");
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    useDesignWorkspaceUiStore.getState().setSelectedTargets(workspaceId, [{ frame }], { activeFrame: frame });
    return frame;
  }, { workspaceId, file });
  await page.locator(`[data-design-retained-workspace="${workspaceId}"][aria-hidden="false"] [data-design-frame=${JSON.stringify(selected)}] iframe[data-design-document-buffer="displayed"][data-design-document-ready]`).waitFor();
  return selected;
}
