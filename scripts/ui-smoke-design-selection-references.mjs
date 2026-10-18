import { expect } from "@playwright/test";

export async function runDesignSelectionReferencesSmoke({ page, check }) {
  const previousViewport = page.viewportSize();
  const previousStorage = await page.evaluate(() =>
    Object.entries(localStorage),
  );
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(
      `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?selectionReferences`,
      { waitUntil: "networkidle" },
    );
    await page
      .locator(
        '[data-design-frame="home.html"] iframe[data-design-document-ready]',
      )
      .waitFor();
    const pill = page.locator("[data-composer-design-frame]");
    const row = (file) => page.locator(`[data-design-frame-row="${file}"]`);
    const layer = (id) => page.locator(`[data-design-layer-id="${id}"]`);
    await row("home.html").click();
    await expect(pill).toHaveText("home.html");
    await page
      .getByRole("button", { name: "Attach notes", exact: true })
      .click();
    const editor = page.locator("[data-selection-reference-fixture] .tiptap");
    await editor.click();
    await pill.click();
    await expect(pill).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect(page.locator("[data-attachment-pill]")).toHaveCount(1);
    await expect(page.locator("[data-historical-reference]")).toHaveText(
      "Earlier message: design-history.md",
    );
    await row("home.html").click();
    await expect(pill).toHaveText("home.html");
    await pill.click();
    await row("home.html").click();
    await expect(pill).toHaveText("home.html");
    check(
      "removing a canvas reference preserves editor focus and unrelated attachments, and same-target clicks reattach repeatedly",
      true,
    );

    await layer("home-hero").click();
    await layer("home-heading").click({ modifiers: ["Shift"] });
    await row("pricing.html").click({ modifiers: ["Shift"] });
    await expect(pill).toHaveText("3 selected");
    await expect(pill).toHaveCount(1);
    await expect(layer("home-hero")).toHaveAttribute("aria-selected", "true");
    await expect(layer("home-heading")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(row("pricing.html")).toHaveAttribute("aria-selected", "true");
    await page
      .getByRole("button", { name: "Save reference draft", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Send selection", exact: true })
      .click();
    await expect(pill).toHaveCount(0);
    const submitted = JSON.parse(
      await page.getByLabel("Submitted canvas references").textContent(),
    );
    expect(submitted).toHaveLength(3);
    expect(
      submitted.map((target) => [target.frame, target.nodeId ?? null]),
    ).toEqual([
      ["pricing.html", null],
      ["home.html", "home-heading"],
      ["home.html", "home-hero"],
    ]);
    await expect(page.locator("[data-attachment-pill]")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Restore reference draft", exact: true })
      .click();
    await expect(pill).toHaveText("3 selected");
    await pill.click();
    await expect(pill).toHaveCount(0);
    await row("home.html").click();
    await expect(pill).toHaveText("home.html");
    await page
      .getByRole("button", { name: "Clear composer", exact: true })
      .click();
    await expect(pill).toHaveCount(0);
    await row("home.html").click();
    await row("pricing.html").click({ modifiers: ["Shift"] });
    await expect(pill).toHaveText("2 selected");
    await row("pricing.html").click({ modifiers: ["Shift"] });
    await expect(pill).toHaveText("home.html");
    check(
      "mixed ancestor/descendant/frame references share one counted pill, all survive capture and draft restoration, and deselection updates the group",
      true,
    );

    await page.evaluate(async () => {
      const { useDesignWorkspaceUiStore } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
      const store = useDesignWorkspaceUiStore.getState();
      store.setPanels("ws_design_harness", { inspectorVisible: false });
      store.setViewport("ws_design_harness", {
        zoom: 0.25,
        panX: 64,
        panY: 96,
      });
    });
    const home = await page
      .locator('[data-design-frame="home.html"]')
      .boundingBox();
    const pricing = await page
      .locator('[data-design-frame="pricing.html"]')
      .boundingBox();
    await page.mouse.move(home.x - 12, home.y + home.height + 20);
    await page.mouse.down();
    await page.mouse.move(pricing.x + pricing.width + 12, pricing.y - 12, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(pill).toHaveText("2 selected");
    check(
      "a real outer marquee selects every intersecting scene frame instead of only one",
      true,
    );
    await page.mouse.move(1550, 980);
    await page.screenshot({
      path: ".context/design-selection-references-dark.png",
    });
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
      document.documentElement.dataset.theme = "light";
    });
    await page.screenshot({
      path: ".context/design-selection-references-light.png",
    });
    await runDesignParkedReferenceRemovalSmoke({ page, check });
    await runDesignSelectedFrameDeletionSmoke({ page, check });
    await runDesignSelectionLimitSmoke({ page, check });
    await runDesignRuntimeCompletenessSmoke({ page, check });
  } finally {
    if (previousViewport) await page.setViewportSize(previousViewport);
    await page.evaluate((entries) => {
      window.dispatchEvent(new Event("beforeunload"));
      localStorage.clear();
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, previousStorage);
  }
  expect(await page.evaluate(() => Object.entries(localStorage))).toEqual(previousStorage);
  expect(page.viewportSize()).toEqual(previousViewport);
  check("selection reference fixtures drain pending persistence and restore the caller's storage and viewport", true);
}

export async function runDesignParkedReferenceRemovalSmoke({ page, check }) {
  await page.goto(`${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?selectionReferences`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    useDesignWorkspaceUiStore.getState().setPanels("ws_design_harness", { inspectorVisible: true, layersVisible: true });
  });
  const pill = page.locator("[data-composer-design-frame]");
  await page.locator('[data-design-frame-row="home.html"]').click();
  await page.getByRole("button", { name: "Save reference draft", exact: true }).click();
  await page.locator('[data-design-frame-row="pricing.html"]').click();
  await page.getByRole("button", { name: "Restore reference draft", exact: true }).click();
  await expect(pill).toHaveText("home.html");
  await page.evaluate(async () => {
    const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
    const runtime = designFrameRuntime("ws_design_harness", "pricing.html");
    const inspect = runtime.getElementsInRect.bind(runtime);
    runtime.getElementsInRect = async (...args) => {
      runtime.getElementsInRect = inspect;
      const details = await inspect(...args);
      return new Promise(resolve => { window.__selectionReferenceRelease = () => resolve(details); });
    };
  });
  const frame = await page.locator('[data-design-frame="pricing.html"]').boundingBox();
  await page.mouse.move(frame.x + frame.width - 8, frame.y + frame.height - 8);
  await page.mouse.down();
  await page.mouse.move(frame.x + 8, frame.y + 8, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => typeof window.__selectionReferenceRelease)).toBe("function");
  await pill.click();
  const before = await page.evaluate(async () => {
    const { designWorkspaceView } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    return designWorkspaceView("ws_design_harness");
  });
  await page.evaluate(async () => {
    window.__selectionReferenceRelease();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(pill).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const { designWorkspaceView } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const { selectedTargets, selectionEvent } = designWorkspaceView("ws_design_harness");
    return { selectedTargets, selectionEvent };
  })).toEqual({ selectedTargets: before.selectedTargets, selectionEvent: before.selectionEvent });
  check("removing an unlinked parked reference retires an older marquee without clearing unrelated targets or releasing its null pin", true);
}

export async function runDesignSelectedFrameDeletionSmoke({ page, check }) {
  await page.goto(`${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?selectionReferences`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    useDesignWorkspaceUiStore.getState().setPanels("ws_design_harness", { inspectorVisible: true, layersVisible: true });
  });
  await page.locator('[data-design-frame-row="home.html"]').click();
  const pricing = page.locator('[data-design-frame-row="pricing.html"]');
  await pricing.click({ modifiers: ["Shift"] });
  await expect(page.locator("[data-composer-design-frame]")).toHaveText("2 selected");
  await pricing.press("Delete");
  await expect(page.locator('[data-design-frame="pricing.html"]')).toHaveCount(0);
  await expect(page.locator('[data-design-frame="home.html"]')).toHaveCount(1);
  await expect(page.locator("[data-composer-design-frame]")).toHaveText("home.html");
  expect(await page.evaluate(async () => {
    const { designWorkspaceView } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const { selectedTargets, selectedFrame, frameSelected } = designWorkspaceView("ws_design_harness");
    return { selectedTargets, selectedFrame, frameSelected };
  })).toEqual({ selectedTargets: [{ frame: "home.html" }], selectedFrame: "home.html", frameSelected: true });
  check("actual frame deletion preserves the surviving canonical reference and inspector selection", true);
}

export async function runDesignSelectionLimitSmoke({ page, check }) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?selectionReferences`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const cache = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const { DESIGN_RUNTIME_SOURCE } = await import("/packages/protocol/src/design-runtime.ts");
    const snapshot = cache.designWorkspaceSnapshotCache.peekSnapshot("ws_design_harness").data;
    const frames = Array.from({ length: 40 }, (_, index) => ({ file: `probe-${String(index).padStart(2, "0")}.html`, title: `Probe ${index}`, width: 130, height: 100, x: index % 8 * 150, y: Math.floor(index / 8) * 120, z: index, nodeCount: 1, modifiedAt: 1, sourceVersion: "c".repeat(24) }));
    for (const frame of frames) {
      const source = `<html><body style="margin:0"><main data-oid="node-${frame.z}" style="height:100px;background:white">Frame ${frame.z}</main></body></html>`;
      const srcDoc = source.replace("</body>", `<script>window.__zerosDesignSourceVersion=${JSON.stringify(frame.sourceVersion)};${DESIGN_RUNTIME_SOURCE}</script></body>`);
      cache.designFrameDocumentCache.setData(cache.designFrameDocumentKey("ws_design_harness", frame.file, frame.sourceVersion), { ...frame, source, srcDoc, tree: [] });
    }
    cache.designWorkspaceSnapshotCache.setData("ws_design_harness", { ...snapshot, frames, pages: undefined });
    const store = useDesignWorkspaceUiStore.getState();
    store.setSelectedTargets("ws_design_harness", []);
    store.setPanels("ws_design_harness", { inspectorVisible: false, layersVisible: false });
    store.setViewport("ws_design_harness", { zoom: 0.7, panX: 100, panY: 130 });
  });
  const first = await page.locator('[data-design-frame="probe-00.html"]').boundingBox();
  const last = await page.locator('[data-design-frame="probe-39.html"]').boundingBox();
  await page.mouse.move(first.x - 12, first.y - 12);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width + 12, last.y + last.height + 12, { steps: 12 });
  await page.mouse.up();
  const pill = page.locator("[data-composer-design-frame]");
  await expect(pill).toHaveText("32 selected");
  await expect(page.getByText("Selection limited to 32 targets", { exact: true })).toBeVisible();
  const outlined = await page.locator("[data-design-frame].zd-design-selection-outline").evaluateAll(nodes => nodes.map(node => node.dataset.designFrame));
  await page.getByRole("button", { name: "Send selection", exact: true }).click();
  const submitted = JSON.parse(await page.getByLabel("Submitted canvas references").textContent());
  expect(submitted.map(target => target.frame)).toEqual(outlined);
  expect(submitted).toHaveLength(32);
  await page.evaluate(async () => {
    const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const { selectDesignFrame } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts");
    const frame = designWorkspaceSnapshotCache.peekSnapshot("ws_design_harness").data.frames.find(frame => frame.file === "probe-39.html");
    await selectDesignFrame("ws_design_harness", frame, { selected: true });
  });
  await page.locator('[data-design-frame="probe-39.html"] iframe[data-design-document-ready]').waitFor();
  const ownerBounds = await page.locator('[data-design-frame="probe-39.html"]').boundingBox();
  await page.mouse.move(ownerBounds.x + ownerBounds.width * 0.72, ownerBounds.y + ownerBounds.height * 0.72);
  await page.mouse.down();
  await page.mouse.move(first.x - 10, first.y - 10, { steps: 12 });
  await page.mouse.up();
  await expect(pill).toHaveText("32 selected");
  const targets = await page.evaluate(async () => (await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts")).designWorkspaceView("ws_design_harness").selectedTargets);
  expect(targets[0]).toEqual({ frame: "probe-39.html", nodeId: "node-39" });
  await expect(page.locator('[data-design-frame="probe-39.html"] [data-design-element-overlay="node-39"]')).toHaveCount(1);
  const selectedFrames = await page.locator("[data-design-frame].zd-design-selection-outline").evaluateAll(nodes => nodes.map(node => node.dataset.designFrame));
  expect(selectedFrames).toEqual(targets.filter(target => !target.nodeId).map(target => target.frame));
  await page.getByRole("button", { name: "Send selection", exact: true }).click();
  expect(JSON.parse(await page.getByLabel("Submitted canvas references").textContent()).map(({ frame, nodeId }) => ({ frame, ...(nodeId ? { nodeId } : {}) }))).toEqual(targets);
  check("bounded outer and inner marquees disclose overflow, preserve a late gesture owner, and submit exactly their highlighted membership", true);
}

export async function runDesignRuntimeCompletenessSmoke({ page, check }) {
  const result = await page.evaluate(async () => {
    const { DESIGN_RUNTIME_SOURCE } = await import("/packages/protocol/src/design-runtime.ts");
    const { connectDesignFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
    const { reconcileDesignRuntimeSnapshot } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts");
    const { useDesignWorkspaceUiStore, designWorkspaceView } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const workspaceId = "selection-completeness-smoke";
    const frame = { file: "deep.html", title: "Deep", width: 400, height: 400, x: 0, y: 0, z: 0, nodeCount: 180, modifiedAt: 1, sourceVersion: "d".repeat(24) };
    const warnings = Array.from({ length: 130 }, (_, index) => `<p data-oid="warning-${index}" style="padding:1px">${index}</p>`).join("");
    const deep = Array.from({ length: 40 }, (_, index) => `<div data-oid="deep-${index}">`).join("") + "Target" + "</div>".repeat(40);
    const iframe = document.createElement("iframe");
    iframe.sandbox = "allow-scripts";
    iframe.style.cssText = "width:400px;height:400px";
    iframe.srcdoc = `<html><body>${warnings}${deep}<script>window.__zerosDesignSourceVersion=${JSON.stringify(frame.sourceVersion)};${DESIGN_RUNTIME_SOURCE}</script></body></html>`;
    const loaded = new Promise(resolve => { iframe.onload = resolve; });
    document.body.append(iframe);
    await loaded;
    let ready;
    const didReady = new Promise(resolve => { ready = resolve; });
    const runtime = connectDesignFrameRuntime(workspaceId, frame.file, frame.sourceVersion, iframe, { isActive: () => true, onReady: () => ready() });
    try {
      await didReady;
      const snapshot = await runtime.getSnapshot();
      const actual = await runtime.getNodeDetails("deep-39");
      const has = nodes => nodes.some(node => node.oid === "deep-39" || has(node.children));
      const store = useDesignWorkspaceUiStore.getState();
      store.bindDirectory(workspaceId, "directory");
      store.setSelectedTargets(workspaceId, [{ frame: frame.file, nodeId: "deep-39" }]);
      reconcileDesignRuntimeSnapshot({ workspaceId, folder: "/synthetic", frame, snapshot });
      return { warningCount: snapshot.warnings.length, truncationWarning: snapshot.warnings.some(warning => warning.ruleId === "layer-tree-limit"), inTree: has(snapshot.tree), actual: actual.oid, selectedTargets: designWorkspaceView(workspaceId).selectedTargets };
    } finally {
      runtime.destroy();
      iframe.remove();
    }
  });
  expect(result).toEqual({ warningCount: 128, truncationWarning: true, inTree: false, actual: "deep-39", selectedTargets: [{ frame: "deep.html", nodeId: "deep-39" }] });
  check("the real opaque runtime retains its truncation warning under audit saturation and the reconciler preserves a live deep node", true);
}
