import { expect } from "@playwright/test";

async function resetHarness(page) {
  const base = new URL(page.url()).origin;
  await page.goto(
    `${base}/apps/desktop/src/renderer/harnesses/harness-terminal-workbench.html`,
  );
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: "networkidle" });
}

async function settleLayout(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

export async function runRestoredTerminalScopeSmoke({ page, check }) {
  await resetHarness(page);
  await page
    .getByRole("button", { name: "New File, Browser, or Terminal tab" })
    .click();
  await page.getByRole("option", { name: "Terminal", exact: true }).click();
  const main = page.locator("[data-terminal-workbench]");
  await expect(main).toContainText("Ready /terminal-fixture/a");
  const before = await page.evaluate(() => window.__zerosTerminalSmoke.state());
  const shell = before.tabs.find((tab) => tab.id === before.activeId);
  const originalNode = await main.locator(".xterm").elementHandle();
  const listsBefore = await page.evaluate(() => {
    const fixture = window.__zerosTerminalSmoke;
    const count = fixture.messages.filter((m) => m.type === "PTY_LIST").length;
    fixture.restoreLastFolder();
    fixture.changed();
    return count;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__zerosTerminalSmoke.messages.filter(
            (m) => m.type === "PTY_LIST",
          ).length,
      ),
    )
    .toBeGreaterThan(listsBefore);
  await settleLayout(page);
  const restored = await page.evaluate(() =>
    window.__zerosTerminalSmoke.state(),
  );
  expect(restored.tabs.find((tab) => tab.id === shell.id)).toEqual(shell);
  expect(restored.activeId).toBe(shell.id);
  await expect(main).toContainText("Ready /terminal-fixture/a");
  await page.getByRole("button", { name: "Workspace A", exact: true }).click();
  expect(
    await main
      .locator(".xterm")
      .evaluate((node, original) => node === original, originalNode),
  ).toBe(true);
  check(
    "restoring only the last workspace folder preserves its terminal tab and grid",
    true,
  );
}

export async function runHiddenTerminalAttachmentSmoke({ page, check }) {
  await resetHarness(page);
  const tabs = page.getByRole("tablist", { name: "Workspace panels" });
  await tabs.getByRole("tab", { name: "Setup", exact: true }).click();
  const id = "lifecycle-live-shell";
  await page.evaluate(
    (id) => window.__zerosTerminalSmoke.adoptTerminal(id),
    id,
  );
  const terminal = page.locator(`[data-terminal-session="${id}"]`);
  await expect(terminal.locator(".xterm")).toHaveCount(1);
  await expect(terminal).toBeHidden();
  const originalNode = await terminal.locator(".xterm").elementHandle();
  const requests = () =>
    page.evaluate(
      (id) =>
        window.__zerosTerminalSmoke.messages.filter(
          (m) =>
            m.sessionId === id &&
            (m.type === "PTY_CREATE" || m.type === "PTY_RESIZE"),
        ),
      id,
    );
  await page.evaluate(
    (id) =>
      window.__zerosTerminalSmoke.output(id, "Parked output preserved\r\n"),
    id,
  );
  // Exceed TerminalSessionView's 1.5s fallback: neither a zero-size fit nor
  // the fallback timer may attach and shrink this existing background PTY.
  await page.waitForTimeout(1700);
  expect(await requests()).toEqual([]);
  const title = await page.evaluate(
    (id) =>
      window.__zerosTerminalSmoke.sessions().find((s) => s.id === id).title,
    id,
  );
  await page
    .getByRole("tablist", { name: "Terminal sessions" })
    .getByRole("tab", { name: title, exact: true })
    .click();
  await expect(terminal).toContainText("Ready /terminal-fixture/a");
  expect(
    (await terminal.locator(".xterm-rows").textContent()).match(
      /Parked output preserved/g,
    ),
  ).toHaveLength(1);
  const creates = (await requests()).filter((m) => m.type === "PTY_CREATE");
  expect(creates).toHaveLength(1);
  expect(creates[0].cols).toBeGreaterThan(40);
  expect(creates[0].rows).toBeGreaterThan(10);
  expect(
    await terminal
      .locator(".xterm")
      .evaluate((node, original) => node === original, originalNode),
  ).toBe(true);
  await tabs.getByRole("tab", { name: "Setup", exact: true }).click();
  await expect(terminal).toBeHidden();
  const requestsBeforeResize = await requests();
  const viewport = page.viewportSize();
  await page.setViewportSize({
    width: viewport.width - 100,
    height: viewport.height - 100,
  });
  await page.waitForTimeout(200);
  expect(await requests()).toEqual(requestsBeforeResize);
  await page.setViewportSize(viewport);
  check(
    "parked terminals attach once at visible dimensions and ignore hidden resizes",
    true,
  );
}

export async function runRunTerminalTitleSmoke({ page, check }) {
  await resetHarness(page);
  const tabs = page.getByRole("tablist", { name: "Workspace panels" });
  await tabs.getByRole("tab", { name: "Setup", exact: true }).click();
  const sidebar = page.getByRole("tablist", { name: "Terminal sessions" });
  await sidebar.getByRole("tab", { name: "Test", exact: true }).hover();
  await sidebar.getByRole("button", { name: "Run Test", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__zerosTerminalSmoke.pendingRun()))
    .toBe(true);
  await page.evaluate(() => window.__zerosTerminalSmoke.finishRun("test"));
  const main = page.locator("[data-terminal-workbench]");
  await expect(main.locator("[data-terminal-session]")).toContainText(
    "Ready /terminal-fixture/a",
  );
  await page.evaluate(() =>
    window.__zerosTerminalSmoke.setRunName("Integration Test"),
  );
  await expect(
    tabs.getByRole("tab", { name: "Integration Test", exact: true }),
  ).toBeVisible();
  await tabs.getByRole("tab", { name: "Setup", exact: true }).click();
  await sidebar
    .getByRole("tab", { name: "Integration Test", exact: true })
    .click();
  await expect(
    tabs.getByRole("tab", { name: "Integration Test", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await main
    .getByRole("button", { name: "Move terminal to bottom panel" })
    .click();
  const panel = page.locator("[data-terminal-panel]");
  await panel
    .getByRole("tab", { name: "Integration Test", exact: true })
    .click();
  await expect(
    panel.getByRole("tab", { name: "Integration Test", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  check(
    "sidebar and panel selection preserve the configured Run action name",
    true,
  );
}

export async function runTerminalLifecycleSmoke(context) {
  await runRestoredTerminalScopeSmoke(context);
  await runHiddenTerminalAttachmentSmoke(context);
  await runRunTerminalTitleSmoke(context);
}
