import { expect } from "@playwright/test";

export async function runWorkspaceArchivesSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-workspace-archives.html`,
  );
  const options = (title) =>
    page.getByRole("button", { name: `Options for ${title}`, exact: true });
  const hiddenIndicators = page.getByRole("img", {
    name: "Hidden workspace",
    exact: true,
  });
  const menuItem = (name) => page.getByRole("menuitem", { name, exact: true });
  const navigate = async (destination) =>
    page.evaluate(
      (activePage) => window.archiveFixture.navigate(activePage),
      destination,
    );

  await expect(
    page.getByRole("button", { name: "Unarchive", exact: true }),
  ).toHaveCount(2);
  await options("Recent").click();
  await menuItem("Hide").click();
  await expect(options("Recent")).toHaveCount(0);
  await navigate("settings");
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await page
    .getByRole("switch", {
      name: "Show hidden workspaces in dashboard",
      exact: true,
    })
    .click();
  await navigate("dashboard");
  await expect(options("Recent")).toBeVisible();
  await expect(hiddenIndicators).toHaveCount(1);
  check(
    "Hide retains an archive, and General settings reveals it beside Unarchive",
    true,
  );

  await navigate("settings");
  await page.getByRole("tab", { name: "Experimental", exact: true }).click();
  await page
    .getByRole("switch", {
      name: "Hide archived workspaces after 15 days",
      exact: true,
    })
    .click();
  await navigate("dashboard");
  await expect(hiddenIndicators).toHaveCount(2);
  await options("Older").click();
  await menuItem("Unhide").click();
  await expect(hiddenIndicators).toHaveCount(1);
  check(
    "The 15-day policy hides older archives and honors explicit Unhide",
    true,
  );

  await options("Older").click();
  await menuItem("Delete saved snapshot…").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await options("Older").click();
  await menuItem("Delete saved snapshot…").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await navigate("settings");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await navigate("dashboard");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await options("Older").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await navigate("settings");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await navigate("dashboard");
  await expect(page.getByRole("menu")).toHaveCount(0);
  check(
    "Retained Dashboard menus and deletion dialogs close on navigation",
    true,
  );

  await page.reload();
  await expect(hiddenIndicators).toHaveCount(1);
  await options("Older").click();
  await menuItem("Delete saved snapshot…").click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete saved snapshot", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await options("Older").click();
  await expect(menuItem("Delete saved snapshot…")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  // Focus arrives before Radix registers the menu as its active dismissable
  // layer. Wait for that layer to accept input before sending Escape.
  const menu = page.getByRole("menu");
  await expect(menu).toBeFocused();
  await expect(menu).toHaveCSS("pointer-events", "auto");
  await menu.press("Escape");
  await expect(menu).toHaveCount(0);
  await options("Recent")
    .locator("..")
    .getByRole("button", { name: "Unarchive", exact: true })
    .click();
  await navigate("dashboard");
  await expect(options("Recent")).toHaveCount(0);
  await expect(options("Older")).toBeVisible();
  await expect(hiddenIndicators).toHaveCount(0);
  const mutations = await page.evaluate(() =>
    window.archiveFixture.requests.filter(({ op }) =>
      [
        "workspace.delete",
        "workspace.deleteSnapshot",
        "workspace.restore",
      ].includes(op),
    ),
  );
  expect(mutations.map(({ op }) => op)).toEqual([
    "workspace.deleteSnapshot",
    "workspace.restore",
  ]);
  expect(mutations[0].params).toMatchObject({
    workspaceId: "older",
    archiveSnapshot: "a".repeat(40),
    archivedAt: expect.any(Number),
  });
  check(
    "Visibility survives reload, explicit snapshot deletion keeps the archive, and hidden archives can unarchive",
    true,
  );
}
