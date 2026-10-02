import { expect } from "@playwright/test";

async function resetHarness(page, harnessBase, query = "") {
  await page.goto(`${harnessBase}/harness-app-sidebar.html`, {
    waitUntil: "networkidle",
  });
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${harnessBase}/harness-app-sidebar.html${query}`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator('[data-workspace-id="ws-atlanta"]')).toBeVisible();
}

export async function checkSidebarNarrowHeader({ page, check, harnessBase }) {
  await resetHarness(page, harnessBase);
  await page.evaluate(() => window.appSidebarSetWidth(200));
  const resources = page.getByRole("button", {
    name: "App resources",
    exact: true,
  });
  const archive = page.getByRole("button", {
    name: "Archived workspaces for Zeros",
  });
  await expect(resources).toBeVisible();
  await expect(resources).toHaveText("");
  const sidebarBox = await page.locator("[data-app-sidebar]").boundingBox();
  expect(sidebarBox.width).toBe(200);
  for (const button of [resources, archive]) {
    const box = await button.boundingBox();
    expect(box.width).toBe(28);
    expect(box.x).toBeGreaterThanOrEqual(sidebarBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(
      sidebarBox.x + sidebarBox.width,
    );
  }
  await archive.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByPlaceholder("Search archived workspaces…"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await resources.click();
  const details = page.getByRole("dialog", { name: "App resources" });
  await expect(details).toBeVisible();
  await expect(details).toContainText("1.20 GB");
  await expect(details).toContainText("CPU");
  await page.keyboard.press("Escape");
  check(
    "Resource details stay available from an icon and Archive fits at 200px",
    true,
  );
}

export async function checkSidebarUnopenedFolder({ page, check, harnessBase }) {
  await resetHarness(page, harnessBase, "?unopened-folder");
  const folder = page.locator('[data-sidebar-folder="project-empty-folder"]');
  const originalChats = await page.evaluate(
    () => window.appSidebarState().chats,
  );
  for (const presentation of ["Grouped", "Ungrouped"]) {
    await page
      .getByRole("button", { name: "Filter workspaces", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: presentation, exact: true })
      .click();
    await expect(folder).toBeVisible();
    await folder.click();
    await expect
      .poll(() => page.evaluate(() => window.appSidebarState().page))
      .toBe("repo");
    expect(await page.evaluate(() => window.appSidebarState())).toMatchObject({
      repoId: "project-empty-folder",
      chats: originalChats,
    });
    await expect(folder).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("tab", { name: "Environment", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Paths", exact: true }).click();
    await page.getByRole("button", { name: "Remove folder", exact: true }).click();
    const removal = page.getByRole("dialog", { name: "Remove Empty folder?" });
    await expect(removal).toBeVisible();
    await removal.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("tab", { name: "Environment", exact: true }).click();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.reload({ waitUntil: "networkidle" });
    await expect(folder).toBeVisible();
  }
  expect(
    await page.evaluate(() =>
      window.appSidebarRequests.filter(
        ({ op }) => op === "workspace.create" || op === "chat.create",
      ),
    ),
  ).toEqual([]);
  check(
    "Unopened plain folders reach settings in both presentations without creating a chat",
    true,
  );
}

export async function checkSidebarRetiredLocalMain({
  page,
  check,
  harnessBase,
}) {
  for (const query of ["", "&no-workspaces", "&no-workspaces&subdirectory"]) {
    await page.goto(`${harnessBase}/harness-app-sidebar.html`);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(
      `${harnessBase}/harness-app-sidebar.html?legacy-main${query}`,
    );
    await expect(page.locator("[data-app-sidebar]")).toBeVisible();
    const empty = query.includes("no-workspaces");
    const state = () => page.evaluate(() => window.appSidebarState());
    await expect
      .poll(async () => (await state()).page)
      .toBe(empty ? "repo" : "workspace");
    if (empty) {
      expect((await state()).repoId).toBe("project-zeros");
      await expect(
        page.getByText("No workspaces yet", { exact: true }),
      ).toBeVisible();
    } else {
      expect((await state()).folder).toBe("/fixture-workspaces/zeros/atlanta");
    }
    const savedChats = (await state()).chats;
    expect(savedChats).toContainEqual({
      id: "chat-legacy-main",
      folder: `/fixture/zeros${query.includes("subdirectory") ? "/packages/app" : ""}`,
    });
    for (const presentation of ["Ungrouped", "Grouped"]) {
      await page
        .getByRole("button", { name: "Filter workspaces", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: presentation, exact: true })
        .click();
      await expect(page.locator('[data-workspace-id^="local:"]')).toHaveCount(
        0,
      );
    }

    const header = page.locator('[data-sidebar-repository="project-zeros"]');
    await header.hover();
    await header
      .getByRole("button", { name: "Zeros settings", exact: true })
      .click();
    await page.getByRole("tab", { name: "Workspaces", exact: true }).click();
    await expect(
      page.locator('[data-harness-page="repo"] div[role="button"]'),
    ).toHaveCount(empty ? 0 : 2);
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(
      page.locator('[data-harness-page="dashboard"] div[role="button"]'),
    ).toHaveCount(empty ? 3 : 5);
    expect((await state()).chats).toEqual(savedChats);

    // Simulate another launch of an older build's saved root selection while
    // leaving its chats and the retired enabled setting in storage.
    await page.evaluate((subdirectory) => {
      window.dispatchEvent(new Event("beforeunload"));
      const saved = JSON.parse(localStorage.getItem("zeros:ui-state:v1"));
      const folder = `/fixture/zeros${subdirectory ? "/packages/app" : ""}`;
      localStorage.setItem(
        "zeros:ui-state:v1",
        JSON.stringify({
          ...saved,
          activePage: "workspace",
          activeChatId: "chat-legacy-main",
          lastWorkspaceFolder: folder,
          lastWorkspaceByRepoRoot: {
            ...saved.lastWorkspaceByRepoRoot,
            "/fixture/zeros": folder,
          },
        }),
      );
    }, query.includes("subdirectory"));
    await page.reload();
    await expect(page.locator("[data-app-sidebar]")).toBeVisible();
    await expect
      .poll(async () => (await state()).page)
      .toBe(empty ? "repo" : "workspace");
    await expect(page.locator('[data-workspace-id^="local:"]')).toHaveCount(0);
    expect((await state()).chats).toEqual(savedChats);
    expect(
      await page.evaluate(() =>
        window.appSidebarRequests.filter(
          ({ op }) => op === "workspace.create" || op === "chat.create",
        ),
      ),
    ).toEqual([]);
  }
  check(
    "Saved Local main selections and the retired enabled setting never recreate a workspace, including after reload",
    true,
  );
}

export async function checkSidebarHiddenReads({ page, check, harnessBase }) {
  await resetHarness(page, harnessBase);
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  const sidebar = page.locator("[data-app-sidebar]");
  const counts = page.locator(
    '[data-workspace-id="ws-atlanta"] [data-workspace-change-counts]',
  );
  const requestCount = (id) =>
    page.evaluate(
      (workspaceId) =>
        window.appSidebarRequests.filter(
          ({ op, params }) =>
            op === "git.changeLineCounts" &&
            params?.workspaceId === workspaceId,
        ).length,
      id,
    );
  const update = (additions) =>
    page.evaluate(
      (value) =>
        window.appSidebarSetChangeLines("ws-atlanta", {
          additions: value,
          deletions: 3,
        }),
      additions,
    );
  const hide = () =>
    page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  const show = () =>
    page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await expect(counts).toContainText("+12");
  for (const [mode, value] of [
    ["collapsed", 21],
    ["settings", 22],
  ]) {
    const before = await requestCount("ws-atlanta");
    if (mode === "collapsed") await hide();
    else await page.evaluate(() => window.appSidebarNavigate("settings"));
    await expect(sidebar).toBeHidden();
    await update(value);
    // Give the refresh subscription and its async request effect a chance to
    // run; hidden rows must remain subscribed only to retained local state.
    await page.waitForTimeout(150);
    expect(await requestCount("ws-atlanta")).toBe(before);
    if (mode === "collapsed") await show();
    else await page.evaluate(() => window.appSidebarNavigate("customize"));
    await expect(counts).toContainText(`+${value}`);
  }

  const otherBefore = await requestCount("ws-boston");
  const beforeRace = await requestCount("ws-atlanta");
  await page.evaluate(() => window.appSidebarDeferChangeLines());
  await update(30);
  await expect.poll(() => requestCount("ws-atlanta")).toBe(beforeRace + 1);
  expect(await requestCount("ws-boston")).toBe(otherBefore);
  await expect(counts).toContainText("+22");
  await hide();
  await update(40);
  await page.evaluate(() => window.appSidebarReleaseChangeLines());
  await page.waitForTimeout(150);
  await expect(counts).toContainText("+22");
  await show();
  await expect(counts).toContainText("+40");
  check(
    "Hidden rows suspend Git reads, retain confirmed counts, and reject stale results",
    true,
  );
}

export async function checkSidebarReselection({ page, check, harnessBase }) {
  await resetHarness(page, harnessBase, "?long-list");
  const row = page.locator('[data-workspace-id="ws-atlanta"]');
  const list = page.getByRole("region", {
    name: "Workspaces grouped by repository",
  });
  await row.getByRole("button", { name: /^Open workspace atlanta/ }).click();
  expect(await list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await list.evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.evaluate(() =>
    window.appSidebarSetChangeLines("ws-atlanta", {
      additions: 20,
      deletions: 3,
    }),
  );
  await expect(row.locator("[data-workspace-change-counts]")).toContainText(
    "+20",
  );
  expect(await list.evaluate((node) => node.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page
    .locator('[data-harness-page="dashboard"] [role="button"]')
    .filter({ hasText: "atlanta" })
    .first()
    .click();
  await expect(row).toHaveAttribute("data-active", "true");
  const listBox = await list.boundingBox();
  const rowBox = await row.boundingBox();
  expect(rowBox.y).toBeGreaterThanOrEqual(listBox.y);
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(
    listBox.y + listBox.height,
  );
  check(
    "Returning from Home reveals the same workspace without undoing manual scroll during refresh",
    true,
  );
}

export const appSidebarRegressionChecks = [
  checkSidebarNarrowHeader,
  checkSidebarUnopenedFolder,
  checkSidebarRetiredLocalMain,
  checkSidebarHiddenReads,
  checkSidebarReselection,
];
