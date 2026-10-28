import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function runWorkspaceShortcutsSmoke({ page, check, harnessBase, screenshotDir }) {
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 1600, height: 1000 });
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
  // Do not repair focus between presses: the outgoing composer becomes inert
  // during selection, and the shortcut must hand off before that happens.
  for (const [key, index] of [
    ["ArrowRight", 1], ["ArrowRight", 2], ["ArrowRight", 0], ["ArrowLeft", 2],
  ]) {
    await page.keyboard.press(`Meta+${key}`);
    await expect(chatTabs.nth(index)).toHaveAttribute("aria-selected", "true");
    await expect(composer()).toBeFocused();
    if (index === 0) await expect(composer()).toHaveText("Keep this chat draft");
  }
  check("Command+Left/Right preserves composer focus across consecutive chat switches and wrapping", true);

  const chatIds = await chatTabs.evaluateAll(nodes => nodes.map(node => node.dataset.chatId));
  const rapidSelections = await page.evaluate(async () => {
    const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
    const selections = [];
    const unsubscribe = useWorkspaceStore.subscribe((state, previous) => {
      if (state.activeChatId !== previous.activeChatId) selections.push(state.activeChatId);
    });
    try {
      // Deliver both keys before React can refresh the pane's focus listener.
      for (let index = 0; index < 2; index++) document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowRight", code: "ArrowRight", metaKey: true, bubbles: true, cancelable: true,
      }));
      return selections;
    } finally { unsubscribe(); }
  });
  expect(rapidSelections).toEqual([chatIds[0], chatIds[1]]);
  await expect(chatTabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(composer()).toBeFocused();
  check("Rapid chat shortcuts publish exactly one selection per key without restoring a stale tab", true);

  await chatTabs.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(chatTabs.nth(1)).toBeFocused();
  for (const [key, index] of [["ArrowRight", 2], ["ArrowRight", 0], ["ArrowLeft", 2]]) {
    await page.keyboard.press(`Meta+${key}`);
    await expect(chatTabs.nth(index)).toHaveAttribute("aria-selected", "true");
    await expect(chatTabs.nth(index)).toBeFocused();
  }
  // A deliberate pointer return releases tab-strip keyboard focus.
  await composer().click();
  check("Chat shortcuts preserve deliberate tab-strip focus and move it to the selected tab", true);

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
  const atPanelBoundary = boundary => surface.evaluate((root, boundary) => {
    const scroll = root.querySelector(".zeros-agent-body");
    const target = boundary === "top" ? 0 : scroll.scrollHeight - scroll.clientHeight;
    return Math.abs(scroll.scrollTop - target) <= 1;
  }, boundary);
  const jumpToPrompt = async number => {
    // Use the expanded rail row: its hover popup covers the narrow tick.
    await surface.getByRole("navigation", { name: "Chat checkpoints" }).hover();
    const prompt = page.getByRole("button", { name: `User message ${number}`, exact: true });
    await prompt.click();
    await composer().click();
    await expect(prompt).toHaveCount(0);
  };
  const checkPanelScrolling = async label => {
    // The short final response needs checkpoint blank space when its prompt
    // is pinned at the top. A panel-bottom shortcut must remove that space.
    await jumpToPrompt(4);
    await expect.poll(() => atPrompt(3)).toBe(true);
    const draft = await composer().textContent();
    await page.keyboard.press("Shift+Meta+ArrowDown");
    await expect.poll(() => atPanelBoundary("bottom")).toBe(true);
    await expect.poll(() => atPrompt(3)).toBe(false);
    await page.keyboard.press("Shift+Meta+ArrowUp");
    await expect.poll(() => atPanelBoundary("top")).toBe(true);
    // Interrupt a checkpoint correction before React/animation frames settle.
    await composer().evaluate(node => {
      node.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown", code: "ArrowDown", metaKey: true, bubbles: true, cancelable: true,
      }));
      node.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown", code: "ArrowDown", metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
    });
    await expect.poll(() => atPanelBoundary("bottom")).toBe(true);
    await expect(composer()).toBeFocused();
    expect(await composer().textContent()).toBe(draft);
    check(label, true);
  };
  await checkPanelScrolling("Local: Shift+Command+Up/Down reaches the panel boundaries, clears checkpoint space and preserves the draft");
  await jumpToPrompt(4);
  for (const [key, index] of [["ArrowUp", 2], ["ArrowUp", 1], ["ArrowDown", 2], ["ArrowDown", 3]]) {
    await composer().focus();
    await page.keyboard.press(`Meta+${key}`);
    await expect.poll(() => atPrompt(index)).toBe(true);
  }
  // The rail click and keyboard navigation share a pin, including two keys
  // delivered before another animation frame.
  await jumpToPrompt(3);
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
  await expect(twoTabs.locator(".composer-pm:visible")).toBeFocused();
  await page.keyboard.press("Meta+ArrowLeft");
  await expect(paneTabs.nth(paneIndex)).toHaveAttribute("aria-selected", "true");
  await expect(twoTabs.locator(".composer-pm:visible")).toBeFocused();
  await page.keyboard.press("Shift+Meta+ArrowUp");
  await expect.poll(() => atPanelBoundary("top")).toBe(true);
  await page.keyboard.press("Shift+Meta+ArrowDown");
  await expect.poll(() => atPanelBoundary("bottom")).toBe(true);
  expect(await neighbor.locator(".zeros-agent-body:visible").evaluate(node => node.scrollTop)).toBe(neighborBefore);
  await expect(neighbor.getByRole("tab")).toHaveAttribute("aria-selected", "true");
  check("Split panes route keys through the portaled composer without changing the neighboring chat", true);

  await neighbor.locator(".composer-pm:visible").click();
  for (const key of ["ArrowLeft", "ArrowRight"]) {
    await page.keyboard.press(`Meta+${key}`);
    await expect(neighbor.locator(".composer-pm:visible")).toBeFocused();
    expect((await state()).chatId).toBe(thirdChatId);
  }
  await twoTabs.locator(".composer-pm:visible").click();
  check("A single-tab pane keeps its composer and selection when cycling", true);

  const beforeOverlay = await state();
  const beforeOverlayScroll = await surface.locator(".zeros-agent-body").evaluate(node => node.scrollTop);
  await page.keyboard.press("Meta+Alt+Slash");
  const palette = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  const search = palette.getByRole("combobox");
  await expect(search).toBeFocused();
  for (const key of ["Meta+Digit1", "Meta+KeyN", "Meta+Alt+ArrowDown", "Meta+Alt+ArrowRight", "Meta+ArrowLeft", "Meta+ArrowRight", "Shift+Meta+ArrowUp", "Shift+Meta+ArrowDown"]) await page.keyboard.press(key);
  expect((await state()).folder).toBe(beforeOverlay.folder);
  expect((await state()).page).toBe("workspace");
  expect((await state()).chatId).toBe(beforeOverlay.chatId);
  expect((await state()).workbench.activeId).toBe(beforeOverlay.workbench.activeId);
  expect(await surface.locator(".zeros-agent-body").evaluate(node => node.scrollTop)).toBe(beforeOverlayScroll);
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const category of ["Workspace", "Chats", "View"]) {
      await palette.getByRole("button", { name: category, exact: true }).click();
      if (category === "Chats") {
        const top = palette.locator('[data-slot="command-item"]').filter({ hasText: "Scroll agent panel to top" });
        const bottom = palette.locator('[data-slot="command-item"]').filter({ hasText: "Scroll agent panel to bottom" });
        await expect(top.locator('[data-slot="kbd"]')).toHaveText(["⇧⌘↑"]);
        await expect(bottom.locator('[data-slot="kbd"]')).toHaveText(["⇧⌘↓"]);
        await expect(palette.getByText("First user message", { exact: true })).toHaveCount(0);
        await expect(palette.getByText("Last user message", { exact: true })).toHaveCount(0);
      }
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
  await expect(composer()).toBeFocused();
  await page.keyboard.press("Meta+ArrowLeft");
  await expect(chatTabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(composer()).toBeFocused();
  await checkPanelScrolling("Cloud: Shift+Command+Up/Down scrolls the whole panel and cancels an older checkpoint jump");
  await jumpToPrompt(1);
  for (const [key, index] of [["ArrowDown", 1], ["ArrowDown", 2], ["ArrowUp", 1]]) {
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
