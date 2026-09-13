// An empty authored frame exercises the real creation path, unlike the seeded
// landing page. All source edits go through the harness's in-memory Design API.
export async function runDesignFrameChildrenSmoke({ page, waitFor, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?emptyFrame`,
    { waitUntil: "networkidle" },
  );
  const layers = page.locator("#design-layers-panel");
  const layout = page.locator("[data-design-layout-section]");
  const frame = page.locator('[data-design-frame="home.html"]');
  const runtime = () =>
    page.frameLocator(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    );
  const committed = async (action) => {
    const root = runtime().locator('[data-oid="home-main"]');
    const before = await root.evaluate(
      (el) => el.ownerDocument.defaultView.__zerosDesignSourceVersion,
    );
    await action();
    await waitFor(
      () =>
        root.evaluate(
          (el, before) =>
            el.ownerDocument.defaultView.__zerosDesignSourceVersion !== before,
          before,
        ),
      "frame-style-committed",
    );
  };
  await frame.locator("[data-design-frame-label]").click();
  await waitFor(
    () => runtime().locator('[data-oid="home-main"]').count(),
    "empty-frame-runtime",
  );
  check(
    "an empty canvas frame has no duplicate root layer or child controls",
    (await layers.locator('[data-design-layer-id="home-main"]').count()) ===
      0 &&
      (await layout
        .getByRole("button", { name: "Align left", exact: true })
        .count()) === 0 &&
      (await layout.locator("[data-design-layout-constraints]").count()) === 0,
  );
  const frameCount = await page.locator("[data-design-frame]").count();
  const draw = async () => {
    await page.getByRole("button", { name: "Frame tool", exact: true }).click();
    const bounds = await frame.boundingBox();
    await page.mouse.move(
      bounds.x + bounds.width * 0.25,
      bounds.y + bounds.height * 0.25,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width * 0.6,
      bounds.y + bounds.height * 0.5,
      { steps: 6 },
    );
    await page.mouse.up();
  };
  await draw();
  await waitFor(
    () => runtime().locator('[data-oid="home-main"] > [data-oid]').count(),
    "drawn-child-frame",
  );
  const childId = await runtime()
    .locator('[data-oid="home-main"] > [data-oid]')
    .getAttribute("data-oid");
  check(
    "drawing inside a frame creates one real child, not another canvas document",
    (await page.locator("[data-design-frame]").count()) === frameCount,
  );
  const childRow = layers.locator(`[data-design-layer-id="${childId}"]`);
  await childRow.click();
  check(
    "the new empty child starts with None and hides child controls",
    (await layout
      .getByRole("button", { name: "Auto layout: None", exact: true })
      .getAttribute("aria-pressed")) === "true" &&
      (await layout.locator("[data-design-layout-constraints]").count()) === 0,
  );
  await frame.locator("[data-design-frame-label]").click();
  check(
    "a frame with a real child exposes enabled alignment and constraints in None",
    (await layout
      .getByRole("button", { name: "Align left", exact: true })
      .isEnabled()) &&
      (await layout
        .getByRole("button", { name: "Pin right", exact: true })
        .isEnabled()),
  );
  for (const [targetId, otherId, mode, display] of [
    ["home-main", childId, "Stack", "flex"],
    [childId, "home-main", "Grid", "grid"],
    ["home-main", childId, "None", "block"],
  ]) {
    if (targetId === "home-main")
      await frame.locator("[data-design-frame-label]").click();
    else await childRow.click();
    const other = runtime().locator(`[data-oid="${otherId}"]`);
    const before = await other.evaluate((el) => el.style.cssText);
    await committed(() =>
      layout
        .getByRole("button", { name: `Auto layout: ${mode}`, exact: true })
        .click(),
    );
    check(
      `${mode} applies only to its selected frame`,
      await waitFor(
        async () =>
          (await runtime()
            .locator(`[data-oid="${targetId}"]`)
            .evaluate(
              (el, display) => el.style.display === display,
              display,
            )) &&
          (await other.evaluate(
            (el, before) => el.style.cssText === before,
            before,
          )),
        `isolated-${mode}`,
      ),
    );
  }
  const root = runtime().locator('[data-oid="home-main"]');
  const child = runtime().locator(`[data-oid="${childId}"]`);
  const rootStyle = await root.evaluate((el) => el.style.cssText);
  await childRow.click();
  await committed(() =>
    layout.getByRole("button", { name: "Rotate 90° clockwise" }).click(),
  );
  await committed(() =>
    layout.getByText("Clip content", { exact: true }).click(),
  );
  check(
    "rotation and clipping on a child leave the parent's declarations unchanged",
    await root.evaluate((el, before) => el.style.cssText === before, rootStyle),
  );
  await frame.locator("[data-design-frame-label]").click();
  const childStyle = await child.evaluate((el) => el.style.cssText);
  await committed(() =>
    layout.getByText("Clip content", { exact: true }).click(),
  );
  const opacity = page
    .locator("[data-design-inspector]")
    .getByLabel("Opacity", { exact: true });
  await opacity.fill("0.7");
  await committed(() => opacity.press("Enter"));
  check(
    "parent clipping and opacity edits do not rewrite child styles",
    await child.evaluate(
      (el, before) => el.style.cssText === before,
      childStyle,
    ),
  );
  await committed(async () => {
    await layout
      .getByRole("button", { name: "Auto layout: Stack", exact: true })
      .evaluate((button) => button.click());
    await childRow.click();
  });
  check(
    "switching selection during a style commit preserves the original target",
    (await root.evaluate((el) => el.style.display === "flex")) &&
      (await child.evaluate((el) => el.style.display === "grid")),
  );
  await committed(() =>
    layout.getByRole("button", { name: "Rotate 90° clockwise" }).click(),
  );
  await committed(() =>
    layout.getByRole("button", { name: "Rotate 90° clockwise" }).click(),
  );
  await committed(() =>
    layout.getByRole("button", { name: "Rotate 90° clockwise" }).click(),
  );
  // Draw inside the existing child at its current painted position; its Grid
  // layout accepts the new frame in flow while that frame starts with None.
  const childBounds = await child.boundingBox();
  await page.getByRole("button", { name: "Frame tool", exact: true }).click();
  await page.mouse.move(childBounds.x + 8, childBounds.y + 8);
  await page.mouse.down();
  await page.mouse.move(childBounds.x + 35, childBounds.y + 30, { steps: 5 });
  await page.mouse.up();
  await waitFor(
    () => runtime().locator(`[data-oid="${childId}"] > [data-oid]`).count(),
    "nested-frame-child",
  );
  check(
    "drawing inside a Grid child inserts into that child and defaults the new frame to None",
    await runtime()
      .locator(`[data-oid="${childId}"] > [data-oid]`)
      .evaluate(
        (el) =>
          el.style.display === "block" && el.style.position === "relative",
      ),
  );
  await childRow.click();
  check(
    "the child now exposes its own alignment and constraints",
    (await layout
      .getByRole("button", { name: "Align left", exact: true })
      .isEnabled()) &&
      (await layout.locator("[data-design-layout-constraints]").count()) === 1,
  );
}
