import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

export async function runTurnChangesSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  const url = `${origin}/apps/desktop/src/renderer/harnesses/harness-turn-changes.html`;
  const viewport = page.viewportSize();
  const initialUrl = page.url();
  await mkdir(".context/turn-changes", { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const owner of ["personal", "organization", "cloud"]) for (const agent of ["claude", "codex", "cursor"]) {
      await page.goto(`${url}?owner=${owner}&agent=${agent}`);
      const card = page.locator("[data-turn-changes]");
      await expect(card).toContainText("20 Files Changed");
      await expect(card.locator("[data-turn-file]")).toHaveCount(4);
      await expect(page.getByRole("button", { name: "Turn usage, 30m 49s" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Copy output" })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Turn actions" })).toBeVisible();
      if (owner === "cloud") expect(await page.evaluate(() => window.__turnChanges.requests().filter(request => request.op?.startsWith("turns.")).length)).toBe(0);
      for (const theme of ["dark", "light"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        const colors = await card.evaluate(element => {
          const style = getComputedStyle(element);
          const probe = document.createElement("div");
          probe.style.backgroundColor = "var(--bg1-highlight)"; probe.style.border = "1px solid var(--border2)";
          element.append(probe);
          const expected = getComputedStyle(probe);
          const result = [style.backgroundColor, expected.backgroundColor, style.borderTopColor, expected.borderTopColor];
          probe.remove(); return result;
        });
        expect(colors[0]).toBe(colors[1]); expect(colors[2]).toBe(colors[3]);
        if (owner === "personal" && agent === "claude") await page.locator("[data-footer-fixture]").screenshot({ path: `.context/turn-changes/collapsed-${theme}.png` });
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      const more = card.getByRole("button", { name: "Show 16 more" });
      await more.focus(); await page.keyboard.press("Enter");
      await expect(card.locator("[data-turn-file]")).toHaveCount(20);
      await expect(card.locator("[data-turn-file]").nth(4)).toBeFocused();
      const list = card.locator("[data-turn-files]");
      expect(await list.evaluate(element => element.clientHeight)).toBe(280);
      expect(await list.evaluate(element => element.scrollHeight)).toBeGreaterThan(280);
      await list.hover(); await page.mouse.wheel(0, 900);
      await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await expect(card.getByRole("button", { name: "Review", exact: true })).toBeVisible();
      if (owner === "personal" && agent === "claude") {
        await list.evaluate(element => { element.scrollTop = 0; });
        await page.locator("[data-footer-fixture]").screenshot({ path: ".context/turn-changes/expanded-dark.png" });
      }
      await card.getByRole("button", { name: "Review", exact: true }).click();
      await expect(page.locator("[data-review-fixture]")).toBeVisible();
      await expect(page.getByRole("button", { name: "Changes scope: Write the city notes" })).toBeVisible();
      const selected = await page.evaluate(() => {
        const state = window.__turnChanges.state();
        return { tab: state.tabs.find(tab => tab.id === state.activeId), filter: window.__turnChanges.filter() };
      });
      expect(selected.tab.type).toBe("changes");
      expect(selected.filter.scope).toMatchObject({ kind: "turn-range", from: { turnId: "opening" }, to: { turnId: "opening" } });
      await page.getByRole("button", { name: "Switch turn" }).click();
      await expect(card.locator("[data-turn-file]")).toHaveCount(4);
      check(`${owner}/${agent}: bounded turn card, both themes, exact Review filter and turn switch`, true);
    }
    for (const count of [0, 1, 4, 5]) {
      await page.goto(`${url}?count=${count}`);
      await expect(page.getByRole("button", { name: "Copy output" })).toBeVisible();
      await expect(page.locator("[data-turn-file]")).toHaveCount(Math.min(4, count));
      await expect(page.locator("[data-turn-changes]")).toHaveCount(count ? 1 : 0);
      await expect(page.getByRole("button", { name: /^Show \d+ more$/ })).toHaveCount(count > 4 ? 1 : 0);
    }
    await page.setViewportSize({ width: 360, height: 700 });
    await page.goto(url);
    await page.getByRole("button", { name: "Show 16 more" }).click();
    const last = page.locator("[data-turn-file]").last();
    await last.scrollIntoViewIfNeeded();
    expect(await last.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    check("Empty/singular/boundary file counts and narrow long paths retain card geometry", true);
  } finally {
    await page.setViewportSize(viewport);
    await page.goto(initialUrl);
  }
}
