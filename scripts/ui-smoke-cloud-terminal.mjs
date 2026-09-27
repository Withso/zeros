import { expect } from "@playwright/test";

export async function runCloudTerminalSmoke({ page, check, harnessBase }) {
  await page.goto(`${harnessBase}/harness-terminal-workbench.html?cloud`);
  const fixtures = () =>
    page.evaluate(() => {
      const api = window.__zerosTerminalSmoke;
      return {
        folders: api.folders,
        sessions: api.sessions(),
        messages: api.messages,
      };
    });
  // Existing remote shells must be discovered before the panel seeds a shell.
  await expect
    .poll(async () => {
      const { folders, sessions } = await fixtures();
      return sessions.filter((s) => s.folder === folders.a).map((s) => s.id);
    })
    .toEqual([
      "cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:existing-shell",
    ]);

  await page
    .getByRole("button", { name: "New File, Browser, or Terminal tab" })
    .click();
  await page.getByRole("option", { name: "Terminal", exact: true }).click();
  const main = page.locator("[data-terminal-workbench]");
  const tabs = page.getByRole("tablist", { name: "Workspace panels" });
  const selected = tabs.getByRole("tab", { selected: true });
  await expect(
    selected.getByLabel("Cloud terminal", { exact: true }),
  ).toBeVisible();
  await expect(main.locator(".xterm-helper-textarea")).toBeVisible();
  const currentId = await page.evaluate(() => {
    const state = window.__zerosTerminalSmoke.state();
    return state.tabs.find((tab) => tab.id === state.activeId).terminalId;
  });
  await main.locator(".xterm-helper-textarea").pressSequentially("pwd");
  await main.locator(".xterm-helper-textarea").press("Enter");
  expect(
    (await fixtures()).messages
      .filter((m) => m.type === "PTY_WRITE")
      .every((m) => m.sessionId === currentId),
  ).toBe(true);
  await page.evaluate((sessionId) => {
    const api = window.__zerosTerminalSmoke;
    api.setConnectionStatus(api.folders.a, "disconnected");
    api.output(sessionId, "OUTPUT WHILE DISCONNECTED\r\n");
    api.setConnectionStatus(api.folders.a, "connected");
  }, currentId);
  await expect(main.locator(".xterm-rows")).toContainText(
    "OUTPUT WHILE DISCONNECTED",
  );
  await expect
    .poll(
      async () =>
        (await fixtures()).messages.filter(
          (m) => m.type === "PTY_CREATE" && m.sessionId === currentId,
        ).length,
    )
    .toBe(2);
  await page.evaluate(() => {
    const api = window.__zerosTerminalSmoke;
    api.delayNextAttach();
    api.setConnectionStatus(api.folders.a, "disconnected");
    api.setConnectionStatus(api.folders.a, "connected");
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.__zerosTerminalSmoke.attachPending()),
    )
    .toBe(true);
  await page.evaluate((sessionId) => {
    const api = window.__zerosTerminalSmoke;
    api.setConnectionStatus(api.folders.a, "disconnected");
    api.output(sessionId, "OUTPUT AFTER SECOND RECONNECT\r\n");
    api.setConnectionStatus(api.folders.a, "connected");
    api.failAttach();
  }, currentId);
  await expect(main.locator(".xterm-rows")).toContainText(
    "OUTPUT AFTER SECOND RECONNECT",
  );
  const writesBefore = (await fixtures()).messages.filter(
    (m) => m.type === "PTY_WRITE",
  ).length;
  await expect(main.locator(".xterm-rows")).not.toContainText(
    "No host connection",
  );
  await page
    .getByRole("button", { name: "Move terminal to bottom panel", exact: true })
    .click();
  const panel = page.locator("[data-terminal-panel]");
  await expect(
    panel
      .getByRole("tab", { selected: true })
      .getByLabel("Cloud terminal", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("tablist", { name: "Terminal sessions" })
    .getByRole("tab", { name: "Terminal 1", exact: true })
    .click();
  await expect(main.locator(".xterm-helper-textarea")).toBeVisible();
  await page.screenshot({
    path: ".context/cloud-terminal-ui.png",
    animations: "disabled",
  });
  const createsBeforeSwitch = (await fixtures()).messages.filter(
    (m) => m.type === "PTY_CREATE",
  ).length;

  await page.getByRole("button", { name: "Workspace B", exact: true }).click();
  await expect
    .poll(async () => {
      const { folders, sessions } = await fixtures();
      return sessions.some(
        (s) => s.folder === folders.b && s.id.endsWith(":existing-shell"),
      );
    })
    .toBe(true);
  await page.getByRole("button", { name: "Workspace A", exact: true }).click();
  await expect(
    panel
      .getByRole("tab", { selected: true })
      .getByLabel("Cloud terminal", { exact: true }),
  ).toBeVisible();
  expect(
    (await fixtures()).messages.filter((m) => m.type === "PTY_WRITE"),
  ).toHaveLength(writesBefore);
  expect(
    (await fixtures()).messages.filter((m) => m.type === "PTY_CREATE"),
  ).toHaveLength(createsBeforeSwitch);

  await page.getByRole("button", { name: "Workspace B", exact: true }).click();
  await page.evaluate((sessionId) => {
    const api = window.__zerosTerminalSmoke;
    api.setConnectionStatus(api.folders.a, "disconnected");
    api.output(sessionId, "RECOVERED AFTER HIDDEN RECONNECT\r\n");
    api.setConnectionStatus(api.folders.a, "connected");
  }, currentId);
  expect(
    (await fixtures()).messages.filter((m) => m.type === "PTY_CREATE"),
  ).toHaveLength(createsBeforeSwitch);
  await page.getByRole("button", { name: "Workspace A", exact: true }).click();
  await expect(panel.locator(".xterm-rows")).toContainText(
    "RECOVERED AFTER HIDDEN RECONNECT",
  );

  const sidebar = page.getByRole("tablist", { name: "Terminal sessions" });
  await sidebar.getByRole("tab", { name: "Test", exact: true }).click();
  await main.getByRole("button", { name: "Start Test", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__zerosTerminalSmoke.pendingRun()))
    .toBe(true);
  await page.evaluate(() => window.__zerosTerminalSmoke.finishRun());
  await expect(main.locator(".xterm-helper-textarea")).toBeVisible();
  await expect(
    selected.getByLabel("Cloud terminal", { exact: true }),
  ).toBeVisible();
  await expect(selected.locator("[data-run-wave]")).toBeVisible();
  const run = await page.evaluate(() => {
    const api = window.__zerosTerminalSmoke;
    return { id: api.runIdFor("test"), folder: api.folders.a };
  });
  await expect
    .poll(
      async () =>
        (await fixtures()).messages.filter(
          (m) => m.type === "PTY_CREATE" && m.sessionId === run.id,
        ).length,
    )
    .toBe(1);
  await main
    .locator("[data-terminal-header]")
    .getByRole("button", { name: "Stop Test", exact: true })
    .click();
  expect(
    (await fixtures()).messages.find((m) => m.op === "workspace.stopRun")
      .params,
  ).toMatchObject({ sessionId: run.id, workspaceId: run.folder });
  await page
    .getByRole("button", { name: "Local workspace", exact: true })
    .click();
  await expect(page.getByLabel("Cloud terminal", { exact: true })).toHaveCount(
    0,
  );
  check(
    "Cloud terminals discover the correct registry, restore output on reconnect, attach Run sessions, and keep their indicator when docked",
    true,
  );
}
