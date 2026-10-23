import { expect } from "@playwright/test";

// Real pointer/focus events with a paused clock: an eventual visibility check
// alone also passes when a tooltip opens immediately.
export async function runTooltipSmoke({ page, harnessBase, check }) {
  await page.goto(`${harnessBase}/harness-tooltips.html`, {
    waitUntil: "networkidle",
  });
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  const tooltip = page.getByRole("tooltip");
  const branch = page.getByRole("button", {
    name: "Target branch",
    exact: true,
  });
  const split = page.getByRole("button", { name: "Split diff", exact: true });
  const leave = async () => {
    await page.mouse.move(900, 600, { steps: 2 });
    await page.clock.runFor(250);
    await expect(tooltip).toHaveCount(0);
  };

  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (value) => (document.documentElement.dataset.theme = value),
      theme,
    );
    await branch.hover();
    await page.clock.runFor(900);
    await expect(tooltip).toHaveCount(0);
    await page.clock.runFor(200);
    await expect(tooltip).toHaveText("Target branch");
    const style = await tooltip.evaluate((node) => {
      // Radix's accessible tooltip lives inside the painted content.
      const css = getComputedStyle(node.parentElement);
      return [
        css.fontSize,
        css.paddingTop,
        css.paddingRight,
        css.paddingBottom,
        css.paddingLeft,
        css.borderRadius,
      ];
    });
    expect(style).toEqual(["12px", "4px", "8px", "4px", "8px", "4px"]);
    await leave();
    check(
      `${theme}: hints wait one second and use 12px type, 4/8px padding and 4px corners`,
      true,
    );
  }

  await branch.hover();
  await page.clock.runFor(1_100);
  await expect(tooltip).toHaveText("Target branch");
  const splitBox = await split.boundingBox();
  // Real travel also exits Radix's trigger-to-content hover grace polygon.
  await page.mouse.move(
    splitBox.x + splitBox.width / 2,
    splitBox.y + splitBox.height / 2,
    { steps: 8 },
  );
  await page.clock.runFor(250);
  await expect(tooltip.filter({ hasText: "Split diff" })).toHaveCount(0);
  await page.clock.runFor(650);
  await expect(tooltip.filter({ hasText: "Split diff" })).toHaveCount(0);
  await page.clock.runFor(200);
  await expect(tooltip.filter({ hasText: "Split diff" })).toBeVisible();
  await leave();
  check("Moving between controls never skips the hover delay", true);

  await branch.hover();
  await page.clock.runFor(600);
  await page.getByRole("button", { name: "Replace controls" }).click();
  await page.clock.runFor(1_500);
  await expect(tooltip).toHaveCount(0);
  check("Replacing a surface cancels its pending hint", true);

  await page.getByRole("button", { name: "Add fill", exact: true }).hover();
  await page.clock.runFor(2_000);
  await expect(tooltip).toHaveCount(0);
  await leave();
  await page.getByRole("button", { name: "Independent corners" }).hover();
  await page.clock.runFor(1_100);
  await expect(tooltip).toHaveText("Independent corners");
  await leave();
  check(
    "Inspector add actions stay quiet while unfamiliar icons retain help",
    true,
  );

  await page.getByRole("button", { name: "Replace controls" }).focus();
  await page.keyboard.press("Tab");
  await expect(branch).toBeFocused();
  await page.clock.runFor(100);
  await expect(tooltip).toHaveText("Target branch");
  await page.keyboard.press("Escape");
  await page.clock.runFor(250);
  await expect(tooltip).toHaveCount(0);
  await expect(branch).toBeFocused();
  check(
    "Keyboard focus still exposes help and Escape keeps focus on the control",
    true,
  );
  await page.clock.resume();

  for (const query of [
    "owner=personal&placement=local",
    "owner=organization&placement=local",
    "owner=organization&placement=cloud",
  ]) {
    await page.goto(
      `${harnessBase}/harness-model-menu.html?defaults=claude&tooltip-policy=1&${query}`,
      { waitUntil: "networkidle" },
    );
    await page.evaluate(() => {
      window.__tooltipOverlayActive = false;
      document.addEventListener(
        "zeros-native-surface-overlay-intent",
        (event) => {
          window.__tooltipOverlayActive = event.detail.active;
        },
      );
    });
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
    const permission = page.getByRole("button", { name: /^Permission mode:/ });
    await permission.hover();
    await page.clock.runFor(900);
    await expect(tooltip).toHaveCount(0);
    await page.clock.runFor(200);
    await expect(tooltip).toHaveCount(1);
    await leave();
    const model = page.getByRole("button", { name: /^Model:/ });
    await model.hover();
    await page.clock.runFor(1_300);
    await expect(tooltip).toHaveCount(0);
    await page.clock.runFor(300);
    await expect(tooltip).toHaveText("Model");
    expect(await page.evaluate(() => window.__tooltipOverlayActive)).toBe(true);
    await model.click();
    await page.clock.runFor(2_000);
    await expect(page.getByPlaceholder("Search models…")).toBeVisible();
    await expect(tooltip).toHaveCount(0);
    await page.mouse.click(900, 600);
    await page.clock.runFor(250);
    await expect(page.getByPlaceholder("Search models…")).toHaveCount(0);
    await expect(tooltip).toHaveCount(0);
    expect(await page.evaluate(() => window.__tooltipOverlayActive)).toBe(
      false,
    );
    await page
      .getByRole("button", { name: "Add attachment or link a workspace" })
      .hover();
    await page.clock.runFor(2_000);
    await expect(tooltip).toHaveCount(0);
    await page.clock.resume();
    check(
      `${query}: composer hints wait, yield to menus, and omit the attachment plus`,
      true,
    );
  }

  await page.goto(
    `${harnessBase}/harness-design-workspace.html?motionOwner=1`,
    { waitUntil: "networkidle" },
  );
  const property = page.getByLabel("Motion property", { exact: true });
  await property.fill("not a property");
  await property.press("Enter");
  await expect(property).toHaveAttribute("aria-invalid", "true");
  await expect(property).toBeFocused();
  await property.press("ControlOrMeta+A");
  await page.keyboard.type("opacity");
  await expect(property).toHaveValue("opacity");
  await expect(property).toHaveAttribute("aria-invalid", "false");
  await expect(property).toBeFocused();
  check(
    "Conditional validation hints preserve input focus while correcting a motion property",
    true,
  );
}
