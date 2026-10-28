import { expect } from "@playwright/test";

// Hold the real Design transaction while a second edit claims focus. These
// nonmodal tool windows must not take it back when the earlier save completes.
export async function runDesignDeferredFocusSmoke({
  page,
  check,
  operations = ["import", "variable", "theme", "reset"],
  moveFocus = true,
}) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const operation of operations) {
    await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`);
    await page.getByRole("button", { name: "Open theme editor", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Theme editor" });
    const search = dialog.getByRole("textbox", { name: "Search theme variables" });
    await expect(search).toBeVisible();
    await page.evaluate(() => {
      window.__zerosHarnessDesignTransactionGate = new Promise((resolve) => {
        window.__zerosReleaseThemeFocusSave = resolve;
      });
    });
    let pending;
    let destination;
    if (operation === "import") {
      destination = dialog.getByRole("button", { name: "Paste CSS", exact: true });
      await destination.click();
      pending = dialog.getByRole("textbox", { name: "CSS variables to import" });
      await pending.fill(":root { --focus-example: royalblue; }");
      await dialog.getByRole("button", { name: "Import", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Importing…", exact: true })).toBeDisabled();
    } else if (operation === "variable") {
      destination = dialog.getByRole("button", { name: "New variable", exact: true });
      await destination.click();
      pending = dialog.getByRole("textbox", { name: "Variable name", exact: true });
      await pending.fill("--focus-example");
      await dialog.getByRole("textbox", { name: "Base value", exact: true }).fill("royalblue");
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(pending).toBeDisabled();
    } else if (operation === "theme") {
      destination = dialog.getByRole("button", { name: "Add theme", exact: true });
      await destination.click();
      pending = dialog.getByRole("textbox", { name: "New theme name" });
      await pending.fill("contrast");
      await pending.press("Enter");
      await expect(pending).toBeDisabled();
    } else {
      pending = dialog.getByRole("textbox", { name: "--accent Dark value", exact: true });
      destination = dialog.locator(".zd-theme-token-name").filter({ hasText: "--accent" });
      await pending.click();
      await pending.press("Alt+Enter");
      await expect(pending).toBeDisabled();
    }
    if (moveFocus) {
      await search.click();
      await page.keyboard.type("accent");
    }
    await page.evaluate(() => window.__zerosReleaseThemeFocusSave());
    await expect(pending).toHaveCount(0);
    // Include the post-commit restoration frame in the observation.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(moveFocus ? search : destination).toBeFocused();
    check(`Design ${operation}: ${moveFocus ? "a newer edit keeps focus after save" : "an uninterrupted save restores its control"}`, true);
  }
}

export async function runDesignCloseFocusSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`);
  await page.locator('[data-design-layer-id="home-heading"]').click();
  const size = page.getByRole("textbox", { name: "Size", exact: true });
  await expect(size).toBeVisible();
  const trigger = page.getByRole("button", { name: "Open theme editor", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Theme editor" });
  await dialog.getByRole("button", { name: "Close theme editor", exact: true }).evaluate((button) => {
    button.click();
    // A second destination claims focus before the dialog's teardown frame.
    document.querySelector('input[aria-label="Size"]').focus();
  });
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(size).toBeFocused();
  await trigger.click();
  await dialog.getByRole("button", { name: "Close theme editor", exact: true }).click();
  await expect(trigger).toBeFocused();
  check("closing the Design tool returns focus only if another destination has not claimed it", true);
}

export async function runDesignPageFocusSmoke({ page, check, moveFocus = true }) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?pages=1`);
  const picker = page.getByRole("button", { name: /^Page:/ });
  await picker.click();
  await page.getByRole("menuitem", { name: "Rename page…", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Page title" });
  const savedTitle = moveFocus ? "Focus page newer" : "Focus page current";
  await title.fill(savedTitle);
  await page.evaluate(() => { window.__zerosHarnessPages.holdRename = true; });
  await title.press("Enter");
  await expect(title).toBeDisabled();
  const canvas = page.locator("[data-design-canvas-viewport]");
  if (moveFocus) {
    await canvas.focus();
    await page.keyboard.press("Shift");
  }
  await page.evaluate(() => window.__zerosHarnessPages.releaseRename());
  await expect(picker).toHaveAccessibleName(`Page: ${savedTitle}`);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(moveFocus ? canvas : picker).toBeFocused();
  check(`a saved Design page title ${moveFocus ? "does not take focus back from the canvas" : "restores focus after an uninterrupted save"}`, true);
}
