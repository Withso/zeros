import { expect } from "@playwright/test";

export async function runTurnUsageSmoke({ page, check }) {
  const fixture = page.locator("#turn-usage-fixture");
  const trigger = fixture.locator('[data-usage-provider="claude"] button');
  const card = page.getByRole("tooltip").filter({ hasText: "Cache read" });
  await trigger.hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Claude");
  await expect(card).toContainText("Estimated");
  await expect(card).toContainText("$5.34");
  await expect(card.locator("dt")).toHaveText([
    "Input",
    "Output",
    "Cache read",
    "Total cost · Estimated",
  ]);
  await expect(card.locator("dd").first()).toHaveText("214,405");
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);
  await trigger.focus();
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await trigger.click();
  await expect(card).toBeVisible();
  await fixture.getByRole("button", { name: "Toggle usage owner" }).click();
  await expect(card).toHaveCount(0);
  await trigger.hover();
  await expect(card).toHaveCount(0);
  await fixture.getByRole("button", { name: "Toggle usage owner" }).click();
  await fixture.getByRole("button", { name: "Settle late usage" }).click();
  await trigger.hover();
  await expect(card).toContainText("$5.39");
  await fixture.locator('[data-usage-provider="codex"] button').hover();
  await expect(card.filter({ hasText: "Codex" })).toContainText("Unavailable");
  await fixture.locator('[data-usage-provider="cursor"] button').hover();
  await expect(card.filter({ hasText: "Cursor" })).toContainText("$0.00");
  await page.mouse.move(0, 0);
  check(
    "Timer usage opens on hover, focus and click, closes with its owner, and distinguishes unknown from zero cost",
    true,
  );
}
