import { designCanvasSafeRect } from "./ui-smoke-design-helpers.mjs";
// Camera safeguards: a canvas never opens onto empty space while it has
// frames, and selecting a frame the user cannot see brings it into view.
// Camera setup uses the UI store only; the document is the harness fixture.
export async function runDesignCameraSmoke({ page, waitFor, check }) {
  const origin = new URL(page.url()).origin;
  const url = `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: "networkidle" });
  const viewport = page.locator("[data-design-canvas-viewport]");
  const world = page.locator("[data-design-canvas-world]");

  const setCamera = (camera) =>
    page.evaluate(async (next) => {
      const { useDesignWorkspaceUiStore } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
      useDesignWorkspaceUiStore
        .getState()
        .setViewport("ws_design_harness", next);
    }, camera);
  // Frames with at least a 4px overlap in canvas space clear of floating chrome.
  const visibleFrames = async () =>
    page.evaluate(
      (canvas) => {
        return [
          ...document.querySelectorAll(
            "[data-design-canvas-world] [data-design-frame]",
          ),
        ]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const width =
              Math.min(rect.right, canvas.right) -
              Math.max(rect.left, canvas.left);
            const height =
              Math.min(rect.bottom, canvas.bottom) -
              Math.max(rect.top, canvas.top);
            return width >= 4 && height >= 4;
          })
          .map((element) => element.getAttribute("data-design-frame"));
      },
      await designCanvasSafeRect(page),
    );
  const transform = () =>
    world.evaluate((element) => getComputedStyle(element).transform);

  await viewport.waitFor({ timeout: 10_000 });
  const nativeScrollIsolation = await viewport.evaluate(canvas => {
    const world = canvas.querySelector("[data-design-canvas-world]");
    const before = world.getBoundingClientRect();
    // Native focus and scrollIntoView can otherwise move an overflow:hidden
    // canvas independently of its camera. Exercise an offscreen focus target
    // without changing the authored fixture or its remembered camera.
    const target = document.createElement("button");
    target.textContent = "Offscreen focus fixture";
    Object.assign(target.style, { position: "absolute", left: `${canvas.clientWidth * 2}px`,
      top: `${canvas.clientHeight * 2}px`, width: "40px", height: "24px" });
    canvas.appendChild(target);
    try {
      target.focus();
      target.scrollIntoView({ block: "center", inline: "center" });
      const after = world.getBoundingClientRect();
      return { focused: document.activeElement === target, left: canvas.scrollLeft, top: canvas.scrollTop,
        drift: Math.max(Math.abs(after.left - before.left), Math.abs(after.top - before.top)) };
    } finally {
      target.remove(); canvas.scrollTo(0, 0); canvas.focus({ preventScroll: true });
    }
  });
  check("native focus cannot scroll the canvas independently of its camera",
    nativeScrollIsolation.focused && nativeScrollIsolation.left === 0 && nativeScrollIsolation.top === 0 && nativeScrollIsolation.drift < .01,
    JSON.stringify(nativeScrollIsolation));
  const wheelOwnership = await viewport.evaluate(canvas => {
    const bounds = canvas.getBoundingClientRect();
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true,
      clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2, deltaY: 1 });
    canvas.dispatchEvent(wheel);
    const rail = canvas.querySelector("[data-design-canvas-tools-rail]");
    const railWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 1 });
    rail?.dispatchEvent(railWheel);
    return { canvas: wheel.defaultPrevented, rail: railWheel.defaultPrevented, hasRail: !!rail };
  });
  check("canvas wheel consumes native scrolling while the tool rail keeps its own input",
    wheelOwnership.canvas && wheelOwnership.hasRail && !wheelOwnership.rail,
    JSON.stringify(wheelOwnership));
  await waitFor(() => world.evaluate(element => !element.hasAttribute("data-design-camera-gesture")), "wheel gesture settled");
  const wheelGeometry = await viewport.evaluate(async canvas => {
    const world = canvas.querySelector("[data-design-canvas-world]");
    const original = canvas.getBoundingClientRect;
    let reads = 0, dispatching = false;
    canvas.getBoundingClientRect = function () {
      if (dispatching) reads++;
      return original.call(this);
    };
    const bounds = original.call(canvas);
    const point = { x: bounds.width / 2, y: bounds.height / 2 };
    const before = new DOMMatrixReadOnly(world.style.transform);
    try {
      for (let frame = 0; frame < 3; frame++) {
        for (let event = 0; event < 4; event++) {
          dispatching = true;
          canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
            ctrlKey: true, clientX: bounds.left + point.x, clientY: bounds.top + point.y, deltaY: -0.1 }));
          dispatching = false;
        }
        await new Promise(requestAnimationFrame);
      }
      const after = new DOMMatrixReadOnly(world.style.transform);
      // CSSOM serializes transforms with finite precision. Compare in screen
      // pixels, where sub-hundredth-pixel rounding is below painted geometry.
      return { reads, anchorDrift: after.a * Math.max(
        Math.abs((point.x - before.e) / before.a - (point.x - after.e) / after.a),
        Math.abs((point.y - before.f) / before.d - (point.y - after.f) / after.d)),
        changed: after.a > before.a };
    } finally { canvas.getBoundingClientRect = original; }
  });
  check("a continuous wheel gesture reuses viewport geometry without forcing layout per input",
    wheelGeometry.reads <= 1 && wheelGeometry.changed && wheelGeometry.anchorDrift < 0.01,
    JSON.stringify(wheelGeometry));
  const resizedAnchor = await viewport.evaluate(async canvas => {
    const world = canvas.querySelector("[data-design-canvas-world]");
    const oldWidth = canvas.style.width, oldMargin = canvas.style.marginLeft;
    const bounds = canvas.getBoundingClientRect();
    canvas.style.width = `${bounds.width - 80}px`; canvas.style.marginLeft = "40px";
    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const moved = canvas.getBoundingClientRect();
      const point = { x: moved.width / 3, y: moved.height / 3 };
      const before = new DOMMatrixReadOnly(world.style.transform);
      canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
        ctrlKey: true, clientX: moved.left + point.x, clientY: moved.top + point.y, deltaY: -0.1 }));
      const after = new DOMMatrixReadOnly(world.style.transform);
      return { moved: moved.left !== bounds.left && moved.width !== bounds.width,
        drift: after.a * Math.max(Math.abs((point.x - before.e) / before.a - (point.x - after.e) / after.a),
          Math.abs((point.y - before.f) / before.d - (point.y - after.f) / after.d)) };
    } finally { canvas.style.width = oldWidth; canvas.style.marginLeft = oldMargin; }
  });
  check("resizing and repositioning the viewport during a wheel gesture keeps the cursor anchor",
    resizedAnchor.moved && resizedAnchor.drift < 0.01, JSON.stringify(resizedAnchor));
  await waitFor(() => world.evaluate(element => !element.hasAttribute("data-design-camera-gesture")), "wheel geometry gesture settled");
  // A camera parked far from every frame (as after zooming around a very tall
  // frame that was later deleted) must not reopen onto empty space.
  await setCamera({ zoom: 0.05, panX: -40_000, panY: -30_000 });
  await page.waitForTimeout(600);
  await page.reload({ waitUntil: "networkidle" });
  await viewport.waitFor({ timeout: 10_000 });
  const fitted = await waitFor(
    async () => (await visibleFrames()).length >= 2,
    "frames fitted on open",
    5_000,
  );
  check(
    "a canvas that opens onto empty space fits its frames",
    fitted,
    JSON.stringify(await visibleFrames()),
  );

  // After opening, the camera belongs to the user.
  await setCamera({ zoom: 0.5, panX: -8_000, panY: 0 });
  await page.waitForTimeout(300);
  check(
    "the open fit runs once; a later empty view is left alone",
    (await visibleFrames()).length === 0,
    JSON.stringify(await visibleFrames()),
  );

  await page.locator('[data-design-frame-row="pricing.html"]').click();
  const revealed = await waitFor(
    async () => (await visibleFrames()).includes("pricing.html"),
    "selected frame revealed",
    3_000,
  );
  check(
    "selecting an off-screen frame in Layers brings it into view",
    revealed,
    JSON.stringify(await visibleFrames()),
  );

  // A frame with any visible part is never moved under the user.
  const before = await transform();
  const partlyVisible = (await visibleFrames()).includes("home.html");
  await page.locator('[data-design-frame-row="home.html"]').click();
  await page.waitForTimeout(300);
  check(
    "selecting a frame already on screen leaves the camera alone",
    !partlyVisible || (await transform()) === before,
    `home visible=${partlyVisible}`,
  );

  // Pricing is inside the full viewport but completely behind the right
  // panel. That overlap must not qualify as a visible frame.
  const safe = await designCanvasSafeRect(page);
  await setCamera({ zoom: 0.1, panX: safe.right + 8 - 156, panY: 96 });
  const pricing = await page
    .locator('[data-design-frame="pricing.html"]')
    .boundingBox();
  const obscured =
    !(await visibleFrames()).includes("pricing.html") &&
    pricing.x >= safe.right &&
    pricing.x + pricing.width < 1440;
  await page.locator('[data-design-frame-row="pricing.html"]').click();
  check(
    "selecting a frame covered by the floating panel reveals it in usable canvas",
    obscured &&
      (await waitFor(
        async () => (await visibleFrames()).includes("pricing.html"),
        "covered frame revealed",
      )),
  );
  await runAsyncDesignCameraSmoke({ page, check });
}

async function runAsyncDesignCameraSmoke({ page: parent, check }) {
  const page = await parent.context().browser().newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    // Exercise the host capability branch without manufacturing a native IPC
    // bridge. Actual OS wheel/pinch ownership is qualified in the Mac driver.
    await page.route("**/platform/runtime.ts*", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(
        "function hasAsyncCanvasWheel() {", "function hasAsyncCanvasWheel() { return true;") });
    });
    await page.goto(`${new URL(parent.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`, { waitUntil: "networkidle" });
    const result = await page.evaluate(async () => {
      const canvas = document.querySelector("[data-design-canvas-viewport]");
      const world = canvas.querySelector("[data-design-canvas-world]");
      const bounds = canvas.getBoundingClientRect(), before = new DOMMatrixReadOnly(world.style.transform);
      const rail = canvas.querySelector("[data-design-canvas-tools-rail]");
      const railWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 50 });
      rail.dispatchEvent(railWheel);
      const railMovedBeforePan = world.style.transform !== before.toString() &&
        new DOMMatrixReadOnly(world.style.transform).f !== before.f;
      let framePaints = 0;
      const paints = new MutationObserver(records => { framePaints += records.length; });
      paints.observe(world, { attributes: true, attributeFilter: ["style"] });
      const events = [];
      for (let i = 0; i < 12; i++) {
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true,
          clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2, deltaX: 2, deltaY: 1 });
        canvas.dispatchEvent(event); events.push(event.defaultPrevented);
      }
      const immediate = world.style.transform;
      const immediatePaints = paints.takeRecords().length;
      await new Promise(requestAnimationFrame);
      framePaints += paints.takeRecords().length;
      paints.disconnect();
      const after = new DOMMatrixReadOnly(world.style.transform);
      rail.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 50 }));
      await new Promise(requestAnimationFrame);
      return { events, railCancelled: railWheel.defaultPrevented, railMovedBeforePan,
        immediatePaints, framePaints, immediateX: new DOMMatrixReadOnly(immediate).e - before.e,
        immediateY: new DOMMatrixReadOnly(immediate).f - before.f,
        x: after.e - before.e, y: after.f - before.f,
        railMoved: world.style.transform !== after.toString() && new DOMMatrixReadOnly(world.style.transform).f !== after.f };
    });
    // The first native pan response must not wait for a new display callback.
    // Continued pan input still shares one camera paint per display interval;
    // the tool rail retains its ordinary wheel behavior.
    check("native pan claims its first wheel and batches passive continuation without losing deltas",
      result.events[0] && result.events.slice(1).every(value => !value) &&
        !result.railCancelled && !result.railMovedBeforePan && result.immediatePaints === 1 && result.framePaints === 1 &&
        Math.abs(result.immediateX + 2) < .001 && Math.abs(result.immediateY + 1) < .001 &&
        Math.abs(result.x + 24) < .001 && Math.abs(result.y + 12) < .001 && !result.railMoved,
      JSON.stringify(result));
    await page.waitForFunction(() => !document.querySelector("[data-design-canvas-world]").hasAttribute("data-design-camera-gesture"));
    const ownership = await page.evaluate(() => {
      const c = window.__zerosHarnessDesignSurface, { flushSync } = window.__zerosDesignHarnessRuntime;
      const canvas = document.querySelector("[data-design-canvas-viewport]");
      const wheel = () => {
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 3 });
        canvas.dispatchEvent(event); return event.defaultPrevented;
      };
      const nextGesture = wheel();
      flushSync(() => c.ui.getState().setCanvasBackground("ws_design_harness", "#17202a"));
      return { nextGesture, afterRender: wheel(), continued: wheel() };
    });
    check("native pan rearms after settlement without reclaiming a gesture on an unrelated render",
      ownership.nextGesture && !ownership.afterRender && !ownership.continued, JSON.stringify(ownership));
    await page.waitForFunction(() => !document.querySelector("[data-design-canvas-world]").hasAttribute("data-design-camera-gesture"));
    const ordered = await page.evaluate(async () => {
      const c = window.__zerosHarnessDesignSurface;
      const { flushSync } = window.__zerosDesignHarnessRuntime;
      const { designWheelZoomFactor, designWheelDeltaPixels, zoomDesignViewportAtPoint } =
        await import("/apps/desktop/src/renderer/features/design-workspace/design-canvas-math.ts");
      const canvas = document.querySelector("[data-design-canvas-viewport]");
      const world = canvas.querySelector("[data-design-canvas-world]");
      const bounds = canvas.getBoundingClientRect();
      // Opposite deltas crossing the zoom clamp cannot be summed before the
      // camera math; they have a different result from their zero sum.
      let expected = { zoom: 7.9, panX: 20, panY: 30 };
      flushSync(() => c.ui.getState().setViewport("ws_design_harness", expected));
      const prevented = [];
      let firstExpected;
      const paints = new MutationObserver(() => {});
      paints.observe(world, { attributes: true, attributeFilter: ["style"] });
      const inputs = [
        { ctrlKey: true, deltaY: -100, clientX: bounds.left + 150, clientY: bounds.top + 160 },
        { ctrlKey: true, deltaY: 100, clientX: bounds.left + 220, clientY: bounds.top + 190 },
        { deltaMode: 1, deltaX: 2, deltaY: -1 },
        { metaKey: true, deltaY: -4, clientX: bounds.left + 250, clientY: bounds.top + 180 },
      ];
      for (const input of inputs) {
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...input });
        if (event.ctrlKey || event.metaKey) {
          const factor = designWheelZoomFactor({ deltaY: event.deltaY, deltaMode: event.deltaMode,
            ctrlKey: event.ctrlKey, metaKey: event.metaKey, pageHeight: bounds.height });
          expected = zoomDesignViewportAtPoint(expected, expected.zoom * factor,
            { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
        } else expected = { ...expected,
          panX: expected.panX - designWheelDeltaPixels(event.deltaX, event.deltaMode, bounds.width),
          panY: expected.panY - designWheelDeltaPixels(event.deltaY, event.deltaMode, bounds.height) };
        canvas.dispatchEvent(event);
        prevented.push(event.defaultPrevented);
        firstExpected ??= { ...expected };
      }
      const immediatePaints = paints.takeRecords().length;
      const immediateMatrix = new DOMMatrixReadOnly(world.style.transform);
      // A store render between input delivery and display must retain the
      // pending camera, including mixed input and changes in cursor anchors.
      flushSync(() => c.ui.getState().setCanvasBackground("ws_design_harness", "#182430"));
      await new Promise(requestAnimationFrame);
      paints.disconnect();
      const matrix = new DOMMatrixReadOnly(world.style.transform);
      return { expected, firstExpected, prevented, immediatePaints, immediate: { zoom: immediateMatrix.a, panX: immediateMatrix.e, panY: immediateMatrix.f },
        actual: { zoom: matrix.a, panX: matrix.e, panY: matrix.f } };
    });
    check("native zoom paints its first response immediately and coalesces ordered continuation through a background render",
      ordered.prevented.every(value => !value) && ordered.immediatePaints === 1 &&
      Object.keys(ordered.expected).every(key => Math.abs(ordered.expected[key] - ordered.actual[key]) < .001 &&
        Math.abs(ordered.firstExpected[key] - ordered.immediate[key]) < .001), JSON.stringify(ordered));
    await page.waitForFunction(() => !document.querySelector("[data-design-canvas-world]").hasAttribute("data-design-camera-gesture"));
    const compactReturn = await page.evaluate(async () => {
      const c = window.__zerosHarnessDesignSurface, { flushSync } = window.__zerosDesignHarnessRuntime;
      const canvas = document.querySelector("[data-design-canvas-viewport]");
      const world = canvas.querySelector("[data-design-canvas-world]");
      flushSync(() => c.ui.getState().setViewport("ws_design_harness", { zoom: .05, panX: 30, panY: 50 }));
      const frame = world.querySelector('[data-design-frame]:not([data-design-frame-chrome-protected])');
      const before = frame.hasAttribute("data-design-frame-compact-controls");
      const bounds = canvas.getBoundingClientRect();
      const anchor = {
        x: (Number.parseFloat(frame.style.left) + Number.parseFloat(frame.style.width) / 2) * .05 + 30,
        y: (Number.parseFloat(frame.style.top) + Number.parseFloat(frame.style.height) / 2) * .05 + 50,
      };
      const wheel = deltaY => canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
        ctrlKey: true, deltaY, clientX: bounds.left + anchor.x, clientY: bounds.top + anchor.y }));
      // An unrelated store update can render React while the camera remains
      // transient. It must not freeze all frame controls at that zoom level.
      for (let i = 0; i < 12; i++) wheel(-100);
      await new Promise(requestAnimationFrame);
      const expandedZoom = new DOMMatrixReadOnly(world.style.transform).a;
      flushSync(() => c.ui.getState().setCanvasBackground("ws_design_harness", "#123456"));
      const expanded = !frame.hasAttribute("data-design-frame-compact-controls");
      for (let i = 0; i < 12; i++) wheel(100);
      await new Promise(requestAnimationFrame);
      return { before, expanded, expandedZoom, connected: frame.isConnected, background: c.ui.getState().byWorkspace.ws_design_harness.canvasBackground,
        compact: frame.hasAttribute("data-design-frame-compact-controls"),
        gesture: world.hasAttribute("data-design-camera-gesture"),
        screenWidth: Number.parseFloat(frame.style.width) * new DOMMatrixReadOnly(world.style.transform).a };
    });
    check("frame controls follow the displayed zoom after an unrelated render during the gesture",
      compactReturn.before && compactReturn.expanded && compactReturn.compact && compactReturn.connected && compactReturn.gesture && compactReturn.screenWidth < 128,
      JSON.stringify(compactReturn));
    const direct = await page.evaluate(async () => {
      const canvas = document.querySelector("[data-design-canvas-viewport]");
      const world = canvas.querySelector("[data-design-canvas-world]");
      const before = new DOMMatrixReadOnly(world.style.transform);
      canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 23 }));
      canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift", code: "ShiftLeft", shiftKey: true }));
      const immediate = new DOMMatrixReadOnly(world.style.transform);
      canvas.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift", code: "ShiftLeft" }));
      await new Promise(requestAnimationFrame);
      const after = new DOMMatrixReadOnly(world.style.transform);
      return { delta: immediate.f - before.f, drift: after.f - immediate.f };
    });
    check("a direct action sees the native camera before hit testing", Math.abs(direct.delta + 23) < .001 && direct.drift === 0, JSON.stringify(direct));
    const inactive = await page.evaluate(async () => {
      const { flushSync } = window.__zerosDesignHarnessRuntime;
      const canvas = document.querySelector("[data-design-canvas-viewport]"), world = canvas.querySelector("[data-design-canvas-world]");
      canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }));
      flushSync(() => window.__zerosHarnessDesignSurface.active(false));
      const expected = { zoom: .25, panX: 40, panY: 80 };
      flushSync(() => window.__zerosHarnessDesignSurface.ui.getState().setViewport("ws_design_harness", expected));
      await new Promise(requestAnimationFrame);
      const before = world.style.transform;
      const hiddenWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
      canvas.dispatchEvent(hiddenWheel);
      await new Promise(requestAnimationFrame);
      const unchanged = world.style.transform === before;
      flushSync(() => window.__zerosHarnessDesignSurface.active(true));
      await new Promise(requestAnimationFrame);
      const matrix = new DOMMatrixReadOnly(world.style.transform);
      const returnedWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 2 });
      canvas.dispatchEvent(returnedWheel);
      return unchanged && !hiddenWheel.defaultPrevented && returnedWheel.defaultPrevented &&
        Math.abs(matrix.a - expected.zoom) < .001 &&
        Math.abs(matrix.e - expected.panX) < .001 && Math.abs(matrix.f - expected.panY) < .001;
    });
    check("a retained inactive canvas cancels wheel settlement and releases its native listener", inactive);
    check("asynchronous canvas input reports no renderer errors", errors.length === 0, JSON.stringify(errors));
  } finally { await page.close(); }
}
