import { expect } from "@playwright/test";

export async function runSetupSidebarSmoke({ page, check }) {
  const base = new URL(page.url()).origin;
  await page.goto(
    `${base}/apps/desktop/src/renderer/harnesses/harness-terminal-workbench.html`,
  );
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "New File, Browser, or Terminal tab" })
    .click();
  await page.getByRole("option", { name: "Terminal", exact: true }).click();
  const sidebar = page.getByRole("tablist", { name: "Terminal sessions" });
  const setup = sidebar.getByRole("tab", { name: "Setup", exact: true });
  const actions = setup.locator("..").locator("[data-terminal-row-actions]");
  const run = actions.getByRole("button", { name: "Run Setup", exact: true });
  const main = page.locator("[data-terminal-workbench]");
  const panel = page.locator("[data-terminal-panel]");
  const state = () => page.evaluate(() => window.__zerosTerminalSmoke.state());
  const initialState = await state();
  const shell = initialState.tabs.find((tab) => tab.id === initialState.activeId);
  const requests = () =>
    page.evaluate(() =>
      window.__zerosTerminalSmoke.messages.filter(
        (message) => message.op === "workspace.rerunSetup",
      ),
    );
  const finish = (id) =>
    page.evaluate(
      (id) => window.__zerosTerminalSmoke.finishSetupRequest(id),
      id,
    );
  const complete = (id) =>
    page.evaluate((id) => window.__zerosTerminalSmoke.completeSetup(id), id);
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  const initialBox = await setup.boundingBox();
  await setup.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await expect(run).toBeVisible();
  await expect(run).toBeEnabled();
  expect((await setup.boundingBox()).height).toBe(initialBox.height);
  expect(
    await run.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--blue-fg)";
      document.body.appendChild(probe);
      const matches =
        getComputedStyle(element).color === getComputedStyle(probe).color;
      probe.remove();
      return matches;
    }),
  ).toBe(true);
  await run.click();
  await expect.poll(async () => (await requests()).length).toBe(1);
  const a = (await requests())[0].params;
  expect(a.repoRoot).toBe("/terminal-fixture/a");
  await expect(run).toBeDisabled();
  await expect(main).toContainText("Setup output preserved");
  await main.locator(".xterm").evaluate((node) => {
    window.__setupOriginalNode = node;
  });
  const setupState = await state();
  expect(
    setupState.tabs.find((tab) => tab.id === setupState.activeId).terminalId,
  ).toBe("setup");
  await run.dispatchEvent("click");
  await main
    .getByRole("button", { name: /Rerun setup$/ })
    .dispatchEvent("click");
  expect(await requests()).toHaveLength(1);
  await finish(a.workspaceId);
  await expect(main).toContainText("Fresh setup run 1: dependencies ready");
  await expect(main).not.toContainText("Setup output preserved");
  await expect(run).toBeDisabled();
  expect(
    await main
      .locator(".xterm")
      .evaluate((node) => node === window.__setupOriginalNode),
  ).toBe(true);
  check(
    "Setup reveals a Run button on hover and invokes the setup runner",
    true,
  );
  check(
    "setup reruns reset the existing output and suppress duplicate pending or running starts",
    true,
  );

  await complete(a.workspaceId);
  await expect(run).toBeEnabled();
  await page.mouse.move(0, 0);
  await setup.focus();
  await page.keyboard.press("Tab");
  await expect(run).toBeFocused();
  await expect(actions).toHaveCSS("opacity", "1");
  check(
    "Setup's hover action is also reachable with visible keyboard focus",
    true,
  );

  await main
    .getByRole("button", { name: "Move terminal to bottom panel" })
    .click();
  await page
    .getByRole("tablist", { name: "Workspace panels" })
    .getByRole("tab", { name: shell.title, exact: true })
    .click();
  await panel.getByRole("button", { name: "Collapse panel" }).click();
  const beforeDockedRun = await state();
  await setup.hover();
  await run.click();
  await expect.poll(async () => (await requests()).length).toBe(2);
  const afterDockedRun = await state();
  expect(afterDockedRun.activeId).toBe(beforeDockedRun.activeId);
  expect(afterDockedRun.activeTerminalPanelId).toBe(
    beforeDockedRun.activeTerminalPanelId,
  );
  expect(
    afterDockedRun.tabs.filter((tab) => tab.terminalId === "setup"),
  ).toHaveLength(1);
  await expect(panel).toHaveAttribute("aria-expanded", "true");
  await finish(a.workspaceId);
  await expect(panel).toContainText("Fresh setup run 2: dependencies ready");
  await expect(panel).not.toContainText("Fresh setup run 1");
  await panel.getByRole("button", { name: "Stop setup", exact: true }).click();
  await expect(run).toBeEnabled();
  check(
    "Run Setup reveals a collapsed docked view, resets its log, and preserves the existing Stop action",
    true,
  );

  await setup.hover();
  await run.click();
  await expect.poll(async () => (await requests()).length).toBe(3);
  await page.getByRole("button", { name: "Workspace B", exact: true }).click();
  await page
    .getByRole("button", { name: "New File, Browser, or Terminal tab" })
    .click();
  await page.getByRole("option", { name: "Terminal", exact: true }).click();
  await setup.hover();
  await expect(run).toBeEnabled();
  await run.click();
  await expect.poll(async () => (await requests()).length).toBe(4);
  const b = (await requests())[3].params;
  expect(b.repoRoot).toBe("/terminal-fixture/b");
  expect(b.workspaceId).not.toBe(a.workspaceId);
  const bSelection = (await state()).activeId;
  await finish(a.workspaceId);
  await expect(run).toBeDisabled();
  expect((await state()).activeId).toBe(bSelection);
  await expect(main).not.toContainText("Fresh setup run 3");
  await finish(b.workspaceId);
  await expect(main).toContainText("Fresh setup run 1: dependencies ready");
  await complete(b.workspaceId);
  await expect(run).toBeEnabled();
  await page.getByRole("button", { name: "Workspace A", exact: true }).click();
  await expect(run).toBeDisabled();
  await expect(panel).toContainText("Fresh setup run 3: dependencies ready");
  await complete(a.workspaceId);
  await expect(run).toBeEnabled();
  check(
    "pending Setup requests and their output stay with their workspace through A to B to A navigation",
    true,
  );

  await setup.hover();
  await run.click();
  await expect.poll(async () => (await requests()).length).toBe(5);
  await page.evaluate(
    (id) => window.__zerosTerminalSmoke.failSetupRequest(id),
    a.workspaceId,
  );
  await expect(run).toBeEnabled();
  await expect(panel).toContainText("Fresh setup run 3");
  await page.evaluate(() => window.__zerosTerminalSmoke.setSetupCommand(false));
  await run.click();
  await expect.poll(async () => (await requests()).length).toBe(6);
  await finish(a.workspaceId);
  await expect(run).toBeEnabled();
  await expect(panel).toContainText("Fresh setup run 3");
  await page.evaluate(() => window.__zerosTerminalSmoke.setSetupCommand(true));
  await run.click();
  await expect.poll(async () => (await requests()).length).toBe(7);
  await finish(a.workspaceId);
  await expect(panel).toContainText("Fresh setup run 4: dependencies ready");
  await complete(a.workspaceId);
  await expect(run).toBeEnabled();
  check(
    "failed and unconfigured Setup requests release the busy guard and preserve output for a successful retry",
    true,
  );

  await panel.getByRole("button", { name: "Rerun setup", exact: true }).click();
  await expect.poll(async () => (await requests()).length).toBe(8);
  await expect(run).toBeDisabled();
  await finish(a.workspaceId);
  await expect(panel).toContainText("Fresh setup run 5: dependencies ready");
  await complete(a.workspaceId);
  await expect(run).toBeEnabled();
  check("Setup's output and sidebar buttons share the same pending state", true);

  await page.getByRole("button", { name: "No workspace", exact: true }).click();
  await page
    .getByRole("button", { name: "New File, Browser, or Terminal tab" })
    .click();
  await page.getByRole("option", { name: "Terminal", exact: true }).click();
  await setup.hover();
  await expect(run).toBeDisabled();
  expect(await requests()).toHaveLength(8);
  check("Setup Run remains disabled without a runnable workspace", true);
}
