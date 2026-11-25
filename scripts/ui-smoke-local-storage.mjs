import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";

/** Settings → Local Storage through the real Settings page, rail, store and
 *  panel; only Electron main's measurements are a fixture. Set
 *  ZEROS_LOCAL_STORAGE_SHOTS to a folder to keep PNGs of each state. */
export async function runLocalStorageSmoke({ page, harnessBase, check }) {
  const shots = process.env.ZEROS_LOCAL_STORAGE_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  // A theme flip runs the controls' colour transitions; read and capture at rest.
  const settle = () =>
    page.evaluate(async () => {
      await document.fonts.ready;
      const transitions = document.getAnimations().filter((animation) => animation instanceof CSSTransition);
      await Promise.all(transitions.map((animation) => animation.finished.catch(() => {})));
    });
  const capture = async (name) => {
    if (!shots) return;
    await settle();
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
  };
  const theme = (value) =>
    page.evaluate((next) => document.documentElement.setAttribute("data-theme", next), value);
  const calls = (command) =>
    page.evaluate((name) => window.__localStorageFixture.calls().filter((c) => c === name).length, command);
  const panel = page.locator('[aria-hidden="false"]').filter({ has: page.getByRole("heading", { name: "Local Storage", exact: true }) });

  const open = async () => {
    await page.goto(`${harnessBase}/harness-local-storage.html?settings`, { waitUntil: "networkidle" });
    await page.evaluate(() => window.appSidebarNavigate("settings"));
    await expect(page.getByRole("tab", { name: "Local Storage" })).toBeVisible();
  };
  await open();

  const nav = page.getByRole("tab", { name: "Local Storage" });
  const tabs = await page.getByRole("tab").allTextContents();
  expect(tabs.indexOf("Local Storage")).toBe(tabs.indexOf("Appearance") + 1);
  expect(await calls("local_storage_measure")).toBe(0);
  check("Settings lists Local Storage after Appearance and measures nothing until asked", true);

  // Hold the warmed measurement open so opening provably joins it.
  const pending = () => page.evaluate(() => window.__localStorageFixture.pending());
  await page.evaluate(() => window.__localStorageFixture.hold());
  await nav.hover();
  await expect.poll(() => calls("local_storage_measure")).toBe(1);
  await expect.poll(pending).toBe(true);
  await nav.click();
  await expect(panel.getByText("What Zeros keeps on this Mac.")).toBeVisible();
  await expect(panel.getByText("Measuring…")).toBeVisible();
  expect(await pending()).toBe(true);
  expect(await calls("local_storage_measure")).toBe(1);
  await page.evaluate(() => window.__localStorageFixture.release());
  await expect(panel.getByText("Updated just now")).toBeVisible();
  await expect(panel.getByText("124 MB")).toBeVisible();
  expect(await calls("local_storage_measure")).toBe(1);
  check("Hovering the entry warms the measurement and opening joins the one still in flight", true);

  for (const label of ["Workspaces", "Cloud sync", "Chats and history", "Provider accounts", "Window and editor state", "Other app data", "Cache", "Logs", "Updates"])
    // The titled category groups; the Storage total is its own untitled group.
    await expect(panel.locator("section:has(h2)").getByText(label, { exact: true })).toBeVisible();
  await expect(panel.getByText("~/zeros/workspaces")).toBeVisible();
  await expect(panel.getByText("Managed by Zeros")).toBeVisible();
  await expect(panel.getByText("Files in cloud workspaces live on their Cloud Computer and are not counted here.")).toBeVisible();
  await expect(panel.getByText("Updated just now")).toBeVisible();
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-hidden="false"] section > div > div')]
      .filter((row) => row.closest("section")?.querySelector("h2"))
      .map((row) => Math.round(row.getBoundingClientRect().height)),
  );
  expect(heights.length).toBe(9);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  check("Every row shows, the rows share one height, and the footnote explains cloud files", true);

  await capture("dark-loaded");
  await theme("light");
  await capture("light-loaded");
  await theme("dark");

  const reveal = panel.getByRole("button", { name: "Reveal workspaces in Finder" });
  await panel.getByRole("button", { name: "Refresh" }).focus();
  await page.keyboard.press("Tab");
  await expect(reveal).toBeFocused();
  await expect.poll(() => reveal.evaluate((node) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    node.parentElement.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return node.matches(":focus-visible") && getComputedStyle(node).borderTopColor === accent;
  })).toBe(true);
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.__localStorageFixture.callsOf("local_storage_reveal"))).toEqual([{ category: "workspaces" }]);
  check("Reveal is labelled, keyboard reachable with visible focus, and sends only the row id", true);

  await page.evaluate(() => window.__localStorageFixture.hold());
  await panel.getByRole("button", { name: "Refresh" }).click();
  await expect(panel.getByText("Measuring…")).toBeVisible();
  await expect(panel.getByText("124 MB")).toBeVisible();
  await expect(panel.getByText("58 MB")).toBeVisible();
  check("Refresh keeps the confirmed sizes on screen while measuring", true);
  await page.getByRole("tab", { name: "Appearance" }).click();
  await expect.poll(() => calls("local_storage_cancel")).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__localStorageFixture.listeners())).toBe(0);
  check("Leaving the section cancels the measurement and stops listening", true);

  await nav.click();
  await panel.getByRole("button", { name: "Clear cache" }).click();
  await expect(panel.getByRole("status").filter({ hasText: "Freed 58 MB" })).toBeVisible();
  await expect(panel.getByText("3.1 MB")).toBeVisible();
  expect(await page.evaluate(() => window.__localStorageFixture.callsOf("local_storage_clear_cache"))).toEqual([{ category: "cache" }]);
  check("Clear cache sends only the cache id and shows the measured amount freed in place", true);
  await capture("dark-cleared");
  await theme("light");
  await capture("light-cleared");
  await theme("dark");

  // A cold first measurement part-way through: placeholders and lower bounds.
  await page.evaluate(() => sessionStorage.clear());
  await open();
  await page.evaluate(() => window.__localStorageFixture.hold());
  await nav.click();
  await expect(panel.getByText("Measuring…")).toBeVisible();
  await expect(panel.getByText("at least")).toHaveCount(2);
  const placeholder = panel.getByRole("img", { name: "Measuring", exact: true });
  await expect(placeholder).toHaveCount(1);
  await expect(panel.getByText("0 KB")).toHaveCount(0);
  // The placeholder must paint: a real box whose fill differs from the row's.
  const painted = () =>
    placeholder.evaluate((node) => {
      const bar = node.querySelector('[data-slot="skeleton"]');
      if (!bar) return { present: false };
      const box = bar.getBoundingClientRect();
      const fill = getComputedStyle(bar).backgroundColor;
      let surface = "rgba(0, 0, 0, 0)";
      for (let at = bar.parentElement; at; at = at.parentElement) {
        const color = getComputedStyle(at).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
          surface = color;
          break;
        }
      }
      return { present: true, width: box.width, height: box.height, fill, surface };
    });
  const expectPainted = async (label) => {
    const result = await painted();
    expect(result.present, label).toBe(true);
    expect(result.width, label).toBeGreaterThan(0);
    expect(result.height, label).toBeGreaterThan(0);
    expect(result.fill, label).not.toBe("rgba(0, 0, 0, 0)");
    expect(result.fill, label).not.toBe(result.surface);
    return result;
  };
  await settle();
  const dark = await expectPainted("dark");
  check("A first measurement fills in per category with a placeholder or an at-least bound, never zero", true);
  await capture("dark-measuring");
  await theme("light");
  await settle();
  const light = await expectPainted("light");
  check(`The unmeasured row's labelled placeholder paints in Dark (${dark.fill} on ${dark.surface}) and Light (${light.fill} on ${light.surface})`, true);
  await capture("light-measuring");
  await theme("dark");
  await page.evaluate(() => window.__localStorageFixture.release());
  await expect(panel.getByText("Updated just now")).toBeVisible();

  // Local and cloud owners read the same device snapshot.
  await page.evaluate(() => window.appSidebarSeedCloud());
  await page.evaluate(() => window.appSidebarNavigate("settings"));
  const before = await calls("local_storage_measure");
  const organization = "11111111-1111-4111-8111-111111111111";
  for (const owner of [organization, null, organization]) {
    await page.evaluate((id) => window.appSidebarSelectOwner(id), owner);
    await page.evaluate(() => window.appSidebarNavigate("settings"));
    await page.getByRole("tab", { name: "Local Storage" }).click();
    await expect(panel.getByText("124 MB")).toBeVisible();
  }
  expect(await calls("local_storage_measure")).toBe(before);
  check("Organization (cloud) and Local owners show Local Storage; A → B → A neither refetches nor drops sizes", true);
}
