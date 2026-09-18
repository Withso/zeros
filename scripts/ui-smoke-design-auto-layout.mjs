import { expect } from "@playwright/test";

// Real runtime measurements prove resizing behavior; no authored Design files
// are touched. The document and its mutation/history lane are the app harness.
export async function runDesignAutoLayoutSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?autoLayout=1`,
    { waitUntil: "networkidle" },
  );
  const layers = page.locator("#design-layers-panel");
  const layout = page.locator("[data-design-layout-section]");
  const editor = page.locator("[data-design-style-editor]");
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const hero = runtime.locator('[data-oid="home-hero"]');
  const heading = runtime.locator('[data-oid="home-heading"]');
  const select = async (id) => {
    await layers.locator(`[data-design-layer-id="${id}"]`).click();
    await expect(editor).toBeVisible();
  };
  const sizing = async (dimension, name) => {
    await layout
      .getByRole("button", { name: `${dimension} resizing`, exact: true })
      .click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };
  // Seed both the saved fixture and iframe from the same source. Patching only
  // the live DOM let a later save/revalidation restore unrelated fixture CSS.
  await select("home-hero");
  await expect(page.locator("[data-design-lint-review]")).toHaveCount(0);

  await expect(
    layout.getByRole("button", { name: "Auto layout: None", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  check(
    "None keeps geometry visible and hides automatic padding, gap and sizing limits",
    (await layout.getByLabel("W", { exact: true }).count()) === 1 &&
      (await layout.getByLabel("Gap", { exact: true }).count()) === 0 &&
      (await layout
        .getByRole("button", { name: "Width resizing", exact: true })
        .count()) === 0 &&
      (await layout.getByText("Sizing limits", { exact: true }).count()) === 0,
  );
  await layout
    .getByRole("button", { name: "Auto layout: Vertical", exact: true })
    .click();
  await expect
    .poll(() => hero.evaluate((element) => getComputedStyle(element).display))
    .toBe("flex");
  await expect
    .poll(() =>
      heading.evaluate((element) => getComputedStyle(element).position),
    )
    .toBe("relative");
  await expect(layout.getByLabel("Horizontal", { exact: true })).toBeVisible();
  check(
    "enabling auto layout includes previously drawn children in flow",
    true,
  );
  await sizing("Width", "Hug contents");
  await expect
    .poll(() =>
      hero.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(80);
  await layout
    .getByRole("button", { name: "Width resizing", exact: true })
    .click();
  check(
    "parent resizing exposes Hug and optional limits without Fill container",
    (await page
      .getByRole("menuitemradio", { name: "Fill container", exact: true })
      .count()) === 0,
  );
  await page
    .getByRole("menuitem", { name: "Add min width…", exact: true })
    .click();
  const minimum = layout.getByLabel("Min W", { exact: true });
  await minimum.fill("120");
  await expect
    .poll(() =>
      hero.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(80);
  await minimum.press("Enter");
  await expect
    .poll(() =>
      hero.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(120);
  check(
    "Hug respects an added minimum and typing stays local until Enter",
    true,
  );
  await layout
    .getByRole("button", { name: "Remove min width", exact: true })
    .click();
  await sizing("Width", "Fixed width");
  await layout.getByLabel("W", { exact: true }).fill("300");
  await layout.getByLabel("W", { exact: true }).press("Enter");
  await layout.getByLabel("Horizontal", { exact: true }).fill("16");
  await layout.getByLabel("Horizontal", { exact: true }).press("Enter");
  await expect
    .poll(() =>
      hero.evaluate((element) => [
        element.style.paddingLeft,
        element.style.paddingRight,
      ]),
    )
    .toEqual(["16px", "16px"]);
  await layout
    .getByRole("button", { name: "Independent padding", exact: true })
    .click();
  await layout.getByLabel("Right", { exact: true }).fill("24");
  await layout.getByLabel("Right", { exact: true }).press("Enter");
  await expect
    .poll(() =>
      hero.evaluate((element) => [
        element.style.paddingLeft,
        element.style.paddingRight,
      ]),
    )
    .toEqual(["16px", "24px"]);
  check("padding supports paired axes and independent sides", true);
  await select("home-heading");
  check(
    "text keeps its own Fill and cannot be converted to a layout container",
    (await layout
      .getByRole("group", { name: "Auto layout", exact: true })
      .count()) === 0 &&
      (await editor.locator('[data-design-style-property="color"]').count()) ===
        1 &&
      (await editor
        .locator('[data-design-style-property="background-color"]')
        .count()) === 0,
  );
  const fill = editor.getByLabel("Fill", { exact: true });
  await fill.fill("#112233");
  await fill.press("Enter");
  await expect
    .poll(() => heading.evaluate((element) => getComputedStyle(element).color))
    .toBe("rgb(17, 34, 51)");
  await sizing("Width", "Fill container");
  await expect
    .poll(() =>
      heading.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(260);
  check(
    "Fill stretches a text child across the available padded width",
    await heading.evaluate(
      (element) =>
        element.tagName === "H1" &&
        getComputedStyle(element).position !== "absolute" &&
        getComputedStyle(element).backgroundColor === "rgba(0, 0, 0, 0)",
    ),
  );
  await layout
    .getByRole("button", { name: "Height resizing", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    layout.getByRole("button", { name: "Height resizing", exact: true }),
  ).toBeFocused();
  await select("home-hero");
  await layout.getByLabel("Gap", { exact: true }).fill("12");
  await layout.getByLabel("Gap", { exact: true }).press("Enter");
  await layout
    .getByRole("button", { name: "Align children bottom right", exact: true })
    .click();
  await expect
    .poll(() =>
      hero.evaluate((element) => [
        element.style.alignItems,
        element.style.justifyContent,
      ]),
    )
    .toEqual(["flex-end", "flex-end"]);
  await layout
    .getByRole("button", { name: "Align children bottom right", exact: true })
    .press("ArrowLeft");
  await expect
    .poll(() => hero.evaluate((element) => element.style.alignItems))
    .toBe("center");
  await expect(
    layout.locator('[aria-label="Align children"] button[tabindex="0"]'),
  ).toHaveCount(1);
  check(
    "the alignment pad supports pointer and arrow-key changes with one tab stop",
    true,
  );
  await layout
    .getByRole("button", { name: "Auto spacing", exact: true })
    .click();
  await expect
    .poll(() =>
      hero.evaluate((element) => [
        getComputedStyle(element).justifyContent,
        getComputedStyle(element).rowGap,
      ]),
    )
    .toEqual(["space-between", "0px"]);
  await expect(
    layout.getByRole("button", { name: "Use fixed gap", exact: true }).first(),
  ).toBeVisible();
  const autoAlignment = layout.getByRole("button", {
    name: "Align children middle center",
    exact: true,
  });
  await autoAlignment.focus();
  await autoAlignment.press("ArrowUp");
  await expect(autoAlignment).toBeFocused();
  check(
    "Auto spacing releases the numeric gap and keeps keyboard focus on available alignment points",
    true,
  );
  await layout
    .getByRole("button", { name: "Use fixed gap", exact: true })
    .first()
    .click();

  await layout
    .getByRole("button", { name: "Auto layout: Horizontal", exact: true })
    .click();
  await expect
    .poll(() =>
      heading.evaluate((element) => getComputedStyle(element).flexGrow),
    )
    .toBe("1");
  await select("home-heading");
  await sizing("Width", "Fixed width");
  await expect
    .poll(() =>
      heading.evaluate((element) => getComputedStyle(element).flexGrow),
    )
    .toBe("0");
  await select("home-hero");
  await layout
    .getByRole("button", { name: "Auto layout: Grid", exact: true })
    .click();
  await layout.getByLabel("Columns", { exact: true }).fill("2");
  await layout.getByLabel("Columns", { exact: true }).press("Enter");
  await expect
    .poll(() => hero.evaluate((element) => getComputedStyle(element).display))
    .toBe("grid");
  await select("home-heading");
  await sizing("Width", "Fill container");
  await expect
    .poll(() => heading.evaluate((element) => element.style.justifySelf))
    .toBe("stretch");
  check("Fill uses growth on a flex main axis and stretch in grid cells", true);
  await select("home-hero");
  await layout
    .getByRole("button", { name: "Auto layout: None", exact: true })
    .click();
  await expect
    .poll(() => heading.evaluate((element) => element.style.position))
    .toBe("absolute");
  check(
    "removing auto layout freezes child geometry without hiding the frame",
    await hero.evaluate((element) => element.getBoundingClientRect().width > 0),
  );
  check(
    "the narrow inspector has consistent type and no horizontal overflow",
    await editor.evaluate((element) => {
      const input = element.querySelector("input");
      return (
        element.scrollWidth <= element.clientWidth &&
        getComputedStyle(input).fontSize === "13px" &&
        !getComputedStyle(input).fontFamily.toLowerCase().includes("mono")
      );
    }),
  );
  await editor.getByLabel("Opacity", { exact: true }).fill("75");
  await editor.getByLabel("Opacity", { exact: true }).press("Enter");
  await expect
    .poll(() => hero.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("0.75");
  check("opacity uses percentages while persisting the CSS scalar", true);
  // A canvas frame's geometry and authored root must agree after changing
  // resizing modes; otherwise the iframe clips the newly sized content.
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  const root = runtime.locator('[data-oid="home-main"]');
  await root.evaluate((element) => {
    element.style.cssText =
      "display:flex;flex-direction:column;align-items:flex-start;width:300px;height:240px;min-height:0;padding:0;box-sizing:border-box";
    [...element.children].forEach((child) => {
      child.style.cssText =
        "position:relative;flex:0 0 auto;width:200px;height:80px;min-width:0;max-width:none;margin:0;padding:0;box-sizing:border-box";
    });
  });
  await layers.locator('[data-design-frame-row="home.html"]').click();
  await sizing("Width", "Hug contents");
  const canvas = page.locator('[data-design-frame="home.html"]');
  await expect
    .poll(() => canvas.evaluate((el) => parseFloat(el.style.width)))
    .toBe(200);
  await layout.getByLabel("Horizontal", { exact: true }).fill("20");
  await layout.getByLabel("Horizontal", { exact: true }).press("Enter");
  await expect
    .poll(() => root.evaluate((el) => el.style.paddingLeft))
    .toBe("20px");
  await expect
    .poll(async () =>
      Math.abs(
        (await root.evaluate((el) => el.getBoundingClientRect().width)) -
          (await canvas.evaluate((el) => parseFloat(el.style.width))),
      ),
    )
    .toBeLessThan(1);
  await layout.getByLabel("W", { exact: true }).fill("640");
  await layout.getByLabel("W", { exact: true }).press("Enter");
  await expect
    .poll(() => root.evaluate((el) => el.getBoundingClientRect().width))
    .toBe(640);
  await expect
    .poll(() => canvas.evaluate((el) => parseFloat(el.style.width)))
    .toBe(640);
  check(
    "canvas frame sizing updates its viewport and authored root together",
    true,
  );
  await layout.getByText("Wrap", { exact: true }).click();
  const crossGap = layout.getByLabel("Column gap", { exact: true });
  await expect(crossGap).toBeVisible();
  const fixedGap = layout
    .getByRole("button", { name: "Use fixed gap", exact: true })
    .first();
  if (await fixedGap.count()) await fixedGap.click();
  await layout.getByLabel("Gap", { exact: true }).fill("12");
  await layout.getByLabel("Gap", { exact: true }).press("Enter");
  await crossGap.fill("8");
  await crossGap.press("Enter");
  await expect
    .poll(() =>
      root.evaluate((el) => [
        getComputedStyle(el).rowGap,
        getComputedStyle(el).columnGap,
      ]),
    )
    .toEqual(["12px", "8px"]);
  check(
    "wrapped vertical flow keeps main and cross-axis gaps independent",
    true,
  );
}
