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
  await resetHarness(page, harnessBase, "?internal");
  // Below the floor: the sidebar stops where its title band still fits.
  await page.evaluate(() => window.appSidebarSetWidth(200));
  const resources = page.getByRole("button", {
    name: "App resources",
    exact: true,
  });
  await expect(resources).toBeVisible();
  await expect(resources).toHaveText("1.20 GB");
  await expect(
    page.getByRole("button", { name: /Archived workspaces/ }),
  ).toHaveCount(0);
  const sidebarBox = await page.locator("[data-app-sidebar]").boundingBox();
  expect(sidebarBox.width).toBe(280);
  let previousEnd = sidebarBox.x;
  for (const name of [
    "Hide sidebar",
    "App resources",
    "Go back",
    "Go forward",
  ]) {
    const box = await page
      .getByRole("button", { name, exact: true })
      .boundingBox();
    expect(box.height).toBe(28);
    if (name !== "App resources") expect(box.width).toBe(28);
    expect(box.x).toBeGreaterThanOrEqual(previousEnd);
    previousEnd = box.x + box.width;
  }
  expect(previousEnd).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width);
  await resources.click();
  const details = page.getByRole("dialog", { name: "App resources" });
  await expect(details).toBeVisible();
  await expect(details).toContainText("1.20 GB");
  await expect(details).toContainText("CPU");
  await page.keyboard.press("Escape");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const organization = await page.getByRole("button", { name: "Switch organization", exact: true }).boundingBox();
    const home = await page.getByRole("button", { name: "Home", exact: true }).boundingBox();
    expect(home.y - (organization.y + organization.height)).toBe(4);
  }
  await page.evaluate(() => window.appSidebarSetMemory(3 * 1024 ** 3));
  await expect(resources).toHaveText("3.00 GB", { timeout: 7_000 });
  // A persisted narrow rail comes back when the Internal summary is disabled.
  await page.evaluate(async () => {
    const { setInternalFeatureEnabled } = await import("/apps/desktop/src/renderer/features/settings/internal-features.ts");
    setInternalFeatureEnabled("resourceSummary", false);
  });
  await expect(resources).toHaveCount(0);
  expect((await page.locator("[data-app-sidebar]").boundingBox()).width).toBe(220);
  await page.evaluate(async () => {
    const { setInternalFeatureEnabled } = await import("/apps/desktop/src/renderer/features/settings/internal-features.ts");
    setInternalFeatureEnabled("resourceSummary", true);
  });
  await expect(resources).toHaveText("3.00 GB");
  await resetHarness(page, harnessBase);
  await expect(resources).toHaveCount(0);
  expect(await page.evaluate(() => window.appSidebarRequests.filter(request => request.op === "process_metrics_snapshot"))).toEqual([]);
  check(
    "Internal live memory fits with navigation, toggles without losing sidebar width, and stays absent for ordinary users",
    true,
  );
}

export async function checkSidebarHistory({ page, check, harnessBase }) {
  await resetHarness(page, harnessBase);
  const back = page.getByRole("button", { name: "Go back", exact: true });
  const forward = page.getByRole("button", { name: "Go forward", exact: true });
  const shown = async () => {
    const state = await page.evaluate(() => window.appSidebarState());
    if (state.page === "workspace") return `workspace:${state.folder}`;
    if (state.page === "repo") return `repo:${state.repoId}`;
    if (state.page === "create") return `create:${state.createProjectId}`;
    return state.page;
  };
  const expectAvailable = async (button, available) => {
    if (available) await expect(button).not.toHaveAttribute("aria-disabled");
    else await expect(button).toHaveAttribute("aria-disabled", "true");
  };
  const step = async (button, destination) => {
    await button.click();
    await expect.poll(shown).toBe(destination);
  };
  const atlanta = "workspace:/fixture-workspaces/zeros/atlanta";

  // A first load with no workspace selected has nothing to return to.
  await expectAvailable(back, false);
  await expectAvailable(forward, false);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await expectAvailable(back, true);
  await expectAvailable(forward, false);
  await page
    .locator('[data-workspace-id="ws-atlanta"]')
    .getByRole("button", { name: /^Open workspace atlanta/ })
    .click();
  const zeros = page.locator('[data-sidebar-repository="project-zeros"]');
  await zeros.hover();
  await zeros
    .getByRole("button", { name: "Zeros settings", exact: true })
    .click();
  await page
    .locator("[data-app-sidebar]")
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect.poll(shown).toBe("create:project-zeros");
  // Settings replaces the sidebar and is never an entry; its Back opens Home.
  await page.evaluate(() => window.appSidebarNavigate("settings"));
  await expect(back).toHaveCount(0);
  await page.evaluate(() => window.appSidebarNavigate("dashboard"));

  for (const destination of [
    "create:project-zeros",
    "repo:project-zeros",
    atlanta,
    "customize",
    "dashboard",
  ]) {
    await step(back, destination);
  }
  await expectAvailable(back, false);
  // aria-disabled keeps the click on the button, where it does nothing.
  await back.click({ force: true });
  expect(await shown()).toBe("dashboard");
  for (const destination of [
    "customize",
    atlanta,
    "repo:project-zeros",
    "create:project-zeros",
    "dashboard",
  ]) {
    await step(forward, destination);
  }
  await expectAvailable(forward, false);

  // Somewhere new from the middle drops the entries ahead.
  await step(back, "create:project-zeros");
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await expectAvailable(forward, false);
  await step(back, "create:project-zeros");
  expect(
    await page.evaluate(() =>
      window.appSidebarRequests.filter(
        ({ op }) => op === "workspace.create" || op === "chat.create",
      ),
    ),
  ).toEqual([]);
  check(
    "Go back and Go forward retrace Home, Customize, workspaces, repository pages and Create, never Settings",
    true,
  );
}

export async function checkSidebarUnopenedFolder({ page, check, harnessBase }) {
  await resetHarness(page, harnessBase, "?unopened-folder");
  const folder = page.locator('[data-sidebar-folder="project-empty-folder"]');
  const originalChats = await page.evaluate(
    () => window.appSidebarState().chats,
  );
  for (const presentation of ["Repository", "Status", "None"]) {
    await page
      .getByRole("button", { name: "Filter workspaces", exact: true })
      .click();
    await page
      .getByRole("menuitemradio", { name: presentation, exact: true })
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
    await page
      .getByRole("button", { name: "Remove folder", exact: true })
      .click();
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
    for (const presentation of ["None", "Repository"]) {
      await page
        .getByRole("button", { name: "Filter workspaces", exact: true })
        .click();
      await page
        .getByRole("menuitemradio", { name: presentation, exact: true })
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

export async function checkSidebarResourceDiagnostics({
  page,
  check,
  harnessBase,
}) {
  await resetHarness(page, harnessBase, "?resource-pressure&internal");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await page.getByRole("button", { name: "App resources", exact: true }).click();
  const details = page.getByRole("dialog", { name: "App resources" });
  await expect(details).toBeVisible();
  // The whole Zeros tree — engine, supervisor, agent and the agent's tools —
  // is listed by role, with Mac pressure and other Zeros apps beside it.
  for (const name of ["Engine", "Agent supervisor", "Codex", "pnpm typecheck", "tsc"])
    await expect(details.getByText(name, { exact: true })).toBeVisible();
  await expect(details).toContainText("Mac: Memory pressure Warning");
  await expect(details).toContainText("Swap 6.0 of 7.0 GB");
  await expect(details).toContainText("Other Zeros apps on this Mac");
  await expect(details).toContainText("Zeros Alpha");
  await expect(details).toContainText("memory = physical footprint");
  // The open inspector asks main to keep the footprint read fresh.
  const snapshotRequests = await page.evaluate(() =>
    window.appSidebarRequests.filter((request) => request.op === "process_metrics_snapshot"),
  );
  expect(snapshotRequests.some((request) => request.params?.detail === true)).toBe(true);
  await details.getByRole("button", { name: "Copy diagnostics", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.appSidebarRequests.some((request) => request.op === "process_diagnostics_report"),
      ),
    )
    .toBe(true);
  await expect(page.getByText(/Diagnostics copied — \d+ KB with recent app logs/)).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("# Zeros diagnostics report");
  expect(copied).toContain("## Design renderer allocations");
  expect(copied).toContain("Logical allocation counters and estimates; physical process memory is reported above.");
  const allocations = JSON.parse(copied.split("## Design renderer allocations\n")[1].split("\n").slice(1).join("\n"));
  expect(allocations.sourceTiles).toMatchObject({ bytes: 0, outputBytes: 0, activeScenes: 0 });
  expect(allocations.captures).toMatchObject({ running: 0, queued: 0 });
  expect(allocations.source).toMatchObject({ documents: 0 });
  await page.keyboard.press("Escape");
  check(
    "Resources lists the engine, agents and their tools, Mac pressure and other Zeros apps; Copy builds the native diagnostics report",
    true,
  );
  await resetHarness(page, harnessBase, "?resource-pressure&resource-pending-cpu&internal");
  await page.getByRole("button", { name: "App resources", exact: true }).click();
  await expect(details.getByRole("row", { name: /^tsc\./ }).getByRole("gridcell").nth(1)).toHaveText("—");
  await expect(details.getByRole("row", { name: /^App\./ }).getByRole("gridcell").nth(1)).toHaveText("—");
  await expect(details.getByRole("row", { name: /^Engine\./ }).getByRole("gridcell").nth(1)).toHaveText("18.0%");
  await expect(details).toContainText(/CPU —\s*Memory/);
  await page.keyboard.press("Escape");
  check("Resources keeps new-process CPU unknown in its row and app total while retaining measured processes", true);
}

/** Retained from the retired cloud restart smoke: a Local workspace menu takes
 * Escape at its first focus and releases the native overlay without writes.
 * The menu is shared by every Local owner; owner-specific Local-link gating
 * has its own unit coverage. */
export async function checkSidebarLocalMenuFirstFocusEscape({ page, check, harnessBase }) {
  await resetHarness(page, harnessBase);
  await page.evaluate(() => {
    window.appSidebarMenuProbe = { overlayActive: false };
    document.addEventListener("zeros-native-surface-overlay-intent", (event) => {
      window.appSidebarMenuProbe.overlayActive = event.detail.active;
    });
  });
  const writes = () =>
    page.evaluate(() =>
      window.appSidebarRequests.filter(({ op }) => ["workspace.setStatus", "workspace.archive"].includes(op)).length,
    );
  const row = page.locator('[data-workspace-id="ws-atlanta"]');
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await writes();
    await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
    await page.evaluate(() => {
      const probe = window.appSidebarMenuProbe;
      probe.escapeSent = false;
      const onFocus = (event) => {
        const menu = event.target.closest?.('[role="menu"]');
        if (!menu) return;
        document.removeEventListener("focusin", onFocus, true);
        probe.focusInsideMenu = menu.contains(document.activeElement);
        probe.overlayAtFirstFocus = probe.overlayActive;
        menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        probe.escapeSent = true;
      };
      document.addEventListener("focusin", onFocus, true);
    });
    await row.click({ button: "right" });
    await expect.poll(() => page.evaluate(() => window.appSidebarMenuProbe.escapeSent)).toBe(true);
    expect(await page.evaluate(() => window.appSidebarMenuProbe.focusInsideMenu)).toBe(true);
    expect(await page.evaluate(() => window.appSidebarMenuProbe.overlayAtFirstFocus)).toBe(true);
    await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
    await expect(row).toHaveAttribute("data-state", "closed");
    // Leave the row so a hover tooltip cannot hold the shared overlay intent.
    await page.mouse.move(1, 1);
    await expect.poll(() => page.evaluate(() => window.appSidebarMenuProbe.overlayActive)).toBe(false);
    expect(await writes()).toBe(before);
  }
  check(
    "A Local workspace menu handles first-focus Escape twice and releases native overlays without writes",
    true,
  );
}

export const appSidebarRegressionChecks = [
  checkSidebarNarrowHeader,
  checkSidebarHistory,
  checkSidebarUnopenedFolder,
  checkSidebarRetiredLocalMain,
  checkSidebarHiddenReads,
  checkSidebarReselection,
  checkSidebarResourceDiagnostics,
  checkSidebarLocalMenuFirstFocusEscape,
];
