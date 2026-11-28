import { expect } from "@playwright/test";

/** The Agents tab groups children like the sidebar's Group › Status, never
 * lists a side chat, keeps its right side to Open or Viewing, and a side chat's
 * branch banner shows two lines, the second cut at half width. */
export async function runAgentsTabSmoke({ page, check, harnessBase }) {
  await page.goto(`${harnessBase}/harness-agents-tab.html`);
  const tab = page.locator("[data-agents-tab]");
  await expect(tab.locator("[data-agents-group]")).toHaveCount(4);
  expect(await tab.locator("[data-agents-group]").evaluateAll((groups) => groups.map((g) => g.dataset.agentsGroup)))
    .toEqual(["needs-you", "working", "idle", "archived"]);
  check("groups read Needs you, Working, Idle, then Archived", true);

  await expect(tab.locator('[data-agents-row="side"]')).toHaveCount(0);
  await expect(tab.locator('[data-agents-row="side-legacy"]')).toHaveCount(0);
  await expect(tab.getByText("Side chat", { exact: true })).toHaveCount(0);
  check("a side chat never appears in the Agents tab, nor one branched before the marker", true);

  const archived = tab.locator('[data-agents-group="archived"]');
  await expect(archived.locator("[data-agents-row]")).toHaveCount(0);
  await archived.getByRole("button", { name: "Archived, 1" }).click();
  await expect(archived.locator('[data-agents-row="c-arch"]')).toBeVisible();
  check("Archived starts collapsed and expands from its header", true);

  const needs = tab.locator('[data-agents-group="needs-you"]');
  await expect(needs.locator("[data-agents-lead-dot]")).toHaveCount(3);
  await expect(tab.locator('[data-agents-row="c-done"] [data-agents-placement="cloud"]')).toBeVisible();
  await expect(tab.locator('[data-agents-row="c-input"] [data-agents-placement]')).toHaveCount(0);
  check("status dots take the lead, and only a child workspace shows its placement", true);

  await expect(tab.locator('[data-agents-row="c-idle"]')).toContainText("Viewing");
  await expect(tab.getByRole("button", { name: "Open Switch harness and model in place" })).toHaveAttribute("aria-current", "true");
  check("with a side chat focused, the chat column's session reads Viewing", true);

  const tabsList = tab.getByRole("tablist", { name: "Parent sessions" });
  const firstCard = tab.locator("[data-agents-group]").first();
  const gap = await tabsList.evaluate((list, card) => card.getBoundingClientRect().top - list.getBoundingClientRect().bottom, await firstCard.elementHandle());
  expect(Math.round(gap)).toBe(8);
  const widths = await page.evaluate(() => {
    const list = document.querySelector('[aria-label="Parent sessions"]').getBoundingClientRect();
    const card = document.querySelector("[data-agents-group]").getBoundingClientRect();
    return { list: list.width, card: card.width, left: list.left - card.left };
  });
  expect(widths.list).toBe(widths.card);
  expect(widths.left).toBe(0);
  expect(widths.card).toBeLessThanOrEqual(520);
  check("parent tabs float in the cards' 520px column, 8px above the first card", true);

  const banner = page.locator("[data-side-chat-banner]").first();
  await expect(banner.locator("[data-side-chat-source]")).toHaveText("Branched from Research multi-agent chat UX");
  const quote = await banner.locator("blockquote").evaluate((block) => {
    const lines = [...block.querySelectorAll(":scope > span.block")].map((line) => line.getBoundingClientRect().width);
    return { height: block.getBoundingClientRect().height, lines, full: block.clientWidth };
  });
  expect(quote.lines).toHaveLength(2);
  expect(quote.height).toBe(36);
  expect(quote.lines[1]).toBeLessThanOrEqual(quote.full / 2);
  check("the branch banner names the chat and quotes two lines, the second at half width", true);
}
