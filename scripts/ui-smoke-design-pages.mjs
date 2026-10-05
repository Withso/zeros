import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { designCanvasPoint } from "./ui-smoke-design-helpers.mjs";

export async function runDesignPagesSmoke({ page, check }) {
  const storage = await page.evaluate(() => Object.entries(localStorage));
  await page.evaluate(() => localStorage.clear());
  try {
    await exercisePages({ page, check });
    await exercisePageLayersNavigation({ page, check });
  } finally {
    await page.evaluate((entries) => {
      localStorage.clear();
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, storage);
  }
}

async function exercisePageLayersNavigation({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?denseLayers=1`,
    { waitUntil: "networkidle" },
  );
  const panel = page.locator("[data-design-sidebar-panel]");
  const tree = panel.getByRole("tree");
  await expect
    .poll(() =>
      tree.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThan(10_000 * 28);
  const rows = tree.locator("[data-design-panel-row]");
  await rows.first().focus();
  await page.keyboard.press("End");
  await expect
    .poll(() =>
      rows.last().evaluate((element) => document.activeElement === element),
    )
    .toBe(true);
  await expect
    .poll(() =>
      panel
        .locator("[data-radix-scroll-area-viewport]")
        .evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(0);
  expect(await rows.count()).toBeLessThan(100);
  await page.keyboard.press("Home");
  await expect(rows.first()).toBeFocused();
  check(
    "Page-aware Layers virtualization preserves End and Home keyboard focus",
    true,
  );
}

async function exercisePages({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?pages=1`,
    { waitUntil: "networkidle" },
  );
  await mkdir(".context/m4-screens", { recursive: true });
  const picker = () => page.getByRole("button", { name: /^Page: / });
  const viewport = page.locator("[data-design-canvas-viewport]");
  const view = () =>
    page.evaluate(async () => {
      const { designWorkspaceView } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
      const {
        activePageId,
        zoom,
        panX,
        panY,
        canvasBackground,
        selectedFrame,
        selectedNodeId,
        frameSelected,
      } = designWorkspaceView("ws_design_pages_harness");
      return {
        activePageId,
        zoom,
        panX,
        panY,
        canvasBackground,
        selectedFrame,
        selectedNodeId,
        frameSelected,
      };
    });
  const switchTo = async (title) => {
    await picker().click();
    await page
      .getByRole("menuitemcheckbox", { name: title, exact: true })
      .click();
    await expect(picker()).toHaveAccessibleName("Page: " + title);
  };
  const setBackground = async (hex) => {
    const field = page.getByRole("textbox", {
      name: "Canvas background",
      exact: true,
    });
    await field.fill(hex);
    await field.press("Enter");
    await expect(field).toHaveValue(hex);
  };
  const pan = async (x, y) => {
    const before = await view();
    const point = await designCanvasPoint(page, { empty: true });
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(x, y);
    await expect.poll(async () => (await view()).panX).toBe(before.panX - x);
    await expect.poll(async () => (await view()).panY).toBe(before.panY - y);
  };
  const createFrame = async () => {
    await page.getByRole("button", { name: "Frame tool", exact: true }).click();
    const point = await designCanvasPoint(page, { empty: true });
    await page.mouse.click(point.x, point.y);
  };
  const deselect = async () => {
    await viewport.focus();
    await page.keyboard.press("Escape");
    await expect(picker()).toBeVisible();
  };
  await expect(picker()).toHaveAccessibleName("Page: Page 1");
  await expect(
    page.locator(
      '[data-design-frame="page-1/home.html"] iframe[data-design-document-ready]',
    ),
  ).toBeVisible();
  await page.screenshot({ path: ".context/m4-screens/1-picker-closed.png" });
  await picker().focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Page 1", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker()).toBeFocused();
  await setBackground("345678");
  await pan(100, 60);
  const alpha = await view();
  await picker().click();
  await page.getByRole("menuitem", { name: "New page", exact: true }).click();
  await expect(picker()).toHaveAccessibleName("Page: Page 2");
  await expect(page.locator("[data-design-frame]")).toHaveCount(0);
  await createFrame();
  await expect(
    page.locator('[data-design-frame="page-2/frame-1.html"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-design-frame-row="page-1/home.html"]'),
  ).toHaveCount(0);
  await deselect();
  await setBackground("654321");
  await pan(-80, -40);
  const beta = await view();
  await picker().click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(2);
  await expect(page.getByRole("menu")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: ".context/m4-screens/2-picker-menu.png" });
  await page
    .getByRole("menuitemcheckbox", { name: "Page 1", exact: true })
    .click();
  await expect(
    page.locator('[data-design-frame="page-1/home.html"]'),
  ).toBeVisible();
  await expect.poll(view).toEqual(alpha);
  await expect(
    page.locator('[data-design-frame="page-2/frame-1.html"]'),
  ).toHaveCount(0);
  await switchTo("Page 2");
  await expect.poll(view).toEqual(beta);
  check(
    "Design pages restore distinct cameras, backgrounds and frame ownership across A → B → A",
    true,
  );

  // A delayed frame write remains on its submitted page; its reply cannot
  // select or pan the page the user switched to.
  await page.evaluate(() => {
    window.__zerosHarnessPages.holdCreate = true;
  });
  await createFrame();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__zerosHarnessPages.calls.filter(
            (call) => call.op === "design.frame.create",
          ).length,
      ),
    )
    .toBe(2);
  await switchTo("Page 1");
  const beforeReply = await view();
  await page.evaluate(() => window.__zerosHarnessPages.releaseCreate());
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { designWorkspaceSnapshotCache } =
          await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
        return designWorkspaceSnapshotCache.peekSnapshot(
          "ws_design_pages_harness",
        ).data.frames.length;
      }),
    )
    .toBe(3);
  expect(await view()).toEqual(beforeReply);
  await expect(
    page.locator('[data-design-frame="page-2/frame-2.html"]'),
  ).toHaveCount(0);
  check(
    "Design pages ignore a frame-creation reply after leaving its captured page",
    true,
  );

  // Native inspector blur caused by the picker still commits to the old page.
  await page
    .getByRole("textbox", { name: "Canvas background", exact: true })
    .fill("456789");
  await switchTo("Page 2");
  await expect(
    page.getByRole("textbox", { name: "Canvas background", exact: true }),
  ).toHaveValue("654321");
  await switchTo("Page 1");
  await expect(
    page.getByRole("textbox", { name: "Canvas background", exact: true }),
  ).toHaveValue("456789");
  await picker().click();
  await page
    .getByRole("menuitem", { name: "Rename page…", exact: true })
    .click();
  const input = page.getByRole("textbox", { name: "Page title" });
  await expect(input).toBeFocused();
  await input.fill("Landing screens");
  await page.screenshot({ path: ".context/m4-screens/3-inline-rename.png" });
  await input.press("Enter");
  await expect(picker()).toHaveAccessibleName("Page: Landing screens");
  await expect(picker()).toBeFocused();
  // Saving an unchanged title returns focus just like a successful rename.
  await picker().click();
  await page
    .getByRole("menuitem", { name: "Rename page…", exact: true })
    .click();
  await input.press("Enter");
  await expect(picker()).toBeFocused();
  // Escape cancels without the subsequent blur submitting a rename.
  await picker().click();
  await page
    .getByRole("menuitem", { name: "Rename page…", exact: true })
    .click();
  await input.fill("Cancelled");
  await input.press("Escape");
  await expect(picker()).toHaveAccessibleName("Page: Landing screens");
  await expect(picker()).toBeFocused();
  await switchTo("Page 2");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("zeros:design-workspace-ui-v1") ?? "{}",
          ).ws_design_pages_harness?.activePageId,
      ),
    )
    .toBe(beta.activePageId);
  await page.reload({ waitUntil: "networkidle" });
  await expect(picker()).toHaveAccessibleName("Page: Page 2");
  expect(await view()).toMatchObject({
    activePageId: beta.activePageId,
    zoom: beta.zoom,
    panX: beta.panX,
    panY: beta.panY,
    canvasBackground: beta.canvasBackground,
  });
  await switchTo("Landing screens");
  check("Design pages reload the active page and its saved view", true);

  // Shared Files uses the real section and tree with the pages layout.
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?pages=1&workbench`,
    { waitUntil: "networkidle" },
  );
  await page.getByRole("tab", { name: "Open file", exact: true }).click();
  const files = page.getByTestId("design-files-section");
  await expect(files).toBeVisible();
  const designFolder = files.locator('[data-item-path="North One - Design/"]');
  await designFolder.click();
  await expect(
    files.locator('[data-item-path="North One - Design/meta/"]'),
  ).toBeVisible();
  await expect(
    files.locator('[data-item-path="North One - Design/page-1/"]'),
  ).toBeVisible();
  await expect(
    files.locator('[data-item-path="North One - Design/rules.md"]'),
  ).toBeVisible();
  await expect(
    files.locator('[data-item-path="North One - Design/tokens.css"]'),
  ).toBeVisible();
  await page.screenshot({
    path: ".context/m4-screens/5-files-design-section.png",
  });
  check(
    "Files Design files section includes meta, page folders, rules and shared tokens",
    true,
  );
  await page.getByRole("tab", { name: "Design", exact: true }).click();
  await expect(picker()).toHaveAccessibleName("Page: Landing screens");
  await picker().click();
  await page
    .getByRole("menuitem", { name: "Delete page…", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Delete page “Landing screens”?" }),
  ).toBeVisible();
  await expect(
    page.getByText("This deletes its 1 frame. Other files in", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: ".context/m4-screens/4-delete-dialog.png" });
  await page.getByRole("button", { name: "Delete page", exact: true }).click();
  await expect(picker()).toHaveAccessibleName("Page: Page 2");
  await page.reload({ waitUntil: "networkidle" });
  await expect(picker()).toHaveAccessibleName("Page: Page 2");
  expect(await view()).toMatchObject({
    activePageId: beta.activePageId,
    canvasBackground: beta.canvasBackground,
  });
  await picker().click();
  await expect(
    page.getByRole("menuitem", { name: "Delete page…", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  check(
    "Design pages: keyboard picker, confirmed creation, isolation, inline rename, deletion and reload",
    true,
  );
}
