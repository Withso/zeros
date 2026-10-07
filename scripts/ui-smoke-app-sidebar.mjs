import { expect } from "@playwright/test";
import { appSidebarRegressionChecks } from "./ui-smoke-app-sidebar-regressions.mjs";

// App sidebar contract: Grouped by default with every workspace under its
// repository; Grouped/Ungrouped are the only presentations; repository headers
// swap their icon for a disclosure chevron on hover, keep + visible, and reveal
// settings and ⋯ (Create workspace / Create from… / Configuration / Remove
// repository); collapse is persisted per repository and never hides the
// selected workspace.
export async function runAppSidebarSmoke({ page, check, harnessBase }) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const harness = `${harnessBase}/harness-app-sidebar.html`;
  const state = () => page.evaluate(() => window.appSidebarState());
  const header = (id) => page.locator(`[data-sidebar-repository="${id}"]`);
  const row = (id) => page.locator(`[data-workspace-id="${id}"]`);
  const moveAway = () => page.mouse.move(900, 700);
  const selectFilter = async (name) => {
    await page
      .getByRole("button", { name: "Filter workspaces", exact: true })
      .click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };

  await page.goto(harness, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(harness, { waitUntil: "networkidle" });
  await expect(row("ws-new-york")).toBeVisible();

  const headers = page.locator("[data-sidebar-repository]");
  expect(
    await headers.evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector(".truncate")?.textContent),
    ),
  ).toEqual(["Zeros", "0colors", "0kit", "To-do app"]);
  const order = await page
    .locator("[data-sidebar-repository], [data-workspace-tab]")
    .evaluateAll((nodes) =>
      nodes.map(
        (node) =>
          node.getAttribute("data-sidebar-repository") ??
          node.getAttribute("data-workspace-id"),
      ),
    );
  expect(order).toEqual([
    "project-zeros",
    "ws-boston",
    "ws-atlanta",
    "project-ocolors",
    "ws-seville",
    "project-okit",
    "ws-paris-mumbai-city-docs",
    "project-todo-app",
    "ws-new-york",
  ]);
  expect((await state()).filter).toBe("grouped");
  check(
    "Grouped is the default and lists each workspace under its repository",
    true,
  );

  const zeros = header("project-zeros");
  const plus = zeros.getByRole("button", {
    name: "Create workspace in Zeros",
    exact: true,
  });
  const settings = zeros.getByRole("button", {
    name: "Zeros settings",
    exact: true,
  });
  const more = zeros.getByRole("button", {
    name: "More actions for Zeros",
    exact: true,
  });
  await moveAway();
  await expect(plus).toBeVisible();
  await expect(settings).toBeHidden();
  await expect(more).toBeHidden();
  const chip = zeros.locator("span.rounded-sm").first();
  const chevron = zeros.locator("svg.lucide-chevron-down");
  await expect(chevron).toBeHidden();
  await zeros.hover();
  await expect(settings).toBeVisible();
  await expect(more).toBeVisible();
  await expect(chevron).toBeVisible();
  expect(await chip.evaluate((node) => getComputedStyle(node).visibility)).toBe(
    "hidden",
  );
  const plusBox = await plus.boundingBox();
  await moveAway();
  expect(await plus.boundingBox()).toEqual(plusBox);
  check(
    "Hover swaps the repository icon for a chevron and reveals settings and ⋯ beside the fixed +",
    true,
  );

  await zeros.hover();
  await more.click();
  const items = page.getByRole("menuitem");
  expect(await items.allTextContents()).toEqual([
    "Create workspace",
    "Create from…",
    "Configuration",
    "Remove repository",
  ]);
  // The open menu hides the page from assistive tech, so assert the trigger's
  // painted visibility directly: its actions stay while the menu is open.
  await moveAway();
  await expect(
    zeros.locator('button[aria-label="More actions for Zeros"]'),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Configuration" }).click();
  await expect.poll(async () => (await state()).page).toBe("repo");
  expect(await state()).toMatchObject({
    repoId: "project-zeros",
    repoView: "environment",
  });
  await expect(zeros).toHaveAttribute("data-active", "true");
  check(
    "The repository menu offers exactly Create workspace, Create from…, Configuration and Remove repository",
    true,
  );

  const okit = header("project-okit");
  await okit.hover();
  await okit
    .getByRole("button", { name: "Create workspace in 0kit", exact: true })
    .click();
  await expect.poll(async () => (await state()).page).toBe("create");
  expect((await state()).createProjectId).toBe("project-okit");
  await expect(
    page.getByRole("button", { name: "Choose project" }),
  ).toContainText("0kit");
  await expect(
    page.getByRole("dialog", { name: "Create from source" }),
  ).toHaveCount(0);
  await header("project-ocolors").hover();
  await page
    .getByRole("button", { name: "More actions for 0colors", exact: true })
    .click();
  // A pointer can leave the selected item after the new picker takes focus,
  // while Radix still retains the closing menu for its exit animation.
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent === "Create from…",
    );
    const menu = item.closest('[data-radix-menu-content]');
    // Hold the exit phase until the event is delivered, even on a slow host.
    menu.style.animationPlayState = "paused";
    window.__sidebarSourceLeaveSent = false;
    const leaveAfterFocus = (event) => {
      if (event.target.getAttribute?.("aria-label") !== "Search sources") return;
      document.removeEventListener("focusin", leaveAfterFocus, true);
      if (!item?.isConnected) return;
      item.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          pointerType: "mouse",
          relatedTarget: event.target,
        }),
      );
      menu.style.animationPlayState = "";
      window.__sidebarSourceLeaveSent = true;
    };
    document.addEventListener("focusin", leaveAfterFocus, true);
  });
  await page.getByRole("menuitem", { name: "Create from…" }).click();
  await expect(
    page.getByRole("button", { name: "Choose project" }),
  ).toContainText("0colors");
  const source = page.getByRole("dialog", { name: "Create from source" });
  await expect
    .poll(() => page.evaluate(() => window.__sidebarSourceLeaveSent))
    .toBe(true);
  await expect(source).toBeVisible();
  await expect(
    source.getByRole("searchbox", { name: "Search sources" }),
  ).toBeFocused();
  await page.waitForTimeout(400);
  await expect(source).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(source).toHaveCount(0);
  check(
    "+ opens Create for its repository; Create from… also opens that repository's source picker",
    true,
  );

  await zeros.hover();
  await settings.click();
  await expect.poll(async () => (await state()).page).toBe("repo");
  expect((await state()).repoId).toBe("project-zeros");
  await zeros.hover();
  await more.click();
  await page.getByRole("menuitem", { name: "Remove repository" }).click();
  const removal = page.getByRole("dialog", { name: "Remove Zeros?" });
  await expect(removal).toBeVisible();
  await removal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(removal).toHaveCount(0);
  await expect(zeros).toHaveCount(1);
  check(
    "Settings opens the repository page and Remove repository asks before removing",
    true,
  );

  await row("ws-atlanta")
    .getByRole("button", { name: /^Open workspace atlanta/ })
    .click();
  await expect.poll(async () => (await state()).page).toBe("workspace");
  expect((await state()).folder).toBe("/fixture-workspaces/zeros/atlanta");
  await expect(row("ws-atlanta")).toHaveAttribute("data-active", "true");
  await moveAway();
  const archive = row("ws-seville").getByRole("button", {
    name: "Archive workspace seville",
  });
  const overlayOpacity = () =>
    archive.evaluate((node) => getComputedStyle(node.parentElement).opacity);
  expect(await overlayOpacity()).toBe("0");
  await row("ws-seville").hover();
  expect(await overlayOpacity()).toBe("1");
  check(
    "Rows open their workspace, mark the selection, and reveal Archive only on hover",
    true,
  );

  const zerosToggle = zeros.getByRole("button", { name: "Zeros", exact: true });
  await zerosToggle.click();
  await expect(zerosToggle).toHaveAttribute("aria-expanded", "false");
  await expect(row("ws-boston")).toHaveCount(0);
  await expect(row("ws-atlanta")).toBeVisible();
  const okitToggle = okit.getByRole("button", { name: "0kit", exact: true });
  await okitToggle.click();
  await expect(row("ws-paris-mumbai-city-docs")).toHaveCount(0);
  await moveAway();
  await expect(settings).toBeHidden();
  await page.reload({ waitUntil: "networkidle" });
  await expect(row("ws-atlanta")).toBeVisible();
  await expect(row("ws-boston")).toHaveCount(0);
  await expect(row("ws-paris-mumbai-city-docs")).toHaveCount(0);
  await expect(zerosToggle).toHaveAttribute("aria-expanded", "false");
  await okitToggle.click();
  await expect(row("ws-paris-mumbai-city-docs")).toBeVisible();
  check(
    "Collapse persists per repository across reload and keeps the selected workspace visible",
    true,
  );

  await page
    .getByRole("button", { name: "Filter workspaces", exact: true })
    .click();
  expect(await page.getByRole("menuitem").allTextContents()).toEqual([
    "Grouped",
    "Ungrouped",
  ]);
  await page.getByRole("menuitem", { name: "Ungrouped", exact: true }).click();
  await expect(headers).toHaveCount(0);
  expect(
    await page
      .locator("[data-workspace-tab]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-workspace-id")),
      ),
  ).toEqual([
    "ws-paris-mumbai-city-docs",
    "ws-boston",
    "ws-atlanta",
    "ws-seville",
    "ws-new-york",
  ]);
  expect((await state()).filter).toBe("ungrouped");
  await page.reload({ waitUntil: "networkidle" });
  await expect(row("ws-boston")).toBeVisible();
  await expect(headers).toHaveCount(0);
  await selectFilter("Grouped");
  await expect(headers).toHaveCount(4);
  check(
    "Grouped and Ungrouped are the only presentations; Ungrouped is one newest-first list",
    true,
  );

  for (const [legacy, folded] of [
    ["active", "ungrouped"],
    ["repo:project-okit", "grouped"],
  ]) {
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${harness}?filter=${encodeURIComponent(legacy)}`, {
      waitUntil: "networkidle",
    });
    await expect.poll(async () => (await state()).filter).toBe(folded);
    await expect(headers).toHaveCount(folded === "grouped" ? 4 : 0);
  }
  check(
    "Persisted Active and repository-only filters fold into Ungrouped and Grouped",
    true,
  );

  for (const [name, pageId] of [
    ["Home", "dashboard"],
    ["Customize", "customize"],
  ]) {
    const entry = page.getByRole("button", { name, exact: true }).first();
    await entry.click();
    await expect.poll(async () => (await state()).page).toBe(pageId);
    await expect(entry).toHaveAttribute("aria-current", "page");
  }
  // Create is an action: opening Create (from the row or a repository's +)
  // never paints it — or the repository header — as selected.
  const createEntry = page.getByRole("button", {
    name: "Create workspace",
    exact: true,
  });
  const background = (locator) =>
    locator.evaluate((node) => getComputedStyle(node).backgroundColor);
  await createEntry.click();
  await expect.poll(async () => (await state()).page).toBe("create");
  await moveAway();
  await expect(createEntry).not.toHaveAttribute("aria-current", "page");
  await expect(createEntry).not.toHaveAttribute("data-state", "active");
  // The row's hover fill fades out over 150ms; poll for the settled colour.
  await expect.poll(() => background(createEntry)).toBe("rgba(0, 0, 0, 0)");
  await header("project-ocolors").hover();
  await page
    .getByRole("button", { name: "Create workspace in 0colors", exact: true })
    .click();
  await expect
    .poll(async () => (await state()).createProjectId)
    .toBe("project-ocolors");
  await moveAway();
  await expect
    .poll(() => background(header("project-ocolors")))
    .toBe("rgba(0, 0, 0, 0)");
  await expect.poll(() => background(createEntry)).toBe("rgba(0, 0, 0, 0)");
  check(
    "Home and Customize are destinations; Create and a repository's + never read as selected",
    true,
  );

  // Geometry: every destination, repository and workspace row is 30px, and
  // consecutive repository/workspace rows sit exactly 2px apart.
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(harness, { waitUntil: "networkidle" });
  await expect(row("ws-new-york")).toBeVisible();
  const heights = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        "[data-sidebar-repository], [data-workspace-tab]",
      ),
      ...["Home", "Customize", "Create"].map((text) =>
        [...document.querySelectorAll("[data-app-sidebar] button")].find(
          (button) => button.textContent?.trim() === text,
        ),
      ),
    ].map((node) => node?.getBoundingClientRect().height),
  );
  expect(new Set(heights)).toEqual(new Set([30]));
  const gaps = await page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll(
        "[data-sidebar-repository], [data-workspace-tab]",
      ),
    ].map((node) => node.getBoundingClientRect());
    return rows.slice(1).map((rect, index) => rect.top - rows[index].bottom);
  });
  expect(new Set(gaps)).toEqual(new Set([2]));
  const destinations = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("[data-app-sidebar] button")];
    const rows = ["Home", "Customize", "Create"].map((text) =>
      buttons
        .find((button) => button.textContent?.trim() === text)
        .getBoundingClientRect(),
    );
    const switcher = getComputedStyle(
      document.querySelector('[aria-label="Switch organization"]'),
    );
    return {
      gaps: rows.slice(1).map((rect, index) => rect.top - rows[index].bottom),
      padding: [
        switcher.paddingTop,
        switcher.paddingRight,
        switcher.paddingBottom,
        switcher.paddingLeft,
      ],
    };
  });
  expect(destinations.gaps).toEqual([2, 2]);
  expect(new Set(destinations.padding)).toEqual(new Set(["4px"]));
  check(
    "Sidebar rows are 30px tall and 2px apart; the organization pill has 4px padding",
    true,
  );

  const section = page
    .locator("[data-app-sidebar]")
    .getByText("Workspaces", { exact: true })
    .locator("..");
  const filterButton = page.getByRole("button", {
    name: "Filter workspaces",
    exact: true,
  });
  await section.hover();
  expect(
    await section.evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
  expect(
    await filterButton.evaluate((node) => getComputedStyle(node).opacity),
  ).toBe("1");
  await moveAway();
  expect(
    await filterButton.evaluate((node) => getComputedStyle(node).opacity),
  ).toBe("0");
  check("Workspaces reveals only its ⋯ on hover, with no row highlight", true);

  // Collapse: the panel-left toggle hides the sidebar, then floats over the
  // content's corner at the same position; Home pages start below it.
  const sidebar = page.locator("[data-app-sidebar]");
  const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
  const show = page.getByRole("button", { name: "Show sidebar", exact: true });
  await page.getByRole("button", { name: "Home", exact: true }).click();
  const openBox = await hide.boundingBox();
  await hide.click();
  await expect(sidebar).toBeHidden();
  await expect(show).toBeVisible();
  expect(await show.boundingBox()).toEqual(openBox);
  const dashboardTop = await page
    .locator('[data-harness-page="dashboard"]')
    .evaluate((node) => node.getBoundingClientRect().top);
  expect(dashboardTop).toBeGreaterThanOrEqual(40);
  await page.reload({ waitUntil: "networkidle" });
  await expect(show).toBeVisible();
  await expect(sidebar).toBeHidden();
  await show.click();
  await expect(sidebar).toBeVisible();
  await expect(hide).toBeVisible();
  check(
    "The panel-left toggle collapses and restores the sidebar in place, persisted across reload",
    true,
  );

  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${harness}?conversation`, { waitUntil: "networkidle" });
  await row("ws-atlanta")
    .getByRole("button", { name: /^Open workspace atlanta/ })
    .click();
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  const toggleBox = await show.boundingBox();
  const firstTab = await page
    .getByRole("tablist", { name: "Chat sessions" })
    .getByRole("tab")
    .first()
    .boundingBox();
  const workspaceHeader = page.getByLabel("Workspace header", { exact: true });
  await expect(workspaceHeader).toHaveCount(1);
  const reserve = page.locator("[data-window-controls-reserve]");
  await expect(reserve).toHaveCount(1);
  const [headerBox, placementBox, reserveBox] = await Promise.all([
    workspaceHeader.boundingBox(),
    workspaceHeader.locator("[data-workspace-placement]").boundingBox(),
    reserve.boundingBox(),
  ]);
  expect(reserveBox.width).toBe(108);
  expect(placementBox.x).toBeGreaterThanOrEqual(toggleBox.x + toggleBox.width);
  expect(firstTab.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
  expect(firstTab.y).toBeGreaterThanOrEqual(toggleBox.y + toggleBox.height);
  const composer = page.locator(".zeros-agent-surface .composer-pm").first();
  const measure = await page.evaluate(() => {
    const band = document.querySelector(".zeros-agent-messages");
    const style = band ? getComputedStyle(band) : null;
    return style
      ? {
          width: band.getBoundingClientRect().width,
          content:
            band.getBoundingClientRect().width -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight),
        }
      : null;
  });
  expect(measure?.content).toBeLessThanOrEqual(800);
  expect(measure?.content).toBeGreaterThan(700);
  await expect(composer).toBeVisible();
  await show.click();
  check(
    "Collapsed controls keep the first chat strip clear; the chat column caps at 800px",
    true,
  );

  for (const regression of appSidebarRegressionChecks) {
    await regression({ page, check, harnessBase });
  }

  expect(errors).toEqual([]);
  check("app sidebar interactions have no browser exceptions", true);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}
