import { expect } from "@playwright/test";
import { runDesignCanvasCursorSmoke } from "./ui-smoke-design-canvas-cursors.mjs";
import { designFrameElementBox, openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

export async function runDesignDoubleClickSelectionSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  const open = async (query = "") => {
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html${query}`,
      { waitUntil: "networkidle" },
    );
    await openLayersDrawer(page);
    await page
      .locator(
        '[data-design-frame="home.html"] iframe[data-design-document-ready]',
      )
      .waitFor();
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await open();
  const selected = (id) =>
    page.locator(
      `[data-design-sidebar-panel] [data-design-layer-id="${id}"][aria-selected="true"]`,
    );
  const editor = page.locator("[data-design-inline-text-editor]");
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]',
  );
  const heading = runtime.locator('[data-oid="home-heading"]');
  await page.locator('[data-design-frame-row="home.html"]').click();
  // A layer whose details were never read selects at once and the inspector
  // names that exact layer at once; it never reads "Nothing selected" or
  // shows another layer's properties while the readback is pending.
  const coldRow = page.locator("[data-design-sidebar-panel] [data-design-layer-id]").nth(9);
  const coldId = await coldRow.getAttribute("data-design-layer-id");
  await page.evaluate(() => {
    const probe = { headers: [], done: false };
    window.__designColdLayer = probe;
    // A busy runtime: its node readbacks answer 150 ms late.
    const post = MessagePort.prototype.postMessage;
    probe.restore = () => { MessagePort.prototype.postMessage = post; };
    MessagePort.prototype.postMessage = function (message, ...rest) {
      if (message?.type === "request" && message.method === "getNodeDetails") {
        setTimeout(() => post.call(this, message, ...rest), 150);
        return;
      }
      return post.call(this, message, ...rest);
    };
    const sample = () => {
      const header = document.querySelector("[data-design-inspector-header]")?.getAttribute("data-design-selection-type");
      if (probe.headers.at(-1) !== header) probe.headers.push(header);
      if (!probe.done) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await coldRow.click();
  await expect(page.locator(`[data-design-sidebar-panel] [data-design-layer-id="${coldId}"][aria-selected="true"]`)).toHaveCount(1);
  await page.waitForTimeout(300);
  const cold = await page.evaluate(() => {
    const probe = window.__designColdLayer;
    probe.done = true;
    probe.restore();
    return probe.headers;
  });
  // The frame row was selected before the click ("Frame"); afterwards only the
  // clicked layer's own label may appear.
  const afterClick = cold.slice(cold.indexOf("Frame") + 1);
  check(
    "an uncached layer selection names that layer at once, never Nothing selected",
    !cold.includes("Nothing selected") && new Set(afterClick).size <= 1,
    JSON.stringify(cold),
  );
  await page.locator('[data-design-frame-row="home.html"]').click();
  const box = await designFrameElementBox(runtime.owner(), heading);
  const doubleClick = () =>
    page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await doubleClick();
  await expect(selected("home-hero")).toBeVisible();
  await expect(editor).toHaveCount(0);
  await doubleClick();
  await expect(selected("home-heading")).toBeVisible();
  await expect(editor).toHaveCount(0);
  await doubleClick();
  await expect(editor).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  check(
    "double-click descends through auto-layout containers before editing the selected text layer",
    true,
  );

  await open("?layoutGestures");
  await page
    .locator(
      '[data-design-sidebar-panel] [data-design-layer-id="home-heading"]',
    )
    .click();
  const empty = await designFrameElementBox(runtime.owner(), heading);
  await page.mouse.dblclick(
    empty.x + empty.width / 2,
    empty.y + empty.height / 2,
  );
  await expect(selected("home-heading")).toBeVisible();
  await expect(editor).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(editor).toHaveCount(0);
  check("double-click and Enter preserve an empty frame as a frame", true);
}

// Figma's descent: hover outlines what a double-click enters. Inside a
// selected frame it is the top-level layer under the pointer, inside a
// selected layer its child under the pointer, and with ⌘ the deepest layer.
// A double-click on a parent's own area (padding, gaps) enters its first child.
export async function runDesignDescentHoverSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`, { waitUntil: "networkidle" });
  await openLayersDrawer(page);
  await page.locator('[data-design-frame="home.html"] iframe[data-design-document-ready]').waitFor();
  const iframe = page.locator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]');
  const runtime = page.frameLocator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]');
  const box = (oid) => designFrameElementBox(iframe, runtime.locator(`[data-oid="${oid}"]`));
  const centre = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const hovered = () => page.evaluate(() =>
    [...document.querySelectorAll(".zd-design-hover-outline[data-design-element-overlay]")].map((element) => element.dataset.designElementOverlay));
  const selection = () => page.evaluate(() =>
    [...document.querySelectorAll('[data-design-sidebar-panel] [aria-selected="true"]')].map((element) => element.dataset.designLayerId ?? element.dataset.designFrameRow));
  const settle = () => page.waitForTimeout(350);

  await page.locator('[data-design-frame-row="home.html"]').click();
  const mark = centre(await box("home-mark"));
  await page.mouse.move(mark.x, mark.y, { steps: 3 });
  await settle();
  const inFrame = await hovered();
  await page.keyboard.down("Meta");
  await settle();
  const deep = await hovered();
  await page.keyboard.up("Meta");
  await settle();
  const released = await hovered();
  check(
    "inside a selected frame, hover outlines the top-level layer under the pointer, and ⌘ the deepest",
    JSON.stringify(inFrame) === '["home-nav"]' && JSON.stringify(deep) === '["home-mark"]' && JSON.stringify(released) === '["home-nav"]',
    JSON.stringify({ inFrame, deep, released }),
  );

  await page.mouse.dblclick(mark.x, mark.y);
  await expect.poll(selection).toEqual(["home-nav"]);
  await settle();
  const entered = await hovered();
  check(
    "after a double-click enters a layer, the child under the resting pointer is outlined at once",
    JSON.stringify(entered) === '["home-mark"]',
    JSON.stringify(entered),
  );

  await page.locator('[data-design-sidebar-panel] [data-design-layer-id="home-hero"]').click();
  const hero = await box("home-hero");
  const copy = await box("home-copy");
  // Beside the copy line, inside the hero, is the hero's own area. The gap
  // between heading and copy is only a few pixels with some fonts.
  const gap = { x: (copy.x + copy.width + hero.x + hero.width) / 2, y: copy.y + copy.height / 2 };
  await page.mouse.move(gap.x, gap.y, { steps: 3 });
  await settle();
  const overParent = await hovered();
  await page.mouse.dblclick(gap.x, gap.y);
  await expect.poll(selection).toEqual(["home-heading"]);
  check(
    "double-clicking a selected parent's own area selects its first child",
    overParent.length === 0,
    JSON.stringify(overParent),
  );
}
// Layer structure: a selection's parent is dotted, and ⌘/Ctrl-hover dots the
// hovered layer's parent and direct children, with no edge stroked twice.
export async function runDesignLayerStructureSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  const open = async (query = "") => {
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html${query}`,
      { waitUntil: "networkidle" },
    );
    await openLayersDrawer(page);
    await page.locator('[data-design-frame="home.html"] iframe[data-design-document-ready]').waitFor();
    await page.locator('[data-design-frame-row="home.html"]').click();
    await page.keyboard.press("Shift+2");
    await page.waitForTimeout(500);
  };
  const iframe = page.locator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]');
  const runtime = page.frameLocator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]');
  const box = (oid) => designFrameElementBox(iframe, runtime.locator(`[data-oid="${oid}"]`));
  const row = (id) => page.locator(`[data-design-sidebar-panel] [data-design-layer-id="${id}"]`);
  const structure = () =>
    page.evaluate(() => ({
      parent: [...document.querySelectorAll("[data-design-structure-parent]")].map((element) => element.dataset.designStructureParentId),
      hoverParent: [...document.querySelectorAll("[data-design-structure-hover-parent]")].map((element) => element.dataset.designStructureHoverParent),
      children: [...document.querySelectorAll("[data-design-structure-child]")].map((element) => element.dataset.designStructureChild),
      constraint: document.querySelectorAll("[data-design-constraint-parent]").length,
    }));
  const settle = () => page.waitForTimeout(350);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open();
  await row("home-heading").click();
  await settle();
  const selected = await structure();
  const dots = await page.locator("[data-design-structure-parent]").evaluate((element) => {
    const style = getComputedStyle(element);
    return { image: style.backgroundImage, pointer: style.pointerEvents };
  });
  check(
    "a selected layer's parent is outlined in dots, and only that parent",
    JSON.stringify(selected.parent) === '["home-hero"]' && selected.children.length === 0 &&
      dots.image.includes("repeating-linear-gradient") && dots.pointer === "none",
    JSON.stringify({ selected, dots }),
  );
  await row("home-copy").click({ modifiers: ["Shift"] });
  await settle();
  const siblings = await structure();
  await row("home-services").click({ modifiers: ["Shift"] });
  await settle();
  const mixed = await structure();
  await row("home-hero").click();
  await settle();
  const rootChild = await structure();
  check(
    "siblings share their dotted parent; layers of different parents, or a parent on the frame edge, show none",
    JSON.stringify(siblings.parent) === '["home-hero"]' && mixed.parent.length === 0 && rootChild.parent.length === 0,
    JSON.stringify({ siblings, mixed, rootChild }),
  );

  const hero = await box("home-hero");
  const copy = await box("home-copy");
  const heading = await box("home-heading");
  await row("home-services").click();
  await page.mouse.move(5, 5);
  await page.keyboard.down("Meta");
  await page.mouse.move(hero.x + hero.width - 4, copy.y + copy.height / 2, { steps: 4 });
  await settle();
  const heroStructure = await structure();
  await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2, { steps: 4 });
  await settle();
  const headingStructure = await structure();
  await page.keyboard.up("Meta");
  await settle();
  const released = await structure();
  check(
    "⌘-hover dots the hovered layer's children and parent, and releasing ⌘ clears them",
    JSON.stringify(heroStructure.children) === '["home-heading","home-copy","home-action"]' &&
      heroStructure.hoverParent.length === 0 &&
      JSON.stringify(headingStructure.hoverParent) === '["home-hero"]' && headingStructure.children.length === 0 &&
      released.hoverParent.length === 0 && released.children.length === 0,
    JSON.stringify({ heroStructure, headingStructure, released }),
  );
  await page.keyboard.down("Control");
  await settle();
  const control = await structure();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await settle();
  const blurred = await structure();
  await page.keyboard.up("Control");
  check(
    "Ctrl reveals the same structure, and leaving the window drops it",
    JSON.stringify(control.hoverParent) === '["home-hero"]' && blurred.hoverParent.length === 0,
    JSON.stringify({ control, blurred }),
  );
  await row("home-heading").click();
  await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2);
  await page.keyboard.down("Meta");
  await settle();
  const overSelection = await structure();
  await page.keyboard.up("Meta");
  check(
    "⌘ over the selection draws its parent once",
    JSON.stringify(overSelection.parent) === '["home-hero"]' && overSelection.hoverParent.length === 0,
    JSON.stringify(overSelection),
  );

  await open("?mixedParents");
  await row("home-heading").click();
  await settle();
  const absolute = await structure();
  const pinned = await box("home-heading");
  await page.keyboard.down("Meta");
  await page.mouse.move(pinned.x + pinned.width / 2, pinned.y + pinned.height / 2, { steps: 3 });
  await settle();
  const absoluteHover = await structure();
  await page.keyboard.up("Meta");
  check(
    "a pinned layer's constraint parent is the one dotted parent, never doubled",
    absolute.constraint === 1 && absolute.parent.length === 0 && absoluteHover.hoverParent.length === 0,
    JSON.stringify({ absolute, absoluteHover }),
  );
  // A held gesture owns the pointer: the hover structure leaves mid-drag.
  await row("home-panel").click();
  await settle();
  const panel = await box("home-panel");
  const grab = { x: panel.x + panel.width / 2, y: panel.y + panel.height - 10 };
  await page.mouse.move(grab.x, grab.y);
  await page.keyboard.down("Meta");
  await settle();
  const beforeDrag = await page.locator("[data-design-structure-child]").count();
  const panelOverlay = page.locator('[data-design-element-overlay="home-panel"][data-design-selected-element]');
  const startBox = await panelOverlay.boundingBox();
  await page.mouse.down();
  await page.mouse.move(grab.x + 40, grab.y + 20, { steps: 6 });
  await page.waitForTimeout(150);
  const dragBox = await panelOverlay.boundingBox();
  const dragging = await page.locator("[data-design-structure-overlay]").count();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.keyboard.up("Meta");
  check(
    "a drag hides the ⌘ hover structure while the gesture holds the pointer",
    beforeDrag === 1 && dragBox.x - startBox.x > 5 && dragging === 0,
    JSON.stringify({ beforeDrag, startBox, dragBox, dragging }),
  );
}
// Exercise frame identity through real pointer events and the production
// inspector, including the empty frame that has no selectable child layers.
export async function runDesignSelectionSmoke({ page, waitFor, check }) {
  await runDesignDoubleClickSelectionSmoke({ page, check });
  await runDesignDescentHoverSmoke({ page, check });
  await runDesignLayerStructureSmoke({ page, check });
  await runDesignCanvasCursorSmoke({ page, check });
  const origin = new URL(page.url()).origin;
  const open = async (query) => {
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html${query}`,
      {
        waitUntil: "networkidle",
      },
    );
    await openLayersDrawer(page);
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
    "selecting the outer frame uses the canvas arrow without a movable root overlay",
    (await frameSelected()) &&
      (await frame.locator("[data-design-selected-element]").count()) === 0 &&
      (await page.evaluate(
        ({ x, y }) =>
          getComputedStyle(document.elementFromPoint(x, y)).cursor.includes(
            "zd-cursor-arrow",
          ),
        point,
      )) &&
      (await frame
        .locator("[data-design-frame-label]")
        .evaluate((el) => getComputedStyle(el).cursor.includes("zd-cursor-arrow"))),
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
  const menuItems = menu.getByRole("menuitem");
  check(
    "an empty frame's selection menu offers the frame once without document wrappers",
    (await menuItems.filter({ hasNotText: "Duplicate as independent frame" }).count()) === 1,
  );
  check(
    "the empty-frame selection menu exposes the independent-copy command separately",
    (await menu.getByRole("menuitem", { name: "Duplicate as independent frame", exact: true }).count()) === 1,
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
    const box = await designFrameElementBox(runtime.owner(), mark);
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
  const navBox = await designFrameElementBox(runtime.owner(), nav);
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
  const headingBox = await designFrameElementBox(runtime.owner(), runtime.locator('[data-oid="home-heading"]'));
  for (const child of ["home-hero", "home-heading"]) {
    await page.mouse.dblclick(
      headingBox.x + headingBox.width / 2,
      headingBox.y + headingBox.height * 0.4,
    );
    await expect.poll(() => selectedNode(child)).toBe(true);
    await expect(editor).toHaveCount(0);
  }
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
  const underPadding = await designFrameElementBox(runtime.owner(), runtime.locator('[data-oid="home-heading"]'));
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
  const paddingSelected = await waitFor(
    () => selectedNode("home-heading"),
    "padding-deep-selection",
  );
  check(
    "deep selection passes through padding controls to the authored layer underneath",
    paddingSelected,
    paddingSelected
      ? ""
      : JSON.stringify(
          await page.evaluate(() => ({
            selected: [
              ...document.querySelectorAll("[data-design-selected-element]"),
            ].map((element) =>
              element.getAttribute("data-design-element-overlay"),
            ),
            focused: document.activeElement?.getAttribute("aria-label"),
          })),
        ),
  );

  await open("?emptyFrame");
  // Three levels past the emitted Layers bound, whatever that bound is.
  const fixtureDepth =
    (await page.evaluate(
      async () =>
        (await import("/packages/protocol/src/design-runtime.ts"))
          .DESIGN_RUNTIME_TREE_DEPTH_LIMIT,
    )) + 3;
  await runtime.locator('[data-oid="home-main"]').evaluate((root, levels) => {
    let parent = root;
    for (let depth = 1; depth <= levels; depth += 1) {
      // Use a non-text leaf to exercise bounded container descent.
      const child = root.ownerDocument.createElement(
        depth === levels ? "canvas" : "div",
      );
      child.dataset.oid = `bounded-depth-${depth}`;
      child.style.cssText = "display:block;width:100%;height:100%";
      parent.append(child);
      parent = child;
    }
  }, fixtureDepth);
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
