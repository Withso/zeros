import { expect } from "@playwright/test";

// The theme editor's row ⋯ on the production Design workspace renderer
// (fixture I/O): a plain variable renames and deletes in place, a variable
// frames read asks before it goes, and @property-registered rows say why
// their actions are off.
export async function runDesignThemeVariablesSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?themeVariables`);
  await page.getByRole("button", { name: "Open theme editor", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Theme editor" });
  const rows = dialog.locator("[data-design-theme-row]");
  await expect(rows.first()).toBeVisible();
  const names = () => rows.locator(".zd-theme-token-name").allTextContents();
  const row = (name) =>
    rows.filter({ has: page.locator(".zd-theme-token-name", { hasText: new RegExp(`^${name}$`) }) }).first();
  const actions = (name) => row(name).getByRole("button", { name: `${name} actions`, exact: true });
  const menu = page.getByRole("menu");
  const openMenu = async (name) => {
    await row(name).hover();
    await actions(name).click();
    await expect(menu).toBeVisible();
  };

  await openMenu("--accent");
  await expect(menu.getByRole("menuitem", { name: /^Rename…/ })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toBeDisabled();
  check(
    "a variable registered with @property says why it cannot be renamed or deleted",
    (await menu.getByRole("menuitem").allTextContents()).every((label) => label.endsWith("Registered with @property")),
  );
  await page.keyboard.press("Escape");

  await dialog.getByRole("button", { name: "New variable", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Variable name", exact: true }).fill("--gap");
  await dialog.getByRole("textbox", { name: "Base value", exact: true }).fill("12px");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(row("--gap")).toBeVisible();

  // Keyboard: open the ⋯ and choose Rename… with Enter; the field keeps focus
  // after the menu closes.
  await actions("--gap").focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Enter");
  const rename = dialog.getByRole("textbox", { name: "Rename --gap", exact: true });
  await expect(rename).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("--gutter");
  await page.keyboard.press("Enter");
  await expect(row("--gutter")).toBeVisible();
  check("Rename… moves a plain variable to its new name", !(await names()).includes("--gap"));

  // A name another variable has is refused with the reason, and nothing moves.
  await openMenu("--gutter");
  await menu.getByRole("menuitem", { name: "Rename…", exact: true }).click();
  const taken = dialog.getByRole("textbox", { name: "Rename --gutter", exact: true });
  await taken.fill("--accent");
  await taken.press("Enter");
  await expect(page.getByText("--accent already exists", { exact: true })).toBeVisible();
  check(
    "a name that is taken is refused with its reason",
    (await names()).includes("--gutter") && (await names()).filter((name) => name === "--accent").length === 1,
  );

  await openMenu("--gutter");
  await menu.getByRole("menuitem", { name: "Rename…", exact: true }).click();
  const again = dialog.getByRole("textbox", { name: "Rename --gutter", exact: true });
  await again.fill("--not-saved");
  await again.press("Escape");
  await expect(again).toHaveCount(0);
  check(
    "Escape leaves the name as it was and keeps the theme editor open",
    (await names()).includes("--gutter") && !(await names()).includes("--not-saved") && (await dialog.isVisible()),
  );

  await openMenu("--gutter");
  await menu.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(row("--gutter")).toHaveCount(0);
  check("Delete removes a variable nothing reads without asking", true);

  await openMenu("--radius");
  await expect(menu.getByRole("menuitem", { name: /^Rename…\s*Used 3 times$/ })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Delete --radius?", exact: true });
  await expect(confirm).toContainText("It's used 3 times; those values fall back without it.");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(row("--radius")).toBeVisible();
  await openMenu("--radius");
  await menu.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row("--radius")).toHaveCount(0);
  check("a variable frames read asks before it is deleted, and Cancel keeps it", true);
}
