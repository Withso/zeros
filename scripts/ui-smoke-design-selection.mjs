// Exercise frame identity through real pointer events and the production
// inspector, including the empty frame that has no selectable child layers.
export async function runDesignSelectionSmoke({ page, waitFor, check }) {
  const origin = new URL(page.url()).origin;
  const open = async (query) => {
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html${query}`,
      {
        waitUntil: "networkidle",
      },
    );
    await page
      .locator(
        '[data-design-frame="home.html"] iframe[data-design-document-ready]',
      )
      .waitFor();
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await open("?emptyFrame");
  const frame = page.locator('[data-design-frame="home.html"]');
  const frameRow = page.locator('[data-design-frame-row="home.html"]');
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const center = async () => {
    const bounds = await frame.boundingBox();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  };
  const clickBody = async (options) => {
    const point = await center();
    await page.mouse.click(point.x, point.y, options);
  };
  const frameSelected = () =>
    frameRow.getAttribute("aria-selected").then((value) => value === "true");
  await clickBody();
  check(
    "clicking an empty frame body selects the frame and opens Layout",
    (await waitFor(frameSelected, "empty-frame-body-selection")) &&
      (await page.locator("[data-design-layout-section]").isVisible()),
  );
  await page
    .locator("[data-design-layout-section]")
    .getByLabel("W", { exact: true })
    .focus();
  await clickBody();
  check(
    "clicking a frame returns keyboard focus from Style to the canvas",
    await canvas.evaluate((el) => el.contains(document.activeElement)),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape after a frame click clears selection without manually focusing the canvas",
    !(await frameSelected()),
  );
  await clickBody();
  const point = await center();
  check(
    "selecting the outer frame uses the ordinary cursor without a movable root overlay",
    (await frameSelected()) &&
      (await frame.locator("[data-design-selected-element]").count()) === 0 &&
      (await page.evaluate(
        ({ x, y }) =>
          getComputedStyle(document.elementFromPoint(x, y)).cursor ===
          "default",
        point,
      )) &&
      (await frame
        .locator("[data-design-frame-label]")
        .evaluate((el) => getComputedStyle(el).cursor === "default")),
  );
  await page.mouse.dblclick(point.x, point.y);
  await page.keyboard.down("ControlOrMeta");
  await clickBody();
  await page.keyboard.up("ControlOrMeta");
  check(
    "double-click and deep-select keep an empty frame on its canonical frame selection",
    (await frameSelected()) &&
      (await frame.locator("[data-design-selected-element]").count()) === 0,
  );
  // Older sessions could restore the frame's style owner as a node. Re-enter
  // that state through the existing selection API before clicking its overlay.
  await page.evaluate(async () => {
    const { selectDesignNode } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts");
    const { designWorkspaceSnapshotCache } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const { designRuntimeFrameState } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-runtime-store.ts");
    const workspaceId = "ws_design_harness";
    const snapshot = designWorkspaceSnapshotCache.getSnapshot(workspaceId).data;
    const frame = snapshot.frames.find((item) => item.file === "home.html");
    await selectDesignNode({
      workspaceId,
      folder: snapshot.lint.workspacePath,
      frame,
      nodeId: designRuntimeFrameState(workspaceId, frame.file).snapshot.frame
        .oid,
    });
  });
  await frame.locator("[data-design-selected-element]").waitFor();
  const restoredBounds = await frame.boundingBox();
  await page.mouse.click(
    restoredBounds.x + restoredBounds.width * 0.25,
    restoredBounds.y + restoredBounds.height * 0.25,
  );
  check(
    "clicking a restored root-layer overlay selects its outer frame",
    await waitFor(
      async () =>
        (await frameSelected()) &&
        (await frame.locator("[data-design-selected-element]").count()) === 0,
      "restored-frame-root-selection",
    ),
  );
  await frameRow.click();
  const beforeDrag = await frame.boundingBox();
  const label = await frame.locator("[data-design-frame-label]").boundingBox();
  await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    label.x + label.width / 2 + 40,
    label.y + label.height / 2 + 30,
    { steps: 4 },
  );
  const duringDrag = await frame.boundingBox();
  check(
    "the ordinary frame cursor still allows label dragging",
    Math.abs(duringDrag.x - beforeDrag.x) > 20 && (await frameSelected()),
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  const afterCancel = await frame.boundingBox();
  check(
    "Escape cancels label dragging without changing the frame selection",
    Math.abs(afterCancel.x - beforeDrag.x) < 1 &&
      Math.abs(afterCancel.y - beforeDrag.y) < 1 &&
      (await frameSelected()),
  );
  await page.keyboard.down("Space");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 35, point.y + 25, { steps: 4 });
  const duringPan = await frame.boundingBox();
  check(
    "Space-drag over a selected frame still pans the canvas",
    Math.abs(duringPan.x - beforeDrag.x - 35) < 1 && (await frameSelected()),
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.keyboard.up("Space");
  const afterPanCancel = await frame.boundingBox();
  check(
    "cancelling a pan restores the camera and leaves the frame selected",
    Math.abs(afterPanCancel.x - beforeDrag.x) < 1 && (await frameSelected()),
  );
  await page.keyboard.down("Shift");
  await clickBody();
  await page.keyboard.up("Shift");
  check(
    "Shift-click toggles the selected outer frame off",
    !(await frameSelected()),
  );
  await clickBody();
  await canvas.focus();
  await page.keyboard.press("Enter");
  check(
    "Enter on an empty frame does not select an invisible root",
    await frameSelected(),
  );
  await page.keyboard.press("Escape");
  check("Escape clears the outer frame selection", !(await frameSelected()));
  await clickBody({ button: "right" });
  const menu = page.getByRole("menu", { name: "Layers under pointer" });
  await waitFor(() => menu.isVisible(), "empty-frame-selection-menu");
  check(
    "an empty frame's selection menu offers the frame once without document wrappers",
    (await menu.getByRole("menuitem").count()) === 1,
  );
  await page.keyboard.press("Escape");

  await open("");
  // The general harness deliberately restores a nested heading selection.
  // Return to the unselected canvas before exercising initial entry.
  await canvas.focus();
  for (let depth = 0; depth < 3; depth += 1)
    await page.keyboard.press("Escape");
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const mark = runtime.locator('[data-oid="home-mark"]');
  const clickMark = async (double = false) => {
    const box = await mark.boundingBox();
    await page.mouse[double ? "dblclick" : "click"](
      box.x + box.width / 2,
      box.y + box.height / 2,
    );
  };
  const selectedNode = (id) =>
    frame
      .locator(
        `[data-design-selected-element][data-design-element-overlay="${id}"]`,
      )
      .count()
      .then((count) => count === 1);
  await clickMark();
  check(
    "the first click over nested content gives the outer frame precedence",
    await waitFor(frameSelected, "outer-frame-precedence"),
  );
  await canvas.focus();
  await page.keyboard.press("Enter");
  check(
    "Enter descends from the frame to its first real child",
    await waitFor(() => selectedNode("home-nav"), "frame-enter-child"),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape returns from a top-level child directly to its frame",
    await waitFor(frameSelected, "child-escape-frame"),
  );
  await page.keyboard.down("ControlOrMeta");
  await clickMark();
  await page.keyboard.up("ControlOrMeta");
  check(
    "deep selection reaches a nested layer through the selected outer frame",
    await waitFor(() => selectedNode("home-mark"), "frame-deep-child"),
  );
  await canvas.focus();
  await page.keyboard.press("Shift+Enter");
  await waitFor(() => selectedNode("home-nav"), "nested-parent");
  await page.keyboard.press("Shift+Enter");
  check(
    "Shift+Enter skips hidden document wrappers when returning to the frame",
    await waitFor(frameSelected, "nested-parent-frame"),
  );

  // Use non-text container padding to check that one double-click descends
  // once even when pointer-up and dblclick arrive before the runtime answers.
  const nav = runtime.locator('[data-oid="home-nav"]');
  const navBox = await nav.boundingBox();
  await page.mouse.dblclick(
    navBox.x + navBox.width / 2,
    navBox.y + navBox.height / 2,
  );
  check(
    "one double-click descends exactly one visible container level",
    await waitFor(() => selectedNode("home-nav"), "frame-double-click-child"),
  );

  await open("");
  const editor = page.getByLabel(/^Edit text for /);
  await frameRow.click();
  await page.evaluate(async () => {
    const { getActiveBridge } =
      await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts");
    const bridge = getActiveBridge();
    const request = bridge.request.bind(bridge);
    let blocked = true;
    const releases = [];
    const gate = {
      pending: 0,
      release() {
        blocked = false;
        for (const release of releases.splice(0)) release();
      },
    };
    window.__zerosSelectionWriteGate = gate;
    bridge.request = async (message, ...args) => {
      if (message.op !== "design.selection.set" || !blocked)
        return request(message, ...args);
      gate.pending += 1;
      try {
        await new Promise((resolve) => releases.push(resolve));
        return await request(message, ...args);
      } finally {
        gate.pending -= 1;
      }
    };
  });
  const headingBox = await runtime
    .locator('[data-oid="home-heading"]')
    .boundingBox();
  await page.mouse.dblclick(
    headingBox.x + headingBox.width / 2,
    headingBox.y + headingBox.height * 0.4,
  );
  try {
    const opened = await waitFor(
      () => editor.isVisible(),
      "text-editor-before-selection-persistence",
    );
    check(
      "double-click opens text editing while selection persistence is pending",
      opened &&
        (await page.evaluate(() => window.__zerosSelectionWriteGate.pending)) >
          0,
    );
    if (opened) {
      await page.keyboard.type(" temporary local edit");
      const draft = await editor.textContent();
      await page.evaluate(() => window.__zerosSelectionWriteGate.release());
      await waitFor(
        () =>
          page.evaluate(() => window.__zerosSelectionWriteGate.pending === 0),
        "text-selection-persistence-settled",
      );
      check(
        "settling selection persistence does not reopen the text editor or replace its draft",
        (await editor.textContent()) === draft,
      );
    }
  } finally {
    await page.evaluate(() => window.__zerosSelectionWriteGate.release());
  }

  await open("");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const selectedText = await frame
      .locator("[data-design-selected-element]")
      .boundingBox();
    await page.mouse.dblclick(
      selectedText.x + selectedText.width / 2,
      selectedText.y + selectedText.height * 0.4,
    );
    await editor.waitFor({ state: "visible" });
    await page.keyboard.type(` temporary ${attempt}`);
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "hidden" });
  }
  check(
    "text can be reopened immediately after cancellation without losing editor focus",
    true,
  );

  await open("");
  await runtime.locator('[data-oid="home-hero"]').evaluate((element) => {
    element.style.cssText =
      "position:relative;display:flex;flex-direction:column;width:400px;height:300px;padding:100px;box-sizing:border-box";
    element.querySelector('[data-oid="home-heading"]').style.cssText =
      "position:absolute;left:40px;top:20px;width:300px;height:60px;margin:0;font-size:24px";
  });
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
      frame: snapshot.frames.find((item) => item.file === "home.html"),
      nodeId: "home-hero",
      forceRuntimeRead: true,
    });
  });
  const underPadding = await runtime
    .locator('[data-oid="home-heading"]')
    .boundingBox();
  const paddingPoint = {
    x: underPadding.x + underPadding.width / 2,
    y: underPadding.y + underPadding.height / 2,
  };
  await page.mouse.move(paddingPoint.x, paddingPoint.y);
  check(
    "the padding selection fixture places authored text beneath a spacing control",
    await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest("[data-design-inline-spacing]")
          ?.getAttribute("data-design-inline-spacing") === "padding-top",
      paddingPoint,
    ),
  );
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(paddingPoint.x, paddingPoint.y);
  await page.keyboard.up("ControlOrMeta");
  check(
    "deep selection passes through padding controls to the authored layer underneath",
    await waitFor(() => selectedNode("home-heading"), "padding-deep-selection"),
  );

  await open("?emptyFrame");
  await runtime.locator('[data-oid="home-main"]').evaluate((root) => {
    let parent = root;
    for (let depth = 1; depth <= 35; depth += 1) {
      // Empty divs are editable text. End on a shape to exercise container
      // descent, without the deliberate double-click shortcut into text.
      const child = root.ownerDocument.createElement(
        depth === 35 ? "canvas" : "div",
      );
      child.dataset.oid = `bounded-depth-${depth}`;
      child.style.cssText = "display:block;width:100%;height:100%";
      parent.append(child);
      parent = child;
    }
  });
  check(
    "the nested selection fixture exceeds the runtime layer-tree depth limit",
    await waitFor(
      () =>
        page.evaluate(async () => {
          const { designRuntimeFrameState } =
            await import("/apps/desktop/src/renderer/features/design-workspace/state/design-runtime-store.ts");
          return designRuntimeFrameState(
            "ws_design_harness",
            "home.html",
          )?.snapshot?.warnings.some(
            (warning) => warning.ruleId === "layer-tree-limit",
          );
        }),
      "bounded-runtime-tree",
    ),
  );
  await frameRow.click();
  const nestedPoint = await center();
  for (let depth = 1; depth <= 2; depth += 1) {
    await page.mouse.dblclick(nestedPoint.x, nestedPoint.y);
    check(
      `double-click descends to visible level ${depth} when the deepest hit is beyond the tree limit`,
      await waitFor(
        () => selectedNode(`bounded-depth-${depth}`),
        `bounded-tree-descend-${depth}`,
      ),
    );
  }
}
