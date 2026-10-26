import { expect } from "@playwright/test";

export async function runSidebarWorkspaceFilters({ page, check, harnessBase }) {
  const harness = `${harnessBase}/harness-app-sidebar.html`;
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(harness, { waitUntil: "networkidle" });
  const trigger = page.getByRole("button", {
    name: "Filter workspaces",
    exact: true,
    // The modal menu hides the surrounding sidebar from the accessibility
    // tree while its still-visible trigger updates the filter indicator.
    includeHidden: true,
  });
  const indicator = trigger.locator("[data-filter-indicator]");
  const expectFilterIndicator = async (active) => {
    await expect(trigger).toHaveAccessibleDescription(
      active ? "Repository filter active" : "",
    );
    await expect(indicator).toHaveCount(active ? 1 : 0);
    if (active) await expect(indicator).toBeVisible();
  };
  const row = (id) => page.locator(`[data-workspace-id="${id}"]`);
  const order = () =>
    page
      .locator("[data-workspace-tab]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.workspaceId));
  const selectGroup = async (name) => {
    await trigger.click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };
  const selectSort = async (name) => {
    await trigger.click();
    await page.getByRole("menuitem", { name: "Sort by", exact: true }).hover();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };
  const openRepositories = async () => {
    await trigger.click();
    const filter = page.getByRole("menuitem", { name: /^Filter/ });
    await expect(filter).toHaveText("Filter");
    await filter.hover();
    await page.getByRole("menuitem", { name: "Repo", exact: true }).hover();
    const search = page.getByRole("searchbox", { name: "Search repositories" });
    await expect(search).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS("border-top-width", "0px");
    await expect(
      page.getByRole("menuitem", { name: "All repositories", exact: true }),
    ).toHaveCount(0);
    return search;
  };

  await expectFilterIndicator(false);
  await selectGroup("None");
  const createdOrder = await order();
  await page.evaluate(() =>
    window.appSidebarRecordActivity("ws-new-york", Date.now()),
  );
  await expect.poll(async () => (await order())[0]).toBe("ws-new-york");
  await row("ws-atlanta")
    .getByRole("button", { name: /^Open workspace/ })
    .click();
  expect((await order())[0]).toBe("ws-new-york");
  await selectSort("Created");
  expect(await order()).toEqual(createdOrder);
  await page.evaluate(() => window.appSidebarUpdateChat("ws-seville"));
  expect(await order()).toEqual(createdOrder);
  await selectSort("Updated");
  await expect.poll(async () => (await order())[0]).toBe("ws-seville");
  await page.evaluate(() =>
    window.appSidebarUpdateWorkspace("ws-new-york", { status: "done" }),
  );
  await expect.poll(async () => (await order())[0]).toBe("ws-new-york");
  check(
    "Updated follows actions, chats and confirmed status changes; Created and navigation stay fixed",
    true,
  );

  await selectGroup("Status");
  expect(
    await page
      .locator("[data-sidebar-status]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.sidebarStatus)),
  ).toEqual(["backlog", "in-progress", "in-review", "done", "cancelled"]);
  await expect(
    page
      .getByRole("group", { name: "Done workspaces", exact: true })
      .locator('[data-workspace-id="ws-new-york"]'),
  ).toBeVisible();
  await page.evaluate(() =>
    window.appSidebarUpdateWorkspace("ws-seville", { status: "in-review" }),
  );
  await expect(
    page
      .getByRole("group", { name: "In review workspaces", exact: true })
      .locator('[data-workspace-id="ws-seville"]'),
  ).toBeVisible();
  const progress = page.locator('[data-sidebar-status="in-progress"]');
  await progress.click();
  await expect(progress).toHaveAttribute("aria-expanded", "false");
  await expect(row("ws-atlanta")).toBeVisible();
  await expect(row("ws-boston")).toHaveCount(0);
  await progress.click();
  await expect(row("ws-boston")).toBeVisible();
  await page.evaluate(() =>
    window.appSidebarUpdateWorkspace("ws-new-york", { archivedAt: 1 }),
  );
  await expect(row("ws-new-york")).toHaveCount(0);
  check(
    "Status reuses Home's five groups, updates live, excludes archives and keeps the selection through collapse",
    true,
  );

  await selectGroup("None");
  const search = await openRepositories();
  await search.fill("no matching repository");
  await expect(
    page.getByText("No repositories found", { exact: true }),
  ).toBeVisible();
  await search.fill("ze");
  await search.press("ArrowDown");
  const zeros = page.getByRole("menuitemcheckbox", {
    name: "example/zeros",
    exact: true,
  });
  await expect(zeros).toBeFocused();
  await zeros.press("Enter");
  await expect(zeros).toHaveAttribute("aria-checked", "true");
  await expectFilterIndicator(true);
  const originalTheme = await page.evaluate(
    () => document.documentElement.dataset.theme,
  );
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (value) => (document.documentElement.dataset.theme = value),
      theme,
    );
    const colors = await indicator.evaluate((node) => {
      const swatch = document.createElement("span");
      swatch.style.backgroundColor = "var(--blue-primary)";
      document.body.append(swatch);
      const expected = getComputedStyle(swatch).backgroundColor;
      swatch.remove();
      return { actual: getComputedStyle(node).backgroundColor, expected };
    });
    expect(colors.actual).toBe(colors.expected);
  }
  await page.evaluate((theme) => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, originalTheme);
  await expect.poll(order).toEqual(["ws-boston", "ws-atlanta"]);
  await search.fill("ocolors");
  const colors = page.getByRole("menuitemcheckbox", {
    name: "example/ocolors",
    exact: true,
  });
  await colors.click();
  await expect(colors).toHaveAttribute("aria-checked", "true");
  await expect(row("ws-seville")).toBeVisible();
  await expect(row("ws-paris-mumbai-city-docs")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "networkidle" });
  await expect(row("ws-atlanta")).toBeVisible();
  await expect(row("ws-seville")).toBeVisible();
  await expect(row("ws-paris-mumbai-city-docs")).toHaveCount(0);
  await expect(trigger).toHaveAttribute("data-filtered", "true");
  await expectFilterIndicator(true);
  check(
    "Repo supports search, keyboard selection, multiple repositories and reload persistence",
    true,
  );

  await openRepositories();
  await zeros.click();
  await expectFilterIndicator(true);
  await colors.click();
  await expect(row("ws-paris-mumbai-city-docs")).toBeVisible();
  await expectFilterIndicator(false);
  await expect(
    page.locator('button[aria-label="Filter workspaces"]'),
  ).not.toHaveAttribute("data-filtered");
  await page.evaluate(() => window.appSidebarNavigate("settings"));
  await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
  await page.evaluate(() => window.appSidebarNavigate("dashboard"));
  await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
  await trigger.focus();
  await trigger.press("Enter");
  await expect(
    page.getByRole("menuitemradio", { name: "None", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("menuitemradio", { name: "Repository", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitemradio", { name: "Status", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-sidebar-status]")).toHaveCount(5);
  check(
    "Clearing filters restores all repositories; hidden menus close and grouping is keyboard accessible",
    true,
  );

  await selectGroup("None");
  await openRepositories();
  await page
    .getByRole("menuitemcheckbox", { name: "example/zeros", exact: true })
    .click();
  const cloud = await page.evaluate(() => window.appSidebarSeedCloud());
  await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
  await expectFilterIndicator(false);
  await expect(row(cloud.keys[0])).toBeVisible();
  await expect(row(cloud.keys[1])).toBeVisible();
  await expect(row("ws-atlanta")).toHaveCount(0);
  await openRepositories();
  await page
    .getByRole("menuitemcheckbox", { name: "example/cloud-two", exact: true })
    .click();
  await expect(row(cloud.keys[0])).toHaveCount(0);
  await expect(row(cloud.keys[1])).toBeVisible();
  await expectFilterIndicator(true);
  await page.evaluate(
    (id) => window.appSidebarSelectOwner(id),
    cloud.otherOrganizationId,
  );
  await expect(row(cloud.keys[2])).toBeVisible();
  await expect(row(cloud.keys[1])).toHaveCount(0);
  await expectFilterIndicator(false);
  await page.evaluate(
    (id) => window.appSidebarSelectOwner(id),
    cloud.organizationId,
  );
  await expect(row(cloud.keys[1])).toBeVisible();
  await expect(row(cloud.keys[0])).toHaveCount(0);
  await expectFilterIndicator(true);
  await page.evaluate(() => window.appSidebarSelectOwner(null));
  await expect(row("ws-atlanta")).toBeVisible();
  await expect(row("ws-seville")).toHaveCount(0);
  await expect(row(cloud.keys[1])).toHaveCount(0);
  await expectFilterIndicator(true);
  check(
    "Local and cloud repository filters restore independently through owner switches, closing stale menus",
    true,
  );
}
