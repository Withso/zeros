import { expect } from "@playwright/test";

async function openCanvasFixture(page, query = "layoutGestures") {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?${query}`,
    { waitUntil: "networkidle" },
  );
  await page.evaluate(async () => {
    const { useDesignWorkspaceUiStore } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    useDesignWorkspaceUiStore.getState().setViewport("ws_design_harness", {
      zoom: 0.5,
      panX: 100,
      panY: 120,
    });
  });
  await expect(
    page.locator(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    ),
  ).toHaveCount(1);
}

const canvasWrites = (page) =>
  page.evaluate(() => (window.__zerosHarnessCanvasUpdates ?? []).length);

const styleWrites = (page) =>
  page.evaluate(
    () =>
      (window.__zerosHarnessDesignShortcutOperations ?? []).filter(
        (operation) => operation === "style:end",
      ).length,
  );

const transactionWrites = (page) =>
  page.evaluate(
    () =>
      (window.__zerosHarnessWorkbenchOperations ?? []).filter(
        (operation) => operation === "design.transaction.apply",
      ).length,
  );

const frameGeometry = (frame) =>
  frame.evaluate((element) => ({
    x: Number.parseFloat(element.style.left),
    y: Number.parseFloat(element.style.top),
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  }));

async function foreignPointer(page, type, point) {
  await page.evaluate(
    ({ type, point }) => {
      window.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 42,
          pointerType: "touch",
          isPrimary: false,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: point.x,
          clientY: point.y,
          bubbles: true,
        }),
      );
    },
    { type, point },
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

export async function runDesignFramePointerOwnershipSmoke({ page, check }) {
  await openCanvasFixture(page);
  const frame = page.locator('[data-design-frame="home.html"]');
  const label = frame.locator("[data-design-frame-label]");
  const labelBounds = await label.boundingBox();
  const start = {
    x: labelBounds.x + labelBounds.width / 2,
    y: labelBounds.y + labelBounds.height / 2,
  };
  const baseline = await frameGeometry(frame);
  const writesBefore = await canvasWrites(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await foreignPointer(page, "pointermove", {
    x: start.x + 90,
    y: start.y + 45,
  });
  expect(await frameGeometry(frame)).toEqual(baseline);
  await page.mouse.move(start.x + 40, start.y + 20);
  await expect
    .poll(() => frameGeometry(frame))
    .toMatchObject({
      x: baseline.x + 80,
      y: baseline.y + 40,
    });
  await foreignPointer(page, "pointerup", { x: start.x + 40, y: start.y + 20 });
  await page.mouse.move(start.x + 60, start.y + 30);
  await expect
    .poll(() => frameGeometry(frame))
    .toMatchObject({
      x: baseline.x + 120,
      y: baseline.y + 60,
    });
  await label.dispatchEvent("lostpointercapture", { pointerId: 1 });
  await expect.poll(() => frameGeometry(frame)).toEqual(baseline);
  await page.mouse.up();
  await page.waitForTimeout(750);
  expect(await canvasWrites(page)).toBe(writesBefore);
  check(
    "frame dragging owns one pointer and lost capture restores its geometry without saving",
    true,
  );
}

export async function runDesignNodeResizeCaptureSmoke({ page, check }) {
  await openCanvasFixture(page);
  await page.locator('[data-design-layer-id="home-hero"]').click();
  const overlay = page.locator('[data-design-element-overlay="home-hero"]');
  const handle = overlay.locator('[data-design-resize-edge="e"]');
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const hero = runtime.locator('[data-oid="home-hero"]');
  const size = () =>
    hero.evaluate((element) => getComputedStyle(element).width);
  const baseline = await size();
  const writesBefore = await styleWrites(page);
  const bounds = await handle.boundingBox();
  const start = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y);
  await expect.poll(size).toBe("680px");
  await handle.evaluate((element) => element.releasePointerCapture(1));
  // Chromium processes a pending capture change on the next pointer event.
  await page.mouse.move(start.x + 41, start.y);
  await expect.poll(size).toBe(baseline);
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect(await styleWrites(page)).toBe(writesBefore);
  check(
    "node resizing cancels on lost pointer capture and preserves authored dimensions",
    true,
  );
}

export async function runDesignGroupResizePointerOwnershipSmoke({
  page,
  check,
}) {
  await openCanvasFixture(page, "autoLayout");
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await page
    .locator('[data-design-layer-id="home-copy"]')
    .click({ modifiers: ["Shift"] });
  const group = page.locator("[data-design-multi-selection]");
  await expect(group).toHaveCount(1);
  const handle = group.locator('[data-design-resize-edge="e"]');
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const widths = () =>
    runtime
      .locator('[data-oid="home-heading"], [data-oid="home-copy"]')
      .evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).width),
      );
  const baseline = await widths();
  const writesBefore = await transactionWrites(page);
  const bounds = await handle.boundingBox();
  const start = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await foreignPointer(page, "pointermove", { x: start.x + 50, y: start.y });
  expect(await widths()).toEqual(baseline);
  await foreignPointer(page, "pointercancel", start);
  await page.mouse.move(start.x + 40, start.y);
  await expect.poll(widths).not.toEqual(baseline);
  await handle.evaluate((element) => element.releasePointerCapture(1));
  await page.mouse.move(start.x + 41, start.y);
  await expect.poll(widths).toEqual(baseline);
  await page.mouse.up();
  expect(await transactionWrites(page)).toBe(writesBefore);
  await expect(
    page.locator('[data-design-layer-id][aria-selected="true"]'),
  ).toHaveCount(2);
  check(
    "group resizing ignores other pointers and lost capture restores every selected layer",
    true,
  );
}

export async function runDesignLayoutDragPointerOwnershipSmoke({
  page,
  check,
}) {
  await openCanvasFixture(page);
  await page.locator('[data-design-layer-id="home-heading"]').click();
  const overlay = page.locator('[data-design-element-overlay="home-heading"]');
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const heading = runtime.locator('[data-oid="home-heading"]');
  const state = () =>
    heading.evaluate((element) => ({
      parent: element.parentElement.getAttribute("data-oid"),
      left: getComputedStyle(element).left,
      top: getComputedStyle(element).top,
      position: getComputedStyle(element).position,
    }));
  const baseline = await state();
  const writesBefore = await transactionWrites(page);
  const bounds = await overlay.boundingBox();
  const start = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // A different pointer release must not end this still-held mouse drag.
  await foreignPointer(page, "pointerup", start);
  await page.mouse.move(start.x + 70, start.y + 150, { steps: 5 });
  await expect.poll(state).not.toEqual(baseline);
  await overlay.evaluate((element) => element.releasePointerCapture(1));
  await page.mouse.move(start.x + 71, start.y + 150);
  await expect.poll(state).toEqual(baseline);
  await page.mouse.up();
  expect(await transactionWrites(page)).toBe(writesBefore);
  check(
    "layout dragging retains its pointer through foreign releases and lost capture restores parent and styles",
    true,
  );
}

export async function runDesignGestureReleasePositionSmoke({ page, check }) {
  await openCanvasFixture(page);
  await page.locator('[data-design-layer-id="home-hero"]').click();
  const handle = page.locator(
    '[data-design-element-overlay="home-hero"] [data-design-resize-edge="e"]',
  );
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const hero = runtime.locator('[data-oid="home-hero"]');
  const bounds = await handle.boundingBox();
  const start = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const writesBefore = await styleWrites(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Model Chromium coalescing the last travel into the native release event.
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: start.x + 40,
    y: start.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await session.detach();
  await expect
    .poll(() => hero.evaluate((element) => getComputedStyle(element).width))
    .toBe("680px");
  await expect.poll(() => styleWrites(page)).toBe(writesBefore + 1);
  check(
    "node resizing applies the native release position and saves it exactly once",
    true,
  );
}

export async function runDesignCompletedCanvasGesturesSmoke({ page, check }) {
  await openCanvasFixture(page);
  const frame = page.locator('[data-design-frame="home.html"]');
  const label = frame.locator("[data-design-frame-label]");
  const labelBounds = await label.boundingBox();
  const start = {
    x: labelBounds.x + labelBounds.width / 2,
    y: labelBounds.y + labelBounds.height / 2,
  };
  const baseline = await frameGeometry(frame);
  const frameWritesBefore = await canvasWrites(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 50, start.y + 25, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() => frameGeometry(frame))
    .toMatchObject({ x: baseline.x + 100, y: baseline.y + 50 });
  await expect.poll(() => canvasWrites(page)).toBe(frameWritesBefore + 1);

  await page.locator('[data-design-layer-id="home-hero"]').click();
  const handle = page.locator(
    '[data-design-element-overlay="home-hero"] [data-design-resize-edge="e"]',
  );
  const bounds = await handle.boundingBox();
  const handleStart = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const nodeWritesBefore = await styleWrites(page);
  await page.mouse.move(handleStart.x, handleStart.y);
  await page.mouse.down();
  await page.mouse.move(handleStart.x + 30, handleStart.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => styleWrites(page)).toBe(nodeWritesBefore + 1);
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  await expect
    .poll(() =>
      runtime
        .locator('[data-oid="home-hero"]')
        .evaluate((element) => getComputedStyle(element).width),
    )
    .toBe("660px");
  check(
    "completed frame movement and node resizing each save their final geometry once",
    true,
  );
}

export async function runDesignNoopCanvasResizeSmoke({ page, check }) {
  await openCanvasFixture(page, "");
  await page.locator('[data-design-layer-id="home-heading"]').click();
  const width = page.getByRole("textbox", { name: "W", exact: true });
  await expect(width).toHaveValue("Fill");
  const handle = page.locator(
    '[data-design-element-overlay="home-heading"] [data-design-resize-edge="e"]',
  );
  const bounds = await handle.boundingBox();
  const start = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const writesBefore = await styleWrites(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 30, start.y, { steps: 4 });
  await expect(width).not.toHaveValue("Fill");
  await page.mouse.move(start.x, start.y, { steps: 4 });
  await page.mouse.up();
  await expect(width).toHaveValue("Fill");
  await page.waitForTimeout(150);
  expect(await styleWrites(page)).toBe(writesBefore);
  check(
    "resizing out and back preserves Fill sizing and writes no source change",
    true,
  );
}

export async function runDesignNoopFrameGestureSmoke({ page, check }) {
  await openCanvasFixture(page);
  const frame = page.locator('[data-design-frame="home.html"]');
  const label = frame.locator("[data-design-frame-label]");
  const bounds = await label.boundingBox();
  const start = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const baseline = await frameGeometry(frame);
  const writesBefore = await canvasWrites(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + 20, { steps: 4 });
  await expect.poll(() => frameGeometry(frame)).not.toEqual(baseline);
  await page.mouse.move(start.x, start.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => frameGeometry(frame)).toEqual(baseline);
  await page.waitForTimeout(750);
  expect(await canvasWrites(page)).toBe(writesBefore);
  check(
    "a frame drag that returns to its starting geometry writes nothing",
    true,
  );
}

export async function runDesignNoopGroupResizeSmoke({ page, check }) {
  await openCanvasFixture(page, "autoLayout");
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await page
    .locator('[data-design-layer-id="home-copy"]')
    .click({ modifiers: ["Shift"] });
  const group = page.locator("[data-design-multi-selection]");
  const handle = group.locator('[data-design-resize-edge="e"]');
  const baseline = await group.boundingBox();
  const bounds = await handle.boundingBox();
  const start = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const writesBefore = await transactionWrites(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y, { steps: 4 });
  await expect
    .poll(async () => (await group.boundingBox()).width)
    .not.toBe(baseline.width);
  await page.mouse.move(start.x, start.y, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => (await group.boundingBox()).width)
    .toBe(baseline.width);
  expect(await transactionWrites(page)).toBe(writesBefore);
  check(
    "a group resize returning to its original geometry creates no transaction",
    true,
  );
}

export async function runDesignFrameDirectoryReplacementSmoke({ page, check }) {
  await openCanvasFixture(page);
  const frame = page.locator('[data-design-frame="home.html"]');
  const label = frame.locator("[data-design-frame-label]");
  const bounds = await label.boundingBox();
  const start = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const writesBefore = await canvasWrites(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + 20);
  await expect.poll(() => frameGeometry(frame)).toMatchObject({ x: 80, y: 40 });
  const replacement = { x: 420, y: 180, width: 1280, height: 800 };
  await page.evaluate(async (geometry) => {
    const {
      designWorkspaceSnapshotCache,
      observeDesignDirectory,
      primeDesignWorkspaceSnapshot,
    } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const current =
      designWorkspaceSnapshotCache.peekSnapshot("ws_design_harness").data;
    const next = {
      ...current,
      directoryId: "design_replacement",
      frames: current.frames.map((frame) =>
        frame.file === "home.html" ? { ...frame, ...geometry } : frame,
      ),
    };
    observeDesignDirectory("ws_design_harness", next);
    primeDesignWorkspaceSnapshot("ws_design_harness", next);
  }, replacement);
  await page.mouse.move(start.x + 60, start.y + 30);
  await expect.poll(() => frameGeometry(frame)).toMatchObject(replacement);
  await page.mouse.up();
  await page.waitForTimeout(750);
  expect(await canvasWrites(page)).toBe(writesBefore);
  expect(await frameGeometry(frame)).toMatchObject(replacement);
  check(
    "directory replacement retires a held frame drag and preserves the replacement frame's geometry",
    true,
  );
}

export async function runDesignPanDirectoryReplacementSmoke({ page, check }) {
  await openCanvasFixture(page);
  const label = page.locator(
    '[data-design-frame="home.html"] [data-design-frame-label]',
  );
  const bounds = await label.boundingBox();
  const start = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const camera = () =>
    page.locator("[data-design-canvas-world]").evaluate((element) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return { zoom: matrix.a, panX: matrix.e, panY: matrix.f };
    });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(start.x + 40, start.y + 20);
  await expect.poll(camera).toEqual({ zoom: 0.5, panX: 140, panY: 140 });
  const replacement = { zoom: 0.3, panX: 180, panY: 140 };
  await page.evaluate(async (viewport) => {
    const {
      designWorkspaceSnapshotCache,
      observeDesignDirectory,
      primeDesignWorkspaceSnapshot,
    } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const { useDesignWorkspaceUiStore } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const current =
      designWorkspaceSnapshotCache.peekSnapshot("ws_design_harness").data;
    const next = { ...current, directoryId: "design_pan_replacement" };
    observeDesignDirectory("ws_design_harness", next);
    primeDesignWorkspaceSnapshot("ws_design_harness", next);
    useDesignWorkspaceUiStore
      .getState()
      .setViewport("ws_design_harness", viewport);
  }, replacement);
  await expect.poll(camera).toEqual(replacement);
  await page.mouse.move(start.x + 60, start.y + 30);
  await page.mouse.up({ button: "middle" });
  await expect.poll(camera).toEqual(replacement);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { designWorkspaceView } =
          await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
        const { directoryId, zoom, panX, panY } =
          designWorkspaceView("ws_design_harness");
        return { directoryId, zoom, panX, panY };
      }),
    )
    .toEqual({ directoryId: "design_pan_replacement", ...replacement });
  expect(await page.evaluate(() => document.body.style.cursor)).toBe("");
  check(
    "directory replacement cancels hand panning without restoring the previous directory or camera",
    true,
  );
}

export async function runDesignLayoutAffineCameraSmoke({ page, check }) {
  await openCanvasFixture(page);
  await page.evaluate(async () => {
    const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
    const { updateDesignNodeStylesCached } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const runtime = designFrameRuntime("ws_design_harness", "home.html");
    await updateDesignNodeStylesCached("ws_design_harness", {
      frame: "home.html", sourceVersion: runtime.sourceVersion, nodeId: "home-heading",
      styles: { position: "absolute", left: "100px", top: "50px", margin: "5px 7px 9px 20px" },
    });
  });
  await page.locator('[data-design-layer-id="home-heading"]').click();
  const overlay = page.locator('[data-design-element-overlay="home-heading"]');
  await expect(overlay).toHaveCount(1);
  const runtime = page.frameLocator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]');
  const child = runtime.locator('[data-oid="home-heading"]');
  const parent = runtime.locator('[data-oid="home-hero"]');
  const local = (locator) => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const original = await local(child);
  const parentOriginal = await local(parent);
  const screen = await child.boundingBox();
  const start = { x: screen.x + screen.width / 2, y: screen.y + screen.height / 2 };
  const writes = await transactionWrites(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + 20, { steps: 5 });
  await expect.poll(() => local(child)).toMatchObject({ x: original.x + 80, y: original.y + 40 });
  await page.evaluate(async () => {
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    useDesignWorkspaceUiStore.getState().setViewport("ws_design_harness", { zoom: 0.5, panX: 50, panY: 120 });
  });
  await page.mouse.move(start.x + 41, start.y + 20);
  await expect.poll(async () => {
    const current = await child.boundingBox();
    return Math.hypot(current.x - screen.x - 41, current.y - screen.y - 20);
  }).toBeLessThan(0.5);
  expect(await local(parent)).toEqual(parentOriginal);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(() => local(child)).toEqual(original);
  expect(await transactionWrites(page)).toBe(writes);
  check("structural movement preserves margins and the world grab anchor across a live camera pan; cancellation restores source", true);
}

export async function runDesignWorldNudgeSmoke({ page, check }) {
  await openCanvasFixture(page);
  const frame = page.locator('[data-design-frame="home.html"]');
  const label = frame.locator("[data-design-frame-label]");
  const confirmedX = () => page.evaluate(async () => {
    const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    return designWorkspaceSnapshotCache.peekSnapshot("ws_design_harness").data.frames.find((frame) => frame.file === "home.html").x;
  });
  await label.click();
  const initialX = await confirmedX();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(confirmedX).toBe(initialX + 8);
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("ArrowRight");
  await page.keyboard.up("ArrowRight");
  await expect.poll(confirmedX).toBe(initialX + 11);
  await page.evaluate(async () => {
    const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
    const { updateDesignNodeStylesCached } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    for (const [nodeId, styles] of [
      ["home-hero", { left: "500px", transform: "rotate(90deg) scale(2)", "transform-origin": "0 0" }],
      ["home-heading", { position: "absolute", left: "100px", top: "50px", margin: "0" }],
    ]) {
      await updateDesignNodeStylesCached("ws_design_harness", { frame: "home.html", sourceVersion: designFrameRuntime("ws_design_harness", "home.html").sourceVersion, nodeId, styles });
    }
  });
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await page.locator('[data-design-element-overlay="home-heading"]').click();
  const child = page.frameLocator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]').locator('[data-oid="home-heading"]');
  const rect = () => child.evaluate((element) => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y }; });
  const before = await rect();
  const writes = await transactionWrites(page);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => Math.abs((await rect()).x - before.x - 8)).toBeLessThan(0.01);
  await expect.poll(() => transactionWrites(page)).toBe(writes + 1);
  expect(Math.abs((await rect()).y - before.y)).toBeLessThan(0.01);
  const committed = await rect();
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => Math.abs((await rect()).x - committed.x - 1)).toBeLessThan(0.01);
  await page.keyboard.press("Escape");
  await page.keyboard.up("ArrowRight");
  await expect.poll(rect).toEqual(committed);
  expect(await transactionWrites(page)).toBe(writes + 1);
  check("scene and transformed-node arrows move one/eight world pixels; held-key cancellation restores the preview without writing", true);
}

export async function runDesignFreeRelocationSmoke({ page, check }) {
  await openCanvasFixture(page, "layoutGestures&freeRelocation");
  await page.locator('[data-design-layer-id="home-hero"]').click();
  const originalFrame = page.locator('[data-design-frame="home.html"]');
  const live = originalFrame.frameLocator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]');
  const original = await live.locator('[data-oid="home-hero"]').boundingBox();
  const bounds = await originalFrame.boundingBox();
  const start = { x: original.x + original.width / 2, y: original.y + original.height / 2 };
  const end = { x: start.x + 30, y: bounds.y + bounds.height + 70 };
  const overlay = page.locator('[data-design-element-overlay="home-hero"]');
  expect(await overlay.boundingBox()).toMatchObject({ width: expect.closeTo(original.width, 1), height: expect.closeTo(original.height, 1) });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  const detached = page.locator('[data-design-frame="detached.html"]');
  await expect(detached).toHaveCount(1);
  const child = detached.frameLocator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]').locator('[data-oid="home-hero"]');
  await expect(child).toHaveCount(1);
  const moved = await child.boundingBox();
  expect(moved.x).toBeCloseTo(original.x + end.x - start.x, 1);
  expect(moved.y).toBeCloseTo(original.y + end.y - start.y, 1);
  expect(moved.width).toBeCloseTo(original.width, 1);
  expect(moved.height).toBeCloseTo(original.height, 1);
  expect(await child.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, fontSize: style.fontSize, background: style.backgroundColor, margin: style.margin };
  })).toEqual({ color: "rgb(0, 0, 128)", fontSize: "30px", background: "rgb(255, 0, 0)", margin: "0px" });
  expect(await page.evaluate(() => (window.__zerosHarnessDesignShortcutOperations ?? []).filter((operation) => operation === "transfer:confirmed").length)).toBe(1);
  check("free direct-root children detach once with the same affine outline, inherited appearance, and world placement", true);
}

export async function runDesignCanvasRefinementsSmoke(options) {
  await runDesignFrameLiveCameraSmoke(options);
  await runDesignMixedParentMovementSmoke(options);
  await runDesignFreeRelocationSmoke(options);
  await runDesignWorldNudgeSmoke(options);
  await runDesignLayoutAffineCameraSmoke(options);
  await runDesignFramePointerOwnershipSmoke(options);
  await runDesignNodeResizeCaptureSmoke(options);
  await runDesignGroupResizePointerOwnershipSmoke(options);
  await runDesignLayoutDragPointerOwnershipSmoke(options);
  await runDesignGestureReleasePositionSmoke(options);
  await runDesignCompletedCanvasGesturesSmoke(options);
  await runDesignNoopCanvasResizeSmoke(options);
  await runDesignNoopFrameGestureSmoke(options);
  await runDesignNoopGroupResizeSmoke(options);
  await runDesignFrameDirectoryReplacementSmoke(options);
  await runDesignPanDirectoryReplacementSmoke(options);
}

export async function runDesignFrameLiveCameraSmoke({ page, check }) {
  await openCanvasFixture(page);
  const frame = page.locator('[data-design-frame="home.html"]');
  const label = frame.locator("[data-design-frame-label]");
  const bounds = await label.boundingBox();
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const before = await frame.boundingBox();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 30, start.y + 20);
  await page.evaluate(async () => {
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    useDesignWorkspaceUiStore.getState().setViewport("ws_design_harness", { zoom: 0.5, panX: 50, panY: 120 });
  });
  await page.mouse.move(start.x + 31, start.y + 20);
  await expect.poll(async () => Math.abs((await frame.boundingBox()).x - before.x - 31)).toBeLessThan(0.5);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await canvasWrites(page)).toBe(0);
  check("scene dragging retains the world grab point through live camera movement", true);
}

export async function runDesignMixedParentMovementSmoke({ page, check }) {
  await openCanvasFixture(page, "layoutGestures&mixedParents");
  await page.locator('[data-design-layer-id="home-panel"] [data-layer-disclosure]').click();
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await page.locator('[data-design-layer-id="home-copy"]').click({ modifiers: ["Shift"] });
  const frame = page.locator('[data-design-frame="home.html"]');
  const runtime = frame.frameLocator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]');
  const child = (id) => runtime.locator(`[data-oid="${id}"]`);
  const before = await Promise.all(["home-heading", "home-copy"].map((id) => child(id).boundingBox()));
  const start = { x: before[1].x + before[1].width / 2, y: before[1].y + before[1].height / 2 };
  await page.keyboard.down("Control");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + 15);
  for (const [i, id] of ["home-heading", "home-copy"].entries()) {
    await expect.poll(async () => Math.abs((await child(id).boundingBox()).x - before[i].x - 40)).toBeLessThan(0.5);
    await expect.poll(async () => Math.abs((await child(id).boundingBox()).y - before[i].y - 15)).toBeLessThan(0.5);
  }
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect.poll(() => transactionWrites(page)).toBe(1);
  check("one group transaction moves scaled and reflected parents' children by the same world delta", true);
}
