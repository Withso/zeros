import { expect } from "@playwright/test";

const SOURCE_TOOLTIP_HOVER_DELAY_MS = 700;

async function openCreateFixture({ page, harnessBase }) {
  await page.goto(`${harnessBase}/harness-folder-workspace.html?create`);
  await page
    .getByRole("button", { name: "Open folder fixture", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Initialize git and create", exact: true })
    .click();
  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  const source = page.locator("[data-create-source-trigger]");
  await expect(source).toHaveText("main");
  return {
    source,
    dialog: page.getByRole("dialog", {
      name: "Create from source",
      exact: true,
    }),
  };
}

export async function runCreateSourceImmediateEscapeSmoke({
  page,
  check,
  harnessBase,
}) {
  const { source } = await openCreateFixture({ page, harnessBase });
  let escapeSent = false;
  await page.exposeFunction("sendCreateSourceImmediateEscape", async () => {
    await page.keyboard.press("Escape");
    escapeSent = true;
  });
  await page.evaluate(() => {
    const onFocus = (event) => {
      if (event.target.getAttribute?.("aria-label") !== "Search sources") {
        return;
      }
      document.removeEventListener("focusin", onFocus, true);
      void window.sendCreateSourceImmediateEscape();
    };
    document.addEventListener("focusin", onFocus, true);
  });
  await source.click();
  await expect.poll(() => escapeSent).toBe(true);
  await expect(source).toHaveAttribute("aria-expanded", "false");
  await expect(source).toBeFocused();
  check("the source picker handles Escape at its first search focus", true);
}

export async function runCreateSourceTooltipEscapeSmoke({
  page,
  check,
  harnessBase,
}) {
  await page.clock.install();
  const { source, dialog } = await openCreateFixture({ page, harnessBase });
  await source.click();
  const search = dialog.getByRole("searchbox", { name: "Search sources" });
  await expect(search).toBeFocused();
  await page.mouse.move(0, 0);
  await source.hover();
  await page.clock.runFor(SOURCE_TOOLTIP_HOVER_DELAY_MS);
  await expect(source).toHaveAttribute("aria-expanded", "true");
  await expect(search).toBeFocused();
  await expect(
    page.getByRole("tooltip").filter({ hasText: /Create from .* branch: main/ }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(source).toHaveAttribute("aria-expanded", "false");
  await expect(source).toBeFocused();
  check("hovering the open source picker cannot consume its first Escape", true);
}
