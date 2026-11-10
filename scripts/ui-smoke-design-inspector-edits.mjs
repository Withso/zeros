import { expect } from "@playwright/test";
import { addDesignSection, openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

async function openHeading(page) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  await openLayersDrawer(page);
  await page
    .locator(
      '[data-design-sidebar-panel] [data-design-layer-id="home-heading"]',
    )
    .click();
}

const writes = (page) =>
  page.evaluate(
    () =>
      (window.__zerosHarnessDesignShortcutOperations ?? []).filter(
        (op) => op === "style:end",
      ).length,
  );

async function savedStyle(page, property) {
  return page.evaluate(async (property) => {
    const { designFrame } =
      await import("/apps/desktop/src/renderer/platform/git.ts");
    const { source } = await designFrame("ws_design_harness", "home.html");
    return new DOMParser()
      .parseFromString(source, "text/html")
      .querySelector('[data-oid="home-heading"]')
      .style.getPropertyValue(property);
  }, property);
}

export async function runDesignTransformCommitSmoke({ page, check }) {
  await openHeading(page);
  // The heading has no transform, so its section is added: that opens the
  // editor the empty section's + used to open.
  await addDesignSection(page, "Transform");
  const x = page.getByRole("textbox", { name: "Translate X", exact: true });
  await x.focus();
  await x.press("ArrowUp");
  await x.press("Enter");
  await expect.poll(() => writes(page)).toBe(1);
  await expect
    .poll(() => savedStyle(page, "transform"))
    .toBe("translate(1px, 0px)");
  const scrub = await page
    .getByRole("button", { name: "Scrub Translate X", exact: true })
    .boundingBox();
  await x.focus();
  await page.mouse.move(scrub.x + scrub.width / 2, scrub.y + scrub.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    scrub.x + scrub.width / 2 + 40,
    scrub.y + scrub.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  await x.press("Tab");
  await expect.poll(() => writes(page)).toBe(2);
  await expect
    .poll(() => savedStyle(page, "transform"))
    .toBe("translate(21px, 0px)");
  await x.focus();
  await x.press("ArrowUp");
  await x.press("Escape");
  await expect(x).toHaveValue("21");
  await expect
    .poll(() => savedStyle(page, "transform"))
    .toBe("translate(21px, 0px)");
  expect(await writes(page)).toBe(2);
  check(
    "transform scrubs and arrow steps save once; Escape restores the committed value",
    true,
  );
}

/** A scrub's value previews in the same frame the shared pointer owner
 * samples its move, as a canvas drag does; a second wait for the next frame
 * added a frame of lag to every inspector scrub. Ordering, not a timing
 * threshold: at most the sampling frame may run between move and request. */
export async function runDesignScrubLeadingPreviewSmoke({ page, check }) {
  await openHeading(page);
  await page.evaluate(async () => {
    const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
    const runtime = designFrameRuntime("ws_design_harness", "home.html");
    const state = { tick: 0, moveTick: -1, previews: [] };
    window.__scrubOrdering = state;
    const count = () => { state.tick += 1; requestAnimationFrame(count); };
    requestAnimationFrame(count);
    window.addEventListener("pointermove", () => { state.moveTick = state.tick; }, true);
    const previewGeometry = runtime.previewGeometry.bind(runtime);
    runtime.previewGeometry = (...args) => {
      state.previews.push({ tick: state.tick, moveTick: state.moveTick });
      return previewGeometry(...args);
    };
  });
  const scrub = await page.getByRole("button", { name: "Scrub Size", exact: true }).boundingBox();
  const start = { x: scrub.x + scrub.width / 2, y: scrub.y + scrub.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y);
  await expect.poll(() => page.evaluate(() => window.__scrubOrdering.previews.length)).toBeGreaterThan(0);
  const first = await page.evaluate(() => window.__scrubOrdering.previews[0]);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(first.tick - first.moveTick, JSON.stringify(first)).toBeLessThanOrEqual(1);
  check("an inspector scrub previews in the frame its move is sampled, not a frame later", true);
}

export async function runDesignColorInputRacesSmoke({ page, check }) {
  await openHeading(page);
  await page.evaluate(() => {
    window.__zerosHarnessStyleDelay = 1200;
  });
  const hex = page.getByRole("textbox", { name: "Fill", exact: true });
  const alpha = page.getByRole("textbox", {
    name: "Fill opacity",
    exact: true,
  });
  await hex.fill("FF0000");
  await hex.press("Enter");
  await alpha.fill("50");
  await alpha.press("Enter");
  await expect.poll(() => writes(page), { timeout: 8000 }).toBe(2);
  await expect
    .poll(() => savedStyle(page, "color"))
    .toMatch(/^rgba\(255, 0, 0, 0\.5[0-9]*\)$/);
  await expect(hex).toHaveValue("FF0000");
  await expect(alpha).toHaveValue("50");
  await alpha.fill("25");
  await alpha.press("Enter");
  await hex.fill("00FF00");
  await hex.press("Enter");
  await expect.poll(() => writes(page), { timeout: 8000 }).toBe(4);
  await expect
    .poll(() => savedStyle(page, "color"))
    .toMatch(/^rgba\(0, 255, 0, 0\.25[0-9]*\)$/);
  await hex.focus();
  await page.evaluate(async () => {
    const { designWorkspaceSnapshotCache, updateDesignNodeStylesCached } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const workspaceId = "ws_design_harness";
    const frame = designWorkspaceSnapshotCache
      .peekSnapshot(workspaceId)
      .data.frames.find((item) => item.file === "home.html");
    await updateDesignNodeStylesCached(workspaceId, {
      frame: frame.file,
      sourceVersion: frame.sourceVersion,
      nodeId: "home-heading",
      styles: { color: "blue" },
    });
  });
  await expect(alpha).toHaveValue("100");
  await hex.press("Tab");
  await expect(hex).toHaveValue("0000FF");
  expect(await writes(page)).toBe(5);
  expect(await savedStyle(page, "color")).toBe("blue");
  check(
    "successive hex and opacity edits preserve both channels while saves are pending",
    true,
  );
}

/** A focused Style field showing its committed value has no text history of
 * its own: Command-Z there reaches the design, and the field shows what the
 * undo left behind. */
export async function runDesignFieldHistorySmoke({ page, check }) {
  // This harness keeps a source history, so an undo really restores the style.
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures`,
    { waitUntil: "networkidle" },
  );
  await openLayersDrawer(page);
  await page
    .locator('[data-design-sidebar-panel] [data-design-layer-id="home-heading"]')
    .click();
  const width = page.getByRole("textbox", { name: "W", exact: true });
  await expect(width).toHaveValue("100");
  for (const expected of ["101px", "102px"]) {
    await width.focus();
    await width.press("ArrowUp");
    await width.press("Enter");
    await expect.poll(() => savedStyle(page, "width")).toBe(expected);
  }
  await width.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => savedStyle(page, "width")).toBe("101px");
  await expect(width).toHaveValue("101");
  // The step takes focus off the field; the next one still belongs to Design.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => savedStyle(page, "width")).toBe("100px");
  await expect(width).toHaveValue("100");
  await width.focus();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => savedStyle(page, "width")).toBe("101px");
  await expect(width).toHaveValue("101");

  await addDesignSection(page, "Transform");
  const y = page.getByRole("textbox", { name: "Translate Y", exact: true });
  for (const expected of ["translate(0px, 1px)", "translate(0px, 2px)"]) {
    await y.focus();
    await y.press("ArrowUp");
    await y.press("Enter");
    await expect.poll(() => savedStyle(page, "transform")).toBe(expected);
  }
  await y.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() => savedStyle(page, "transform"))
    .toBe("translate(0px, 1px)");
  // The popover is still open; it shows what the undo left.
  await expect(y).toHaveValue("1");
  // Shift+A adds auto layout from the canvas; in a field it is a capital A.
  await y.focus();
  await y.press("Shift+A");
  await expect(y).toHaveValue("1A");
  await y.press("Escape");
  await expect(y).toHaveValue("1");
  await expect
    .poll(() => savedStyle(page, "transform"))
    .toBe("translate(0px, 1px)");
  // The next edit builds on what the undo left; a stale popover draft would
  // write the undone 2px back.
  const x = page.getByRole("textbox", { name: "Translate X", exact: true });
  await x.focus();
  await x.press("ArrowUp");
  await x.press("Enter");
  await expect
    .poll(() => savedStyle(page, "transform"))
    .toBe("translate(1px, 1px)");
  check(
    "undo and redo work from a focused Style field, which shows the result; typing there stays typing",
    true,
  );
}

/** An open fill popover holds its gradient draft back from outside values;
 * the person's own undo is not an outside value. */
export async function runDesignFillHistorySmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures`,
    { waitUntil: "networkidle" },
  );
  await openLayersDrawer(page);
  await page
    .locator('[data-design-sidebar-panel] [data-design-layer-id="home-heading"]')
    .click();
  await page.getByRole("button", { name: "Edit fill", exact: true }).click();
  const popover = page.locator("[data-design-popover]");
  await popover.getByRole("button", { name: "Gradient", exact: true }).click();
  await expect
    .poll(() => savedStyle(page, "background-image"))
    .toMatch(/^linear-gradient\(/);
  const angle = popover.getByRole("textbox", {
    name: "Gradient angle value",
    exact: true,
  });
  for (const degrees of ["45", "90"]) {
    await angle.fill(degrees);
    await angle.press("Enter");
    await expect
      .poll(() => savedStyle(page, "background-image"))
      .toMatch(new RegExp(`^linear-gradient\\(${degrees}deg,`));
  }
  await popover.getByRole("button", { name: "Start stop", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() => savedStyle(page, "background-image"))
    .toMatch(/^linear-gradient\(45deg,/);
  await expect(popover).toBeVisible();
  await expect(angle).toHaveValue("45");
  // The next edit builds on what the undo left, not on the undone 90deg.
  await popover.getByRole("button", { name: "Start stop", exact: true }).focus();
  await popover
    .getByRole("combobox", { name: "Gradient type", exact: true })
    .click();
  await page.getByRole("option", { name: "Radial", exact: true }).click();
  await expect
    .poll(() => savedStyle(page, "background-image"))
    .toMatch(/^radial-gradient\(/);
  await popover.getByRole("combobox", { name: "Gradient type", exact: true }).click();
  await page.getByRole("option", { name: "Linear", exact: true }).click();
  await expect
    .poll(() => savedStyle(page, "background-image"))
    .toMatch(/^linear-gradient\(45deg,/);
  check(
    "undo with the fill popover open shows the undone gradient there, and the next edit builds on it",
    true,
  );
}

export async function runDesignInspectorEditsSmoke(context) {
  await runDesignTransformCommitSmoke(context);
  await runDesignFieldHistorySmoke(context);
  await runDesignFillHistorySmoke(context);
  await runDesignScrubLeadingPreviewSmoke(context);
  await runDesignColorInputRacesSmoke(context);
  await runDesignPaintRemovalSmoke(context);
  await runDesignMixedSelectionSmoke(context);
}

/** Two text layers that differ read Mixed everywhere they differ, never a
 * single value; one edit then sets both. */
export async function runDesignMixedSelectionSmoke({ page, check }) {
  await openHeading(page);
  await page
    .locator('[data-design-sidebar-panel] [data-design-layer-id="home-copy"]')
    .click({ modifiers: ["Shift"] });
  const inspector = page.locator("[data-design-inspector]");
  const width = inspector.getByRole("textbox", { name: "W", exact: true });
  const fill = inspector
    .locator("[data-design-fill-section]")
    .getByRole("textbox", { name: "Fill", exact: true });
  await expect(width).toHaveValue("");
  await expect(width).toHaveAttribute("placeholder", "Mixed");
  await expect(fill).toHaveValue("");
  await expect(fill).toHaveAttribute("placeholder", "Mixed");
  await expect(
    inspector.locator("[data-design-fill-section] [data-design-color-mixed]"),
  ).toHaveCount(1);
  check("two differing text layers read Mixed for W and Fill, behind a neutral swatch", true);
  await fill.fill("112233");
  await fill.press("Enter");
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  for (const id of ["home-heading", "home-copy"])
    await expect
      .poll(() =>
        runtime.locator(`[data-oid="${id}"]`).evaluate((element) => getComputedStyle(element).color),
      )
      .toBe("rgb(17, 34, 51)");
  await expect(fill).toHaveValue(/^112233$/i);
  check("a colour typed over Mixed sets every selected layer and ends Mixed", true);
}

export async function runDesignPaintRemovalSmoke({ page, check }) {
  await openHeading(page);
  await page.evaluate(async () => {
    const { designWorkspaceSnapshotCache, updateDesignNodeStylesCached } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const workspaceId = "ws_design_harness";
    const frame = designWorkspaceSnapshotCache
      .peekSnapshot(workspaceId)
      .data.frames.find((item) => item.file === "home.html");
    await updateDesignNodeStylesCached(workspaceId, {
      frame: frame.file,
      sourceVersion: frame.sourceVersion,
      nodeId: "home-hero",
      styles: { border: "2px solid red", background: "blue" },
    });
  });
  await page
    .locator('[data-design-sidebar-panel] [data-design-layer-id="home-hero"]')
    .click();
  // Position lives in Stroke settings with the style and per-side widths.
  await page
    .getByRole("button", { name: "Stroke settings", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Stroke position", exact: true })
    .click();
  await page.getByRole("option", { name: "Outside", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove stroke", exact: true }),
  ).toHaveCount(0);
  const removeOutline = page.getByRole("button", {
    name: "Remove outline",
    exact: true,
  });
  await expect(removeOutline).toBeVisible();
  await removeOutline.click();
  await expect(removeOutline).toHaveCount(0);
  const removeFill = page.getByRole("button", {
    name: "Remove fill",
    exact: true,
  });
  await removeFill.click();
  await expect(removeFill).toHaveCount(0);
  check(
    "moving and removing shorthand paint clears its original stroke and fill rows",
    true,
  );
}
