import { expect } from "@playwright/test";

export async function runRepoSettingsSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-repo-settings.html`,
  );
  const navigation = page.locator("[data-repo-settings-navigation]");
  const code = navigation.getByRole("button", {
    name: "Code mode",
    exact: true,
  });
  const design = navigation.getByRole("button", {
    name: "Design mode",
    exact: true,
  });
  const tabs = navigation.getByRole("tab");
  await expect(code).toHaveAttribute("aria-pressed", "true");
  await expect(tabs).toHaveText([
    "Workspaces",
    "Environment",
    "Git",
    "Actions",
    "Files",
    "Paths",
  ]);
  const toggleBounds = await navigation.getByRole("group").boundingBox();
  const tabsBounds = await navigation.getByRole("tablist").boundingBox();
  check(
    "Repository mode toggle sits left of the tabs at the same height",
    !!toggleBounds &&
      !!tabsBounds &&
      toggleBounds.x + toggleBounds.width < tabsBounds.x &&
      toggleBounds.height === tabsBounds.height,
  );

  const hoverBackground = await navigation.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color =
      "color-mix(in oklab, var(--bg1-highlight) 80%, transparent)";
    element.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  for (const [button, label] of [
    [code, "Code mode"],
    [design, "Design mode"],
  ]) {
    // Leave the previous tooltip's pointer grace area before probing the next.
    await page.mouse.move(0, 0, { steps: 5 });
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    const restingStyle = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        background: style.backgroundColor,
        selected: element.getAttribute("aria-pressed") === "true",
      };
    });
    await button.hover();
    const tooltip = page.locator("[data-radix-popper-content-wrapper]").filter({
      has: page.getByRole("tooltip", { name: label, exact: true }),
    });
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator("[data-side]").first()).toHaveAttribute(
      "data-side",
      "bottom",
    );
    const buttonBounds = await button.boundingBox();
    const tooltipBounds = await tooltip.boundingBox();
    check(
      `${label} tooltip stays below its trigger, clear of native window controls`,
      !!buttonBounds &&
        !!tooltipBounds &&
        tooltipBounds.y >= buttonBounds.y + buttonBounds.height,
    );
    await expect(button).toHaveCSS("color", restingStyle.color);
    await expect(button).toHaveCSS(
      "background-color",
      restingStyle.selected ? restingStyle.background : hoverBackground,
    );
  }
  check(
    "Only the inactive mode changes background on hover; icon colors stay fixed",
    true,
  );
  await tabs.first().hover();

  await navigation.getByRole("tab", { name: "Actions", exact: true }).click();
  await design.click();
  await expect(tabs).toHaveText(["Directory", "Preferences"]);
  await expect(
    navigation.getByRole("tab", { name: "Directory", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const rename = page.getByRole("textbox", { name: "New design folder name" });
  await page
    .getByRole("button", { name: "Design folder Alpha - Design", exact: true })
    .dblclick();
  await expect(rename).toBeVisible();
  await expect(page.locator("#design-reads")).toHaveText("1");
  await rename.fill("Unsubmitted rename");
  await rename.press("Escape");
  await expect(rename).toHaveCount(0);
  await expect(page.locator("#design-renames")).toHaveText("0");
  await navigation
    .getByRole("tab", { name: "Preferences", exact: true })
    .click();
  await expect(rename).toHaveCount(0);
  check(
    "Directory list becomes inert in Preferences",
    await page
      .locator('[aria-label="Design directories"]')
      .evaluate((element) => !!element.closest("[inert][aria-hidden=true]")),
  );
  await code.click();
  await expect(
    navigation.getByRole("tab", { name: "Actions", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await design.click();
  await expect(
    navigation.getByRole("tab", { name: "Preferences", exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  await page
    .getByRole("navigation", { name: "Fixture repositories" })
    .getByRole("button", { name: "Beta", exact: true })
    .click();
  await expect(code).toHaveAttribute("aria-pressed", "true");
  await expect(
    navigation.getByRole("tab", { name: "Workspaces", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("navigation", { name: "Fixture repositories" })
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  await expect(design).toHaveAttribute("aria-pressed", "true");
  const preferences = navigation.getByRole("tab", {
    name: "Preferences",
    exact: true,
  });
  await expect(preferences).toHaveAttribute("aria-selected", "true");
  await preferences.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("button", {
      name: "Design folder Alpha - Design",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("#design-reads")).toHaveText("1");
  check(
    "Repository and mode round trips preserve tabs without refetching Directory",
    true,
  );

  await page
    .getByRole("button", { name: "Rename Alpha - Design", exact: true })
    .click();
  await rename.fill("Brand");
  await rename.press("Enter");
  await expect(
    page.getByRole("button", { name: "Design folder Brand", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#design-renames")).toHaveText("1");
  await page.getByRole("button", { name: "Rename Brand", exact: true }).click();
  await rename.fill("Brand Studio");
  await navigation.getByRole("tab", { name: "Directory", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Design folder Brand Studio",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("#design-renames")).toHaveText("2");
  const remove = page.getByRole("button", {
    name: "Remove Design registration for Brand Studio",
    exact: true,
  });
  await remove.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "all HTML, CSS, images, and other source files will stay exactly as they are",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#design-removals")).toHaveText("0");
  await remove.click();
  await dialog
    .getByRole("button", { name: "Remove registration", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#design-removals")).toHaveText("1");
  await expect(
    page.getByText("No Design directories found.", { exact: false }),
  ).toBeVisible();
  check(
    "Inline rename supports Enter, blur, and Escape; removal requires confirmation",
    true,
  );

  await preferences.click();
  await page.reload();
  await expect(design).toHaveAttribute("aria-pressed", "true");
  await expect(preferences).toHaveAttribute("aria-selected", "true");
  await code.click();
  await expect(
    navigation.getByRole("tab", { name: "Actions", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  check("Reload restores the repository mode and both tab selections", true);
}
