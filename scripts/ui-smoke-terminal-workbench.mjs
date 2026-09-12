import { expect } from "@playwright/test";
import { runNewTabEnvironmentSmoke } from "./ui-smoke-new-tab-environment.mjs";
import { runSetupSidebarSmoke } from "./ui-smoke-setup-sidebar.mjs";
import { runTerminalLifecycleSmoke } from "./ui-smoke-terminal-lifecycle.mjs";

async function expectTokenColor(locator, token, property = "color") {
  await expect
    .poll(() =>
      locator.evaluate(
        (element, [name, property]) => {
          const probe = document.createElement("span");
          probe.style.color = `var(${name})`;
          element.parentElement.appendChild(probe);
          const matches =
            getComputedStyle(element)[property] ===
            getComputedStyle(probe).color;
          probe.remove();
          return matches;
        },
        [token, property],
      ),
    )
    .toBe(true);
}

async function expectCompactRunButtons(surface, openButton, stopButton) {
  const previousWidth = await surface.evaluate((element) => {
    const width = element.style.width;
    element.style.width = "360px";
    return width;
  });
  try {
    // Resize only the workbench surface: labels must follow its width even in
    // a wide window, as when dragging the app's column separator.
    await expect(openButton.getByText("Open", { exact: true })).toBeHidden();
    await expect(openButton.getByText(":5173", { exact: true })).toBeHidden();
    await expect(stopButton.getByText("Stop", { exact: true })).toBeHidden();
    await expect(openButton).toHaveCSS("width", "24px");
    await expect(stopButton).toHaveCSS("width", "24px");
    await expect(openButton).toBeEnabled();
    const surfaceBox = await surface.boundingBox();
    const openBox = await openButton.boundingBox();
    const stopBox = await stopButton.boundingBox();
    expect(openBox.x).toBeGreaterThanOrEqual(surfaceBox.x);
    expect(stopBox.x + stopBox.width).toBeLessThanOrEqual(
      surfaceBox.x + surfaceBox.width,
    );
    expect(await surface.evaluate((element) => element.scrollWidth)).toBe(
      surfaceBox.width,
    );
  } finally {
    await surface.evaluate((element, width) => {
      element.style.width = width;
    }, previousWidth);
  }
  await expect(openButton.getByText("Open", { exact: true })).toBeVisible();
  await expect(stopButton.getByText("Stop", { exact: true })).toBeVisible();
}

export async function runTerminalWorkbenchSmoke({ page, check }) {
  const base = new URL(page.url()).origin;
  await page.goto(
    `${base}/apps/desktop/src/renderer/harnesses/harness-terminal-workbench.html`,
    { waitUntil: "networkidle" },
  );
  const main = page.locator("[data-terminal-workbench]");
  const panel = page.locator("[data-terminal-panel]");
  const tabs = page.getByRole("tablist", { name: "Workspace panels" });
  const sidebar = () =>
    page.getByRole("tablist", { name: "Terminal sessions" });
  const rowActions = (name) =>
    sidebar()
      .getByRole("tab", { name, exact: true })
      .locator("..")
      .locator("[data-terminal-row-actions]");
  const state = () => page.evaluate(() => window.__zerosTerminalSmoke.state());
  await expect
    .poll(() =>
      page.evaluate(() => window.__zerosTerminalSmoke.sessions().length),
    )
    .toBeGreaterThan(0);
  check(
    "terminals default to the main tab area without a bottom panel",
    !(await panel.isVisible()),
  );
  await expect(page.getByRole("button", { name: /^Run Test:/ })).toHaveCount(0);
  await page
    .getByRole("button", { name: "New File, Browser, or Terminal tab" })
    .click();
  await page.getByRole("option", { name: "Terminal", exact: true }).click();
  await expect(main.locator(".xterm-helper-textarea")).toBeVisible();
  const openedFirst = await state();
  const first = openedFirst.tabs.find((tab) => tab.id === openedFirst.activeId);
  const runTest = sidebar().getByRole("button", {
    name: "Run Test",
    exact: true,
  });
  await expect(runTest).toHaveCount(1);
  await expect(rowActions("Test")).toHaveCSS("opacity", "0");
  await expect(runTest).toHaveCSS("pointer-events", "none");
  await sidebar().getByRole("tab", { name: "Test", exact: true }).hover();
  await expect(rowActions("Test")).toHaveCSS("opacity", "1");
  await expect(runTest).toHaveCSS("pointer-events", "auto");
  await expect(runTest).toHaveText("Run");
  await expectTokenColor(runTest, "--blue-fg");
  await page.mouse.move(0, 0);
  await expect(rowActions("Test")).toHaveCSS("opacity", "0");
  check(
    "Run actions are available on row hover and cannot intercept clicks while hidden",
    true,
  );

  const header = main.locator(":scope > div").first();
  const titleChip = header
    .locator("[data-terminal-title-actions] > div")
    .first();
  await expect(titleChip).toHaveCSS("border-top-width", "1px");
  await expect(titleChip).toHaveCSS("padding-left", "8px");
  const dockBox = await header
    .getByRole("button", { name: "Move terminal to bottom panel" })
    .boundingBox();
  await expect(
    header
      .getByRole("button", { name: "Move terminal to bottom panel" })
      .locator("svg"),
  ).toHaveCSS("width", "14px");
  const initialSettingsBox = await header
    .getByRole("button", { name: "Repository environment settings" })
    .boundingBox();
  check(
    "the dock control sits immediately before Settings at the header's right edge",
    initialSettingsBox.x - dockBox.x - dockBox.width === 4 &&
      initialSettingsBox.y === dockBox.y,
  );
  const longTitle = "Terminal with a long workspace task name ".repeat(8);
  await page.setViewportSize({ width: 440, height: 680 });
  await page.evaluate(
    ([id, title]) => window.__zerosTerminalSmoke.renameTerminal(id, title),
    [first.terminalId, longTitle],
  );
  await expect(header.getByText(longTitle, { exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await header
            .getByRole("button", { name: "Move terminal to bottom panel" })
            .boundingBox()
        ).width,
    )
    .toBe(24);
  await expect
    .poll(
      async () =>
        (
          await header
            .getByRole("button", { name: "Hide terminal sidebar" })
            .boundingBox()
        ).width,
    )
    .toBe(24);
  check(
    "long terminal titles truncate without shrinking header controls",
    true,
  );
  await page.evaluate(
    ([id, title]) => window.__zerosTerminalSmoke.renameTerminal(id, title),
    [first.terminalId, first.title],
  );
  await expect(header.getByText(first.title, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 800 });
  const shellHeading = main.locator("[data-terminal-shell-heading]");
  await expect(
    shellHeading.getByText("Terminals", { exact: true }),
  ).toBeVisible();
  const configure = header.getByRole("button", {
    name: "Repository environment settings",
  });
  await expect(configure.locator("svg.lucide-settings2")).toBeVisible();
  const configureBox = await configure.boundingBox();
  const addBox = await shellHeading
    .getByRole("button", { name: "New terminal", exact: true })
    .boundingBox();
  const toggleBox = await header
    .getByRole("button", { name: "Hide terminal sidebar" })
    .boundingBox();
  check(
    "repository settings sits beside the sidebar toggle in the main header",
    toggleBox.x - configureBox.x - configureBox.width === 4 &&
      toggleBox.y === configureBox.y,
  );
  const groupSeparator = sidebar().getByRole("separator", {
    name: "Shell terminals",
  });
  await expect(groupSeparator).toHaveCount(1);
  const separatorBox = await groupSeparator.boundingBox();
  const actionBox = await sidebar()
    .getByRole("tab", { name: "Test", exact: true })
    .boundingBox();
  const shellBox = await sidebar()
    .getByRole("tab", { name: /^Terminal/ })
    .first()
    .boundingBox();
  check(
    "a single separator divides setup and run actions from shell sessions",
    separatorBox.y > actionBox.y + actionBox.height &&
      separatorBox.y < shellBox.y,
  );
  check(
    "the Terminals section heading and plus sit between Run actions and shell rows",
    addBox.y > separatorBox.y && addBox.y + addBox.height <= shellBox.y,
  );
  await expect(header.getByRole("button")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "Run actions", exact: true }),
  ).toHaveCount(0);
  check("terminal headers have no persistent Run button or dropdown", true);
  await configure.click();
  await expect
    .poll(() => page.evaluate(() => window.__zerosTerminalSmoke.navigation()))
    .toEqual({
      page: "repo",
      repoRoot: "/terminal-fixture/a",
      view: "environment",
    });
  await page.evaluate(() => window.__zerosTerminalSmoke.returnToWorkspace());
  check(
    "sidebar settings opens the current repository's Environment view atomically",
    true,
  );
  await expect(
    sidebar()
      .getByRole("tab", { name: "Setup", exact: true })
      .locator("svg.lucide-settings"),
  ).toBeVisible();
  await expect(
    tabs
      .getByRole("tab", { name: "Setup", exact: true })
      .locator("svg.lucide-settings"),
  ).toBeVisible();
  await expect(
    sidebar()
      .getByRole("tab", { name: "Test", exact: true })
      .locator("svg.lucide-flask-conical"),
  ).toBeVisible();
  const selectedShell = sidebar().getByRole("tab", {
    name: first.title,
    exact: true,
  });
  await expect(selectedShell.locator("svg.lucide-terminal")).toBeVisible();
  await expectTokenColor(selectedShell.locator("svg.lucide-terminal"), "--fg1");
  await expectTokenColor(
    sidebar().getByRole("tab", { name: "Setup", exact: true }).locator("svg"),
    "--fg2",
  );
  await expectTokenColor(
    tabs
      .getByRole("tab", { name: first.title, exact: true })
      .locator("svg.lucide-terminal"),
    "--fg1",
  );
  await expectTokenColor(
    tabs
      .getByRole("tab", { name: "Setup", exact: true })
      .locator("svg.lucide-settings"),
    "--fg2",
  );
  await expectTokenColor(
    main
      .getByRole("button", { name: "Move terminal to bottom panel" })
      .locator("svg"),
    "--fg2",
  );
  await expectTokenColor(
    main.getByRole("button", { name: "Hide terminal sidebar" }).locator("svg"),
    "--fg1",
  );
  check(
    "terminal icons reflect destination and selection in both sidebar and primary tabs",
    true,
  );
  await page.evaluate(() => {
    window.__terminalFirstNode = document.querySelector(
      "[data-terminal-workbench] .xterm",
    );
  });
  await main
    .locator(".xterm-helper-textarea")
    .pressSequentially("layout-check");
  await expect(main).toContainText("layout-check");
  await main.getByRole("button", { name: "New terminal", exact: true }).click();
  const openedSecond = await state();
  const second = openedSecond.tabs.find(
    (tab) => tab.id === openedSecond.activeId,
  );
  await sidebar().getByRole("tab", { name: first.title, exact: true }).click();
  check(
    "sidebar selection focuses the existing terminal's own main tab",
    (await state()).activeId === first.id &&
      (await state()).tabs.filter((tab) => tab.type === "terminal").length ===
        3,
  );
  await expect(main).toContainText("layout-check");
  check(
    "terminal tab round trips preserve the actual xterm node and typed output",
    (await page.evaluate(
      () =>
        document.querySelector("[data-terminal-workbench] .xterm") ===
        window.__terminalFirstNode,
    )) && (await main.innerText()).includes("layout-check"),
  );
  await main.getByRole("button", { name: "Hide terminal sidebar" }).click();
  await expectTokenColor(
    main.getByRole("button", { name: "Show terminal sidebar" }).locator("svg"),
    "--fg2",
  );
  await tabs.getByRole("tab", { name: second.title, exact: true }).click();
  await expect(sidebar()).toBeVisible();
  await tabs.getByRole("tab", { name: first.title, exact: true }).click();
  check(
    "each terminal restores its own sidebar visibility",
    await main
      .getByRole("button", { name: "Show terminal sidebar" })
      .isVisible(),
  );
  await main.getByRole("button", { name: "Show terminal sidebar" }).click();

  const sidebarWidth = (await sidebar().boundingBox()).width;
  const sidebarHandle = main.getByRole("separator", {
    name: "Resize terminal sidebar",
  });
  await expect(sidebarHandle).toHaveCSS("width", "7px");
  await expect(sidebarHandle).toHaveCSS("cursor", "ew-resize");
  await expect(sidebarHandle.locator("..")).toHaveCSS("width", "1px");
  const sideSeam = await sidebarHandle.boundingBox();
  const sideCenter = sideSeam.x + sideSeam.width / 2;
  for (const offset of [-2.5, 2.5]) {
    const x = sideCenter + offset;
    const y = sideSeam.y + 60;
    await page.mouse.move(x, y);
    expect(
      await sidebarHandle.evaluate(
        (handle, { x, y }) => document.elementFromPoint(x, y) === handle,
        { x, y },
      ),
    ).toBe(true);
  }
  await expect(
    page.getByRole("tooltip", { name: "Drag to resize", exact: true }),
  ).toBeVisible();
  check(
    "the terminal sidebar matches Files with a 7px grab area, resize cursor, and idle hint",
    true,
  );
  const storedSidebarWidth = await page.evaluate(() =>
    localStorage.getItem("zeros:files-sidebar-fraction:v1"),
  );
  await page.mouse.down();
  await page.mouse.move(sideCenter - 65, sideSeam.y + 60, { steps: 4 });
  await expect(page.locator("body")).toHaveCSS("cursor", "ew-resize");
  await expect(
    page.getByRole("tooltip", { name: "Drag to resize", exact: true }),
  ).toBeHidden();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("zeros:files-sidebar-fraction:v1"),
    ),
  ).toBe(storedSidebarWidth);
  await page.mouse.up();
  check(
    "the terminal sidebar resizes alongside the terminal",
    (await sidebar().boundingBox()).width > sidebarWidth + 40,
  );
  expect(
    await page.evaluate(() => ({
      cursor: document.body.style.cursor,
      selection: document.body.style.userSelect,
    })),
  ).toEqual({ cursor: "", selection: "" });
  const grownSidebarWidth = (await sidebar().boundingBox()).width;
  const nextSeam = await sidebarHandle.boundingBox();
  // Grab the other invisible wing too, outside the one-pixel painted line.
  await page.mouse.move(nextSeam.x + 0.5, nextSeam.y + 60);
  await page.mouse.down();
  await page.mouse.move(nextSeam.x + 30, nextSeam.y + 60, { steps: 3 });
  await page.mouse.up();
  expect((await sidebar().boundingBox()).width).toBeLessThan(
    grownSidebarWidth - 20,
  );
  await page.mouse.move(0, 0);
  await expect(
    page.getByRole("tooltip", { name: "Drag to resize", exact: true }),
  ).toBeHidden();
  check(
    "both sides of the terminal divider can start a drag and release the cursor cleanly",
    true,
  );
  await sidebar().getByRole("tab", { name: first.title, exact: true }).focus();
  await page.keyboard.press("Home");
  await expect(
    sidebar().getByRole("tab", { name: "Setup", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const keyboardState = await state();
  check(
    "sidebar keyboard navigation opens the destination's own tab",
    keyboardState.tabs.find((tab) => tab.id === keyboardState.activeId)
      ?.terminalId === "setup",
  );
  await tabs.getByRole("tab", { name: first.title, exact: true }).click();

  const createsBeforeDock = await page.evaluate(
    () =>
      window.__zerosTerminalSmoke.messages.filter(
        (message) => message.type === "PTY_CREATE",
      ).length,
  );
  await main
    .getByRole("button", { name: "Move terminal to bottom panel" })
    .click();
  await expect(panel).toBeVisible();
  const dockedRow = sidebar().getByRole("tab", {
    name: first.title,
    exact: true,
  });
  await page.mouse.move(0, 0);
  const markerBeforeHover = await dockedRow
    .locator("[data-terminal-dock-indicator]")
    .boundingBox();
  const rowBeforeHover = await dockedRow.boundingBox();
  await dockedRow.hover();
  const closeGlyph = sidebar()
    .getByRole("button", { name: `Close ${first.title}`, exact: true })
    .locator("svg");
  await expect
    .poll(async () => (await closeGlyph.boundingBox()).width)
    .toBe(14);
  const closeAfterHover = await closeGlyph.boundingBox();
  const rowAfterHover = await dockedRow.boundingBox();
  check(
    "docked row hover swaps equally-sized icons in the same fixed slot without moving the row",
    closeAfterHover.x === markerBeforeHover.x &&
      closeAfterHover.y === markerBeforeHover.y &&
      rowBeforeHover.width === rowAfterHover.width &&
      rowBeforeHover.height === rowAfterHover.height,
  );
  await expectTokenColor(dockedRow.locator("svg.lucide-terminal"), "--fg3");
  await expectTokenColor(dockedRow.locator("span").first(), "--fg3");
  await expect
    .poll(
      async () =>
        (
          await dockedRow
            .locator('svg[aria-label="In bottom panel"]')
            .boundingBox()
        ).width,
    )
    .toBe(14);
  await expectTokenColor(
    panel
      .getByRole("button", { name: "Move terminal to tab bar" })
      .locator("svg"),
    "--fg2",
  );
  await expectTokenColor(
    panel.getByRole("button", { name: "Collapse panel" }).locator("svg"),
    "--fg2",
  );
  const collapseBox = await panel
    .getByRole("button", { name: "Collapse panel" })
    .boundingBox();
  const firstPanelTabBox = await panel.getByRole("tab").first().boundingBox();
  await expect(panel.getByRole("button").first()).toHaveAccessibleName(
    "Collapse panel",
  );
  check(
    "the panel collapse arrow stays at the left edge before all tabs",
    firstPanelTabBox.x - collapseBox.x - collapseBox.width === 4,
  );
  await panel.getByRole("button", { name: "Collapse panel" }).click();
  await expect(panel.getByRole("button").first()).toHaveAccessibleName(
    "Expand panel",
  );
  await dockedRow.click();
  await expect(panel).toHaveAttribute("aria-expanded", "true");
  await expect(
    panel
      .getByRole("tab", { name: first.title, exact: true })
      .locator(":scope > svg"),
  ).toHaveCount(0);
  check(
    "docked rows stay muted and clickable with matching icon sizes and text-only panel tabs",
    true,
  );
  check(
    "docking moves only the selected terminal and preserves both active surfaces",
    (await state()).activeId === second.id &&
      (await state()).activeTerminalPanelId === first.id &&
      (await main.locator(".xterm").isVisible()) &&
      (await panel.locator(".xterm").isVisible()),
  );
  check(
    "docking reparents the same xterm without a PTY create or kill",
    await page.evaluate(
      (count) =>
        document.querySelector("[data-terminal-panel] .xterm") ===
          window.__terminalFirstNode &&
        window.__zerosTerminalSmoke.messages.filter(
          (message) => message.type === "PTY_CREATE",
        ).length === count &&
        !window.__zerosTerminalSmoke.messages.some(
          (message) => message.type === "PTY_KILL",
        ),
      createsBeforeDock,
    ),
  );
  const panelHeight = (await panel.boundingBox()).height;
  const panelSeam = await page
    .getByRole("separator", { name: "Resize terminal panel" })
    .boundingBox();
  await page.mouse.move(
    panelSeam.x + panelSeam.width / 2,
    panelSeam.y + panelSeam.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(panelSeam.x + panelSeam.width / 2, panelSeam.y - 65, {
    steps: 4,
  });
  await page.mouse.up();
  check(
    "docked terminals retain the existing panel resize behavior",
    (await panel.boundingBox()).height > panelHeight + 40,
  );
  await panel.getByRole("button", { name: "Move terminal to tab bar" }).click();
  await expect(panel).not.toBeVisible();
  check(
    "undocking restores the same main tab and terminal output",
    (await state()).activeId === first.id &&
      (await page.evaluate(
        () =>
          document.querySelector("[data-terminal-workbench] .xterm") ===
          window.__terminalFirstNode,
      )),
  );

  await sidebar().getByRole("tab", { name: "Setup", exact: true }).click();
  await expect(main).toContainText("Setup output preserved");
  await main
    .getByRole("button", { name: "Move terminal to bottom panel" })
    .click();
  await expect(panel).toContainText("Setup output preserved");
  await panel.getByRole("button", { name: "Collapse panel" }).click();
  check(
    "collapsed Setup output is hidden and inert",
    !(await panel.locator(".xterm").isVisible()) &&
      (await panel.locator('[aria-hidden="true"][inert]').count()) > 0,
  );
  await panel.getByRole("tab", { name: "Setup", exact: true }).click();
  await expect(panel.locator(".xterm")).toBeVisible();

  await sidebar().getByRole("tab", { name: "Test", exact: true }).click();
  await expect(
    tabs
      .getByRole("tab", { name: "Test", exact: true })
      .locator("svg.lucide-flask-conical"),
  ).toBeVisible();
  await page.evaluate(() => window.__zerosTerminalSmoke.setRunIcon("bug"));
  await expect(
    sidebar()
      .getByRole("tab", { name: "Test", exact: true })
      .locator("svg.lucide-bug"),
  ).toBeVisible();
  await expect(
    tabs
      .getByRole("tab", { name: "Test", exact: true })
      .locator("svg.lucide-bug"),
  ).toBeVisible();
  await page.evaluate(() =>
    window.__zerosTerminalSmoke.setRunIcon("unknown-icon"),
  );
  await expect(
    tabs
      .getByRole("tab", { name: "Test", exact: true })
      .locator("svg.lucide-play"),
  ).toBeVisible();
  await page.evaluate(() =>
    window.__zerosTerminalSmoke.setRunIcon("flask-conical"),
  );
  await expect(
    tabs
      .getByRole("tab", { name: "Test", exact: true })
      .locator("svg.lucide-flask-conical"),
  ).toBeVisible();
  check(
    "Run icon edits update both surfaces without a status change and unknown icons fall back safely",
    true,
  );
  check(
    "opening a Run tab does not start its command",
    !(await page.evaluate(() =>
      window.__zerosTerminalSmoke.messages.some(
        (message) => message.op === "workspace.startRun",
      ),
    )),
  );
  await main.getByRole("button", { name: "Start Test", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__zerosTerminalSmoke.pendingRun()))
    .toBe(true);
  await page.evaluate(() => window.__zerosTerminalSmoke.finishRun());
  await expect(main.locator(".xterm")).toBeVisible();
  const stop = header.getByRole("button", { name: "Stop Test", exact: true });
  await expect(stop).toBeVisible();
  await expectTokenColor(
    tabs
      .getByRole("tab", { name: "Test", exact: true })
      .locator("[data-run-wave]"),
    "--fg1",
  );
  await expectTokenColor(
    sidebar()
      .getByRole("tab", { name: "Test", exact: true })
      .locator("[data-run-wave]"),
    "--fg1",
  );
  await expect(
    tabs
      .getByRole("tab", { name: "Test", exact: true })
      .locator("[data-run-wave]"),
  ).toBeVisible();
  check(
    "running commands keep their activity indicator in the main tab strip",
    true,
  );
  const openTest = header.getByRole("button", { name: "Open Test in Browser" });
  await expect(openTest).toBeDisabled();
  await expect(
    main.getByRole("button", { name: "Stop", exact: true }),
  ).toHaveCount(0);
  await expect(stop).toHaveCSS("border-top-width", "1px");
  await expect(openTest).toHaveCSS("border-top-width", "1px");
  await expect(openTest.getByText("Open", { exact: true })).toBeVisible();
  await expect(stop).toHaveText("Stop");
  await expectTokenColor(openTest, "--bg1", "backgroundColor");
  await expectTokenColor(stop, "--bg1", "backgroundColor");
  const runningTitleBox = await titleChip.boundingBox();
  const globeBox = await openTest.boundingBox();
  const stopBox = await stop.boundingBox();
  check(
    "running header buttons follow the title with Open and Stop labels and bg1 backgrounds",
    globeBox.x - runningTitleBox.x - runningTitleBox.width === 4 &&
      stopBox.x - globeBox.x - globeBox.width === 4 &&
      globeBox.width > 24 &&
      stopBox.width > 24 &&
      globeBox.height === 24 &&
      stopBox.height === 24,
  );
  await page.evaluate(() =>
    window.__zerosTerminalSmoke.output(
      window.__zerosTerminalSmoke.runIdFor("test"),
      "Local: http://localhost:51",
    ),
  );
  await expect(openTest).toBeDisabled();
  await page.evaluate(() =>
    window.__zerosTerminalSmoke.output(
      window.__zerosTerminalSmoke.runIdFor("test"),
      "73/\n",
    ),
  );
  await expect(openTest).toBeEnabled();
  await expect(openTest).toHaveText(/^Open\s*:5173$/);
  await expectTokenColor(openTest.getByText(":5173", { exact: true }), "--fg1");
  await expectTokenColor(openTest.locator("svg"), "--fg1");
  await expectTokenColor(stop.locator("svg"), "--fg1");
  await expectTokenColor(stop, "--fg1");
  await expectCompactRunButtons(main, openTest, stop);
  check(
    "main Run labels show the detected port and become icons when only the terminal column narrows",
    true,
  );
  await openTest.click();
  const browserState = await state();
  const previewTab = browserState.tabs.find(
    (tab) => tab.id === browserState.activeId,
  );
  check(
    "the globe opens the exact running action's local address in a Browser tab",
    previewTab.type === "browser" &&
      previewTab.url === "http://localhost:5173/",
  );
  await tabs.getByRole("tab", { name: "Test", exact: true }).click();
  await sidebar().getByRole("tab", { name: "Test", exact: true }).hover();
  const rowGlobe = sidebar().getByRole("button", {
    name: "Open Test in Browser",
  });
  await expect(rowGlobe).toHaveCSS("border-top-width", "1px");
  await expect(rowGlobe).toHaveText("");
  await expect(rowGlobe).toHaveCSS("width", "24px");
  await expectTokenColor(rowGlobe.locator("svg"), "--fg1");
  await expectTokenColor(rowGlobe, "--bg1", "backgroundColor");
  await expectTokenColor(
    sidebar().getByRole("button", { name: "Stop Test", exact: true }),
    "--bg1",
    "backgroundColor",
  );
  check(
    "hovered sidebar Run controls retain compact icons with bg1 backgrounds",
    true,
  );
  await rowGlobe.click();
  check(
    "the sidebar globe reuses the same Browser destination",
    (await state()).activeId === previewTab.id &&
      (await state()).tabs.filter((tab) => tab.type === "browser").length === 1,
  );
  await tabs.getByRole("tab", { name: "Test", exact: true }).click();
  // The stop/rerun pair uses the real controls. The second start stays pending
  // while the user navigates, exercising delayed attachment separately.
  await main
    .getByRole("button", { name: "Move terminal to bottom panel" })
    .click();
  await tabs.getByRole("tab", { name: second.title, exact: true }).click();
  await expect(
    panel
      .getByRole("tab", { name: "Test", exact: true })
      .locator("[data-run-wave]"),
  ).toBeVisible();
  const panelRunWave = panel
    .getByRole("tab", { name: "Test", exact: true })
    .locator("[data-run-wave]");
  await expect(panelRunWave).toHaveAttribute("data-animated", "true");
  await expectTokenColor(panelRunWave, "--fg1");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(panelRunWave.locator("animateTransform")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(panelRunWave).toHaveAttribute("data-animated", "true");
  await expectTokenColor(
    sidebar()
      .getByRole("tab", { name: "Test", exact: true })
      .locator("[data-run-wave]"),
    "--fg3",
  );
  const panelGlobe = panel.getByRole("button", {
    name: "Open Test in Browser",
  });
  await expect(panelGlobe).toBeEnabled();
  await expect(panelGlobe).toHaveText(/^Open\s*:5173$/);
  const panelStop = panel.getByRole("button", {
    name: "Stop Test",
    exact: true,
  });
  await expect(panelStop).toHaveText("Stop");
  await expectTokenColor(panelGlobe, "--bg1", "backgroundColor");
  await expectTokenColor(panelStop, "--bg1", "backgroundColor");
  const panelGlobeBox = await panelGlobe.boundingBox();
  const panelStopBox = await panelStop.boundingBox();
  const panelUndockBox = await panel
    .getByRole("button", { name: "Move terminal to tab bar" })
    .boundingBox();
  check(
    "the active bottom run exposes labeled Open and Stop buttons at the right end without shortcuts",
    panelGlobeBox.x < panelStopBox.x &&
      panelStopBox.x < panelUndockBox.x &&
      panelGlobeBox.y === panelStopBox.y,
  );
  await expectCompactRunButtons(panel, panelGlobe, panelStop);
  await expect(panel.getByRole("button").first()).toHaveAccessibleName(
    "Collapse panel",
  );
  check(
    "bottom Run labels adapt to panel width while collapse stays before the tabs",
    true,
  );
  await panel.getByRole("button", { name: "Collapse panel" }).click();
  await expect(panelRunWave).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Stop Test", exact: true }),
  ).toHaveCount(0);
  await panel.getByRole("tab", { name: "Setup", exact: true }).click();
  await expectTokenColor(panelRunWave, "--fg2");
  await expect(
    panel.getByRole("button", { name: "Stop Test", exact: true }),
  ).toHaveCount(0);
  await panel.getByRole("tab", { name: "Test", exact: true }).click();
  await expect(panelGlobe).toBeEnabled();
  check(
    "bottom Run controls hide while collapsed or a different panel tab is selected",
    true,
  );
  await panel.getByRole("button", { name: "Move terminal to tab bar" }).click();
  check(
    "running indicators animate in bottom tabs and respect selected and docked colors",
    true,
  );
  const stopTest = sidebar().getByRole("button", {
    name: "Stop Test",
    exact: true,
  });
  await page.mouse.move(0, 0);
  await expect(rowActions("Test")).toHaveCSS("opacity", "0");
  await expect(stopTest).toHaveCSS("pointer-events", "none");
  await sidebar().getByRole("tab", { name: "Test", exact: true }).hover();
  await expect(rowActions("Test")).toHaveCSS("opacity", "1");
  await expect(stopTest.locator("svg.lucide-square")).toBeVisible();
  await expectTokenColor(stopTest.locator("svg"), "--fg1");
  await expect(stopTest).toHaveText("");
  await expect(stopTest).toHaveCSS("border-top-width", "1px");
  await stopTest.click();
  const rerun = main.getByRole("button", { name: "Rerun", exact: true });
  await expect(rerun).toBeVisible();
  check(
    "the completed Run overlay stays above its terminal",
    await rerun.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return button.contains(
        document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        ),
      );
    }),
  );
  check("running action rows expose a static Stop icon only on hover", true);
  await main.getByRole("button", { name: "Rerun", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__zerosTerminalSmoke.pendingRun()))
    .toBe(true);
  await tabs.getByRole("tab", { name: second.title, exact: true }).click();
  await page.evaluate(() => window.__zerosTerminalSmoke.finishRun());
  await expect
    .poll(() => page.evaluate(() => window.__zerosTerminalSmoke.pendingRun()))
    .toBe(false);
  check(
    "a delayed Run response cannot replace newer tab navigation",
    (await state()).activeId === second.id,
  );
  await sidebar().getByRole("tab", { name: "Test", exact: true }).click();

  // Exercise the non-default action, keyboard access, and independent docked
  // controls through the same command/controller paths as the production UI.
  await expect(
    header.getByRole("button", { name: "Open Test in Browser" }),
  ).toBeDisabled();
  check("a rerun does not reuse the previous run's preview address", true);
  await page.evaluate(() => window.__zerosTerminalSmoke.addBuildAction());
  const buildRow = sidebar().getByRole("tab", { name: "Build", exact: true });
  await expect(buildRow).toBeVisible();
  await page.mouse.move(0, 0);
  await buildRow.focus();
  await page.keyboard.press("Tab");
  const runBuild = sidebar().getByRole("button", {
    name: "Run Build",
    exact: true,
  });
  await expect(runBuild).toBeFocused();
  await expect(rowActions("Build")).toHaveCSS("opacity", "1");
  await expect(runBuild).toHaveCSS("pointer-events", "auto");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__zerosTerminalSmoke.pendingRun()))
    .toBe(true);
  const buildState = await state();
  const buildTab = buildState.tabs.find(
    (tab) => tab.id === buildState.activeId,
  );
  check(
    "keyboard activation starts the chosen non-default Run action and opens its own tab",
    buildTab.title === "Build" &&
      (await page.evaluate(
        () =>
          window.__zerosTerminalSmoke.messages
            .filter((m) => m.op === "workspace.startRun")
            .at(-1).params.actionId === "build",
      )),
  );
  await page.evaluate(() => window.__zerosTerminalSmoke.finishRun());
  await expect(
    sidebar().getByRole("button", { name: "Stop Build", exact: true }),
  ).toHaveCount(1);
  await page.evaluate(() => {
    window.__zerosTerminalSmoke.output(
      window.__zerosTerminalSmoke.runIdFor("build"),
      "http://localhost:3001/\n",
    );
    window.__zerosTerminalSmoke.output(
      window.__zerosTerminalSmoke.runIdFor("test"),
      "http://localhost:5173/\n",
    );
  });
  await header.getByRole("button", { name: "Open Build in Browser" }).click();
  const buildPreview = await state();
  check(
    "simultaneous Run actions open their own preview addresses",
    buildPreview.tabs.find((tab) => tab.id === buildPreview.activeId)?.url ===
      "http://localhost:3001/",
  );
  await tabs.getByRole("tab", { name: "Build", exact: true }).click();
  await sidebar().getByRole("tab", { name: "Test", exact: true }).hover();
  await sidebar().getByRole("button", { name: "Open Test in Browser" }).click();
  check(
    "a different action's sidebar globe keeps its own preview destination",
    (await state()).activeId === previewTab.id,
  );
  await tabs.getByRole("tab", { name: "Build", exact: true }).click();
  await sidebar().getByRole("tab", { name: "Test", exact: true }).click();
  await main
    .getByRole("button", { name: "Move terminal to bottom panel" })
    .click();
  await tabs.getByRole("tab", { name: "Build", exact: true }).click();
  await panel.getByRole("button", { name: "Collapse panel" }).click();
  const beforeStop = await state();
  await sidebar().getByRole("tab", { name: "Test", exact: true }).hover();
  await sidebar()
    .getByRole("button", { name: "Stop Test", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__zerosTerminalSmoke.messages
            .filter((m) => m.op === "workspace.stopRun")
            .at(-1).params.sessionId ===
          window.__zerosTerminalSmoke.runIdFor("test"),
      ),
    )
    .toBe(true);
  await expect(
    sidebar().getByRole("button", { name: "Run Test", exact: true }),
  ).toHaveCount(1);
  await expect(
    sidebar().getByRole("button", { name: "Stop Build", exact: true }),
  ).toHaveCount(1);
  await expect(panel).toHaveAttribute("aria-expanded", "false");
  check(
    "stopping a docked action leaves the other run and both selections untouched",
    (await state()).activeId === beforeStop.activeId &&
      (await state()).activeTerminalPanelId ===
        beforeStop.activeTerminalPanelId,
  );
  await sidebar()
    .getByRole("button", { name: "Run Test", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__zerosTerminalSmoke.pendingRun()))
    .toBe(true);
  await expect(panel).toHaveAttribute("aria-expanded", "true");
  check(
    "a docked row's Run button reveals its panel without replacing the main tab",
    (await state()).activeId === buildTab.id,
  );
  await page.evaluate(() => window.__zerosTerminalSmoke.finishRun());
  await expect(
    sidebar().getByRole("button", { name: "Stop Test", exact: true }),
  ).toHaveCount(1);

  const fileTab = (await state()).tabs.find((tab) => tab.type === "files");
  await tabs.getByRole("tab", { name: fileTab.title, exact: true }).click();
  await panel.getByRole("button", { name: "Collapse panel" }).click();
  const startsBeforeShortcut = await page.evaluate(
    () =>
      window.__zerosTerminalSmoke.messages.filter(
        (m) => m.op === "workspace.startRun",
      ).length,
  );
  await page.evaluate(() => window.__zerosTerminalSmoke.runShortcut());
  await expect(panel).toHaveAttribute("aria-expanded", "true");
  check(
    "Cmd+R from Files reveals an already-running default action without restarting it",
    (await state()).activeId === fileTab.id &&
      (await page.evaluate(
        (count) =>
          window.__zerosTerminalSmoke.messages.filter(
            (m) => m.op === "workspace.startRun",
          ).length === count,
        startsBeforeShortcut,
      )),
  );
  await expect(
    panel.getByRole("button", { name: "Run actions", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Run Test:/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "Stop Test", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Rerun", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.__zerosTerminalSmoke.runShortcut());
  await expect
    .poll(() => page.evaluate(() => window.__zerosTerminalSmoke.pendingRun()))
    .toBe(true);
  check(
    "Cmd+R still starts the default action while terminal sidebar controls are out of view",
    await page.evaluate(
      () =>
        window.__zerosTerminalSmoke.messages
          .filter((m) => m.op === "workspace.startRun")
          .at(-1).params.actionId === "test",
    ),
  );
  await page.evaluate(() => window.__zerosTerminalSmoke.finishRun());
  await tabs.getByRole("tab", { name: "Build", exact: true }).click();

  const remembered = await state();
  await page.getByRole("button", { name: "Workspace B", exact: true }).click();
  await expect(panel).not.toBeVisible();
  await tabs.getByRole("tab", { name: "Setup", exact: true }).click();
  await main
    .getByRole("button", { name: "Repository environment settings" })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__zerosTerminalSmoke.navigation()))
    .toEqual({
      page: "repo",
      repoRoot: "/terminal-fixture/b",
      view: "environment",
    });
  await page.evaluate(() => window.__zerosTerminalSmoke.returnToWorkspace());
  check(
    "settings navigation changes repository ownership after a workspace switch",
    true,
  );
  await page.getByRole("button", { name: "Workspace A", exact: true }).click();
  check(
    "workspace A → B → A restores both independent terminal selections",
    (await state()).activeId === remembered.activeId &&
      (await state()).activeTerminalPanelId ===
        remembered.activeTerminalPanelId,
  );
  await page
    .getByRole("button", { name: "Toggle workspace visibility" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__zerosTerminalSmoke.shortcutListeners()),
    )
    .toBe(0);
  check("hidden workspace surfaces release the Run shortcut", true);
  check(
    "hidden terminal surfaces stop status and registry reads",
    await page.evaluate(async () => {
      const reads = () =>
        window.__zerosTerminalSmoke.messages.filter(
          (message) =>
            message.type === "PTY_LIST" ||
            message.op === "workspace.setupInfo" ||
            message.op === "workspace.runInfo" ||
            message.op === "workspace.runLog",
        ).length;
      const before = reads();
      window.__zerosTerminalSmoke.output(
        window.__zerosTerminalSmoke.runIdFor("build"),
        "http://localhost:3002/\n",
      );
      window.__zerosTerminalSmoke.changed();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return reads() === before;
    }),
  );
  await page
    .getByRole("button", { name: "Toggle workspace visibility" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__zerosTerminalSmoke.shortcutListeners()),
    )
    .toBe(1);
  await expect
    .poll(() =>
      header
        .getByRole("button", { name: "Open Build in Browser" })
        .getAttribute("disabled"),
    )
    .toBeNull();
  await header.getByRole("button", { name: "Open Build in Browser" }).hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "http://localhost:3002/",
  );
  await header.getByRole("button", { name: "Open Build in Browser" }).click();
  const refreshedPreview = await state();
  check(
    "returning to a hidden workspace recovers preview output missed while inactive",
    refreshedPreview.tabs.find((tab) => tab.id === refreshedPreview.activeId)
      ?.url === "http://localhost:3002/",
  );
  await tabs.getByRole("tab", { name: "Build", exact: true }).click();
  await page.reload({ waitUntil: "networkidle" });
  check(
    "reload restores tab identity, docking, and both selections",
    (await state()).activeId === remembered.activeId &&
      (await state()).activeTerminalPanelId ===
        remembered.activeTerminalPanelId,
  );
  const closeTarget = (await state()).tabs.find(
    (tab) => tab.terminalId === second.terminalId,
  );
  await tabs
    .getByRole("button", { name: `Close ${closeTarget.title}`, exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.__zerosTerminalSmoke
            .sessions()
            .some((session) => session.id === id),
        second.terminalId,
      ),
    )
    .toBe(false);
  check(
    "closing a shell tab closes only that session",
    await page.evaluate(
      (id) =>
        window.__zerosTerminalSmoke.messages
          .filter((message) => message.type === "PTY_KILL")
          .every((message) => message.sessionId === id),
      second.terminalId,
    ),
  );
  await page.evaluate(() => window.__zerosTerminalSmoke.addMany());
  await expect
    .poll(() => page.locator("[data-terminal-session]").count())
    .toBe(12);
  check(
    "terminal DOM retention is bounded while sessions remain available",
    (await page.evaluate(() => window.__zerosTerminalSmoke.sessions().length)) >
      12,
  );
  await page.setViewportSize({ width: 440, height: 680 });
  check(
    "terminal chrome stays within a narrow workbench",
    await page.evaluate(
      () => document.documentElement.scrollWidth === window.innerWidth,
    ),
  );
  const last = await state();
  const lastTab = last.tabs.find((tab) => tab.id === last.activeId);
  await page.evaluate(
    (id) => window.__zerosTerminalSmoke.exit(id),
    lastTab.terminalId,
  );
  await expect(
    tabs.getByRole("tab", { name: lastTab.title, exact: true }),
  ).toContainText("(exited)");
  check("the main terminal tab preserves the exited-session indicator", true);
  await page.evaluate(() => window.__zerosTerminalSmoke.removeRunActions());
  await expect(
    sidebar().getByRole("tab", { name: "Run", exact: true }),
  ).toBeVisible();
  const remainingRunControls = sidebar().getByRole("button", {
    name: /^(Run|Stop) /,
  });
  await expect(remainingRunControls).toHaveCount(1);
  await expect(remainingRunControls).toHaveAttribute("aria-label", "Run Setup");
  await expect(
    sidebar().getByRole("separator", { name: "Shell terminals" }),
  ).toHaveCount(1);
  const startsWithoutActions = await page.evaluate(
    () =>
      window.__zerosTerminalSmoke.messages.filter(
        (m) => m.op === "workspace.startRun",
      ).length,
  );
  await page.evaluate(() => window.__zerosTerminalSmoke.runShortcut());
  check(
    "removing all run actions keeps shell navigation and makes Cmd+R a no-op",
    (await state()).activeId === lastTab.id &&
      (await page.evaluate(
        (count) =>
          window.__zerosTerminalSmoke.messages.filter(
            (m) => m.op === "workspace.startRun",
          ).length === count,
        startsWithoutActions,
      )),
  );
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole("button", { name: "No workspace", exact: true }).click();
  await page
    .getByRole("button", { name: "New File, Browser, or Terminal tab" })
    .click();
  await page.getByRole("option", { name: "Terminal", exact: true }).click();
  await expect(main.locator(".xterm")).toBeVisible();
  await expect(main).toContainText("/terminal-fixture/ambient");
  const ambientState = await state();
  const ambientTab = ambientState.tabs.find(
    (tab) => tab.id === ambientState.activeId,
  );
  check(
    "a terminal without a selected workspace uses the engine folder in the visible tab scope",
    ambientTab?.type === "terminal",
  );
  await page.evaluate(
    (id) => window.__zerosTerminalSmoke.exit(id),
    ambientTab.terminalId,
  );
  await expect(
    tabs.getByRole("tab", { name: ambientTab.title, exact: true }),
  ).toContainText("(exited)");
  check(
    "plain shell exit indicators work without configured Run actions",
    true,
  );
  await main
    .getByRole("button", { name: "Move terminal to bottom panel" })
    .click();
  await expect(panel.locator(".xterm")).toBeVisible();
  await panel.getByRole("button", { name: "Move terminal to tab bar" }).click();
  check(
    "the terminal keeps its ambient scope through docking and undocking",
    (await state()).activeId === ambientTab.id,
  );
  await tabs
    .getByRole("button", { name: `Close ${ambientTab.title}`, exact: true })
    .click({ force: true });
  check(
    "closing an ambient terminal removes the visible tab",
    !(await state()).tabs.some((tab) => tab.id === ambientTab.id),
  );
  await runSetupSidebarSmoke({ page, check });
  await runNewTabEnvironmentSmoke({ page, check });
  await runTerminalLifecycleSmoke({ page, check });
}
