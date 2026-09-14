import { expect } from "@playwright/test";

export async function runDesignGitMenuSmoke({ page, check }) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );

  const trigger = page.getByLabel("Design Git actions", { exact: true });
  const menu = page.getByRole("menu", { name: "Design Git actions" });
  // Staging can finish before Radix removes the closing menu. Hold that exit
  // animation so the next real pointer click always exercises the CI race.
  const heldExit = await page.addStyleTag({
    content:
      '[role="menu"][data-state="closed"] { animation-duration: 60s !important; }',
  });
  try {
    await trigger.click();
    await menu
      .getByRole("menuitem", { name: "Stage Design changes", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.__zerosHarnessDesignShortcutOperations),
      )
      .toEqual(["stage:start", "stage:end"]);
    await expect(trigger).toBeEnabled();
    await expect(menu).toHaveAttribute("data-state", "closed");

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toHaveAttribute("data-state", "open");
    await menu
      .getByRole("menuitem", { name: "Commit staged Design changes" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.__zerosHarnessDesignShortcutOperations),
      )
      .toEqual(["stage:start", "stage:end", "commit"]);
    check(
      "Design Git menu reopens during its prior exit animation and commits once",
      true,
    );
  } finally {
    await heldExit.evaluate((element) => element.remove());
  }

  await expect(menu).toHaveCount(0);
  await trigger.click();
  await expect(menu).toHaveAttribute("data-state", "open");
  await expect(menu).toHaveCSS("pointer-events", "auto");
  const triggerBox = await trigger.boundingBox();
  // A modal menu disables pointer events on the page; use the real mouse to
  // dismiss it on the adjacent Style header, as an ordinary outside click does.
  await page.mouse.click(
    triggerBox.x - 100,
    triggerBox.y + triggerBox.height / 2,
  );
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toHaveCount(0);
  check("Design Git menu still dismisses on an outside pointer click", true);

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveAttribute("data-state", "open");
  await expect(menu).toHaveCSS("pointer-events", "auto");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  check(
    "Design Git menu keeps keyboard opening, Escape, and focus restoration",
    true,
  );
}
