// Cloud projects in the real Create page and workbench (folder harness, synthetic
// transport): picking a project of several repositories, and a workspace of
// several repositories with its switcher, totals, Files and pull request mark.
import { expect } from "@playwright/test";

const ZEROS_FILE = "apps/desktop/src/renderer/features/settings/appearance-panel.tsx";
const DEMO_FILE = "frames/home.html";
const box = async (locator) => { const value = await locator.boundingBox(); return value && { x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width) }; };

async function openHarness(page, harnessBase) {
  await page.goto(`${harnessBase}/harness-folder-workspace.html?create&cloud-enabled&workbench`);
  await page.getByRole("button", { name: "Open folder fixture", exact: true }).click();
  await page.getByRole("button", { name: "Initialize git and create", exact: true }).click();
  await page.evaluate(async () => { window.setCreateOrganization("organization"); await window.seedCloudProjects(); });
}

export async function runCloudProjectsSmoke({ page, check, harnessBase }) {
  await openHarness(page, harnessBase);
  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  const placement = page.getByRole("tablist", { name: "Where the workspace runs", exact: true });
  await placement.getByRole("tab", { name: "Cloud", exact: true }).click();
  const composer = page.locator("[data-dispatcher-composer]");
  const repos = page.getByRole("button", { name: "2 repositories", exact: true });
  await expect(page.getByRole("button", { name: "Choose project", exact: true })).toHaveText(/Zeros/);
  await expect(repos).toBeVisible();
  const before = { tabs: await box(placement), composer: await box(composer) };

  await page.getByRole("button", { name: "Choose project", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("group", { name: "Organization 1" })).toContainText("Zeros");
  await expect(menu.getByRole("group", { name: "Only you" })).toContainText("client-app");
  await expect(menu.getByRole("menuitem", { name: "New project", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Manage projects", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: /^Okit/ }).click();
  // One repository: the plain branch control, and nothing on the page moves.
  await expect(repos).toHaveCount(0);
  await expect(page.locator("[data-dispatcher-context]")).not.toContainText("repos");
  expect({ tabs: await box(placement), composer: await box(composer) }).toEqual(before);
  await page.getByRole("button", { name: "Choose project", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: /^Zeros/ }).click();
  await expect(repos).toBeVisible();
  expect({ tabs: await box(placement), composer: await box(composer) }).toEqual(before);
  check("Create lists the organization's projects, then Only you, New project and Manage projects; N repos comes and goes without moving the tabs or composer", true);

  await repos.click();
  await page.getByRole("menuitem", { name: /zeros-design-demo/ }).hover();
  await page.getByRole("menuitem", { name: "feature/remote", exact: true }).click();
  await repos.click();
  await expect(page.getByRole("menuitem", { name: /zeros-design-demo/ })).toContainText("feature/remote");
  await page.keyboard.press("Escape");
  check("N repos lists each repository with the branch its workspace starts from, picked from its own branches", true);

  await page.evaluate(() => window.openCloudProjectWorkspace());
  await page.getByRole("tab", { name: /^Changes/ }).click();
  await expect(page.getByRole("tab", { name: /^Changes/ })).toContainText("3");
  const switcher = page.getByRole("button", { name: /^Repository:/ });
  await expect(switcher).toHaveText(/zeros/);
  await expect(page.getByText(ZEROS_FILE, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(DEMO_FILE, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Create PR/ }).first()).toBeVisible();
  check("A workspace of several repositories totals its Changes badge and starts on its first repository with Create PR", true);

  await switcher.click();
  await expect(page.getByRole("menuitemradio", { name: /zeros-design-demo/ })).toContainText("+12");
  await page.getByRole("menuitemradio", { name: /zeros-design-demo/ }).click();
  // Never the other repository's list, not even for a frame.
  await expect(page.getByText(ZEROS_FILE, { exact: true })).toHaveCount(0);
  await expect(page.getByText(DEMO_FILE, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Draft pull request", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Create PR/ })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^Changes/ })).toContainText("3");
  await switcher.click();
  await page.getByRole("menuitemradio", { name: /^zeros/ }).first().click();
  await expect(page.getByText(DEMO_FILE, { exact: true })).toHaveCount(0);
  await expect(page.getByText(ZEROS_FILE, { exact: true }).first()).toBeVisible();
  check("Switching repository lists only that repository's changes and its own pull request, never the other's", true);

  await page.getByRole("tab", { name: /^Files/ }).click();
  await expect(page.getByText("Zeros", { exact: true }).first()).toBeVisible();
  // One folder per repository at the top of the project folder, each with its branch; no file outside them.
  for (const folder of ["zeros", "zeros-design-demo"]) {
    const item = page.locator(`file-tree-container [data-item-path="${folder}/"], file-tree-container [data-item-path="${folder}"]`).first();
    await expect(item).toBeVisible();
    await expect(item).toContainText("arun/dark-mode");
  }
  await expect(page.locator('file-tree-container [data-item-path="AGENTS.md"]')).toHaveCount(0);
  check("Files shows the project folder with each repository's folder and branch", true);

  const row = page.locator("[data-folder-workspace-surface]").getByText("Dark mode", { exact: true }).first();
  await expect(row).toBeVisible();
  await expect(page.locator("[data-folder-workspace-surface]")).toContainText("+60");
  const rowBox = await row.boundingBox();
  await page.mouse.move(rowBox.x + 10, rowBox.y + rowBox.height / 2);
  await expect(page.getByText("#9", { exact: true }).first()).toBeVisible();
  check("The sidebar row totals every repository's lines and its hover card carries the one pull request mark", true);
}
