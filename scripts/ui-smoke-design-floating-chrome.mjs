import { designCanvasPoint } from "./ui-smoke-design-helpers.mjs";

// Floating chrome uses real pointer and wheel events. Selection setup may use
// the production selection workflow when the target is outside a virtual slice.
export async function runDesignFloatingChromeSmoke({ page, waitFor, check }) {
  const origin = new URL(page.url()).origin;
  const url = `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`;
  const previousStorage = await page.evaluate(() =>
    Object.entries(localStorage),
  );
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
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: "networkidle" });
    const canvas = page.locator("[data-design-canvas-viewport]");
    const panel = page.locator("[data-design-floating-panel]");
    const layers = page.locator("[data-design-sidebar-panel]");
    const layersSlot = page.locator("[data-design-layers-slot]");
    const layersViewport = layers.locator("[data-radix-scroll-area-viewport]");
    const inspector = page.locator("[data-design-inspector]");
    const toggle = page.getByRole("button", {
      name: "Toggle Layers and Inspector",
    });
    const fold = layers.locator("[data-design-layers-fold]");
    const split = page.getByRole("separator", { name: "Resize Layers panel" });
    const seam = page.getByRole("separator", { name: "Resize Style panel" });
    const world = page.locator("[data-design-canvas-world]");
    const transform = () =>
      world.evaluate((element) => getComputedStyle(element).transform);
    const height = () =>
      layersSlot.evaluate((element) => element.getBoundingClientRect().height);
    const width = () =>
      panel.evaluate((element) => element.getBoundingClientRect().width);
    await layers.waitFor();
    await page
      .locator(
        '[data-design-frame="home.html"] iframe[data-design-document-ready]',
      )
      .waitFor();

    const geometry = () =>
      page.evaluate(() => {
        const rect = (selector) => {
          const element = document.querySelector(selector);
          return element?.getBoundingClientRect().toJSON();
        };
        return {
          surface: rect("[data-design-workspace-surface]"),
          canvas: rect("[data-design-canvas-viewport]"),
          pill: rect("[data-design-directory-header]"),
          panel: rect("[data-design-floating-panel]"),
          layers: rect("[data-design-layers-slot]"),
          inspector: rect("[data-design-inspector]"),
          rail: rect("[data-design-canvas-tools-rail]"),
          toolbar: rect('[role="toolbar"][aria-label="Canvas tools"]'),
          timeline: rect("[data-design-motion-timeline]"),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
    const near = (a, b) => Math.abs(a - b) < 1;
    const checkGeometry = async (label, motion = false) => {
      const g = await geometry();
      check(
        `${label}: canvas fills the Design surface under floating chrome`,
        ["x", "y", "width", "height"].every((key) =>
          near(g.canvas[key], g.surface[key]),
        ) && !g.overflow,
        JSON.stringify(g),
      );
      check(
        `${label}: directory pill and stacked panel keep 8px edge insets`,
        near(g.pill.x, g.canvas.x + 8) &&
          near(g.pill.y, g.canvas.y + 8) &&
          near(g.pill.height, 40) &&
          near(g.panel.right, g.canvas.right - 8) &&
          near(g.panel.y, g.canvas.y + 8) &&
          near(g.panel.bottom, g.canvas.bottom - 8) &&
          g.pill.right + 8 <= g.panel.left &&
          near(g.layers.width, g.inspector.width) &&
          near(g.layers.bottom + 1, g.inspector.top),
      );
      check(
        `${label}: vertical tools sit inside the viewport and center above Motion`,
        (await page
          .getByRole("toolbar", { name: "Canvas tools" })
          .evaluate(
            (element) =>
              element.getAttribute("aria-orientation") === "vertical" &&
              !!element.closest("[data-design-canvas-viewport]"),
          )) &&
          near(g.toolbar.x, g.canvas.x + 8) &&
          near(g.toolbar.width, 40) &&
          near(
            g.toolbar.y + g.toolbar.height / 2,
            g.rail.y + g.rail.height / 2,
          ) &&
          g.toolbar.top >= g.pill.bottom + 8 &&
          (motion
            ? near(g.rail.bottom, g.timeline.top - 8)
            : near(g.rail.bottom, g.canvas.bottom - 8)),
      );
      if (motion)
        check(
          `${label}: Motion floats bottom-left clear of the panel`,
          near(g.timeline.left, g.canvas.left + 8) &&
            near(g.timeline.bottom, g.canvas.bottom - 8) &&
            near(g.timeline.right, g.panel.left - 8) &&
            g.toolbar.bottom + 8 <= g.timeline.top,
        );
    };
    await checkGeometry("1440x900");
    check(
      "new canvases start at 25 percent with pan (64, 96)",
      await world.evaluate((element) => {
        const m = new DOMMatrix(getComputedStyle(element).transform);
        return m.a === 0.25 && m.e === 64 && m.f === 96;
      }),
    );
    check(
      "floating chrome exposes the directory group and namespaced Layers ID",
      (await page.getByRole("group", { name: "Design directory" }).count()) ===
        1 &&
        (await page
          .getByRole("button", { name: "Choose Design directory" })
          .isVisible()) &&
        (await layers.getAttribute("id")) ===
          "design-layers-panel-ws_design_harness" &&
        (await page
          .getByRole("region", { name: "Design workspace sidebar" })
          .count()) === 0,
    );
    await page.getByRole("button", { name: "Toggle motion timeline" }).click();
    await page.locator("[data-design-motion-timeline]").waitFor();
    await page.waitForTimeout(200);
    await checkGeometry("1440x900 Motion", true);
    await page.setViewportSize({ width: 700, height: 700 });
    await checkGeometry("700x700 Motion", true);
    await page.getByRole("button", { name: "Close motion timeline" }).click();
    await page.waitForTimeout(200);
    await checkGeometry("700x700");
    await page.setViewportSize({ width: 1440, height: 900 });

    check(
      "Layers split starts at 240px with horizontal separator semantics",
      near(await height(), 240) &&
        (await split.getAttribute("aria-orientation")) === "horizontal",
    );
    await split.press("ArrowDown");
    check("Layers split ArrowDown adds 8px", near(await height(), 248));
    await split.press("Shift+ArrowDown");
    check("Layers split Shift+ArrowDown adds 32px", near(await height(), 280));
    await split.press("ArrowUp");
    await split.press("Shift+ArrowUp");
    check(
      "Layers split ArrowUp and Shift+ArrowUp restore the height",
      near(await height(), 240),
    );
    await split.press("Home");
    check(
      "Layers split Home keeps the header and two rows",
      near(await height(), 96),
    );
    await split.press("End");
    check(
      "Layers split End leaves at least 200px for Inspector",
      (await height()) > 600 && (await inspector.boundingBox()).height >= 198,
    );
    await split.dblclick();
    check(
      "double-click restores the default Layers height",
      near(await height(), 240),
    );
    const splitBox = await split.boundingBox();
    const slotBox = await layersSlot.boundingBox();
    await page.mouse.move(
      splitBox.x + splitBox.width / 2,
      splitBox.y + splitBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(splitBox.x + splitBox.width / 2, slotBox.y + 312, {
      steps: 6,
    });
    check(
      "dragging the Layers split paints the live height",
      await waitFor(
        async () => near(await height(), 312),
        "layers live height",
      ),
    );
    await page.mouse.up();
    check(
      "Layers split commits its own persisted height",
      near(await height(), 312) &&
        (await page.evaluate(
          () => localStorage.getItem("zeros.design.layers.height") === "312",
        )),
    );
    await seam.press("ArrowLeft");
    await seam.press("Shift+ArrowLeft");
    check(
      "left width seam grows the whole panel by 8px and 32px",
      near(await width(), 320) &&
        (await seam.getAttribute("aria-orientation")) === "vertical",
    );
    const seamBox = await seam.boundingBox();
    const panelBox = await panel.boundingBox();
    await page.mouse.move(seamBox.x + seamBox.width / 2, seamBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(panelBox.x + panelBox.width - 352, seamBox.y + 100, {
      steps: 6,
    });
    await page.mouse.up();
    check(
      "width seam publishes its variable on the Design surface",
      near(await width(), 352) &&
        (await page.evaluate(
          () =>
            localStorage.getItem("zeros.design.style.width") === "352" &&
            document
              .querySelector("[data-design-workspace-surface]")
              .style.getPropertyValue("--zeros-design-style-width") ===
              "352px" &&
            document
              .querySelector("[data-design-inspector]")
              .style.getPropertyValue("--zeros-design-style-width") === "",
        )),
    );
    await page.reload({ waitUntil: "networkidle" });
    await layers.waitFor();
    check(
      "Layers height and floating panel width survive reload",
      near(await height(), 312) && near(await width(), 352),
    );
    await split.dblclick();
    await seam.dblclick();
    check(
      "both resize seams reset to their defaults",
      near(await height(), 240) && near(await width(), 280),
    );

    await layersViewport.evaluate((element) => {
      window.__smokeLayersViewport = element;
    });
    await fold.click();
    check(
      "Layers title folds its tree to a 36px header",
      near(await height(), 36) &&
        (await fold.getAttribute("aria-expanded")) === "false" &&
        (await split.count()) === 0 &&
        !(await layersViewport.isVisible()),
    );
    await fold.click();
    check(
      "unfolding Layers restores its split height and mounted tree",
      near(await height(), 240) &&
        (await layersViewport.isVisible()) &&
        (await layersViewport.evaluate(
          (element) => element === window.__smokeLayersViewport,
        )),
    );
    await inspector.evaluate((element) => {
      window.__smokeInspector = element;
    });
    await toggle.click();
    check(
      "panel toggle hides and inerts the mounted panel",
      (await toggle.getAttribute("aria-pressed")) === "false" &&
        (await panel.evaluate(
          (element) => element.classList.contains("hidden") && element.inert,
        )) &&
        (await inspector.evaluate(
          (element) => element === window.__smokeInspector,
        )),
    );
    await canvas.focus();
    const operationsBefore = await page.evaluate(
      () => window.__zerosHarnessDesignShortcutOperations.length,
    );
    await page.keyboard.press("Meta+z");
    check(
      "Cmd+Z dispatches with the floating panel hidden",
      await waitFor(
        () =>
          page.evaluate(
            (count) =>
              window.__zerosHarnessDesignShortcutOperations
                .slice(count)
                .some((op) => op === "undo:end" || op === "history:confirmed"),
            operationsBefore,
          ),
        "hidden undo",
      ),
    );
    await page.keyboard.press("Meta+s");
    check(
      "Cmd+S dispatches with the floating panel hidden",
      await waitFor(
        () =>
          page.evaluate(
            (count) =>
              window.__zerosHarnessDesignShortcutOperations
                .slice(count)
                .includes("save:end"),
            operationsBefore,
          ),
        "hidden save",
      ),
    );
    await page.keyboard.press("Meta+Backslash");
    check(
      "Cmd+backslash shows the panel from canvas focus",
      (await panel.isVisible()) &&
        (await toggle.getAttribute("aria-pressed")) === "true",
    );
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Control+Backslash");
    check(
      "Ctrl+backslash hides the panel when nothing holds focus",
      !(await panel.isVisible()),
    );
    await toggle.click();
    await fold.focus();
    await page.keyboard.press("Meta+Backslash");
    check(
      "hiding a panel that owns focus returns focus to the canvas",
      !(await panel.isVisible()) &&
        (await canvas.evaluate(
          (element) => document.activeElement === element,
        )),
    );
    await page.keyboard.press("Meta+Backslash");

    const selectedIds = () =>
      layers
        .locator('[aria-selected="true"]')
        .evaluateAll((rows) =>
          rows.map(
            (row) =>
              row.getAttribute("data-design-layer-id") ??
              row.getAttribute("data-design-frame-row"),
          ),
        );
    const selectionBefore = await selectedIds();
    const cameraBefore = await transform();
    for (const selector of [
      "[data-design-directory-header]",
      "[data-design-floating-panel]",
    ]) {
      const bounds = await page.locator(selector).boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + 5, {
        steps: 4,
      });
      check(
        `pointerdown on ${selector} preserves selection and never starts a marquee`,
        JSON.stringify(await selectedIds()) ===
          JSON.stringify(selectionBefore) &&
          !(await page.locator("[data-design-marquee]").isVisible()) &&
          (await transform()) === cameraBefore,
      );
      await page.mouse.up();
    }

    // Only the Layers scroll viewport may move during a reveal. Record every
    // ancestor, including overflow:hidden wrappers that scrollIntoView moves.
    const ancestorScrolls = () =>
      layersViewport.evaluate((viewport) => {
        const result = [];
        for (
          let element = viewport.parentElement;
          element;
          element = element.parentElement
        ) {
          result.push({
            tag: element.tagName,
            top: element.scrollTop,
            left: element.scrollLeft,
          });
        }
        return result;
      });
    const rowVisible = (id) =>
      layersViewport.evaluate((viewport, id) => {
        const row = viewport.querySelector(`[data-design-layer-id="${id}"]`);
        if (!row || row.getAttribute("aria-selected") !== "true") return false;
        const r = row.getBoundingClientRect();
        const v = viewport.getBoundingClientRect();
        return (
          r.height > 0 &&
          r.top >= v.top &&
          r.bottom <= v.bottom &&
          r.left >= v.left &&
          r.right <= v.right
        );
      }, id);
    const deepId = "pricing-start-name";
    const deepElement = page
      .frameLocator(
        '[data-design-frame="pricing.html"] iframe[data-design-document-buffer="displayed"]',
      )
      .locator(`[data-oid="${deepId}"]`);
    await deepElement.waitFor();
    const clickDeep = async () => {
      const box = await deepElement.boundingBox();
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const clear = await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y);
        return (
          !!target?.closest('[data-design-frame="pricing.html"]') &&
          !target.closest("[data-design-controls]")
        );
      }, point);
      if (!clear)
        throw new Error("Deep canvas selection target is obscured by chrome");
      await page.keyboard.down("Meta");
      await page.mouse.click(point.x, point.y);
      await page.keyboard.up("Meta");
    };
    await layers.getByRole("button", { name: "Collapse all layers" }).click();
    const scrollsBefore = await ancestorScrolls();
    await clickDeep();
    check(
      "Collapse all then Meta-click opens the selected frame and every ancestor",
      await waitFor(
        async () =>
          (await layers
            .locator('[data-design-frame-row="pricing.html"]')
            .getAttribute("aria-expanded")) === "true" &&
          (await layers
            .locator('[data-design-layer-id="pricing-plans"]')
            .getAttribute("aria-expanded")) === "true" &&
          (await layers
            .locator('[data-design-layer-id="pricing-start"]')
            .getAttribute("aria-expanded")) === "true" &&
          (await rowVisible(deepId)),
        "deep layer reveal",
      ),
    );
    check(
      "canvas-origin reveal retains canvas focus and leaves all ancestor scroll offsets unchanged",
      (await canvas.evaluate(
        (element) => document.activeElement === element,
      )) &&
        JSON.stringify(await ancestorScrolls()) ===
          JSON.stringify(scrollsBefore),
    );

    // Open the long home tree so the selected pricing row can be scrolled far
    // out of sight without changing selection.
    for (const selector of [
      '[data-design-frame-row="home.html"]',
      '[data-design-layer-id="home-hero"]',
    ]) {
      const row = layers.locator(selector);
      if ((await row.getAttribute("aria-expanded")) !== "true")
        await row.locator("[data-layer-disclosure]").click();
    }
    await layersViewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    check(
      "the repeated-click fixture scrolls the selected row fully out of view",
      !(await rowVisible(deepId)),
    );
    const repeatScrolls = await ancestorScrolls();
    await clickDeep();
    check(
      "clicking the same canvas element again reveals its selected row",
      await waitFor(() => rowVisible(deepId), "repeat reveal"),
    );
    check(
      "an out-of-sight selected row is centered in Layers",
      await layersViewport.evaluate((viewport, id) => {
        const row = viewport
          .querySelector(`[data-design-layer-id="${id}"]`)
          .getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        return (
          Math.abs(row.y + row.height / 2 - bounds.y - bounds.height / 2) < 1
        );
      }, deepId),
    );
    check(
      "repeat reveal scrolls only Layers",
      JSON.stringify(await ancestorScrolls()) === JSON.stringify(repeatScrolls),
    );
    await layersViewport.evaluate((viewport, id) => {
      const row = viewport
        .querySelector(`[data-design-layer-id="${id}"]`)
        .getBoundingClientRect();
      viewport.scrollTop +=
        row.bottom - viewport.getBoundingClientRect().bottom - 8;
    }, deepId);
    const peekingScroll = await layersViewport.evaluate(
      (element) => element.scrollTop,
    );
    const peekingBounds = await layersViewport.evaluate(
      (viewport, id) => ({
        row: viewport
          .querySelector(`[data-design-layer-id="${id}"]`)
          .getBoundingClientRect()
          .toJSON(),
        viewport: viewport.getBoundingClientRect().toJSON(),
      }),
      deepId,
    );
    await clickDeep();
    check(
      "a partially visible row uses only the minimal reveal scroll",
      (await waitFor(() => rowVisible(deepId), "peeking reveal")) &&
        Math.abs(
          (await layersViewport.evaluate((element) => element.scrollTop)) -
            peekingScroll -
            8,
        ) < 1,
      JSON.stringify({
        peekingScroll,
        after: await layersViewport.evaluate((element) => element.scrollTop),
        peekingBounds,
      }),
    );

    await layersViewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    const wheelCamera = await transform();
    const wheelBox = await layersViewport.boundingBox();
    await page.mouse.move(
      wheelBox.x + wheelBox.width / 2,
      wheelBox.y + wheelBox.height / 2,
    );
    await page.mouse.wheel(0, 350);
    check(
      "real wheel scrolls Layers without moving the canvas",
      await waitFor(
        async () =>
          (await layersViewport.evaluate((element) => element.scrollTop > 0)) &&
          (await transform()) === wheelCamera,
        "layers wheel",
      ),
    );
    const inspectorViewport = inspector
      .locator("[data-radix-scroll-area-viewport]")
      .first();
    await inspectorViewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    const inspectorWheelBox = await inspectorViewport.boundingBox();
    await page.mouse.move(
      inspectorWheelBox.x + inspectorWheelBox.width / 2,
      inspectorWheelBox.y + inspectorWheelBox.height / 2,
    );
    await page.mouse.wheel(0, 350);
    check(
      "real wheel scrolls Inspector without moving the canvas",
      await waitFor(
        async () =>
          (await inspectorViewport.evaluate(
            (element) => element.scrollTop > 0,
          )) && (await transform()) === wheelCamera,
        "inspector wheel",
      ),
    );

    await layers.getByRole("button", { name: "Collapse all layers" }).click();
    await page.evaluate(async () => {
      const { selectDesignNode } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts");
      const { designWorkspaceSnapshotCache } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      const snapshot =
        designWorkspaceSnapshotCache.getSnapshot("ws_design_harness").data;
      // A runtime details refresh is deliberately not a user reveal request.
      await selectDesignNode({
        workspaceId: "ws_design_harness",
        folder: snapshot.lint.workspacePath,
        frame: snapshot.frames.find((frame) => frame.file === "pricing.html"),
        nodeId: "pricing-start-name",
        reveal: false,
      });
    });
    check(
      "background selection refresh preserves containers the user folded",
      (await layers
        .locator('[data-design-frame-row="pricing.html"]')
        .getAttribute("aria-expanded")) === "false",
    );
    const clearPoint = await designCanvasPoint(page, { empty: true });
    await page.mouse.click(clearPoint.x, clearPoint.y);
    await toggle.click();
    await clickDeep();
    check(
      "selection keeps a deliberately hidden panel hidden",
      !(await panel.isVisible()),
    );
    await toggle.click();
    check(
      "showing a hidden panel reveals its pending selected row",
      await waitFor(() => rowVisible(deepId), "hidden panel reveal"),
    );
    await fold.click();
    await clickDeep();
    await fold.click();
    check(
      "unfolding Layers reveals its selected row",
      await waitFor(() => rowVisible(deepId), "folded reveal"),
    );

    // Exercise actual runtime reconciliation as well as the background
    // selection path above. A new source generation must preserve a fold.
    await page.evaluate(async () => {
      const { selectDesignNode } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts");
      const { designWorkspaceSnapshotCache } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      const snapshot =
        designWorkspaceSnapshotCache.getSnapshot("ws_design_harness").data;
      await selectDesignNode({
        workspaceId: "ws_design_harness",
        folder: snapshot.lint.workspacePath,
        frame: snapshot.frames.find((frame) => frame.file === "home.html"),
        nodeId: "home-heading",
      });
    });
    await layers
      .locator('[data-design-layer-row="home-hero"] [data-layer-disclosure]')
      .click();
    const nextVersion = await page.evaluate(() =>
      window.__zerosHarnessCommitStyleGeneration(),
    );
    const refreshed = await waitFor(
      () =>
        page
          .locator(
            '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]',
          )
          .getAttribute("data-design-source-version")
          .then((version) => version === nextVersion),
      "runtime source adopted",
    );
    check(
      "runtime source adoption preserves a manually folded selected ancestor",
      refreshed &&
        (await layers
          .locator('[data-design-layer-id="home-hero"]')
          .getAttribute("aria-expanded")) === "false",
    );

    await page.goto(`${url}?denseLayers=1`, { waitUntil: "networkidle" });
    await layers.waitFor();
    const farId = "home-layer-9500";
    check(
      "dense reveal starts with the far row outside the mounted window",
      (await layers.locator(`[data-design-layer-id="${farId}"]`).count()) === 0,
    );
    await page.evaluate(async (nodeId) => {
      const { selectDesignNode } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts");
      const { designWorkspaceSnapshotCache } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      const snapshot =
        designWorkspaceSnapshotCache.getSnapshot("ws_design_harness").data;
      await selectDesignNode({
        workspaceId: "ws_design_harness",
        folder: snapshot.lint.workspacePath,
        frame: snapshot.frames.find((frame) => frame.file === "home.html"),
        nodeId,
      });
    }, farId);
    check(
      "denseLayers far selection mounts and fully reveals the selected row",
      await waitFor(() => rowVisible(farId), "dense far reveal", 15_000),
    );
    check(
      "far reveal preserves the bounded virtual window",
      (await layers.locator("[data-design-layer-id]").count()) < 100,
    );
    const empty = await designCanvasPoint(page, { empty: true });
    await page.mouse.click(empty.x, empty.y);
  } finally {
    // Navigate away before restoring storage so debounced UI writes cannot
    // leak this fixture's preferences into later suites.
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
