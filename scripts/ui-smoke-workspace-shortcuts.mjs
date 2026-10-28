import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function runWorkspaceShortcutsSmoke({ page, check, harnessBase, screenshotDir }) {
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`${harnessBase}/harness-app-sidebar.html?shortcuts&long-list&filter=ungrouped`, { waitUntil: "networkidle" });
  const state = () => page.evaluate(() => window.appSidebarState());
  const rows = page.locator("[data-workspace-id]");
  const order = () => rows.evaluateAll(nodes => nodes.map(node => node.dataset.workspaceId));
  const row = id => page.locator(`[data-workspace-id="${id}"]`);
  const composer = () => page.locator('[data-pane-focused="true"] .composer-pm:visible');
  const selectGroup = async name => {
    await page.getByRole("button", { name: "Filter workspaces", exact: true }).click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };
  const selectSort = async name => {
    await page.getByRole("button", { name: "Filter workspaces", exact: true }).click();
    await page.getByRole("menuitem", { name: "Sort by", exact: true }).hover();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };
  await expect(rows).toHaveCount(35);
  let ids = await order();
  await page.keyboard.press("Meta+Digit5");
  await expect(row(ids[4])).toHaveAttribute("data-active", "true");
  await expect(composer()).toBeVisible();
  await composer().fill("Keep this workspace draft");
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(row(ids[5])).toHaveAttribute("data-active", "true");
  await composer().focus();
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await expect(row(ids[4])).toHaveAttribute("data-active", "true");
  await expect(composer()).toHaveText("Keep this workspace draft");
  await composer().focus();
  await page.keyboard.press("Meta+Digit9");
  await expect(row(ids[8])).toHaveAttribute("data-active", "true");
  await expect(row(ids.at(-1))).toHaveAttribute("data-active", "false");
  await composer().focus();
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(row(ids[9])).toHaveAttribute("data-active", "true");
  await composer().focus();
  await page.keyboard.press("Meta+Digit1");
  await expect(row(ids[0])).toHaveAttribute("data-active", "true");
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await expect(row(ids[0])).toHaveAttribute("data-active", "true");
  check("Workspace keys work in the composer, preserve drafts, limit numbers to nine and continue with arrows", true);

  for (const group of ["Repository", "Status", "None"]) {
    await selectGroup(group);
    ids = await order();
    await page.keyboard.press("Meta+Digit5");
    await expect(row(ids[4])).toHaveAttribute("data-active", "true");
  }
  await page.evaluate(() => window.appSidebarRecordActivity("ws-new-york", Date.now()));
  await expect.poll(async () => (await order())[0]).toBe("ws-new-york");
  await page.keyboard.press("Meta+Digit1");
  await expect(row("ws-new-york")).toHaveAttribute("data-active", "true");
  await selectSort("Created");
  ids = await order();
  expect(ids[0]).not.toBe("ws-new-york");
  await page.keyboard.press("Meta+Digit1");
  await expect(row(ids[0])).toHaveAttribute("data-active", "true");
  check("Workspace numbers follow Repository, Status, None, Updated and Created ordering", true);

  const hideSidebar = page.getByRole("button", { name: "Hide sidebar", exact: true });
  await hideSidebar.click();
  await composer().focus();
  await page.keyboard.press("Meta+Digit2");
  await expect(row(ids[1])).toHaveAttribute("data-active", "true");
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await composer().fill("Keep this chat draft");
  await page.keyboard.press("Meta+KeyN");
  await expect.poll(async () => (await state()).page).toBe("create");
  await expect.poll(async () => (await state()).createProjectId).toBe("project-zeros");
  await page.locator('[data-harness-page="create"] .composer-pm:visible').focus();
  await page.keyboard.press("Meta+Digit2");
  await expect(composer()).toHaveText("Keep this chat draft");
  check("Command+N opens Create for the current repository; workspace keys also work on Create and with a hidden sidebar", true);

  const chatTabs = page.getByRole("tablist", { name: "Chat sessions" }).getByRole("tab");
  await expect(chatTabs).toHaveCount(3);
  await chatTabs.nth(0).click();
  await composer().focus();
  await page.keyboard.press("Meta+ArrowRight");
  await expect(chatTabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await composer().focus();
  await page.keyboard.press("Meta+ArrowRight");
  await expect(chatTabs.nth(2)).toHaveAttribute("aria-selected", "true");
  await composer().focus();
  await page.keyboard.press("Meta+ArrowRight");
  await expect(chatTabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await composer().focus();
  await page.keyboard.press("Meta+ArrowLeft");
  await expect(chatTabs.nth(2)).toHaveAttribute("aria-selected", "true");
  check("Command+Left/Right cycles chat tabs in the focused composer, including the ends", true);

  const sideTabs = page.locator('[data-zeros-column-3] [data-workbench-tab="true"]');
  const sideCount = await sideTabs.count();
  expect(sideCount).toBeGreaterThan(1);
  const selectedSide = () => sideTabs.evaluateAll(nodes => nodes.findIndex(node => node.dataset.active === "true"));
  const sideIndex = await selectedSide();
  await composer().focus();
  await page.keyboard.press("Meta+Alt+ArrowRight");
  await expect.poll(selectedSide).toBe((sideIndex + 1) % sideCount);
  const chatBeforeSide = (await state()).chatId;
  await sideTabs.nth((sideIndex + 1) % sideCount).focus();
  await page.keyboard.press("Meta+ArrowLeft");
  expect((await state()).chatId).toBe(chatBeforeSide);
  await page.keyboard.press("Meta+Alt+ArrowLeft");
  await expect.poll(selectedSide).toBe(sideIndex);
  await chatTabs.nth(2).focus();
  await page.keyboard.press("Meta+Alt+ArrowRight");
  await expect.poll(selectedSide).toBe((sideIndex + 1) % sideCount);
  expect((await state()).chatId).toBe(chatBeforeSide);
  check("Command+Option+Left/Right cycles side tabs from either column without switching chats", true);

  const surface = page.locator('[data-pane-focused="true"] .zeros-agent-surface:visible');
  const atPrompt = index => surface.evaluate((root, index) => {
    const scroll = root.querySelector(".zeros-agent-body");
    const turn = scroll.querySelectorAll("[data-checkpoint-id]")[index];
    return !!turn && Math.abs(turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12) <= 6;
  }, index);
  for (const [key, index] of [["End", 3], ["Home", 0], ["ArrowDown", 1], ["ArrowDown", 2], ["ArrowUp", 1]]) {
    await composer().focus();
    await page.keyboard.press(`Meta+${key}`);
    await expect.poll(() => atPrompt(index)).toBe(true);
  }
  // The rail click and keyboard navigation share a pin, including two keys
  // delivered before another animation frame.
  await surface.getByRole("button", { name: "Jump to: User message 3", exact: true }).click();
  await composer().focus();
  await composer().evaluate(node => {
    for (let index = 0; index < 2; index++) node.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowUp", code: "ArrowUp", metaKey: true, bubbles: true, cancelable: true,
    }));
  });
  await expect.poll(() => atPrompt(0)).toBe(true);
  check("Message keys follow user checkpoints, share rail selection, and reach the short final prompt", true);

  // A real split reparents the chat body through a portal. The two remaining
  // tabs must cycle only in their own pane, and the neighbor must not scroll.
  const firstChatId = await chatTabs.nth(0).getAttribute("data-chat-id");
  const thirdChatId = await chatTabs.nth(2).getAttribute("data-chat-id");
  await page.getByRole("button", { name: "Pane options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split Down", exact: true }).click();
  const panes = page.locator("[data-pane-root]");
  await expect(panes).toHaveCount(2);
  const twoTabs = panes.filter({ has: page.locator(`[data-chat-id="${firstChatId}"]`) });
  const neighbor = panes.filter({ has: page.locator(`[data-chat-id="${thirdChatId}"]`) });
  await twoTabs.locator(".composer-pm:visible").focus();
  const neighborBefore = await neighbor.locator(".zeros-agent-body:visible").evaluate(node => node.scrollTop);
  const paneTabs = twoTabs.getByRole("tab");
  const paneIndex = await paneTabs.evaluateAll(nodes => nodes.findIndex(node => node.getAttribute("aria-selected") === "true"));
  await page.keyboard.press("Meta+ArrowRight");
  await expect(paneTabs.nth((paneIndex + 1) % 2)).toHaveAttribute("aria-selected", "true");
  await twoTabs.locator(".composer-pm:visible").focus();
  await page.keyboard.press("Meta+Home");
  expect(await neighbor.locator(".zeros-agent-body:visible").evaluate(node => node.scrollTop)).toBe(neighborBefore);
  await expect(neighbor.getByRole("tab")).toHaveAttribute("aria-selected", "true");
  check("Split panes route keys through the portaled composer without changing the neighboring chat", true);

  const beforeOverlay = await state();
  await page.keyboard.press("Meta+Alt+Slash");
  const palette = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  const search = palette.getByRole("combobox");
  await expect(search).toBeFocused();
  for (const key of ["Meta+Digit1", "Meta+KeyN", "Meta+Alt+ArrowDown", "Meta+Alt+ArrowRight"]) await page.keyboard.press(key);
  expect((await state()).folder).toBe(beforeOverlay.folder);
  expect((await state()).page).toBe("workspace");
  expect((await state()).workbench.activeId).toBe(beforeOverlay.workbench.activeId);
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const category of ["Workspace", "Chats", "View"]) {
      await palette.getByRole("button", { name: category, exact: true }).click();
      const arrows = palette.locator('[data-slot="kbd"] svg');
      expect(await arrows.count()).toBeGreaterThanOrEqual(2);
      expect(await arrows.evaluateAll(nodes => nodes.every(node => {
        const icon = node.getBoundingClientRect();
        const chip = node.closest('[data-slot="kbd"]').getBoundingClientRect();
        return icon.width === 12 && icon.height === 12 && Math.abs(icon.y + 6 - (chip.y + chip.height / 2)) <= 1;
      }))).toBe(true);
      if (screenshotDir) await palette.screenshot({ path: join(screenshotDir, `shortcuts-${category.toLowerCase()}-${theme}.png`) });
    }
  }
  await search.fill("first 9");
  await expect(palette.locator('[data-slot="command-item"]')).toHaveCount(1);
  await expect(palette.getByText("Go to workspace 1–9 (first 9 in sidebar order)", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  check("Shortcut search documents the bindings, arrow icons align in both themes, and overlays retain keyboard ownership", true);

  const cloud = await page.evaluate(() => window.appSidebarSeedCloud());
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "Home", exact: true }).focus();
  await page.keyboard.press("Meta+Digit1");
  await expect.poll(async () => (await state()).folder).toBe(cloud.keys[0]);
  await expect(chatTabs).toHaveCount(3);
  await chatTabs.nth(0).click();
  await composer().focus();
  await page.keyboard.press("Meta+ArrowRight");
  await expect(chatTabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await composer().focus();
  await page.keyboard.press("Meta+ArrowLeft");
  await expect(chatTabs.nth(0)).toHaveAttribute("aria-selected", "true");
  for (const [key, index] of [["End", 3], ["Home", 0], ["ArrowDown", 1]]) {
    await composer().focus();
    await page.keyboard.press(`Meta+${key}`);
    await expect.poll(() => atPrompt(index)).toBe(true);
  }
  // This cloud fixture does not advertise GitHub Review. The keyboard follows
  // the same filtered strip as clicks, including visible unavailable pages.
  await expect(sideTabs.filter({ hasText: "Review" })).toHaveCount(0);
  const cloudSideCount = await sideTabs.count();
  expect(cloudSideCount).toBeGreaterThan(1);
  const cloudSideIndex = await selectedSide();
  const cloudChatId = (await state()).chatId;
  await composer().focus();
  await page.keyboard.press("Meta+Alt+ArrowRight");
  await expect.poll(selectedSide).toBe((cloudSideIndex + 1) % cloudSideCount);
  await composer().focus();
  await page.keyboard.press("Meta+Alt+ArrowLeft");
  await expect.poll(selectedSide).toBe(cloudSideIndex);
  expect((await state()).chatId).toBe(cloudChatId);
  check("Cloud chat, message and side-tab keys follow the visible tabs and respect Review availability", true);
  await composer().focus();
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(async () => (await state()).folder).toBe(cloud.keys[1]);
  await composer().focus();
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await expect.poll(async () => (await state()).folder).toBe(cloud.keys[0]);
  await page.evaluate(id => window.appSidebarSelectOwner(id), cloud.otherOrganizationId);
  await expect(rows).toHaveCount(1);
  await page.keyboard.press("Meta+Digit1");
  await expect.poll(async () => (await state()).folder).toBe(cloud.keys[2]);
  await page.keyboard.press("Meta+Digit2");
  expect((await state()).folder).toBe(cloud.keys[2]);
  await page.evaluate(id => window.appSidebarSelectOwner(id), cloud.organizationId);
  await expect(rows).toHaveCount(2);
  await page.keyboard.press("Meta+Digit2");
  await expect.poll(async () => (await state()).folder).toBe(cloud.keys[1]);
  await page.evaluate(() => window.appSidebarSelectOwner(null));
  await expect(rows).toHaveCount(35);
  ids = await order();
  await page.keyboard.press("Meta+Digit5");
  await expect(row(ids[4])).toHaveAttribute("data-active", "true");
  check("Workspace shortcuts isolate cloud organizations and restore Local ordering across A → B → A", true);
  await page.setViewportSize(viewport);
}
