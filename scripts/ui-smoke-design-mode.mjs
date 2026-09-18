import { expect } from "@playwright/test";

export async function runDesignModeSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-mode.html`,
  );
  const plus = page.getByRole("button", {
    name: "Add attachment or link a workspace",
    exact: true,
  });
  const tag = page.getByRole("button", {
    name: "Remove Design mode",
    exact: true,
  });
  await expect(tag).toHaveCount(0);
  await plus.click();
  await page
    .getByRole("menuitem", {
      name: "Design Create and edit designs",
      exact: true,
    })
    .click();
  await expect(tag).toBeVisible();
  await expect(page.locator("[data-composer-attachment-menu]")).toHaveCount(0);
  check(
    "Design is selected from + and appears as one removable composer tag",
    true,
  );
  await page
    .getByRole("button", { name: "Switch conversation", exact: true })
    .click();
  await expect(tag).toHaveCount(0);
  await page
    .getByRole("button", { name: "Switch conversation", exact: true })
    .click();
  await expect(tag).toBeVisible();
  await tag.click();
  await expect(tag).toHaveCount(0);
  await page.getByRole("button", { name: "Agent switch", exact: true }).click();
  await expect(tag).toBeVisible();
  check(
    "manual and agent mode changes share the tag without leaking across chats",
    true,
  );
  await plus.click();
  await page.keyboard.press("Escape");
  await expect(plus).toBeFocused();
  await plus.click();
  // A workspace/navigation transition can conceal the composer while a modal
  // menu has hidden background controls from the accessibility tree.
  await page
    .getByRole("button", {
      name: "Toggle concealed",
      exact: true,
      includeHidden: true,
    })
    .evaluate((button) => button.click());
  await expect(page.locator("[data-composer-attachment-menu]")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Toggle concealed", exact: true })
    .click();
  for (const label of [
    "List",
    "Inspect",
    "Inspect Styles",
    "Edit",
    "Validate",
    "Capture",
    "Undo",
  ]) {
    const row = page.getByRole("button", { name: label, exact: true });
    await expect(row.locator("svg.lucide-pen-tool")).toHaveCount(1);
    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await row.click();
  }
  check(
    "Design tools use the Design icon and ordinary expandable code details",
    true,
  );
  await expect(tag).toBeVisible();
  await page.mouse.move(900, 20);
  await page
    .locator("[data-design-mode-fixture]")
    .screenshot({ path: ".context/design-mode-v1.png" });
}
