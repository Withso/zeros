/** Run against both the opaque srcDoc runtime and the HTTP-mapped protocol
 * fixture. The latter proves lifecycle wiring, not native Electron memory. */
export async function runDesignHiddenDocumentsSmoke({ page, check, label = "fallback" }) {
  const selector = 'iframe[data-design-document-buffer="displayed"][data-design-document-ready]';
  await page.locator(selector).first().waitFor();
  await page.clock.install();
  const original = await page.evaluate(() => {
    const controls = window.__zerosHarnessDesignSurface;
    window.__designWarmDocument = document.querySelector('iframe[data-design-document-buffer="displayed"]');
    window.__designWarmDocumentSource = window.__designWarmDocument.srcdoc;
    window.__designWarmDocumentLoads = 0;
    window.__designWarmDocument.addEventListener('load', () => { window.__designWarmDocumentLoads++; });
    const state = controls.ui.getState().byWorkspace.ws_design_harness;
    return { selectedFrame: state.selectedFrame, panX: state.panX, panY: state.panY, zoom: state.zoom };
  });
  // A retained deck hides its owner with visibility. A child's explicit
  // visibility:visible must not paint that owner's old camera over a sibling.
  const hiddenPaint = await page.evaluate(() => {
    const owner = document.querySelector('[data-design-workspace-surface]');
    owner.style.visibility = 'hidden';
    const leaking = [...owner.querySelectorAll('iframe[data-design-document-ready]')]
      .filter(node => getComputedStyle(node).visibility !== 'hidden').length;
    owner.style.removeProperty('visibility');
    return leaking;
  });
  check(`${label}: a hidden canvas cannot paint ready documents over another workspace`, hiddenPaint === 0, `${hiddenPaint} visible descendants`);
  const cameraReturn = await page.evaluate(() => {
    const c = window.__zerosHarnessDesignSurface;
    const { flushSync } = window.__zerosDesignHarnessRuntime;
    const viewport = document.querySelector('[data-design-canvas-viewport]');
    const world = document.querySelector('[data-design-canvas-world]');
    const bounds = viewport.getBoundingClientRect();
    viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, metaKey: true,
      clientX: bounds.left + 200, clientY: bounds.top + 160, deltaY: -80 }));
    const painted = new DOMMatrixReadOnly(getComputedStyle(world).transform);
    flushSync(() => c.active(false));
    flushSync(() => c.active(true));
    const returned = new DOMMatrixReadOnly(getComputedStyle(world).transform);
    const state = c.ui.getState().byWorkspace.ws_design_harness;
    return { painted: [painted.a, painted.e, painted.f], returned: [returned.a, returned.e, returned.f],
      stored: [state.zoom, state.panX, state.panY], gesture: world.hasAttribute('data-design-camera-gesture') };
  });
  check(`${label}: switching during a wheel gesture retains one settled camera without stale scale`,
    !cameraReturn.gesture && cameraReturn.painted.every((value, index) =>
      Math.abs(value - cameraReturn.returned[index]) < .001 && Math.abs(value - cameraReturn.stored[index]) < .001), JSON.stringify(cameraReturn));
  await page.evaluate(before => window.__zerosHarnessDesignSurface.ui.getState().setViewport('ws_design_harness', before), original);
  await page.evaluate(() => window.__zerosHarnessDesignSurface.active(false));
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface.resources().documents.warm > 0);
  check(`${label}: a hidden warm document keeps its exact loaded source`, await page.evaluate(() =>
    window.__designWarmDocument.srcdoc === window.__designWarmDocumentSource));
  await page.clock.fastForward(5_000);
  await page.evaluate(() => window.__zerosHarnessDesignSurface.active(true));
  await page.locator(selector).first().waitFor();
  check(`${label}: quick return reuses the warm document`, await page.evaluate(() => window.__designWarmDocument.isConnected));
  check(`${label}: quick return does not navigate the retained document`, await page.evaluate(() =>
    window.__designWarmDocument.srcdoc === window.__designWarmDocumentSource && window.__designWarmDocumentLoads === 0));
  for (let cycle = 0; cycle < 20; cycle++) {
    await page.evaluate(() => window.__zerosHarnessDesignSurface.active(false));
    await page.clock.fastForward(10_010);
    await page.waitForFunction(() => document.querySelectorAll('iframe[data-design-document-buffer]').length === 0);
    const resources = await page.evaluate(() => window.__zerosHarnessDesignSurface.resources());
    check(`${label}: hidden visit ${cycle + 1} retires idle documents and displayed images`,
      resources.documents.warm === 0 && resources.documents.protected === 0 &&
      resources.counters.nativeDocumentBuffers.current === 0 && resources.images.leases === 0);
    await page.evaluate(() => window.__zerosHarnessDesignSurface.active(true));
    await page.locator(selector).first().waitFor();
  }
  check(`${label}: retirement preserves camera and semantic selection`, await page.evaluate((before) => {
    const state = window.__zerosHarnessDesignSurface.ui.getState().byWorkspace.ws_design_harness;
    return Object.entries(before).every(([key, value]) => state[key] === value);
  }, original));
}

export async function runDesignHiddenEditorSmoke({ page, check, documentHidden = false }) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`, { waitUntil: "networkidle" });
  await page.locator('[data-design-frame="home.html"] iframe[data-design-document-ready]').waitFor();
  await page.clock.install();
  const setActive = async active => page.evaluate(({ active, documentHidden }) => {
    if (documentHidden) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: active ? 'visible' : 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, value: !active });
      document.dispatchEvent(new Event('visibilitychange'));
    } else window.__zerosHarnessDesignSurface.active(active);
  }, { active, documentHidden });
  const overlay = page.locator('[data-design-element-overlay="home-heading"]');
  await overlay.waitFor();
  const box = await overlay.boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.4);
  const editor = page.locator('[data-design-inline-text-editor]');
  await editor.waitFor();
  const draft = "A protected IME draft 構";
  await editor.evaluate((node, text) => {
    window.__designProtectedEditor = node;
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    node.textContent = text;
    node.dispatchEvent(new InputEvent("input", { bubbles: true, data: "構", inputType: "insertCompositionText", isComposing: true }));
  }, draft);
  await setActive(false);
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface.resources().documents.protected > 0);
  await page.clock.fastForward(10_010);
  check("hidden IME keeps its host editor and draft beyond the retirement grace", await page.evaluate((text) => {
    const c = window.__zerosHarnessDesignSurface;
    return window.__designProtectedEditor.isConnected && window.__designProtectedEditor.textContent === text &&
      c.resources().documents.protected === 1 && c.resources().documents.warm === 0;
  }, draft));
  await setActive(true);
  await editor.focus();
  await page.evaluate(() => window.__zerosHarnessDesignSurface.textCommit.hold());
  await editor.evaluate((node) => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "構" })));
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface.textCommit.started() === 1);
  await setActive(false);
  await page.clock.fastForward(10_010);
  check("a delayed text commit retains an accounted document until its outcome is known", await page.evaluate(() => {
    const c = window.__zerosHarnessDesignSurface;
    return c.resources().documents.protected > 0 && window.__designProtectedEditor.isConnected && c.textCommit.started() === 1;
  }));
  await page.evaluate(() => window.__zerosHarnessDesignSurface.textCommit.release());
  await setActive(true);
  await editor.waitFor({ state: "detached" });
  await page.waitForFunction(() => {
    const document = window.__zerosHarnessDesignSurface.snapshots.peekSnapshot("ws_design_harness").data;
    return document.frames.find((frame) => frame.file === "home.html")?.sourceVersion !== "a".repeat(24);
  });
  const heading = page.locator('[data-design-frame="home.html"]').frameLocator('iframe[data-design-document-buffer="displayed"]').locator('[data-oid="home-heading"]');
  await heading.waitFor();
  check("return from a hidden delayed commit preserves the text exactly once", (await heading.textContent()) === draft &&
    await page.evaluate(() => window.__zerosHarnessDesignSurface.textCommit.started() === 1));
}
