import { expect } from "@playwright/test";

export async function runNewTabEnvironmentSmoke({ page, check }) {
  const base = new URL(page.url()).origin;
  await page.goto(
    `${base}/apps/desktop/src/renderer/harnesses/harness-terminal-workbench.html`,
  );
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.setViewportSize({ width: 1600, height: 800 });
  const plus = page.getByRole("button", {
    name: "New File, Browser, or Terminal tab",
  });
  const menu = page.getByRole("dialog", { name: "New tab", exact: true });
  const environment = page.getByRole("option", {
    name: "Environment",
    exact: true,
  });
  const submenu = page.getByRole("menu", { name: "Environment terminals" });
  const search = menu.getByRole("combobox");
  const state = () => page.evaluate(() => window.__zerosTerminalSmoke.state());
  await plus.click();
  await expect(menu).toHaveCSS("width", "280px");
  await expect(menu).toHaveCSS("border-top-left-radius", "16px");
  await expect(menu.locator('[data-slot="command-input-wrapper"]')).toHaveCSS(
    "height",
    "40px",
  );
  await expect
    .poll(async () => {
      const plusBox = await plus.boundingBox();
      const menuBox = await menu.boundingBox();
      return (
        Math.abs(menuBox.x - plusBox.x) < 1 &&
        menuBox.y >= plusBox.y + plusBox.height
      );
    })
    .toBe(true);
  check(
    "the 280px add menu aligns below plus with the requested radius and search height",
    true,
  );
  await expect(menu.getByRole("option")).toHaveCount(4);
  await expect(environment.locator("svg.lucide-play")).toBeVisible();
  await environment.hover();
  await expect(submenu).toBeVisible();
  await expect(submenu).toHaveCSS("width", "280px");
  await expect(submenu).toHaveCSS("border-top-left-radius", "16px");
  await expect(submenu).toHaveAttribute("data-side", "right");
  await page.mouse.down();
  try {
    await expect(submenu).toHaveAttribute("data-state", "open");
  } finally {
    await page.mouse.up();
  }
  await expect(
    submenu
      .getByRole("menuitem", { name: "Setup", exact: true })
      .locator("svg.lucide-settings"),
  ).toBeVisible();
  await expect(
    submenu
      .getByRole("menuitem", { name: "Test", exact: true })
      .locator("svg.lucide-flask-conical"),
  ).toBeVisible();
  check(
    "hovering Environment opens its 280px submenu to the right with Setup and configured action icons",
    true,
  );
  await submenu.getByRole("menuitem", { name: "Test", exact: true }).click();
  await expect(menu).toBeHidden();
  const afterRunSelection = await state();
  const runTab = afterRunSelection.tabs.find(
    (tab) => tab.id === afterRunSelection.activeId,
  );
  check(
    "Environment opens an action's terminal without starting its command",
    runTab.terminalId ===
      (await page.evaluate(() =>
        window.__zerosTerminalSmoke.runIdFor("test"),
      )) &&
      !(await page.evaluate(() =>
        window.__zerosTerminalSmoke.messages.some(
          (message) => message.op === "workspace.startRun",
        ),
      )),
  );

  await plus.click();
  await search.fill("  sEtUp  ");
  await expect(
    menu
      .getByRole("option", { name: "Setup", exact: true })
      .locator("svg.lucide-settings"),
  ).toBeVisible();
  await expect(
    menu.getByRole("option", { name: "setup.sh scripts", exact: true }),
  ).toBeVisible();
  await expect(menu.locator("[cmdk-empty]")).toBeHidden();
  await search.press("Enter");
  await expect(menu).toBeHidden();
  const searchedSetup = await state();
  expect(
    searchedSetup.tabs.find((tab) => tab.id === searchedSetup.activeId)
      .terminalId,
  ).toBe("setup");
  expect(
    searchedSetup.tabs.filter((tab) => tab.terminalId === "setup"),
  ).toHaveLength(1);

  await plus.click();
  await search.fill("  tEs  ");
  const testResult = menu.getByRole("option", { name: "Test", exact: true });
  await expect(testResult.locator("svg.lucide-flask-conical")).toBeVisible();
  await expect(menu.locator("[cmdk-empty]")).toBeHidden();
  await testResult.click();
  await expect(menu).toBeHidden();
  expect((await state()).activeId).toBe(runTab.id);
  expect(
    await page.evaluate(() =>
      window.__zerosTerminalSmoke.messages.some(
        (message) => message.op === "workspace.startRun",
      ),
    ),
  ).toBe(false);
  check(
    "search finds Setup and partial action names with their icons and opens existing terminals without running commands",
    true,
  );

  await plus.click();
  await expect(
    menu.getByRole("option", { name: "File", exact: true }),
  ).toHaveAttribute("data-selected", "true");
  await search.press("End");
  await expect(environment).toHaveAttribute("data-selected", "true");
  await search.press("ArrowRight");
  await expect(
    submenu.getByRole("menuitem", { name: "Setup", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    submenu.getByRole("menuitem", { name: "Test", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(submenu).toBeHidden();
  await expect(menu).toBeVisible();
  await expect(search).toBeFocused();
  await search.press("ArrowRight");
  await expect(submenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(submenu).toBeHidden();
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  check(
    "Environment supports keyboard entry, sibling navigation, and returning to search without closing the parent",
    true,
  );

  await plus.click();
  await environment.hover();
  await expect(submenu).toBeVisible();
  await page.evaluate(() => window.__zerosTerminalSmoke.setRunIcon("bug"));
  await expect(
    submenu
      .getByRole("menuitem", { name: "Test", exact: true })
      .locator("svg.lucide-bug"),
  ).toBeVisible();
  await page.evaluate(() => window.__zerosTerminalSmoke.addBuildAction());
  await expect(
    submenu.getByRole("menuitem", { name: "Build", exact: true }),
  ).toBeVisible();
  await menu.getByRole("option", { name: "File", exact: true }).hover();
  await expect(submenu).toBeHidden();
  await search.fill("tes");
  await expect(testResult.locator("svg.lucide-bug")).toBeVisible();
  await page.evaluate(() =>
    window.__zerosTerminalSmoke.setRunName("Integration Test"),
  );
  await expect(
    menu.getByRole("option", { name: "Integration Test", exact: true }),
  ).toBeVisible();
  await search.fill("int tst");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(menu.locator("[cmdk-empty]")).toBeHidden();
  await page.evaluate(() => window.__zerosTerminalSmoke.setRunName("Test"));
  await expect(menu.getByRole("option")).toHaveCount(0);
  await expect(menu.locator("[cmdk-empty]")).toBeVisible();
  await search.fill("bld");
  await expect(
    menu.getByRole("option", { name: "Build", exact: true }),
  ).toBeVisible();
  await search.fill("   ");
  await expect(menu.getByRole("option")).toHaveCount(4);
  check(
    "action search follows live names and icons, supports fuzzy matches, and restores the default menu when cleared",
    true,
  );
  await search.fill("http://localhost:5274/");
  await expect(menu.getByRole("option", { name: /Open URL/ })).toBeVisible();
  await expect(menu).toHaveCSS("width", "280px");
  await search.press("Enter");
  await expect(menu).toBeHidden();
  const browserState = await state();
  expect(
    browserState.tabs.find((tab) => tab.id === browserState.activeId).url,
  ).toBe("http://localhost:5274/");
  check(
    "live action settings update the submenu and file/URL search remains usable after hover",
    true,
  );

  await page
    .getByRole("tablist", { name: "Workspace panels" })
    .getByRole("tab", { name: "Test", exact: true })
    .click();
  await page
    .locator("[data-terminal-header]")
    .getByRole("button", { name: "Move terminal to bottom panel" })
    .click();
  const beforeDockedSelect = await state();
  await plus.click();
  await environment.hover();
  await submenu.getByRole("menuitem", { name: "Test", exact: true }).click();
  const afterDockedSelect = await state();
  expect(afterDockedSelect.activeTerminalPanelId).toBe(
    beforeDockedSelect.activeTerminalPanelId,
  );
  expect(afterDockedSelect.activeId).toBe(beforeDockedSelect.activeId);
  await expect(page.locator("[data-terminal-panel]")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  check(
    "Environment reuses a docked terminal and preserves the independent primary selection",
    true,
  );

  await page
    .getByRole("button", { name: "Collapse panel", exact: true })
    .click();
  await plus.click();
  await search.fill("Test");
  await search.press("Enter");
  await expect(menu).toBeHidden();
  const afterDockedSearch = await state();
  expect(afterDockedSearch.activeId).toBe(beforeDockedSelect.activeId);
  expect(afterDockedSearch.activeTerminalPanelId).toBe(
    beforeDockedSelect.activeTerminalPanelId,
  );
  expect(
    afterDockedSearch.tabs.filter((tab) => tab.id === runTab.id),
  ).toHaveLength(1);
  await expect(page.locator("[data-terminal-panel]")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  check(
    "a searched action reveals its collapsed bottom panel without duplicating it or changing the primary selection",
    true,
  );

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.evaluate(() => window.__zerosTerminalSmoke.addMany());
  await plus.click();
  await expect
    .poll(async () => {
      const rect = await menu.boundingBox();
      return Math.abs(rect.x + rect.width - 1092) < 1;
    })
    .toBe(true);
  await environment.hover();
  await expect(submenu).toHaveAttribute("data-side", "left");
  await expect(submenu).toHaveCSS("width", "280px");
  await expect
    .poll(async () => {
      const parent = await menu.boundingBox();
      const child = await submenu.boundingBox();
      return child.x >= 8 && child.x + child.width <= parent.x + 5;
    })
    .toBe(true);
  check(
    "a plus at the right edge keeps the menu inside the window and flips its 280px submenu left",
    true,
  );

  await page.getByRole("button", { name: "Workspace B", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(submenu).toBeHidden();
  await plus.click();
  await environment.hover();
  await submenu.getByRole("menuitem", { name: "Test", exact: true }).click();
  const b = await state();
  expect(b.tabs.find((tab) => tab.id === b.activeId).terminalId).toBe(
    await page.evaluate(() => window.__zerosTerminalSmoke.runIdFor("test")),
  );
  expect(b.activeId).not.toBe(runTab.id);
  check(
    "switching workspaces closes both menus and opens Environment terminals for the new owner",
    true,
  );

  await plus.click();
  await search.fill("Test");
  await expect(testResult).toBeVisible();
  await page.getByRole("button", { name: "Workspace A", exact: true }).click();
  await expect(menu).toBeHidden();
  await plus.click();
  await search.fill("tes");
  await testResult.click();
  expect((await state()).activeTerminalPanelId).toBe(runTab.id);
  await page.getByRole("button", { name: "Workspace B", exact: true }).click();
  await plus.click();
  await search.fill("tes");
  await testResult.click();
  expect((await state()).activeId).toBe(b.activeId);
  check(
    "search closes on owner changes and restores each workspace's own action terminal on A to B to A navigation",
    true,
  );

  await plus.click();
  await environment.hover();
  await submenu.getByRole("menuitem", { name: "Setup", exact: true }).click();
  const setup = await state();
  expect(setup.tabs.find((tab) => tab.id === setup.activeId).terminalId).toBe(
    "setup",
  );
  expect(setup.tabs.filter((tab) => tab.terminalId === "setup")).toHaveLength(
    1,
  );
  await plus.click();
  await search.fill("Test");
  await expect(testResult).toBeVisible();
  await page.evaluate(() => window.__zerosTerminalSmoke.removeRunActions());
  await expect(testResult).toBeHidden();
  await expect(
    menu.getByRole("option", { name: "test.ts src", exact: true }),
  ).toBeVisible();
  await expect(menu.locator("[cmdk-empty]")).toBeHidden();
  await search.fill("");
  await environment.hover();
  await expect(submenu.getByRole("menuitem")).toHaveCount(1);
  await expect(
    submenu.getByRole("menuitem", { name: "Setup", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "No workspace", exact: true }).click();
  await expect(submenu).toBeHidden();
  await plus.click();
  await environment.hover();
  await expect(submenu.getByRole("menuitem")).toHaveCount(1);
  await submenu.getByRole("menuitem", { name: "Setup", exact: true }).click();
  await expect(menu).toBeHidden();
  check(
    "Setup remains available without Run actions or a selected workspace and never duplicates its tab",
    true,
  );
  await plus.click();
  await search.fill("setup");
  await menu.getByRole("option", { name: "Setup", exact: true }).click();
  await expect(menu).toBeHidden();
  const ambient = await state();
  expect(
    ambient.tabs.find((tab) => tab.id === ambient.activeId).terminalId,
  ).toBe("setup");
  expect(ambient.tabs.filter((tab) => tab.terminalId === "setup")).toHaveLength(
    1,
  );
  check(
    "removed actions disappear from search without hiding matching files, and Setup is searchable without a workspace",
    true,
  );
  await page.setViewportSize({ width: 1100, height: 800 });
}
