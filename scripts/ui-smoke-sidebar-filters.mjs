import { expect } from "@playwright/test";
import { openSidebarSubmenu, selectSidebarGrouping, selectSidebarSort } from "./ui-smoke/sidebar-menu.mjs";

export async function runSidebarWorkspaceFilters({ page, check, harnessBase }) {
  // Owner isolation below is the stable sidebar; the unified section follows.
  const harness = `${harnessBase}/harness-app-sidebar.html?feature-off=unified-workspaces`;
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
      active ? "View changed from defaults" : "",
    );
    await expect(indicator).toHaveCount(active ? 1 : 0);
    if (active) await expect(indicator).toBeVisible();
  };
  const row = (id) => page.locator(`[data-workspace-id="${id}"]`);
  const order = () =>
    page
      .locator("[data-workspace-tab]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.workspaceId));
  const selectGroup = (name) => selectSidebarGrouping(page, name);
  const selectSort = (name) => selectSidebarSort(page, name);
  const openRepositories = async () => {
    await openSidebarSubmenu(page, "Filter");
    const repository = page.getByRole("menuitem", { name: /^Repository/ });
    await repository.hover();
    await expect(repository).toHaveAttribute("data-state", "open");
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
  await selectSort("Last updated");
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

  await selectGroup("Repository");
  await openRepositories();
  const zeros = page.getByRole("menuitemcheckbox", {
    name: "example/zeros",
    exact: true,
  });
  await zeros.click();
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
      swatch.style.backgroundColor = "var(--accent-text)";
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
    "Repository filter supports multiple repositories and reload persistence",
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
  await expect(page.getByRole("menuitem", { name: /^Sort/ })).toBeFocused();
  const group = page.getByRole("menuitem", { name: /^Group/ });
  for (let step = 0; step < 6; step += 1) {
    if (await group.evaluate((node) => node === document.activeElement)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(group).toBeFocused();
  await page.keyboard.press("ArrowRight");
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

  await selectGroup("Repository");
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

  // unified-workspaces (on in dev): Local work shows under every owner, cloud
  // rows carry one trailing mark, and This Mac / Cloud filter the list.
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`${harnessBase}/harness-app-sidebar.html`, { waitUntil: "networkidle" });
  await expect(row("ws-atlanta")).toBeVisible();
  const seeded = await page.evaluate(() => window.appSidebarSeedCloud());
  await page.evaluate((id) => window.appSidebarSelectOwner(id), seeded.organizationId);
  await expect(row(seeded.keys[0])).toBeVisible();
  await expect(row("ws-atlanta")).toBeVisible();
  await expect(row(seeded.keys[2])).toHaveCount(0);
  await expect(row(seeded.keys[0]).locator('[data-cloud-mark="stopped"]')).toHaveCount(1);
  await expect(row("ws-atlanta").locator("[data-cloud-mark]")).toHaveCount(0);
  const placement = async (name) => {
    await openSidebarSubmenu(page, "Filter");
    const placementItem = page.getByRole("menuitem", { name: /^Placement/ });
    await placementItem.hover();
    await expect(placementItem).toHaveAttribute("data-state", "open");
    await page.getByRole("menuitemcheckbox", { name, exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
  };
  await placement("Cloud");
  await expect(row(seeded.keys[0])).toHaveCount(0);
  await expect(row("ws-atlanta")).toBeVisible();
  await expect(trigger).toHaveAccessibleDescription("View changed from defaults");
  await page.evaluate((id) => window.appSidebarSelectOwner(id), seeded.otherOrganizationId);
  await expect(row(seeded.keys[2])).toBeVisible();
  await page.evaluate((id) => window.appSidebarSelectOwner(id), seeded.organizationId);
  await expect(row(seeded.keys[0])).toHaveCount(0);
  await placement("Cloud");
  await expect(row(seeded.keys[0])).toBeVisible();
  await expect(trigger).toHaveAccessibleDescription("");
  check(
    "Unified sidebar lists Local work under an organization, marks cloud rows, and filters This Mac / Cloud per owner",
    true,
  );
}
