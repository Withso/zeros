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
      await page.getByRole("button", { name: "Turn actions" }).click();
      const reset = page.getByRole("menuitem", { name: "Reset changes", exact: true });
      if (owner === "cloud") {
        await expect(reset).toHaveCount(0);
        await page.keyboard.press("Escape");
      } else {
        await reset.click();
        const dialog = page.getByRole("dialog", { name: "Reset changes?" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
        await expect(dialog.getByRole("button", { name: "Reset changes", exact: true })).toBeEnabled();
        const description = dialog.locator("[id]").filter({ hasText: /^Reset this chat and its changes to this point\./ }).last();
        await expect(description).toHaveText("Reset this chat and its changes to this point.This turn and later turns will be removed. You can undo.");
        // The dialog opens with a 200 ms zoom from 97%. getBoundingClientRect
        // includes that transform, so measure the settled dialog.
        await dialog.evaluate(element => Promise.all(element.getAnimations({ subtree: true })
          .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
          .map(animation => animation.finished)));
        const lines = await description.evaluate(element => element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight));
        expect(lines).toBeCloseTo(2, 1);
        if (owner === "personal" && agent === "claude") {
          for (const theme of ["dark", "light"]) {
            await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
            await dialog.screenshot({ path: `.context/turn-changes/reset-confirmation-${theme}.png` });
          }
          await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
        }
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        expect(await page.evaluate(() => window.__turnChanges.requests().some(request => request.op === "turns.reset"))).toBe(false);
      }
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
      await card.locator("[data-turn-file]").nth(1).click();
      const fileSelection = await page.evaluate(() => {
        const state = window.__turnChanges.state();
        return { tab: state.tabs.find(tab => tab.id === state.activeId), filter: window.__turnChanges.filter() };
      });
      expect(fileSelection.tab).toMatchObject({ type: "changes", filePath: "docs/paris.md", changesPresentation: "single", diffHistory: { kind: "turn-range", from: { turnId: "opening" }, to: { turnId: "opening" } } });
      expect(fileSelection.filter.scope).toEqual(selected.filter.scope);
      await expect(page.locator('[data-review-fixture] [contenteditable="true"]')).toHaveCount(0);
      await page.getByRole("button", { name: "Switch turn" }).click();
      await expect(card.locator("[data-turn-file]")).toHaveCount(4);
      check(`${owner}/${agent}: bounded turn card, both themes, exact Review filter and turn switch`, true);

      await page.goto(`${url}?owner=${owner}&agent=${agent}&timeline=1`);
      const first = page.locator('[data-fixture-turn="opening"]');
      const toggle = first.locator("[data-turn-changes-toggle]");
      await expect(first.locator("[data-turn-changes]")).toBeVisible();
      await expect(toggle).toHaveCount(0);
      await page.getByRole("button", { name: "Next turn without edits", exact: true }).click();
      await expect(page.locator("[data-turn-changes]")).toHaveCount(0);
      await expect(toggle).toHaveText("+380−2");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await page.getByRole("button", { name: "Finish turn", exact: true }).click();
      // An empty actual tail never promotes the newest turn that has edits.
      await expect(page.locator("[data-turn-changes]")).toHaveCount(0);
      for (const theme of ["dark", "light"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await toggle.hover();
        await expect.poll(() => toggle.evaluate(element => {
          const probe = document.createElement("span");
          probe.style.backgroundColor = "var(--bg1-hover)";
          probe.style.color = "var(--red-primary)";
          element.append(probe);
          const actual = getComputedStyle(element), expected = getComputedStyle(probe);
          const matches = actual.backgroundColor === expected.backgroundColor &&
            getComputedStyle(element.querySelector("span:nth-child(2)")).color === expected.color;
          probe.remove(); return matches;
        })).toBe(true);
        if (owner === "personal" && agent === "claude") await page.locator("[data-footer-fixture]").screenshot({ path: `.context/turn-changes/history-${theme}.png` });
      }
      await toggle.focus(); await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(first.locator("[data-turn-changes]")).toHaveAttribute("id", await toggle.getAttribute("aria-controls"));
      await expect(first.locator("[data-turn-file]")).toHaveCount(4);
      await first.getByRole("button", { name: "Show 16 more" }).click();
      await expect(first.locator("[data-turn-file]")).toHaveCount(20);
      await toggle.click();
      await expect(first.locator("[data-turn-changes]")).toHaveCount(0);
      await toggle.focus(); await page.keyboard.press("Space");
      await expect(first.locator("[data-turn-file]")).toHaveCount(4);
      if (owner === "cloud") expect(await page.evaluate(() => window.__turnChanges.requests().filter(request => request.op?.startsWith("turns.")).length)).toBe(0);
      // The first turn was already historical: changing isLastTurn alone
      // cannot close it when a third turn begins.
      await page.getByRole("button", { name: "Next turn with edits", exact: true }).click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("[data-turn-changes]")).toHaveCount(0);
      await page.getByRole("button", { name: "Finish turn", exact: true }).click();
      await expect(page.locator("[data-turn-changes]")).toHaveCount(1);
      await expect(page.locator('[data-fixture-turn="opening-3"] [data-turn-changes]')).toBeVisible();
      await toggle.click();
      await expect(page.locator("[data-turn-changes]")).toHaveCount(2);
      await first.locator("[data-turn-file]").nth(2).click();
      const historicalFile = await page.evaluate(() => {
        const state = window.__turnChanges.state();
        return { tab: state.tabs.find(tab => tab.id === state.activeId), filter: window.__turnChanges.filter() };
      });
      expect(historicalFile.tab).toMatchObject({ type: "changes", filePath: "docs/cairo.md", changesPresentation: "single" });
      expect(historicalFile.filter.scope).toMatchObject({ kind: "turn-range", from: { turnId: "opening" }, to: { turnId: "opening" } });
      await page.getByRole("button", { name: "Switch workspace", exact: true }).click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toHaveText("+3−1");
      await page.getByRole("button", { name: "Switch workspace", exact: true }).click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toHaveText("+380−2");
      if (owner === "personal" && agent === "claude") {
        for (const theme of ["dark", "light"]) {
          await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
          await page.locator("[data-footer-fixture]").screenshot({ path: `.context/turn-changes/thread-${theme}.png` });
        }
      }
      check(`${owner}/${agent}: historical totals, keyboard disclosure, automatic collapse and owner switching`, true);
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
