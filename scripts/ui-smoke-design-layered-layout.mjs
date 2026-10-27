import { expect } from "@playwright/test";

/** A CSS-authored background and flow content must survive actual inspector
 * actions, source transactions, layer rename, history and whole-frame Play. */
export async function runDesignLayeredLayoutSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layeredLayout&layoutGestures`,
    { waitUntil: "networkidle" },
  );
  const frame = page.locator('[data-design-frame="home.html"]');
  const frameRow = page.locator('[data-design-frame-row="home.html"]');
  const content = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const root = content.locator('[data-oid="home-main"]');
  const backdrop = content.locator('[data-oid="home-field"]');
  const copy = content.locator('[data-oid="home-hero"]');
  const heading = content.locator('[data-oid="home-heading"]');
  const layout = page.locator("[data-design-layout-section]");
  await expect(root).toBeAttached();
  await frameRow.click();
  // Use the user's actual frame dimensions through the real geometry fields.
  for (const [label, value] of [
    ["W", "960"],
    ["H", "600"],
  ]) {
    await layout.getByLabel(label, { exact: true }).fill(value);
    await layout.getByLabel(label, { exact: true }).press("Enter");
    await expect
      .poll(() =>
        root.evaluate(
          (element, label) =>
            Math.round(
              element.getBoundingClientRect()[
                label === "W" ? "width" : "height"
              ],
            ),
          label,
        ),
      )
      .toBe(Number(value));
  }
  const composition = async () => {
    const state = await root.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const layers = ["home-heading", "home-mark-b"].map((id) => {
        const layer = element.querySelector(`[data-oid="${id}"]`);
        const rect = layer.getBoundingClientRect();
        return (
          rect.top >= box.top &&
          rect.bottom < box.bottom &&
          getComputedStyle(layer).opacity === "1"
        );
      });
      const backdrop = element.querySelector('[data-oid="home-field"]');
      const fixed = element.querySelector('[data-oid="home-fixed"]');
      return (
        layers.every(Boolean) &&
        getComputedStyle(backdrop).position === "absolute" &&
        getComputedStyle(fixed).position === "fixed"
      );
    });
    expect(state).toBe(true);
  };
  await composition();
  check(
    "delayed entrance animations leave text and selection geometry visible while editing",
    true,
  );

  for (const [label, display] of [
    ["Vertical", "flex"],
    ["None", "block"],
    ["Horizontal", "flex"],
    ["None", "block"],
    ["Grid", "grid"],
  ]) {
    await layout
      .getByRole("button", { name: `Auto layout: ${label}`, exact: true })
      .click();
    await expect
      .poll(() => root.evaluate((element) => getComputedStyle(element).display))
      .toBe(display);
    await composition();
  }
  check(
    "Auto layout toggles preserve background overlays, fixed layers and content inside a clipped frame",
    true,
  );
  expect(await backdrop.getAttribute("style")).toBeNull();
  check(
    "layout changes do not persist positioning or fixed dimensions onto the authored background",
    true,
  );

  await frameRow.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() => root.evaluate((element) => getComputedStyle(element).display))
    .toBe("block");
  await composition();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect
    .poll(() => root.evaluate((element) => getComputedStyle(element).display))
    .toBe("grid");
  await composition();

  // Undo pressed while the latest layout edit is still saving must not paint
  // a predicted inverse under that edit: the edit would record the predicted
  // pixels as its baseline and Undo would land on an older layout.
  await layout.getByRole("button", { name: "Auto layout: None", exact: true }).click();
  await expect
    .poll(() => root.evaluate((element) => getComputedStyle(element).display))
    .toBe("block");
  await composition();
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.__zerosHarnessStyleDelay = 400; });
  await layout.getByRole("button", { name: "Auto layout: Vertical", exact: true }).click();
  await expect
    .poll(() => root.evaluate((element) => getComputedStyle(element).display))
    .toBe("flex");
  await frameRow.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() => root.evaluate((element) => getComputedStyle(element).display))
    .toBe("block");
  await page.waitForTimeout(600);
  check(
    "Undo pressed while a layout edit is still saving restores that edit's own baseline",
    (await root.evaluate((element) => getComputedStyle(element).display)) === "block",
  );
  await page.evaluate(() => { window.__zerosHarnessStyleDelay = 50; });
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect
    .poll(() => root.evaluate((element) => getComputedStyle(element).display))
    .toBe("flex");
  await layout.getByRole("button", { name: "Auto layout: Grid", exact: true }).click();
  await expect
    .poll(() => root.evaluate((element) => getComputedStyle(element).display))
    .toBe("grid");
  await composition();
  check(
    "Undo and Redo restore the composition through the real source history lane",
    true,
  );

  if ((await frameRow.getAttribute("aria-expanded")) !== "true")
    await frameRow.locator("[data-layer-disclosure]").click();
  const backgroundRow = page.locator('[data-design-layer-id="home-field"]');
  await backgroundRow.locator("[data-design-layer-name]").dblclick();
  const name = page.getByRole("textbox", { name: "Layer name", exact: true });
  await name.fill("Background orbs");
  await name.press("Enter");
  await expect(backgroundRow.locator("[data-design-layer-name]")).toHaveText(
    "Background orbs",
  );
  await composition();
  check(
    "renaming an overlay changes its label without changing the artboard layout",
    true,
  );

  const play = frame.getByRole("button", {
    name: "Play Launch home",
    exact: true,
  });
  await play.click();
  await expect
    .poll(() =>
      heading.evaluate((element) =>
        element
          .getAnimations()
          .some((animation) => animation.playState === "running"),
      ),
    )
    .toBe(true);
  await play.click();
  await expect
    .poll(() =>
      heading.evaluate((element) => getComputedStyle(element).opacity),
    )
    .toBe("1");
  await composition();
  check(
    "stopping Play restores visible text after delayed looping animations",
    true,
  );

  const before = await copy.evaluate((element) =>
    element.getBoundingClientRect().toJSON(),
  );
  // Renaming a second layer exercises the saved-generation path again.
  const copyRow = page.locator('[data-design-layer-id="home-hero"]');
  await copyRow.press("F2");
  await name.fill("Content");
  await name.press("Enter");
  await expect(copyRow.locator("[data-design-layer-name]")).toHaveText(
    "Content",
  );
  expect(
    await copy.evaluate((element) => element.getBoundingClientRect().toJSON()),
  ).toEqual(before);
  check("saved layer renames retain measured content bounds", true);
}
