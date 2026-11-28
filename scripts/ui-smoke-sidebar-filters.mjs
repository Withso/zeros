import { expect } from "@playwright/test";
import { closeSidebarMenu, openSidebarSubmenu, selectSidebarGrouping, selectSidebarSort } from "./ui-smoke/sidebar-menu.mjs";

export async function runSidebarWorkspaceFilters({ page, check, harnessBase }) {
  // Owner isolation below is the stable sidebar; the unified section follows.
  const harness = `${harnessBase}/harness-app-sidebar.html?feature-off=unified-workspaces`;
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(harness, { waitUntil: "networkidle" });
  const trigger = page.getByRole("button", {
    name: "Filter workspaces",
    exact: true,
    // The modal menu hides the surrounding sidebar from the accessibility
    // tree while its still-visible trigger keeps its description current.
    includeHidden: true,
  });
  // A changed view is announced, never painted: the filter icon carries no dot.
  const expectFilterIndicator = async (active) => {
    await expect(trigger).toHaveAccessibleDescription(
      active ? "View changed from defaults" : "",
    );
    await expect(trigger.locator("[data-filter-indicator]")).toHaveCount(0);
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
  const groupKeys = () =>
    page
      .locator('[data-sidebar-section="mine"] ~ [role="group"] [data-sidebar-group], [data-sidebar-group]')
      .evaluateAll((nodes) => [...new Set(nodes.map((node) => node.dataset.sidebarGroup))]);
  await page.evaluate(() =>
    window.appSidebarUpdateWorkspace("ws-seville", { setupState: "failed" }),
  );
  const needsYou = page.getByRole("group", { name: "Needs you workspaces", exact: true });
  const idle = page.getByRole("group", { name: "Idle workspaces", exact: true });
  await expect(needsYou.locator('[data-workspace-id="ws-seville"]')).toBeVisible();
  await expect(needsYou.locator('[data-workspace-id="ws-seville"]')).toContainText("Setup failed");
  await expect(idle.locator('[data-workspace-id="ws-boston"]')).toBeVisible();
  await expect
    .poll(async () => (await groupKeys()).filter((key) => /needs-you|idle/.test(key)))
    .toEqual(["group:needs-you", "group:idle"]);
  const idleHeader = page.locator('[data-sidebar-group="group:idle"]');
  const idleToggle = idleHeader.getByRole("button", { name: /^Idle, \d+$/ });
  await idleToggle.click();
  await expect(idleToggle).toHaveAttribute("aria-expanded", "false");
  await expect(row("ws-atlanta")).toBeVisible();
  await expect(row("ws-boston")).toHaveCount(0);
  await idleToggle.click();
  await expect(row("ws-boston")).toBeVisible();
  await page.evaluate(() =>
    window.appSidebarUpdateWorkspace("ws-new-york", { archivedAt: 1 }),
  );
  const archived = page.getByRole("group", { name: "Archived workspaces", exact: true });
  await expect(archived.locator('[data-workspace-id="ws-new-york"]')).toHaveCount(0);
  await expect(page.locator('[data-sidebar-group="group:archived"]')).toBeVisible();
  expect((await groupKeys()).at(-1)).toBe("group:archived");
  check(
    "Status groups are Needs you, Working, Idle, then Archived; Setup failed needs you, and collapse keeps the selection",
    true,
  );

  // The Group menu lists this grouping's groups: the eye hides one (the open
  // workspace stays), Alt+↑ moves one, and the menu stays open throughout.
  await openSidebarSubmenu(page, "Group");
  const idleOrder = page.getByRole("menuitemcheckbox", { name: /^Idle/ });
  await expect(idleOrder).toHaveAttribute("aria-checked", "true");
  await idleOrder.click();
  await expect(idleOrder).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("menu").first()).toBeVisible();
  await expect(row("ws-boston")).toHaveCount(0);
  await expect(row("ws-atlanta")).toBeVisible();
  await idleOrder.click();
  await expect(idleOrder).toHaveAttribute("aria-checked", "true");
  const orderLabels = () =>
    page
      .locator("[data-sidebar-group-order-list] [role=menuitemcheckbox]")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent.replace(/\d+$/, "").trim()));
  await expect.poll(orderLabels).toEqual(["Needs you", "Working", "Idle", "Archived"]);
  // Park the pointer off the menu: an item sliding under a resting pointer
  // takes focus the way any menu row does on hover.
  await page.mouse.move(900, 700);
  await idleOrder.focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(orderLabels).toEqual(["Needs you", "Idle", "Working", "Archived"]);
  await expect(idleOrder).toBeFocused();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(orderLabels).toEqual(["Idle", "Needs you", "Working", "Archived"]);
  await closeSidebarMenu(page);
  await expect
    .poll(async () => (await groupKeys()).filter((key) => /needs-you|idle/.test(key)))
    .toEqual(["group:idle", "group:needs-you"]);
  await expectFilterIndicator(true);
  // The harness's Setup failed patch is in memory; the order is persisted.
  await page.reload({ waitUntil: "networkidle" });
  await openSidebarSubmenu(page, "Group");
  await expect.poll(orderLabels).toEqual(["Idle", "Needs you", "Working", "Archived"]);
  await page.getByRole("menu").last().getByRole("menuitem", { name: "Reset", exact: true }).click();
  await expect(page.locator('[data-sidebar-group="group:needs-you"]')).toHaveCount(0);
  await closeSidebarMenu(page);
  check(
    "Group order and hiding persist per grouping, keep the open workspace and leave the menu open",
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
  await expect.poll(order).toEqual(["ws-boston", "ws-atlanta"]);
  const colors = page.getByRole("menuitemcheckbox", {
    name: "example/ocolors",
    exact: true,
  });
  await colors.click();
  await expect(colors).toHaveAttribute("aria-checked", "true");
  await expect(row("ws-seville")).toBeVisible();
  await expect(row("ws-paris-mumbai-city-docs")).toHaveCount(0);
  await closeSidebarMenu(page);
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
    page.getByRole("menuitem", { name: /^Group by/ }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("menuitemradio", { name: "Repository", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitemradio", { name: "Status", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-sidebar-group="group:idle"]')).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: "Status", exact: true })).toHaveAttribute("aria-checked", "true");
  await closeSidebarMenu(page);
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
    await closeSidebarMenu(page);
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
