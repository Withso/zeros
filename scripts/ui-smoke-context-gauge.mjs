import { expect } from "@playwright/test";

export async function runContextGaugeSmoke({ page, harnessBase }) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${harnessBase}/harness-context-gauge.html`);
  const trigger = page.getByRole("button", { name: /^Context ·/ });
  await trigger.focus();
  await trigger.press("Enter");
  const panel = page.locator('[data-zeros-native-overlay="popover"]');
  const row = (name) => panel.getByText(name, { exact: true }).locator("..");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("80.0k / 200k");
  await expect(row("Free space")).toHaveText("Free space50.0%");
  await expect(row("Messages")).toHaveText("Messages30.0%");
  await expect(row("Autocompact buffer")).toHaveText("Autocompact buffer10.0%");
  await expect(panel).not.toContainText("Available room");
  await expect(panel).not.toContainText("On-demand tools");
  await expect(panel).not.toContainText("Not included");
  await expect(panel).not.toContainText("deferred");
  // The category rows are one continuous list. Only the existing action footer
  // has a divider; no new deferred section or explanatory paragraph.
  await expect(panel.locator(".border-t")).toHaveCount(1);
  await expect(panel.locator("p")).toHaveCount(0);
  await panel.getByRole("button", { name: "Compact now" }).click();
  expect(await page.evaluate(() => window.contextCompactions)).toBe(1);

  // A refresh updates the open popover in place. Native zero free space must
  // not be replaced by the computed remainder.
  await page.evaluate(() =>
    window.setContextFixture({
      compactDisabled: true,
      usage: {
        size: 100,
        used: 30,
        categories: [
          { name: "Available", tokens: 0, kind: "free" },
          { name: "Tools", tokens: 30, kind: "used" },
        ],
      },
    }),
  );
  await expect(panel).toContainText("30 / 100");
  await expect(row("Free space")).toHaveText("Free space0.0%");
  await expect(row("Tools")).toHaveText("Tools30.0%");
  await expect(
    panel.getByRole("button", { name: "Compact now" }),
  ).toBeDisabled();
  await page.evaluate(() =>
    window.setContextFixture({
      usage: {
        size: 100,
        used: 30,
        categories: [{ name: "Tools", tokens: 30, kind: "deferred" }],
      },
    }),
  );
  await expect(panel.getByText("Tools", { exact: true })).toHaveCount(0);
  await expect(row("Used")).toHaveText("Used30.0%");

  // Older snapshots have names only; providers without categories retain the
  // same Used/Free display. Compaction may validly reduce the reading to zero.
  await page.evaluate(() =>
    window.setContextFixture({
      usage: {
        size: 100,
        used: 30,
        categories: [
          { name: "Messages", tokens: 30 },
          { name: "Compact buffer", tokens: 10 },
          { name: "MCP tools (deferred)", tokens: 500 },
        ],
      },
    }),
  );
  await expect(row("Free space")).toHaveText("Free space60.0%");
  await expect(panel).not.toContainText("deferred");
  await page.evaluate(() =>
    window.setContextFixture({ usage: { size: 100, used: 0, categories: [] } }),
  );
  await expect(row("Free space")).toHaveText("Free space100.0%");
  await expect(row("Used")).toHaveText("Used0.0%");
  await expect(panel.getByText("Messages", { exact: true })).toHaveCount(0);

  await page.evaluate(() =>
    window.setContextFixture({ usage: { size: 100, used: 120 } }),
  );
  await expect(panel).toContainText("120 / 100");
  await expect(row("Free space")).toHaveText("Free space0.0%");
  await expect(
    page.getByRole("img", { name: "Context 100% used" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(panel).toBeVisible();

  await page.evaluate(() =>
    window.setContextFixture({
      usage: null,
      unavailableReason: "Context usage is not available for this agent.",
    }),
  );
  await expect(panel).toHaveText(
    "Context usage is not available for this agent.",
  );
  await expect(panel.getByRole("button", { name: "Compact now" })).toHaveCount(
    0,
  );
  expect(errors).toEqual([]);
  console.log(
    "  [ok] context categories: native/legacy kinds, reserve, deferred hiding, live refresh, compaction and keyboard controls",
  );
}
