import { designCanvasPoint } from "./ui-smoke-design-helpers.mjs";

// Floating-chrome edge cases found in review: wheel ownership inside the
// viewport, a short canvas with Motion open, live width sharing while a seam
// is held, separators that report and step from the rendered size, repeated
// frame-body reveals, and Layers keyboard focus that never outlives a newer
// focus owner. Real pointer, wheel, and keyboard input throughout.
export async function runDesignFloatingChromeEdgesSmoke({
  page,
  waitFor,
  check,
}) {
  const origin = new URL(page.url()).origin;
  const url = `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`;
  const previousStorage = await page.evaluate(() =>
    Object.entries(localStorage),
  );
  const open = async (width, height) => {
    await page.setViewportSize({ width, height });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator("[data-design-sidebar-panel]").waitFor();
    await page
      .locator(
        '[data-design-frame="home.html"] iframe[data-design-document-ready]',
      )
      .waitFor();
  };
  const transform = () =>
    page
      .locator("[data-design-canvas-world]")
      .evaluate((element) => getComputedStyle(element).transform);
  const openMotion = async () => {
    await page.getByRole("button", { name: "Toggle motion timeline" }).click();
    await page.locator("[data-design-motion-timeline]").waitFor();
    await page.waitForTimeout(200);
  };
  try {
    await page.evaluate(() => {
      for (const key of [
        "zeros.design.layers.height",
        "zeros.design.style.width",
        "zeros:design-workspace-ui-v1",
        "zeros.design.motion-timeline-height",
      ]) {
        localStorage.removeItem(key);
      }
    });

    // Wheel over chrome that lives inside the canvas viewport.
    await open(1440, 900);
    const camera = await transform();
    const rail = await page
      .getByRole("toolbar", { name: "Canvas tools" })
      .boundingBox();
    await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height / 2);
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(200);
    check(
      "real wheel over the tool rail leaves the canvas camera alone",
      (await transform()) === camera,
    );
    await openMotion();
    const timeline = page.locator("[data-design-motion-timeline]");
    const lane = await timeline.boundingBox();
    await page.mouse.move(lane.x + lane.width / 2, lane.y + lane.height - 40);
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(200);
    check(
      "real wheel over the Motion timeline leaves the canvas camera alone",
      (await transform()) === camera,
    );
    const bare = await designCanvasPoint(page, { empty: true });
    await page.mouse.move(bare.x, bare.y);
    await page.mouse.wheel(0, 120);
    check(
      "real wheel over bare canvas still pans it",
      await waitFor(
        async () => (await transform()) !== camera,
        "bare canvas wheel",
      ),
    );

    // Neighbouring chrome follows a held width seam, not only its release.
    const seam = page.getByRole("separator", { name: "Resize Style panel" });
    const seamBox = await seam.boundingBox();
    await page.mouse.move(seamBox.x + seamBox.width / 2, seamBox.y + 200);
    await page.mouse.down();
    await page.mouse.move(seamBox.x - 160, seamBox.y + 200, { steps: 6 });
    const held = await page.evaluate(() => {
      const rect = (selector) =>
        document.querySelector(selector).getBoundingClientRect();
      return {
        panel: rect("[data-design-floating-panel]").left,
        timeline: rect("[data-design-motion-timeline]").right,
        pill: rect("[data-design-directory-header]").right,
      };
    });
    check(
      "while the width seam is held the timeline ends 8px beside the panel",
      Math.abs(held.panel - held.timeline - 8) < 1 &&
        held.pill + 8 <= held.panel,
      JSON.stringify(held),
    );
    await page.mouse.up();
    const released = await page.evaluate(() => ({
      panel: document
        .querySelector("[data-design-floating-panel]")
        .getBoundingClientRect().left,
      timeline: document
        .querySelector("[data-design-motion-timeline]")
        .getBoundingClientRect().right,
    }));
    check(
      "releasing the width seam keeps the timeline where the drag left it",
      Math.abs(released.panel - held.panel) < 1 &&
        Math.abs(released.timeline - held.timeline) < 1,
      JSON.stringify(released),
    );
    await seam.dblclick();

    // A canvas too short for tools and Motion together keeps every tool usable.
    await open(700, 480);
    await openMotion();
    const toggleBox = await page
      .getByRole("button", { name: "Toggle motion timeline" })
      .boundingBox();
    check(
      "a short canvas keeps the Motion toggle above an overlapping timeline",
      (await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest("button")
            ?.getAttribute("aria-label"),
        {
          x: toggleBox.x + toggleBox.width / 2,
          y: toggleBox.y + toggleBox.height / 2,
        },
      )) === "Toggle motion timeline",
    );
    await page.getByRole("button", { name: "Toggle motion timeline" }).click();
    check(
      "the covered Motion toggle still closes its timeline",
      await waitFor(
        async () =>
          (await page.locator("[data-design-motion-timeline]").count()) === 0,
        "short canvas motion toggle",
      ),
    );

    // Separators report and step from what CSS actually renders.
    await open(400, 400);
    const split = page.getByRole("separator", { name: "Resize Layers panel" });
    const slot = page.locator("[data-design-layers-slot]");
    await split.focus();
    const rendered = Math.round((await slot.boundingBox()).height);
    check(
      "a CSS-capped Layers split reports its rendered height and reachable bounds",
      rendered < 240 &&
        Number(await split.getAttribute("aria-valuenow")) === rendered &&
        Number(await split.getAttribute("aria-valuemax")) === rendered &&
        Number(await split.getAttribute("aria-valuemin")) === 96,
      JSON.stringify({
        rendered,
        now: await split.getAttribute("aria-valuenow"),
        max: await split.getAttribute("aria-valuemax"),
      }),
    );
    await split.press("ArrowUp");
    check(
      "the first ArrowUp on a capped split moves it by one step",
      Math.round((await slot.boundingBox()).height) === rendered - 8 &&
        Number(await split.getAttribute("aria-valuenow")) === rendered - 8,
    );
    const narrowSeam = page.getByRole("separator", {
      name: "Resize Style panel",
    });
    await narrowSeam.focus();
    const panelWidth = Math.round(
      (await page.locator("[data-design-floating-panel]").boundingBox()).width,
    );
    check(
      "a narrow window's width seam reports the width it can actually take",
      Number(await narrowSeam.getAttribute("aria-valuenow")) === panelWidth &&
        Number(await narrowSeam.getAttribute("aria-valuemax")) === panelWidth,
      JSON.stringify({
        panelWidth,
        now: await narrowSeam.getAttribute("aria-valuenow"),
        min: await narrowSeam.getAttribute("aria-valuemin"),
        max: await narrowSeam.getAttribute("aria-valuemax"),
      }),
    );

    // Clicking a frame again brings its row back after Layers scrolled away.
    await open(1440, 900);
    const layers = page.locator("[data-design-sidebar-panel]");
    const layersViewport = layers.locator("[data-radix-scroll-area-viewport]");
    const homeRow = layers.locator('[data-design-frame-row="home.html"]');
    const homeBody = await designCanvasPoint(page, {
      selector: '[data-design-frame="home.html"]',
    });
    // Start from nothing selected, where a body click selects the frame.
    const nothing = await designCanvasPoint(page, { empty: true });
    await page.mouse.click(nothing.x, nothing.y);
    await page.mouse.click(homeBody.x, homeBody.y);
    check(
      "a plain frame-body click selects the frame row",
      await waitFor(
        async () => (await homeRow.getAttribute("aria-selected")) === "true",
        "frame body selection",
      ),
    );
    if ((await homeRow.getAttribute("aria-expanded")) !== "true") {
      await homeRow.locator("[data-layer-disclosure]").click();
    }
    const hero = layers.locator('[data-design-layer-row="home-hero"]');
    if (
      (await hero
        .locator("[data-design-layer-id]")
        .getAttribute("aria-expanded")) !== "true"
    ) {
      await hero.locator("[data-layer-disclosure]").click();
    }
    await layersViewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const rowInView = () =>
      layersViewport.evaluate((viewport) => {
        const row = viewport
          .querySelector('[data-design-frame-row="home.html"]')
          ?.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        return !!row && row.top >= bounds.top && row.bottom <= bounds.bottom;
      });
    check(
      "the repeated frame-click fixture scrolls the frame row out of view",
      !(await rowInView()),
    );
    await page.mouse.click(homeBody.x, homeBody.y);
    check(
      "clicking the selected frame's body again brings its row back into view",
      await waitFor(rowInView, "repeat frame reveal"),
    );

    // Keyboard travel never takes focus back from a newer owner.
    const heading = layers.locator('[data-design-layer-id="home-heading"]');
    await heading.click();
    await heading.focus();
    const stolen = await page.evaluate(async () => {
      const row = document.activeElement;
      const canvas = document.querySelector("[data-design-canvas-viewport]");
      row.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      // A canvas click lands before the tree's next frame.
      canvas.focus({ preventScroll: true });
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return document.activeElement !== canvas;
    });
    check(
      "a canvas that takes focus before Layers' next frame keeps it",
      !stolen,
    );

    // Source must remain readable around every floating island, including at
    // its scroll limits and while the panel/timeline changes size.
    await open(1100, 780);
    await page.getByRole("button", { name: "Toggle frame source" }).click();
    const source = page.locator("[data-design-source-view]");
    await source.locator("pre").waitFor();
    const sourceIsClear = () => source.evaluate((element) => {
      const viewport = element.querySelector("[data-radix-scroll-area-viewport]");
      const bounds = viewport.getBoundingClientRect();
      const overlaps = (selector) => {
        const island = document.querySelector(selector);
        if (!island || !island.getClientRects().length) return false;
        const rect = island.getBoundingClientRect();
        return bounds.left < rect.right && bounds.right > rect.left &&
          bounds.top < rect.bottom && bounds.bottom > rect.top;
      };
      return bounds.width > 0 && bounds.height > 0 && ![
        "[data-design-directory-header]",
        '[role="toolbar"][aria-label="Canvas tools"]',
        "[data-design-floating-panel]",
        "[data-design-motion-timeline]",
      ].some(overlaps);
    });
    check("Source's filename and text clear the floating chrome", await sourceIsClear());
    await openMotion();
    check("Source stays above the open Motion timeline", await sourceIsClear());
    await source.locator("pre").evaluate((pre) => {
      pre.parentElement.scrollLeft = pre.parentElement.scrollWidth;
      const viewport = pre.closest("[data-radix-scroll-area-viewport]");
      viewport.scrollTop = viewport.scrollHeight;
    });
    check("Source's scroll limits stay clear of chrome", await sourceIsClear());
    await page.getByRole("separator", { name: "Resize Style panel" }).press("Shift+ArrowLeft");
    check("Source follows a resized inspector", await sourceIsClear());
    const sourceWidth = (await source.locator("[data-radix-scroll-area-viewport]").boundingBox()).width;
    await page.getByRole("button", { name: "Toggle Layers and Inspector" }).click();
    check(
      "Source reclaims the space of a hidden inspector",
      await sourceIsClear() &&
        (await source.locator("[data-radix-scroll-area-viewport]").boundingBox()).width > sourceWidth,
    );
    await page.getByRole("button", { name: "Toggle Layers and Inspector" }).click();
    await page.getByRole("button", { name: "Toggle frame source" }).click();

    // A post-adoption runtime refresh can reorder containers without moving
    // selected layers between them. Neither folds nor the reveal nonce move.
    await open(1440, 900);
    await page.waitForFunction(async () => {
      const { useDesignRuntimeStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-runtime-store.ts");
      const tree = useDesignRuntimeStore.getState().byWorkspace.ws_design_harness?.frames["home.html"]?.snapshot?.tree ?? [];
      const hasMark = (nodes) => nodes.some((node) => node.oid === "home-mark" || hasMark(node.children));
      return hasMark(tree);
    });
    await page.evaluate(async () => {
      const { selectDesignNodes } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts");
      const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      const snapshot = designWorkspaceSnapshotCache.getSnapshot("ws_design_harness").data;
      await selectDesignNodes({
        workspaceId: "ws_design_harness",
        folder: snapshot.lint.workspacePath,
        frame: snapshot.frames.find((frame) => frame.file === "home.html"),
        nodeIds: ["home-heading", "home-mark"],
        primaryNodeId: "home-heading",
      });
    });
    await page.getByRole("button", { name: "Collapse all layers" }).click();
    const revealNonce = () => page.evaluate(async () => {
      const { useDesignLayerDisclosureStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-layer-disclosure.ts");
      return useDesignLayerDisclosureStore.getState().revealByWorkspace.ws_design_harness?.nonce ?? 0;
    });
    const beforeReorder = await revealNonce();
    const selectionState = () => page.evaluate(async () => {
      const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
      const view = useDesignWorkspaceUiStore.getState().byWorkspace.ws_design_harness;
      return { primary: view.selectedNodeId, nodeIds: view.selectedNodeIds };
    });
    check("the reorder fixture keeps both selected layers", (await selectionState()).nodeIds.length === 2, JSON.stringify(await selectionState()));
    const publishTree = (swapParents) => page.evaluate(async (swap) => {
      const { useDesignRuntimeStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-runtime-store.ts");
      const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      const workspaceId = "ws_design_harness";
      const folder = designWorkspaceSnapshotCache.getSnapshot(workspaceId).data.lint.workspacePath;
      const runtime = useDesignRuntimeStore.getState();
      const snapshot = runtime.byWorkspace[workspaceId].frames["home.html"].snapshot;
      const members = new Map();
      const collect = (nodes) => nodes.forEach((node) => { members.set(node.oid, node); collect(node.children); });
      collect(snapshot.tree);
      const update = (nodes) => nodes.map((node) => {
        if (swap && node.oid === "home-heading") return members.get("home-mark");
        if (swap && node.oid === "home-mark") return members.get("home-heading");
        return { ...node, children: !swap && node.oid === "home-main" ? [...node.children].reverse() : update(node.children) };
      });
      runtime.publishSnapshot(workspaceId, folder, "home.html", {
        ...snapshot, revision: snapshot.revision + 1, tree: update(snapshot.tree),
      }, snapshot.sourceVersion);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, swapParents);
    await publishTree(false);
    check(
      "reordering selected containers preserves Collapse all and its scroll request",
      (await homeRow.getAttribute("aria-expanded")) === "false" &&
        (await revealNonce()) === beforeReorder,
    );
    await publishTree(true);
    check(
      "swapping selected layers between the same two parents reveals their new paths",
      (await homeRow.getAttribute("aria-expanded")) === "true" &&
        (await revealNonce()) > beforeReorder,
      JSON.stringify({ beforeReorder, after: await revealNonce(), selection: await selectionState(), expanded: await homeRow.getAttribute("aria-expanded") }),
    );

    await page.getByRole("button", { name: "Collapse all layers" }).click();
    const beforePrune = await revealNonce();
    await page.evaluate(async () => {
      const { reconcileDesignRuntimeSnapshot } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts");
      const { useDesignRuntimeStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-runtime-store.ts");
      const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      const workspaceId = "ws_design_harness";
      const workspace = designWorkspaceSnapshotCache.getSnapshot(workspaceId).data;
      const snapshot = useDesignRuntimeStore.getState().byWorkspace[workspaceId].frames["home.html"].snapshot;
      const prune = (nodes) => nodes.filter((node) => node.oid !== "home-mark").map((node) => ({ ...node, children: prune(node.children) }));
      reconcileDesignRuntimeSnapshot({
        workspaceId, folder: workspace.lint.workspacePath,
        frame: workspace.frames.find((frame) => frame.file === "home.html"),
        snapshot: { ...snapshot, revision: snapshot.revision + 1, tree: prune(snapshot.tree) },
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    check(
      "pruning a removed group member preserves folds around the surviving selection",
      (await homeRow.getAttribute("aria-expanded")) === "false" &&
        (await selectionState()).nodeIds.length === 1 &&
        (await revealNonce()) === beforePrune,
    );

    // A selected secondary layer can arrive later, after a manual fold has
    // cancelled the workflow's pending reveal. Arrival is not reparenting.
    await page.evaluate(async () => {
      const { useDesignRuntimeStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-runtime-store.ts");
      const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
      const { requestDesignLayerReveal } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-layer-disclosure.ts");
      const workspaceId = "ws_design_harness";
      const nodeIds = ["home-heading", "home-later"];
      useDesignWorkspaceUiStore.getState().setSelection(workspaceId, "home.html", nodeIds[0], nodeIds);
      requestDesignLayerReveal({
        workspaceId, frame: "home.html", nodeIds,
        tree: useDesignRuntimeStore.getState().byWorkspace[workspaceId].frames["home.html"].snapshot.tree,
      });
    });
    await page.getByRole("button", { name: "Collapse all layers" }).click();
    const cancelledNonce = await revealNonce();
    await page.evaluate(async () => {
      const { useDesignRuntimeStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-runtime-store.ts");
      const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      const workspaceId = "ws_design_harness";
      const folder = designWorkspaceSnapshotCache.getSnapshot(workspaceId).data.lint.workspacePath;
      const runtime = useDesignRuntimeStore.getState();
      const snapshot = runtime.byWorkspace[workspaceId].frames["home.html"].snapshot;
      const append = (nodes) => nodes.map((node) => ({
        ...node,
        children: node.oid === "home-hero"
          ? [...node.children, { oid: "home-later", tag: "p", name: "Later", text: "Later", visible: true, children: [] }]
          : append(node.children),
      }));
      runtime.publishSnapshot(workspaceId, folder, "home.html", {
        ...snapshot, revision: snapshot.revision + 1, tree: append(snapshot.tree),
      }, snapshot.sourceVersion);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    check(
      "a late selected layer does not revive a reveal cancelled by Collapse all",
      (await homeRow.getAttribute("aria-expanded")) === "false" &&
        (await revealNonce()) === cancelledNonce,
    );
  } finally {
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-model-menu.html`,
      { waitUntil: "networkidle" },
    );
    await page.evaluate((entries) => {
      localStorage.clear();
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, previousStorage);
  }
}
