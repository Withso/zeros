import { expect } from "@playwright/test";

// The theme editor's source rail, driven with real pointer and keyboard input
// on the production Design workspace renderer (fixture I/O). Stylesheets that
// declare no variables fold into one "Styles only" group that still shows
// their worst status, and choosing another source never keeps a type filter
// that hides all of its variables.
export async function runDesignThemeSourcesSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleSources`);
  await page.getByRole("button", { name: "Open theme editor", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Theme editor" });
  const rail = dialog.getByRole("group", { name: "Theme sources" });
  await expect(rail).toBeVisible();
  const group = rail.locator("[data-design-theme-styles-only]");
  const rows = dialog.locator("[data-design-theme-row]");
  const summary = dialog.locator(".zd-theme-source-summary");
  const types = dialog.getByRole("group", { name: "Filter variables by type" });

  check(
    "sources with variables, and failed ones, stay listed while styles-only sheets fold away",
    (await rail.getByRole("button", { name: "App tokens, Warning", exact: true }).isVisible()) &&
      (await rail.getByRole("button", { name: "Brand kit, Error", exact: true }).isVisible()) &&
      (await group.getAttribute("aria-expanded")) === "false" &&
      (await group.getAttribute("aria-label")) === "Styles only, 2 sources, Warning" &&
      (await rail.getByRole("button", { name: "Runtime content, Ready", exact: true }).count()) === 0,
  );

  await rail.getByRole("button", { name: "App tokens, Warning", exact: true }).click();
  await types.getByRole("button", { name: "Color", exact: true }).click();
  await expect(rows).toHaveCount(1);

  await group.click();
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await rail.getByRole("button", { name: "Runtime content, Ready", exact: true }).click();
  await expect(summary).toHaveText("74 rules · read-only");
  check(
    "a styles-only source says what it holds, and the filter returns to All",
    (await dialog.locator(".zd-theme-empty-note").textContent()) === "Its 74 rules style frames that use its classes." &&
      (await types.locator('button[aria-pressed="true"]').getAttribute("aria-label")) === "All",
  );

  await rail.getByRole("button", { name: "App tokens, Warning", exact: true }).click();
  await expect(rows).toHaveCount(2);
  check("returning to a source shows every variable, not the earlier type", true);

  // Keyboard: the group's disclosure toggles with Enter like any button.
  await group.click();
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(group).toHaveAttribute("aria-expanded", "false");
  check("the Styles only group opens and closes from the keyboard", true);
}
