/** Production conversation/workbench composition, with fixture transport. */
export async function runDesignWorkbenchSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  const previousStorage = await page.evaluate(() =>
    Object.entries(localStorage),
  );
  try {
    await exerciseDesignWorkbench({ page, check });
  } finally {
    // This test deliberately persists camera/panel/tab state across reloads.
    // Restore its caller's storage before the standalone canvas fixtures run;
    // otherwise their starting geometry depends on this wider workbench view.
    await page.evaluate((entries) => {
      localStorage.clear();
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, previousStorage);
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
      { waitUntil: "networkidle" },
    );
  }
}

async function exerciseDesignWorkbench({ page, check }) {
  const origin = new URL(page.url()).origin;
  const url = `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?workbench`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: "networkidle" });
  const designTab = page.getByRole("tab", { name: "Design", exact: true });
  const filesTab = page.getByRole("tab", { name: "Open file", exact: true });
  const canvas = page.locator(
    '[data-design-retained-workspace="ws_design_harness"]',
  );
  await canvas
    .locator("[data-design-canvas-viewport]")
    .waitFor({ state: "visible" });
  check(
    "Design opens next to the existing agent column",
    (await page
      .getByRole("region", { name: "Agent Workspace", exact: true })
      .isVisible()) &&
      (await designTab.getAttribute("aria-selected")) === "true",
  );
  check(
    "Design navigation has no old workspace-mode switch",
    (await page.locator("[data-workspace-mode-toggle]").count()) === 0,
  );
  await canvas
    .locator('iframe[data-design-document-buffer="displayed"]')
    .first()
    .waitFor();
  await page.evaluate(() => {
    window.__retainedDesignFrame = document.querySelector(
      '[data-design-retained-workspace="ws_design_harness"] iframe[data-design-document-buffer="displayed"]',
    );
  });
  await filesTab.click();
  check(
    "a hidden Design tab is inert and retains its frame DOM",
    (await canvas.getAttribute("inert")) !== null &&
      (await page.evaluate(
        () => window.__retainedDesignFrame?.isConnected === true,
      )),
  );
  await designTab.click();
  check(
    "returning to Design reuses its existing frame",
    await page.evaluate(
      () =>
        window.__retainedDesignFrame ===
        document.querySelector(
          '[data-design-retained-workspace="ws_design_harness"] iframe[data-design-document-buffer="displayed"]',
        ),
    ),
  );
  await page.getByRole("button", { name: "Layers", exact: true }).click();
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await filesTab.click();
  await page.reload({ waitUntil: "networkidle" });
  check(
    "reload preserves the chosen Files tab after the one-time Design migration",
    (await filesTab.getAttribute("aria-selected")) === "true",
  );
  await designTab.click();
  await canvas
    .locator("[data-design-canvas-viewport]")
    .waitFor({ state: "visible" });
  check(
    "Design panel choices survive reload",
    (await page
      .getByRole("button", { name: "Layers", exact: true })
      .getAttribute("aria-pressed")) === "false" &&
      (await page
        .getByRole("button", { name: "Inspector", exact: true })
        .getAttribute("aria-pressed")) === "false",
  );
  await page.setViewportSize({ width: 900, height: 700 });
  check(
    "the narrow combined workspace has no document overflow",
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  check(
    "tab navigation never calls workspace.setMode",
    await page.evaluate(
      () =>
        !window.__zerosHarnessWorkbenchOperations.includes("workspace.setMode"),
    ),
  );
  for (const suffix of ["second", "third"]) {
    await page.evaluate(async (value) => {
      const { useWorkspaceStore } =
        await import("/apps/desktop/src/renderer/state/store.tsx");
      useWorkspaceStore.setState({
        activeChatId: null,
        newAgentFolder: `/Users/demo/zeros/design workspaces/north-one/launch-system-${value}`,
      });
    }, suffix);
    await page
      .locator(
        `[data-design-retained-workspace="ws_design_harness_${suffix}"] [data-design-canvas-viewport]`,
      )
      .waitFor({ state: "visible" });
  }
  check(
    "the Design canvas deck retains at most two workspace owners",
    (await page.locator("[data-design-retained-workspace]").count()) === 2,
  );
  check(
    "inactive retained owners stay inert",
    (await page
      .locator(
        '[data-design-retained-workspace][aria-hidden="true"]:not([inert])',
      )
      .count()) === 0,
  );
  await page.goto(`${url}&conflicts`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Design", exact: true }).click();
  await page
    .locator("[data-design-conflict-pause]")
    .waitFor({ state: "visible" });
  check(
    "a Git conflict pauses the live canvas and offers retry/cancel",
    (await page.locator("[data-design-canvas-viewport]").count()) === 0 &&
      (await page.getByRole("button", { name: "Retry Design" }).isVisible()) &&
      (await page.getByRole("button", { name: "Cancel merge…" }).isVisible()),
  );
}
