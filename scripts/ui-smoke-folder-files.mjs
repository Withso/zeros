import { expect } from "@playwright/test";

export async function runFolderFilesSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-folder-workspace.html?workbench&files`,
  );
  await page
    .getByRole("button", { name: "Restore saved folder", exact: true })
    .click();
  const filesTab = page.getByRole("tab", { name: "Open file", exact: true });
  await filesTab.click();
  const empty = page.getByText("No files in this workspace", { exact: true });
  await expect(page.getByTestId("files-tab")).toBeVisible();
  await expect(empty).toHaveCount(0);
  await page.evaluate(() => window.releaseFolderFiles());
  await expect(empty).toBeVisible();
  await expect(
    page.getByTestId("files-tab").locator("svg.lucide-file"),
  ).toBeVisible();
  check(
    "Files shows a file icon and empty message only after the workspace listing is confirmed",
    true,
  );

  const repo = page
    .getByRole("tablist", { name: "Home navigation" })
    .getByRole("tab", { name: /^To-do app/ });
  await expect(repo).toHaveText("To-do app");
  await page.evaluate(() => window.setFolderGitState(true));
  await expect(repo.getByText("1", { exact: true })).toBeVisible();
  await page.evaluate(() => window.setFolderGitState(false));
  await expect(repo).toHaveText("To-do app");
  check(
    "Sidebar omits workspace counts for plain folders and retains them for Git repositories",
    true,
  );

  await page.evaluate(() => window.setFolderFiles(["README.md"]));
  const readme = page.locator(
    'file-tree-container [data-item-path="README.md"]',
  );
  await expect(readme).toBeVisible();
  await expect(empty).toHaveCount(0);
  await page.evaluate(() => window.setFolderFiles([], [], true));
  await expect(readme).toBeVisible();
  await expect(empty).toHaveCount(0);
  await page.evaluate(() => window.setFolderFiles([], [".env"]));
  await expect(
    page.locator('file-tree-container [data-item-path=".env"]'),
  ).toBeVisible();
  await expect(empty).toHaveCount(0);
  await page.evaluate(() => window.setFolderFiles([]));
  await expect(empty).toBeVisible();
  await expect(readme).toHaveCount(0);
  check(
    "Files updates after creation and deletion, retains files on read failure, and counts ignored files as content",
    true,
  );
}
