// An unmarked, visibly smaller HTML root must remain a real layer beneath the
// canvas frame. Exercise both rows through the production inspector and API.
export async function runDesignAuthoredFrameSmoke({ page, waitFor, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?authoredFrame`,
    { waitUntil: "networkidle" },
  );
  const layers = page.locator("#design-layers-panel");
  const frame = page.locator('[data-design-frame="home.html"]');
  const label = frame.locator("[data-design-frame-label]");
  const layout = page.locator("[data-design-layout-section]");
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const body = runtime.locator("body");
  const red = runtime.locator('[data-oid="home-main"]');
  const row = layers.locator('[data-design-layer-id="home-main"]');
  const childRow = layers.locator('[data-design-layer-id="red-child"]');
  const committed = async (action) => {
    const before = await body.evaluate(
      (el) => el.ownerDocument.defaultView.__zerosDesignSourceVersion,
    );
    await action();
    await waitFor(
      () =>
        body.evaluate(
          (el, before) =>
            el.ownerDocument.defaultView.__zerosDesignSourceVersion !== before,
          before,
        ),
      "authored-frame-commit",
    );
  };
  await label.click();
  await waitFor(() => red.count(), "authored-frame-ready");
  const canvasRow = layers.locator('[data-design-frame-row="home.html"]');
  if ((await canvasRow.getAttribute("aria-expanded")) !== "true")
    await canvasRow.press("ArrowRight");
  await row.waitFor({ state: "visible" });
  check(
    "the visible red frame remains a separate layer under the canvas frame",
    (await row.count()) === 1 &&
      (await row.getAttribute("aria-selected")) === "false",
  );
  check(
    "the canvas frame with an authored child exposes alignment and constraints in None",
    (await layout
      .getByRole("button", { name: "Align left", exact: true })
      .isEnabled()) &&
      (await layout
        .getByRole("button", { name: "Pin right", exact: true })
        .isEnabled()),
  );
  await row.click();
  await row.press("ArrowRight");
  await childRow.waitFor({ state: "visible" });
  check(
    "expanding the authored frame reveals its own child layer",
    (await row.getAttribute("aria-selected")) === "true" &&
      (await canvasRow.getAttribute("aria-selected")) === "false",
  );
  await childRow.click();
  check(
    "an empty child hides alignment and constraints",
    (await layout
      .getByRole("button", { name: "Align left", exact: true })
      .count()) === 0 &&
      (await layout.locator("[data-design-layout-constraints]").count()) === 0,
  );
  for (const [target, other, mode, display] of [
    ["canvas", red, "Stack", "flex"],
    ["red", body, "Grid", "grid"],
    ["canvas", red, "None", "block"],
  ]) {
    await (target === "canvas" ? label : row).click();
    const before = await other.evaluate((el) => el.style.cssText);
    await committed(() =>
      layout
        .getByRole("button", { name: `Auto layout: ${mode}`, exact: true })
        .click(),
    );
    check(
      `${mode} edits the ${target} frame without rewriting the other frame`,
      (await (target === "canvas" ? body : red).evaluate(
        (el, display) => getComputedStyle(el).display === display,
        display,
      )) &&
        (await other.evaluate(
          (el, before) => el.style.cssText === before,
          before,
        )),
    );
  }
  await label.click();
  const redBefore = await red.evaluate((el) => el.style.cssText);
  await committed(() =>
    layout.getByText("Clip content", { exact: true }).click(),
  );
  check(
    "canvas clipping preserves the authored frame's styles and layer rows",
    (await red.evaluate(
      (el, before) => el.style.cssText === before,
      redBefore,
    )) &&
      (await row.isVisible()) &&
      (await childRow.isVisible()),
  );
  await committed(() =>
    layout.getByRole("button", { name: "Align top", exact: true }).click(),
  );
  check(
    "canvas alignment moves its direct frame without rewriting the grandchild",
    (await red.evaluate(
      (el) => Math.abs(el.getBoundingClientRect().top) < 1,
    )) &&
      (await runtime
        .locator('[data-oid="red-child"]')
        .evaluate((el) => el.style.left === "40px" && el.style.top === "10px")),
  );
  await row.click();
  const height = layout.getByLabel("H", { exact: true });
  await height.fill("900");
  await committed(() => height.press("Enter"));
  await page.keyboard.press("Escape");
  const fullBounds = await frame.boundingBox();
  await page.mouse.click(
    fullBounds.x + fullBounds.width * 0.5,
    fullBounds.y + fullBounds.height * 0.5,
  );
  check(
    "a viewport-sized authored frame stays selectable on the canvas",
    (await row.getAttribute("aria-selected")) === "true",
  );
  await height.fill("64");
  await committed(() => height.press("Enter"));
  // Draw on the white portion, outside the red layer: this belongs to the
  // canvas body, not to the first main element elsewhere in the document.
  await page.getByRole("button", { name: "Frame tool", exact: true }).click();
  const bounds = await frame.boundingBox();
  await page.mouse.move(
    bounds.x + bounds.width * 0.3,
    bounds.y + bounds.height * 0.5,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.5,
    bounds.y + bounds.height * 0.7,
    { steps: 5 },
  );
  await page.mouse.up();
  await waitFor(
    () => runtime.locator("body > div[data-oid]").count(),
    "authored-frame-sibling-created",
  );
  check(
    "drawing on the canvas background adds a sibling without replacing existing layers",
    (await red.count()) === 1 &&
      (await runtime.locator('[data-oid="red-child"]').count()) === 1 &&
      (await row.isVisible()) &&
      (await childRow.isVisible()),
  );
}
