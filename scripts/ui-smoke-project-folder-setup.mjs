import { expect } from "@playwright/test";

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
      ["Open shortcuts", "Keyboard shortcuts", false],
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
}
