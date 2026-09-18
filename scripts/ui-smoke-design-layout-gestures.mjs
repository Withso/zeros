import { expect } from "@playwright/test";

export async function runDesignLayoutGesturesSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures`,
    { waitUntil: "networkidle" },
  );
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const hero = runtime.locator('[data-oid="home-hero"]');
  const heading = runtime.locator('[data-oid="home-heading"]');
  const layout = page.locator("[data-design-layout-section]");
  const select = (id) =>
    page.locator(`#design-layers-panel [data-design-layer-id="${id}"]`).click();
  await select("home-hero");
  await expect(page.locator("[data-design-lint-review]")).toHaveCount(0);
  await expect(
    page.locator(
      '[data-design-element-overlay="home-hero"] [data-design-inline-gap-region]',
    ),
  ).toHaveCount(2);
  check("automatic layout exposes inline gap controls on its parent", true);
  await layout
    .getByRole("button", { name: "Independent padding", exact: true })
    .click();
  const padding = layout.getByLabel("Left", { exact: true });
  await padding.fill("21.7");
  await padding.press("Enter");
  await expect(padding).toHaveValue("22");
  const scrub = await layout
    .getByRole("button", { name: "Scrub Left", exact: true })
    .boundingBox();
  await page.keyboard.down("Shift");
  await page.mouse.move(scrub.x + scrub.width / 2, scrub.y + scrub.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    scrub.x + scrub.width / 2 + 4,
    scrub.y + scrub.height / 2,
    { steps: 4 },
  );
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(padding).toHaveValue("62");
  await expect
    .poll(() => hero.evaluate((el) => getComputedStyle(el).paddingLeft))
    .toBe("62px");
  check("padding commits whole pixels and Shift scrubbing moves in tens", true);

  const nestedBox = await heading.boundingBox();
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(
    nestedBox.x + nestedBox.width / 2,
    nestedBox.y + nestedBox.height / 2,
  );
  await page.keyboard.up("ControlOrMeta");
  await expect(
    page.locator('[data-design-layer-id="home-heading"][aria-selected="true"]'),
  ).toBeVisible();
  const peerBox = await runtime.locator('[data-oid="home-copy"]').boundingBox();
  await page.mouse.click(
    peerBox.x + peerBox.width / 2,
    peerBox.y + peerBox.height / 2,
  );
  await expect(
    page.locator('[data-design-layer-id="home-copy"][aria-selected="true"]'),
  ).toBeVisible();
  check(
    "flow drag handles preserve deep selection and ordinary peer clicks",
    true,
  );

  await select("home-heading");
  await layout
    .getByRole("button", { name: "Width resizing", exact: true })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: "Hug contents", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitemradio", { name: "Fill container", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const dragTo = async (target) => {
    const source = await page
      .locator('[data-design-element-overlay="home-heading"]')
      .boundingBox();
    await page.mouse.move(
      source.x + source.width / 2,
      source.y + source.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 12 });
    await page.mouse.up();
  };
  const last = await runtime.locator('[data-oid="home-action"]').boundingBox();
  await dragTo({ x: last.x + last.width * 0.8, y: last.y + last.height / 2 });
  await expect
    .poll(() =>
      hero.evaluate((el) =>
        [...el.children].map((child) => child.getAttribute("data-oid")),
      ),
    )
    .toEqual(["home-copy", "home-action", "home-heading"]);
  await expect.poll(() => heading.evaluate((el) => el.style.left)).toBe("auto");
  check(
    "dragging a flow child reorders siblings without positional offsets",
    true,
  );

  const parent = await hero.boundingBox();
  await dragTo({
    x: parent.x + parent.width + 70,
    y: parent.y + parent.height / 2,
  });
  await expect
    .poll(() =>
      heading.evaluate((el) => el.parentElement.getAttribute("data-oid")),
    )
    .toBe("home-main");
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).position))
    .toBe("absolute");
  const topGuide = page.locator(
    '[data-design-parent-guides="home-heading"] [data-design-parent-guide="top"]',
  );
  const parentGuides = page.locator(
    '[data-design-parent-guides="home-heading"]',
  );
  const mainWidth = await runtime
    .locator('[data-oid="home-main"]')
    .evaluate((el) => el.getBoundingClientRect().width);
  await expect
    .poll(async () =>
      Number(await parentGuides.getAttribute("data-parent-width")),
    )
    .toBe(mainWidth);
  await expect(topGuide).toBeVisible();
  const topDistance = async () => (await topGuide.boundingBox())?.height ?? 0;
  // The document is the reference while a preceding drag's inspector snapshot
  // catches up. Do not capture a transient guide value as the cancel target.
  const initialNodeBox = await heading.boundingBox();
  const initialParentBox = await runtime
    .locator('[data-oid="home-main"]')
    .boundingBox();
  const restingDistance = initialNodeBox.y - initialParentBox.y;
  const freeY = layout.getByLabel("Y", { exact: true });
  await freeY.evaluate((input) => {
    input.dataset.dragIdentity = "free-y";
  });
  const freeBox = await page
    .locator('[data-design-element-overlay="home-heading"]')
    .boundingBox();
  await page.mouse.move(
    freeBox.x + freeBox.width / 2,
    freeBox.y + freeBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    freeBox.x + freeBox.width / 2,
    freeBox.y + freeBox.height / 2 + 24,
    { steps: 4 },
  );
  await expect.poll(topDistance).toBeGreaterThan(restingDistance + 12);
  await expect(freeY).toHaveAttribute("data-drag-identity", "free-y");
  await expect
    .poll(
      async () =>
        Number(await freeY.inputValue()) -
        (await heading.evaluate((el) =>
          Math.round(parseFloat(getComputedStyle(el).top)),
        )),
    )
    .toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await expect
    .poll(async () => Math.abs((await topDistance()) - restingDistance))
    .toBeLessThan(1.5);
  check(
    "free-position drag paints its parent distance guides and cancellation restores them",
    true,
  );
  await dragTo({ x: parent.x + 100, y: parent.y + 70 });
  await expect
    .poll(() =>
      heading.evaluate((el) => el.parentElement.getAttribute("data-oid")),
    )
    .toBe("home-hero");
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).position))
    .toBe("relative");
  check(
    "leaving and reentering a parent changes hierarchy and restores flow",
    true,
  );

  // The harness deliberately holds history replies for half a second. The
  // visible inverse must paint first, retaining the exact iframe and element.
  await select("home-heading");
  const width = layout.getByLabel("W", { exact: true });
  await width.fill("160");
  await width.press("Enter");
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).width))
    .toBe("160px");
  await page.waitForTimeout(150);
  await heading.evaluate((el) => {
    window.__layoutRetainedElement = el;
  });
  await page.locator("[data-design-canvas-viewport]").focus();
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).width), {
      timeout: 300,
      intervals: [10],
    })
    .toBe("100px");
  check(
    "undo paints before the delayed persistence reply",
    (await page.evaluate(() =>
      window.__zerosHarnessDesignShortcutOperations.at(-1),
    )) === "history:waiting",
  );
  await page.waitForTimeout(550);
  await expect
    .poll(() => heading.evaluate((el) => el === window.__layoutRetainedElement))
    .toBe(true);
  await page.keyboard.press("Control+Shift+z");
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).width), {
      timeout: 300,
      intervals: [10],
    })
    .toBe("160px");
  await page.waitForTimeout(550);
  check(
    "redo retains the mounted document and selected element",
    await heading.evaluate((el) => el === window.__layoutRetainedElement),
  );

  // A real cross-document transfer takes much longer than a preview. Its
  // pixels must stay at the drop, including every frame before confirmation.
  await select("home-heading");
  const beforeSizing = await page.evaluate(
    () =>
      window.__zerosHarnessDesignShortcutOperations.filter(
        (op) => op === "style:end",
      ).length,
  );
  await page.evaluate(() => {
    window.__zerosHarnessStyleDelay = 1500;
  });
  await layout
    .getByRole("button", { name: "Width resizing", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Fill container", exact: true })
    .click();
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).flexGrow))
    .toBe("1");
  await layout
    .getByRole("button", { name: "Width resizing", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Fixed width", exact: true })
    .click();
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).flexGrow), {
      timeout: 300,
      intervals: [10],
    })
    .toBe("0");
  check(
    "a second sizing choice paints while the first choice is still saving",
    (await page.evaluate(
      () =>
        window.__zerosHarnessDesignShortcutOperations.filter(
          (op) => op === "style:end",
        ).length,
    )) === beforeSizing,
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.__zerosHarnessDesignShortcutOperations.at(-1)),
    )
    .toBe("style:end");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__zerosHarnessDesignShortcutOperations.filter(
            (op) => op === "style:end",
          ).length,
      ),
    )
    .toBe(beforeSizing + 2);
  await page.evaluate(() => {
    window.__zerosHarnessStyleDelay = 50;
  });
  await page.locator("[data-design-canvas-viewport]").focus();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).width), {
      timeout: 300,
      intervals: [10],
    })
    .toBe("160px");
  check("two quick undo commands paint both inverses before persistence", true);
  await page.waitForTimeout(1100);
  const undoneWidth = await heading.evaluate(
    (el) => getComputedStyle(el).width,
  );
  await page.keyboard.press("Control+Shift+z");
  await page.keyboard.press("Control+Shift+z");
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).width), {
      timeout: 300,
      intervals: [10],
    })
    .not.toBe(undoneWidth);
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).flexGrow), {
      timeout: 300,
      intervals: [10],
    })
    .toBe("0");
  check(
    "two quick redo commands paint both forward changes before persistence",
    true,
  );
  await page.waitForTimeout(1100);
  // The drag reuses exact-revision cached pixels. Undo/redo can invalidate a
  // selection-triggered background capture; explicitly qualify that precondition
  // instead of treating a fixed delay as proof that a new capture completed.
  await expect.poll(() => page.evaluate(async () => {
    const { captureDesignRuntimeScreenshot } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts");
    const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const snapshot = designWorkspaceSnapshotCache.getSnapshot("ws_design_harness").data;
    const frame = snapshot.frames.find((item) => item.file === "home.html");
    return !!await captureDesignRuntimeScreenshot("ws_design_harness", snapshot.lint.workspacePath, frame.file, frame.sourceVersion, "home-heading", 1);
  })).toBe(true);
  const sourceFrame = await page
    .locator('[data-design-frame="home.html"]')
    .boundingBox();
  const sourceBox = await heading.boundingBox();
  const destination = {
    x: sourceFrame.x + sourceFrame.width / 2,
    y: sourceFrame.y + sourceFrame.height + 50,
  };
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(destination.x, destination.y, { steps: 12 });
  const dragPaint = page.locator('[data-design-drag-preview="home-heading"]');
  await expect(dragPaint).toBeVisible({ timeout: 300 });
  await expect(dragPaint.locator("img")).toBeVisible();
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(() => window.__zerosHarnessDesignShortcutOperations.at(-1)),
    )
    .toBe("transfer:waiting");
  await page.waitForTimeout(200);
  await expect(dragPaint).toBeVisible();
  const retained = await dragPaint.boundingBox();
  check(
    "cross-frame drop keeps its pixels at the pointer before persistence",
    Math.abs(retained.x + retained.width / 2 - destination.x) < 2 &&
      Math.abs(retained.y + retained.height / 2 - destination.y) < 2,
  );
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("0");
  const detached = page.locator(
    '[data-design-frame="detached.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  await expect(detached).toBeVisible();
  await expect(dragPaint).toHaveCount(0);
  await expect(
    page
      .frameLocator(
        '[data-design-frame="detached.html"] iframe[data-design-document-buffer="displayed"]',
      )
      .locator('[data-oid="home-heading"]'),
  ).toBeVisible();
  check(
    "confirmed cross-frame transfer releases its cover only after the destination is ready",
    true,
  );

  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures&rejectTransfer`,
    { waitUntil: "networkidle" },
  );
  const movableFrame = page.locator('[data-design-frame="home.html"]');
  const initialFrame = await movableFrame.boundingBox();
  const moveFrame = async () => {
    const label = await movableFrame
      .locator("[data-design-frame-label]")
      .boundingBox();
    await page.mouse.move(
      label.x + label.width / 2,
      label.y + label.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      label.x + label.width / 2 + 40,
      label.y + label.height / 2 + 20,
      { steps: 4 },
    );
    await page.mouse.up();
  };
  await page.keyboard.down("Control");
  await moveFrame();
  await moveFrame();
  await page.keyboard.up("Control");
  await expect
    .poll(
      async () =>
        Math.round((await movableFrame.boundingBox()).x - initialFrame.x),
      { timeout: 300, intervals: [10] },
    )
    .toBe(80);
  await page.waitForTimeout(1500);
  await expect
    .poll(async () =>
      Math.round((await movableFrame.boundingBox()).x - initialFrame.x),
    )
    .toBe(80);
  check(
    "back-to-back frame drags start at the visible position and survive older save replies",
    true,
  );
  await select("home-heading");
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).width))
    .toBe("100px");
  const failedFrame = await page
    .locator('[data-design-frame="home.html"]')
    .boundingBox();
  const failedStart = await heading.boundingBox();
  await page.mouse.move(
    failedStart.x + failedStart.width / 2,
    failedStart.y + failedStart.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    failedFrame.x + failedFrame.width / 2,
    failedFrame.y + failedFrame.height + 50,
    { steps: 12 },
  );
  await expect(dragPaint).toBeVisible();
  await page.mouse.up();
  await expect(
    page.getByText("Couldn't move the layer", { exact: true }),
  ).toBeVisible();
  await expect(dragPaint).toHaveCount(0);
  await expect
    .poll(() => heading.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");
  await expect
    .poll(() =>
      heading.evaluate((el) => el.parentElement.getAttribute("data-oid")),
    )
    .toBe("home-hero");
  await expect(page.locator('[data-design-frame="detached.html"]')).toHaveCount(
    0,
  );
  check(
    "a failed transfer restores the original layer and releases its temporary pixels",
    true,
  );
}
