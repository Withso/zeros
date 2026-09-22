import { expect } from "@playwright/test";

export async function runFolderReviewSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-folder-workspace.html?workbench`,
  );
  await page
    .getByRole("button", { name: "Restore saved folder", exact: true })
    .click();
  const panels = page.getByRole("tablist", { name: "Workspace panels" });
  await expect(panels).toBeVisible();
  const review = panels.getByRole("tab", { name: "Review", exact: true });
  const files = panels.getByRole("tab", { name: "Open file", exact: true });
  const rootTab = page.locator('[data-workspace-id="local:to-do-app"]');
  const chats = await page.locator("[data-folder-state]").textContent();
  const resumeWith = async (isRepo, originUrl = null, fails = false) => {
    await page.evaluate(
      ({ isRepo, originUrl, fails }) => {
        window.setFolderInspection(isRepo, originUrl, fails);
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      },
      { isRepo, originUrl, fails },
    );
  };
  await expect(review).toHaveCount(0);
  await page.evaluate(() => window.selectFolderReview());
  await expect(files).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No pull request", { exact: true })).toHaveCount(
    0,
  );
  await page.evaluate(() => window.setFolderGitState(true, null));
  await expect(review).toHaveCount(0);
  check(
    "Plain folders and local Git without GitHub omit Review, including saved Review selections",
    true,
  );

  await resumeWith(true, "git@github.com:example/project.git");
  await expect(review).toBeVisible();
  await expect(rootTab).toHaveCount(1);
  await expect(page.locator("[data-folder-state]")).toHaveText(chats);
  await review.click();
  await expect(review).toHaveAttribute("aria-selected", "true");
  await resumeWith(false);
  await expect(review).toHaveCount(0);
  await expect(files).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No pull request", { exact: true })).toHaveCount(
    0,
  );
  await resumeWith(true, "git@github.com:example/project.git");
  await expect(review).toHaveAttribute("aria-selected", "true");
  await resumeWith(true, null);
  await expect(review).toHaveCount(0);
  await expect(files).toHaveAttribute("aria-selected", "true");
  await expect(rootTab).toHaveCount(1);
  await expect(rootTab).toHaveCount(1);
  await expect(page.locator("[data-folder-state]")).toHaveText(chats);
  for (const filter of ["To-do app", "Ungrouped", "Active", "Grouped"]) {
    await page
      .getByRole("button", { name: "Filter workspaces", exact: true })
      .click();
    await page.getByRole("menuitem", { name: filter, exact: true }).click();
    await expect(rootTab).toHaveCount(1);
  }
  check(
    "Resume refresh updates Review after external Git/remote changes and preserves chats and the folder tab",
    true,
  );

  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-folder-workspace.html?summary`,
  );
  await page
    .getByRole("button", { name: "Restore saved folder", exact: true })
    .click();
  const summary = page.getByRole("complementary", {
    name: "Workspace summary",
  });
  await expect(summary).toBeVisible();
  await expect(
    summary.getByRole("button", { name: "Review", exact: true }),
  ).toHaveCount(0);
  await expect(
    summary.getByRole("button", { name: "Files", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.setFolderGitState(true, "git@github.com:example/project.git"),
  );
  await expect(
    summary.getByRole("button", { name: "Review", exact: true }),
  ).toBeVisible();
  const probes = () =>
    page.evaluate(
      () =>
        window.folderWorkspaceRequests.filter(
          (request) => request.op === "workspace_inspect_folder",
        ).length,
    );
  const beforeFailure = await probes();
  await resumeWith(false, null, true);
  await expect.poll(probes).toBeGreaterThan(beforeFailure);
  await expect(
    summary.getByRole("button", { name: "Review", exact: true }),
  ).toBeVisible();
  await resumeWith(true, null);
  await expect(
    summary.getByRole("button", { name: "Review", exact: true }),
  ).toHaveCount(0);
  check(
    "Summary shares Review availability and keeps confirmed controls on inspection failure",
    true,
  );
}
