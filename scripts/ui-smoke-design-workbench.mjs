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
  await exerciseInactiveDesignTools({
    page,
    check,
    canvas,
    designTab,
    filesTab,
  });
  await exerciseSharedLayersHeight({ page, check, canvas });
  await canvas.locator("[data-design-layers-fold]").click();
  await canvas
    .getByRole("button", { name: "Toggle Layers and Inspector" })
    .click();
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
    (await canvas
      .locator("[data-design-layers-fold]")
      .getAttribute("aria-expanded")) === "false" &&
      (await canvas
        .getByRole("button", { name: "Toggle Layers and Inspector" })
        .getAttribute("aria-pressed")) === "false" &&
      (await canvas
        .locator("[data-design-floating-panel]")
        .getAttribute("inert")) !== null,
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
    await switchWorkspace(page, `-${suffix}`);
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

async function switchWorkspace(page, suffix) {
  // Unlike evaluate, this wait re-enters after navigation destroys its context.
  // Keep selection idempotent; the active canvas below signals completion.
  await page.waitForFunction(async (value) => {
    const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/store.tsx");
    const newAgentFolder = `/Users/demo/zeros/design workspaces/north-one/launch-system${value}`;
    const current = useWorkspaceStore.getState();
    if (current.activeChatId !== null || current.newAgentFolder !== newAgentFolder) {
      useWorkspaceStore.setState({ activeChatId: null, newAgentFolder });
    }
    return true;
  }, suffix);
  const workspaceId = `ws_design_harness${suffix.replace("-", "_")}`;
  await page
    .locator(`[data-design-retained-workspace="${workspaceId}"]:not([inert]) [data-design-canvas-viewport]`)
    .waitFor({ state: "visible" });
}

/** Both owners remain mounted while an app-wide preference changes. */
async function exerciseSharedLayersHeight({ page, check, canvas }) {
  const second = page.locator('[data-design-retained-workspace="ws_design_harness_second"]');
  const split = (owner) => owner.getByRole("separator", { name: "Resize Layers panel" });
  const height = async (owner) => Math.round((await owner.locator("[data-design-layers-slot]").boundingBox()).height);
  await split(canvas).dblclick();
  await switchWorkspace(page, "-second");
  await page.evaluate(() => {
    window.__retainedSecondLayers = document.querySelector('[data-design-retained-workspace="ws_design_harness_second"] [data-design-layers-slot]');
  });
  await switchWorkspace(page, "");
  await split(canvas).press("Shift+ArrowDown");
  const committed = await height(canvas);
  await switchWorkspace(page, "-second");
  check(
    "a retained workspace adopts the app-wide Layers height before it is shown",
    committed === 272 && (await height(second)) === committed &&
      await page.evaluate(() => window.__retainedSecondLayers === document.querySelector('[data-design-retained-workspace="ws_design_harness_second"] [data-design-layers-slot]')),
  );
  await split(second).press("Shift+ArrowDown");
  await switchWorkspace(page, "");
  check(
    "resizing the second workspace also updates the first retained Layers panel",
    (await height(canvas)) === committed + 32 &&
      Number(await split(canvas).getAttribute("aria-valuenow")) === committed + 32,
    JSON.stringify({ committed, height: await height(canvas), aria: await split(canvas).getAttribute("aria-valuenow") }),
  );
  await page.evaluate(() => {
    const key = "zeros.design.layers.height";
    localStorage.setItem(key, "336");
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "336" }));
  });
  await switchWorkspace(page, "-second");
  check(
    "a height preference from another window reaches retained panels and separator values",
    (await height(second)) === 336 &&
      Number(await split(second).getAttribute("aria-valuenow")) === 336,
  );
  await switchWorkspace(page, "");
  await split(canvas).dblclick();
}

/** A Design tab that goes inactive must not leave its tool window floating
 * over the next tab or keep Motion playing; both return with the tab. */
async function exerciseInactiveDesignTools({
  page,
  check,
  canvas,
  designTab,
  filesTab,
}) {
  const settle = (locator, state) =>
    locator.waitFor({ state, timeout: 5_000 }).then(
      () => true,
      () => false,
    );
  const themeWindow = page.locator("[data-design-theme-editor]");
  const themeTrigger = canvas.getByRole("button", {
    name: "Open theme editor",
  });
  await themeTrigger.click();
  await themeWindow.waitFor({ state: "visible" });
  const themePosition = await themeWindow.boundingBox();
  await filesTab.click();
  check(
    "an inactive Design tab hides and inerts its floating Theme window",
    (await settle(themeWindow, "hidden")) &&
      (await themeWindow.evaluate((element) => element.inert)),
  );
  await designTab.click();
  const returnedPosition = (await settle(themeWindow, "visible"))
    ? await themeWindow.boundingBox()
    : null;
  check(
    "returning to Design shows the same Theme window in place",
    !!returnedPosition &&
      Math.abs(returnedPosition.x - themePosition.x) < 1 &&
      Math.abs(returnedPosition.y - themePosition.y) < 1 &&
      !(await themeWindow.evaluate((element) => element.inert)),
  );
  await themeWindow.getByRole("button", { name: "Close theme editor" }).click();
  await settle(themeWindow, "detached");

  // The timeline hides its duration field below a 720px container, so play
  // a long preview in a wide window.
  await page.setViewportSize({ width: 2400, height: 900 });
  await canvas.locator("[data-design-canvas-viewport]").focus();
  await page.keyboard.press("Shift+A");
  const timeline = canvas.locator("[data-design-motion-timeline]");
  await timeline.waitFor({ state: "visible" });
  await canvas.getByRole("button", { name: /^Animate opacity$/i }).click();
  const duration = timeline.getByLabel("Animation duration");
  await duration.fill("5000");
  await duration.press("Enter");
  const play = timeline.getByRole("button", { name: /motion preview$/ });
  await play.click();
  const playing =
    (await play.getAttribute("aria-label")) === "Pause motion preview";
  await filesTab.click();
  await page.waitForTimeout(300);
  await designTab.click();
  check(
    "switching away from Design stops Motion playback and keeps its draft",
    playing &&
      (await play.getAttribute("aria-label")) === "Play motion preview" &&
      (await timeline
        .getByRole("button", { name: /opacity keyframe at/ })
        .count()) > 0,
  );
  await timeline.getByRole("button", { name: "Close motion timeline" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
}
