import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Exercise the actual Home surface in its own context, so saved preferences,
 * owner selection and fixture mutations cannot affect the archive scenarios. */
export async function runDashboardSmoke({ page: originPage, check }) {
  const origin = new URL(originPage.url()).origin;
  const context = await originPage.context().browser().newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const url = `${origin}/apps/desktop/src/renderer/harnesses/harness-app-sidebar.html?dashboard`;
  const root = () => page.locator('main[data-harness-page="dashboard"]');
  const row = id => root().locator(`[data-dashboard-workspace="${id}"]`);
  const search = () => root().getByRole("searchbox", { name: "Search workspaces" });
  const count = value => expect(root().locator("[data-dashboard-count]")).toHaveText(String(value));
  const goHome = () => page.evaluate(() => window.appSidebarNavigate("dashboard"));
  const view = name => root().getByRole("button", { name: `${name} view`, exact: true }).click();
  const choose = async (menu, value) => {
    await root().getByRole("button", { name: menu, exact: true }).click();
    await page.getByRole("menuitemradio", { name: value, exact: true }).click();
    await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
  };
  const order = () => root().locator("tbody [data-dashboard-workspace]").evaluateAll(nodes => nodes.map(node => node.dataset.dashboardWorkspace));
  const capture = async name => {
    if (!process.env.DASHBOARD_CAPTURE_DIR) return;
    await mkdir(process.env.DASHBOARD_CAPTURE_DIR, { recursive: true });
    await page.screenshot({ path: resolve(process.env.DASHBOARD_CAPTURE_DIR, `${name}.png`), animations: "disabled" });
  };
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await goHome();
    await expect(root().getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(root().getByRole("button", { name: "Board view", exact: true })).toHaveAttribute("aria-pressed", "true");
    for (const name of ["Board view", "List view"])
      await expect(root().getByRole("button", { name, exact: true })).toHaveText("");
    await count(6);
    await expect(row("ws-missing")).toBeVisible();
    await expect(row("ws-archived")).toHaveCount(0);
    await view("List");
    await expect(root().getByRole("table", { name: "Workspaces" })).toBeVisible();
    await count(6);
    await expect(row("ws-atlanta").getByLabel("12 additions, 3 deletions", { exact: true })).toBeVisible();
    const reads = await page.evaluate(() => window.appSidebarRequests.filter(request => request.op === "git.changeLineCounts").length);
    await view("Board");
    await view("List");
    expect(await page.evaluate(() => window.appSidebarRequests.filter(request => request.op === "git.changeLineCounts").length)).toBe(reads);
    check("Home switches between icon-only board/list controls and shares confirmed line counts without new Git reads", true);

    const countReads = () => page.evaluate(() => window.appSidebarRequests.filter(request =>
      request.op === "git.changeLineCounts" && request.params?.workspaceId === "ws-atlanta").length);
    const initialReads = await countReads();
    await page.evaluate(() => {
      window.appSidebarDeferChangeLines();
      window.appSidebarSetChangeLines("ws-atlanta", { additions: 13, deletions: 4 });
    });
    await expect.poll(countReads).toBeGreaterThan(initialReads);
    await page.evaluate(async () => {
      const { writeChangesSections } = await import("/apps/desktop/src/renderer/shell/workbench/tabs/changes-snapshot-cache.ts");
      writeChangesSections("ws-atlanta", { kind: "all" }, [{ kind: "committed", title: null,
        files: [{ path: "src/home.tsx", status: "modified", additions: 80, deletions: 20,
          patch: "", binary: false, staged: false, committed: true }] }], "main");
    });
    await expect(row("ws-atlanta").getByLabel("80 additions, 20 deletions", { exact: true })).toBeVisible();
    await page.evaluate(() => window.appSidebarReleaseChangeLines());
    // The sidebar only receives +80 when the held count request completes.
    // This observation proves the old response arrived, without a timing sleep.
    await expect(page.locator('[data-workspace-id="ws-atlanta"]')).toContainText("+80");
    await expect(row("ws-atlanta").getByLabel("80 additions, 20 deletions", { exact: true })).toBeVisible();
    await page.evaluate(() => window.appSidebarSetChangeLines("ws-atlanta", { additions: 12, deletions: 3 }));
    await expect(row("ws-atlanta").getByLabel("12 additions, 3 deletions", { exact: true })).toBeVisible();
    check("New All Changes totals reach Home and a held older sidebar read cannot replace them", true);

    await search().fill("  KEYboard  0colors #42 ");
    await count(1);
    await expect(row("ws-seville")).toBeVisible();
    await view("Board");
    await count(1);
    await expect(row("ws-seville")).toBeVisible();
    await search().press("Escape");
    await count(6);
    await root().getByRole("group", { name: "Filter by repository" }).getByRole("button", { name: "Zeros", exact: true }).click();
    await count(3);
    await view("List");
    await count(3);
    await search().fill("no matching workspace");
    await count(0);
    await expect(root().getByText("No matching workspaces", { exact: true })).toBeVisible();
    await root().getByRole("button", { name: "Clear filters" }).click();
    await count(6);
    check("Search matches title, branch, repository and PR across both views; repository filters, empty results and Escape stay consistent", true);

    await choose("Sort workspaces", "Name");
    expect(await order()).toEqual(["ws-seville", "ws-boston", "ws-paris-mumbai-city-docs", "ws-missing", "ws-atlanta", "ws-new-york"]);
    await choose("Sort workspaces", "Newest");
    const newest = await order();
    await page.evaluate(() => window.appSidebarRecordActivity("ws-new-york", Date.now()));
    expect(await order()).toEqual(newest);
    await choose("Sort workspaces", "Last active");
    await expect.poll(async () => (await order())[0]).toBe("ws-new-york");
    const sort = root().getByRole("button", { name: "Sort workspaces", exact: true });
    await sort.focus();
    await sort.press("Enter");
    await expect(page.getByRole("menuitemradio", { name: "Last active", exact: true })).toBeFocused();
    await page.keyboard.press("End");
    const repositorySort = page.getByRole("menuitemradio", { name: "Repository", exact: true });
    await expect(repositorySort).toBeFocused();
    await repositorySort.press("Enter");
    await expect.poll(async () => (await order()).slice(0, 2)).toEqual(["ws-seville", "ws-paris-mumbai-city-docs"]);
    check("Last active follows real activity, Newest stays fixed, and Name/Repository sort supports keyboard selection", true);

    await choose("Archive visibility", "Showing all");
    await count(7);
    await expect(row("ws-archived")).toBeVisible();
    await choose("Archive visibility", "Only archived");
    await count(1);
    await expect(row("ws-missing")).toHaveCount(0);
    await view("Board");
    await count(1);
    await expect(row("ws-archived")).toBeVisible();
    await view("List");
    await choose("Archive visibility", "Hiding archived");
    await count(6);
    await expect(row("ws-missing")).toBeVisible();
    check("Archive modes use the archive flag; missing folders remain available while archives are hidden", true);

    await root().getByRole("button", { name: "Display", exact: true }).click();
    for (const name of ["Repository", "Repository icon", "Line changes", "Cost", "Owner", "Last active"])
      await expect(page.getByRole("menuitemcheckbox", { name, exact: true })).toBeVisible();
    await capture("dashboard-display-menu");
    await page.getByRole("menuitemcheckbox", { name: "Repository", exact: true }).click();
    // Radix makes the background inert while the menu stays open. Include it
    // deliberately so these checks exercise the table, not the modal boundary.
    const column = name => root().getByRole("columnheader", { name, exact: true, includeHidden: true });
    await expect(column("Repository")).toHaveCount(0);
    await expect(row("ws-atlanta").locator("td").nth(1).locator('span[aria-hidden="true"]').first()).toBeVisible();
    await page.getByRole("menuitemcheckbox", { name: "Repository icon", exact: true }).click();
    await expect(column("Repository icon")).toHaveCount(0);
    await page.getByRole("menuitemcheckbox", { name: "Line changes", exact: true }).click();
    await expect(column("Changes")).toHaveCount(0);
    await page.getByRole("menuitemcheckbox", { name: "Owner", exact: true }).click();
    await expect(column("Owner")).toHaveCount(0);
    await page.getByRole("menuitemcheckbox", { name: "Last active", exact: true }).click();
    await expect(column("Active")).toHaveCount(0);
    await expect(root().locator("thead th")).toHaveCount(2);
    await page.getByRole("menuitemcheckbox", { name: "Cost", exact: true }).click();
    await expect(column("Cost")).toBeVisible();
    await expect(row("ws-atlanta").getByLabel("Cost unavailable", { exact: true })).toBeVisible();
    for (const name of ["Repository icon", "Line changes", "Last active"])
      await page.getByRole("menuitemcheckbox", { name, exact: true }).click();
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "networkidle" });
    await goHome();
    await expect(root().getByRole("button", { name: "List view", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(root().getByRole("columnheader", { name: "Repository", exact: true })).toHaveCount(0);
    await expect(root().getByRole("columnheader", { name: "Owner", exact: true })).toHaveCount(0);
    await expect(root().getByRole("columnheader", { name: "Cost", exact: true })).toBeVisible();
    await expect(row("ws-atlanta").getByRole("cell").nth(1)).toHaveAccessibleName("Zeros");
    expect(await page.evaluate(() => window.appSidebarRequests.filter(request => request.op === "git.hasChanges"))).toEqual([]);
    await root().getByRole("button", { name: "Display", exact: true }).click();
    for (const name of ["Repository", "Owner", "Cost"])
      await page.getByRole("menuitemcheckbox", { name, exact: true }).click();
    await page.keyboard.press("Escape");
    await choose("Sort workspaces", "Last active");
    await capture("dashboard-list-dark");
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await capture("dashboard-list-light");
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await view("Board");
    await page.setViewportSize({ width: 1920, height: 1000 });
    await capture("dashboard-board-dark");
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await capture("dashboard-board-light");
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.setViewportSize({ width: 1440, height: 900 });
    await view("List");
    check("All six Display options work independently, persist across reload, and render both themes without fabricated cost totals", true);

    await row("ws-seville").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Set status", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Done", exact: true }).click();
    await expect(row("ws-seville").getByRole("img", { name: "Done", exact: true })).toBeVisible();
    await expect(root()).toBeVisible();
    const archive = row("ws-new-york").getByRole("button", { name: "Archive Update release notes", exact: true });
    await archive.focus();
    await archive.press("Enter");
    await expect(row("ws-new-york").getByRole("img", { name: "Archived", exact: true })).toBeVisible();
    await expect(root()).toBeVisible();
    const restore = row("ws-new-york").getByRole("button", { name: "Unarchive Update release notes", exact: true });
    await restore.focus();
    await restore.press("Enter");
    await expect(page.locator('main[data-harness-page="workspace"]')).toBeVisible();
    await goHome();
    await expect(row("ws-new-york").getByRole("img", { name: "Cancelled", exact: true })).toBeVisible();
    await row("ws-archived").getByRole("button", { name: "Open Review pull request workflow history", exact: true }).click();
    await expect(page.locator('main[data-harness-page="workspace"]')).toContainText("/fixture-workspaces/zeros/archived");
    await goHome();
    check("List rows preserve status menus, keyboard archive/restore and passive history navigation without accidental row opens", true);

    await choose("Archive visibility", "Hiding archived");
    const pending = await page.evaluate(() => window.dashboardAddPending());
    await search().fill("integration");
    await count(1);
    await expect(root().getByRole("status").filter({ hasText: "Prepare integration tests" })).toBeVisible();
    await page.evaluate(token => window.dashboardFinishPending(token), pending);
    await count(0);
    await search().press("Escape");
    await count(6);
    await page.setViewportSize({ width: 820, height: 640 });
    await root().getByRole("button", { name: "Display", exact: true }).click();
    const menuBox = await page.getByRole("menu").boundingBox();
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(820);
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(820);
    check("Pending creates respect search; narrow windows keep controls and portalled menus within the viewport", true);

    await page.setViewportSize({ width: 1440, height: 900 });
    const cloud = await page.evaluate(() => window.appSidebarSeedCloud());
    await count(2);
    await expect(root().getByRole("img", { name: "Cloud · stopped", exact: true })).toHaveCount(2);
    await search().fill("cloud-one");
    await count(1);
    await page.evaluate(id => window.appSidebarSelectOwner(id), cloud.otherOrganizationId);
    await expect(search()).toHaveValue("");
    await count(1);
    await expect(root()).toContainText("cloud-other");
    await page.evaluate(id => window.appSidebarSelectOwner(id), cloud.organizationId);
    await expect(search()).toHaveValue("cloud-one");
    await expect(root()).not.toContainText("cloud-other");
    await page.evaluate(() => window.appSidebarSelectOwner(null));
    await count(6);
    await expect(root()).not.toContainText("cloud-one");
    const cloudCommands = await page.evaluate(() => window.appSidebarRequests.filter(request =>
      /cloud:\/\//.test(JSON.stringify(request.params)) && ["git.hasChanges", "gh.prSync", "workspace.archive", "workspace.restore"].includes(request.op)));
    expect(cloudCommands).toEqual([]);
    check("Local and cloud owners stay isolated through A → B → A; stopped VMs remain live and Home adds no cloud work", true);

    // The board's native inner action must own Enter; its containing card must
    // not prevent the button's default click and open the workspace instead.
    await page.evaluate(() => window.appSidebarUpdateWorkspace("ws-atlanta", { prNumber: 7, prState: "merged" }));
    await view("Board");
    const boardArchive = row("ws-atlanta").getByRole("button", { name: "Archive", exact: true });
    await expect(boardArchive).toBeVisible();
    await boardArchive.focus();
    await boardArchive.press("Enter");
    await expect(root()).toBeVisible();
    await expect(row("ws-atlanta")).toContainText("Archived");
    check("Enter on a board action archives exactly that workspace instead of activating the containing card", true);

    await page.goto(`${url}&large-dashboard`, { waitUntil: "networkidle" });
    await goHome();
    await view("List");
    await choose("Sort workspaces", "Name");
    await search().fill("task-");
    await count(250);
    await expect.poll(() => root().locator("tbody [data-dashboard-workspace]").count()).toBeGreaterThan(0);
    expect(await root().locator("tbody [data-dashboard-workspace]").count()).toBeLessThan(60);
    const list = root().getByRole("region", { name: "Workspace list" });
    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(row("ws-bulk-249")).toBeVisible();
    await expect(row("ws-bulk-249")).toHaveAttribute("aria-rowindex", "251");
    await search().fill("task-000");
    await count(1);
    await expect(row("ws-bulk-0")).toBeVisible();
    check("Large workspace lists bound mounted rows and remain searchable after scrolling to the end", true);

    await page.goto(`${url}&defer-dashboard-archives`, { waitUntil: "networkidle" });
    await goHome();
    await choose("Archive visibility", "Only archived");
    await expect.poll(() => page.evaluate(() => window.dashboardPendingArchiveReads())).toBeGreaterThan(0);
    await expect(root().getByText("Loading workspaces…", { exact: true })).toBeVisible();
    await expect(root().getByText("No archived workspaces", { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.dashboardReleaseArchives());
    await count(1);
    await expect(row("ws-archived")).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await goHome();
    await expect.poll(() => page.evaluate(() => window.dashboardPendingArchiveReads())).toBeGreaterThan(0);
    await page.evaluate(() => window.dashboardReleaseArchives(true));
    await expect(root().getByText("Couldn't load archived workspaces", { exact: true })).toBeVisible();
    await root().getByRole("button", { name: "Retry loading archived workspaces", exact: true }).click();
    await count(1);
    await expect(row("ws-archived")).toBeVisible();
    check("Cold and failed archive reads have truthful loading/retry states instead of false empty results", true);

    await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-workspace-archives.html`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Display", exact: true }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.evaluate(() => window.archiveFixture.navigate("settings"));
    await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
    await page.evaluate(() => window.archiveFixture.navigate("dashboard"));
    await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
    check("Retained inactive Home closes its toolbar portals and does not reopen them on return", true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}
