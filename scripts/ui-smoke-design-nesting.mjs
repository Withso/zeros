import { expect } from "@playwright/test";

async function openTwoFrames(page) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures`,
    { waitUntil: "networkidle" },
  );
  // Earlier scenarios on a shared page can leave another directory bound in
  // the persisted Design view and boot snapshot. Clear both in this document
  // (an unloading page would write them back) and mount once more.
  await page.evaluate(async () => {
    const { resetDesignWorkspaceUiForTests } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    resetDesignWorkspaceUiForTests();
    localStorage.removeItem("zeros-design-workspace-snapshots-v1");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const { useDesignWorkspaceUiStore } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    // Both fixture frames on screen: home at x 0, pricing at x 1,560.
    useDesignWorkspaceUiStore.getState().setViewport("ws_design_harness", {
      zoom: 0.25,
      panX: 80,
      panY: 160,
    });
  });
  await expect(page.locator('[data-design-frame="pricing.html"]')).toBeVisible();
  await expect(
    page.locator(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    ),
  ).toHaveCount(1);
}

const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const frameMoves = (page) =>
  page.evaluate(() => window.__zerosHarnessFrameMoves ?? []);

/** Design-tool frame moves: the frame under the pointer is outlined as the
 * nesting target, Control skips nesting, Escape restores, and several selected
 * frames drag and nudge together in one canvas write. */
export async function runDesignNestingSmoke({ page, check }) {
  await openTwoFrames(page);
  const home = page.locator('[data-design-frame="home.html"]');
  const pricing = page.locator('[data-design-frame="pricing.html"]');
  const homeLabel = home.locator("[data-design-frame-label]");
  const pricingLabel = pricing.locator("[data-design-frame-label]");
  const outlined = page.locator("[data-design-nest-target]");

  const homeBefore = await home.boundingBox();
  const grab = center(await homeLabel.boundingBox());
  const over = center(await pricing.boundingBox());
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(over.x, over.y, { steps: 8 });
  await expect(
    page.locator('[data-design-frame="pricing.html"][data-design-nest-target]'),
  ).toHaveCount(1);
  await expect(outlined).toHaveCount(1);
  check("dragging a frame over another outlines the frame it would nest into", true);

  await page.keyboard.down("Control");
  await page.mouse.move(over.x + 6, over.y + 4, { steps: 2 });
  await expect(outlined).toHaveCount(0);
  await page.keyboard.up("Control");
  await page.mouse.move(over.x + 10, over.y + 8, { steps: 2 });
  await expect(
    page.locator('[data-design-frame="pricing.html"][data-design-nest-target]'),
  ).toHaveCount(1);
  check("Control moves a frame over another without nesting; releasing Control nests again", true);

  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(outlined).toHaveCount(0);
  await expect
    .poll(async () => Math.abs((await home.boundingBox()).x - homeBefore.x))
    .toBeLessThan(1);
  check("Escape clears the outline and restores the dragged frame", true);

  await homeLabel.click();
  await pricingLabel.click({ modifiers: ["Shift"] });
  const homeStart = await home.boundingBox();
  const pricingStart = await pricing.boundingBox();
  const groupGrab = center(await homeLabel.boundingBox());
  await page.mouse.move(groupGrab.x, groupGrab.y);
  await page.mouse.down();
  await page.mouse.move(groupGrab.x + 60, groupGrab.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await frameMoves(page)).length).toBe(1);
  const [dragged] = await frameMoves(page);
  expect(dragged.map((move) => move.frame).sort()).toEqual(["home.html", "pricing.html"]);
  const dx = dragged[0].to.x - dragged[0].from.x;
  const dy = dragged[0].to.y - dragged[0].from.y;
  expect(Math.abs(dx) + Math.abs(dy)).toBeGreaterThan(0);
  expect(dragged.every((move) => move.to.x - move.from.x === dx && move.to.y - move.from.y === dy)).toBe(true);
  await expect
    .poll(async () => Math.abs((await pricing.boundingBox()).x - pricingStart.x - ((await home.boundingBox()).x - homeStart.x)))
    .toBeLessThan(1);
  check("several selected frames drag together in one canvas write", true);

  // The nudge lifecycle of one frame: presses while the key is held land as
  // one write on release; Escape and leaving the window restore unsaved ones.
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(500);
  expect((await frameMoves(page)).length).toBe(1);
  await page.keyboard.up("ArrowRight");
  await expect.poll(async () => (await frameMoves(page)).length).toBe(2);
  const nudged = (await frameMoves(page))[1];
  expect(nudged.map((move) => move.frame).sort()).toEqual(["home.html", "pricing.html"]);
  expect(nudged.every((move) => move.to.x - move.from.x === 2 && move.to.y === move.from.y)).toBe(true);
  check("holding an arrow key nudges several selected frames together in one write on release", true);

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await frameMoves(page)).length).toBe(4);
  const pressed = (await frameMoves(page)).slice(2);
  expect(pressed.every((moves) => moves.length === 2 && moves.every((move) => move.to.x - move.from.x === 1))).toBe(true);
  expect(pressed[1][0].from.x).toBe(pressed[0][0].to.x);
  check("a press while the last nudge saves moves the frames from its saved place", true);

  for (const cancel of ["Escape", "blur"]) {
    const homeHeld = await home.boundingBox();
    const pricingHeld = await pricing.boundingBox();
    await page.keyboard.down("ArrowDown");
    await expect.poll(async () => (await home.boundingBox()).y - homeHeld.y).toBeGreaterThan(0);
    if (cancel === "Escape") await page.keyboard.press("Escape");
    else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.keyboard.up("ArrowDown");
    await expect.poll(async () => Math.abs((await home.boundingBox()).y - homeHeld.y)).toBeLessThan(0.01);
    await expect.poll(async () => Math.abs((await pricing.boundingBox()).y - pricingHeld.y)).toBeLessThan(0.01);
    await page.waitForTimeout(500);
    expect((await frameMoves(page)).length).toBe(4);
    await page.getByLabel("Design canvas", { exact: true }).focus();
    check(`${cancel === "Escape" ? "Escape" : "Leaving the window"} restores a multi-frame nudge without saving it`, true);
  }
  await runDesignFrameNestingDropSmoke({ page, check });
}

const harnessView = (page) =>
  page.evaluate(async () => {
    const { designWorkspaceView } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const view = designWorkspaceView("ws_design_harness");
    return { selectedFrame: view.selectedFrame, selectedNodeId: view.selectedNodeId, frameSelected: view.frameSelected,
      zoom: view.zoom, panX: view.panX, panY: view.panY };
  });

/** Releasing a frame over another nests it there as one layer, as in a design
 * tool: the nested layer stays selected and the camera does not move, even
 * though the dragged frame's own file leaves the canvas while it saves. */
export async function runDesignFrameNestingDropSmoke({ page, check }) {
  await openTwoFrames(page);
  const home = page.locator('[data-design-frame="home.html"]');
  const pricing = page.locator('[data-design-frame="pricing.html"]');
  await expect(
    page.locator('[data-design-frame="pricing.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]'),
  ).toHaveCount(1);
  const grab = center(await home.locator("[data-design-frame-label]").boundingBox());
  const target = await pricing.boundingBox();
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 3, { steps: 8 });
  await expect(page.locator('[data-design-frame="pricing.html"][data-design-nest-target]')).toHaveCount(1);
  const before = await harnessView(page);
  const samples = [];
  const sampling = page.evaluate(async () => {
    const { designWorkspaceView } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const seen = [];
    const until = performance.now() + 2_500;
    while (performance.now() < until) {
      const view = designWorkspaceView("ws_design_harness");
      seen.push(`${view.selectedFrame}|${view.selectedNodeId}|${view.panX},${view.panY},${view.zoom}`);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return [...new Set(seen)];
  });
  await page.mouse.up();
  await expect(home).toHaveCount(0);
  await expect.poll(async () => (await harnessView(page)).selectedNodeId ?? "").not.toBe("");
  samples.push(...(await sampling));
  const after = await harnessView(page);
  expect(after).toMatchObject({ selectedFrame: "pricing.html", zoom: before.zoom, panX: before.panX, panY: before.panY });
  // Never another frame, never a moved camera, at any sampled frame.
  expect(samples.every((sample) => /^(home|pricing)\.html\|/.test(sample) && sample.endsWith(`|${before.panX},${before.panY},${before.zoom}`)), samples.join("\n")).toBe(true);
  await expect(page.locator(`[data-design-frame="pricing.html"] iframe[data-design-document-buffer="displayed"]`)).toHaveCount(1);
  check("a frame released over another nests there, its layer stays selected and the camera never moves", true);
}
