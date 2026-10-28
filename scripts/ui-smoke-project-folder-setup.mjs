import { expect } from "@playwright/test";
import { runCommandPaletteSmoke } from "./ui-smoke-command-palette.mjs";
import { runKeyboardFocusSmoke } from "./ui-smoke-focus.mjs";

async function expectDialogChrome(dialog, page, { footer = true } = {}) {
  await expect(dialog.locator('[data-slot="dialog-header"]')).toHaveCSS(
    "padding", "12px 16px 0px",
  );
  await expect(dialog.locator('[data-slot="dialog-body"]')).toHaveCSS(
    "padding", "24px 16px",
  );
  const title = dialog.locator('[data-slot="dialog-title"]');
  await expect(title).toHaveCSS("font-size", "15px");
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await expect(close).toHaveCSS("width", "20px");
  await expect(close).toHaveCSS("height", "20px");
  await expect(close).toHaveCSS("border-radius", "999px");
  await expect(close.locator("svg")).toHaveCSS("width", "12px");
  await expect(close.locator("svg")).toHaveCSS("height", "12px");
  await expect.poll(() => dialog.evaluate((element) => {
    const row = element.querySelector('[data-slot="dialog-title-row"]').getBoundingClientRect();
    const titleBox = element.querySelector('[data-slot="dialog-title"]').getBoundingClientRect();
    const closeBox = element.querySelector('button[aria-label="Close"]').getBoundingClientRect();
    return titleBox.right < closeBox.left &&
      Math.abs(titleBox.left - row.left) < 1 &&
      Math.abs(closeBox.right - row.right) < 1 &&
      Math.abs(closeBox.y + closeBox.height / 2 - titleBox.y - titleBox.height / 2) < 2;
  })).toBe(true);
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0.5)",
  );
  if (footer) {
    const actions = dialog.locator('[data-slot="dialog-footer"]');
    await expect(actions).toHaveCSS("padding", "10px");
    await expect(actions).toHaveCSS("border-top-width", "1px");
    // Read both rectangles in one frame while the dialog's entrance animates.
    await expect.poll(() => dialog.evaluate((element) => {
      const footerBox = element.querySelector('[data-slot="dialog-footer"]').getBoundingClientRect();
      const dialogBox = element.getBoundingClientRect();
      return Math.abs(footerBox.x - dialogBox.x - 1) < 1 &&
        Math.abs(footerBox.width - dialogBox.width + 2) < 1;
    })).toBe(true);
  }
}

export async function runDialogChromeSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-project-folder-setup.html`,
  );
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (value) => (document.documentElement.dataset.theme = value),
      theme,
    );
    for (const [trigger, heading, footer] of [
      ["Open quick start", "Create project", true],
      ["Open confirmation", "Close active chat?", true],
      ["Open command picker", "Choose a folder", false],
    ]) {
      await page.getByRole("button", { name: trigger, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: heading, exact: true });
      await expectDialogChrome(dialog, page, { footer });
      if (trigger === "Open confirmation") {
        await expect(
          dialog.getByRole("button", { name: "Cancel", exact: true }),
        ).toBeFocused();
      }
      if (trigger === "Open quick start") {
        await expect(
          dialog.getByRole("textbox", { name: "Project name", exact: true }),
        ).toBeFocused();
      }
      if (trigger === "Open command picker") {
        await expect(dialog.getByRole("combobox")).toBeFocused();
      }
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    check(
      `${theme}: dialogs share 15px headings, top-right close, separated footers and 50% overlay`,
      true,
    );

    const shortcutsTrigger = page.getByRole("button", { name: "Open shortcuts", exact: true });
    const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
    await shortcutsTrigger.focus();
    await page.keyboard.press("Meta+Slash");
    await expect(shortcuts).toHaveCount(0);
    await page.keyboard.press("Meta+Alt+Slash");
    await expect(shortcuts.locator('[data-slot="dialog-title-row"]')).toHaveCount(0);
    await expect(shortcuts.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await expect(shortcuts.locator('[data-slot="dialog-body"]')).toHaveCSS("padding", "0px");
    const search = shortcuts.getByRole("combobox");
    await expect(search).toBeFocused();
    await expect(shortcuts.locator('[data-slot="command-item"]').filter({ hasText: "Show all shortcuts" }))
      .toContainText("⌥⌘/");
    await page.keyboard.press("Meta+Slash");
    await expect(shortcuts).toBeVisible();
    await page.keyboard.press("Meta+Alt+Slash");
    await expect(shortcuts).toHaveCount(0);
    await page.keyboard.press("Meta+Alt+Slash");
    await expect(search).toBeFocused();
    check(`${theme}: Command+Option+/ toggles shortcuts from the focused search; Command+/ does not`, true);
    await expect(shortcuts.locator('[data-slot="command-input-wrapper"] svg')).toHaveCount(0);
    await expect.poll(() => shortcuts.evaluate((element) => {
      const panel = element.getBoundingClientRect();
      const input = element.querySelector('[data-slot="command-input-wrapper"]').getBoundingClientRect();
      return Math.abs(input.top - panel.top - 1) < 1 &&
        Math.abs(input.left - panel.left - 1) < 1 &&
        Math.abs(input.right - panel.right + 1) < 1;
    })).toBe(true);
    if (theme === "light") {
      // Compare the divider with the composited glass, not the opaque page.
      expect(await shortcuts.evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = 2;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        for (const color of [
          getComputedStyle(element).getPropertyValue("--bg1"),
          getComputedStyle(document.querySelector('[data-slot="dialog-overlay"]')).backgroundColor,
          getComputedStyle(element).backgroundColor,
        ]) {
          context.fillStyle = color;
          context.fillRect(0, 0, 2, 1);
        }
        context.fillStyle = getComputedStyle(element.querySelector('[data-slot="command-input-wrapper"]')).borderBottomColor;
        context.fillRect(1, 0, 1, 1);
        const pixels = context.getImageData(0, 0, 2, 1).data;
        return pixels[4] + pixels[5] + pixels[6] < pixels[0] + pixels[1] + pixels[2];
      })).toBe(true);
    }
    await expect(shortcuts).toHaveCSS("border-radius", "14px");
    await search.fill("feedback");
    await expect(shortcuts.getByText("Send feedback", { exact: true })).toBeVisible();
    await expect(shortcuts.locator('[data-slot="command-item"]')).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(shortcuts).toHaveCount(0);
    check(
      `${theme}: shortcuts start with full-width iconless search, retain an accessible name and dismiss with Escape`,
      true,
    );
  }
  const previousViewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 740 });
  await page.getByRole("button", { name: "Open quick start", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create project" });
  await expectDialogChrome(dialog, page);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.setViewportSize(previousViewport);
  check(
    "Dialog header and footer fit narrow windows and retain Escape dismissal",
    true,
  );
  await runCommandPaletteSmoke({ page, check });
  await runKeyboardFocusSmoke({ page, check });
}
