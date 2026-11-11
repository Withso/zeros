import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Production cloud details card in the real popover, and the Workspace API
 * access row. Computed colors are the assertions; PNGs are written only when
 * ZEROS_SMOKE_SHOTS names a directory, as evidence for review. */
export async function runCloudWorkspaceDetailsSmoke({ page, harnessBase, check }) {
  const base = `${new URL(harnessBase).origin}/apps/desktop/src/renderer/harnesses/harness-cloud-workspace-details.html`;
  const shots = process.env.ZEROS_SMOKE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shoot = async (locator, name) => { if (shots) await locator.screenshot({ path: join(shots, `${name}.png`) }); };
  const open = async (query, theme) => {
    await page.goto(`${base}?${query}&theme=${theme}`);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  };
  const surfaces = new Map();
  /** The token's color as this page resolves it, for comparison with computed styles. */
  const token = name => page.evaluate(variable => {
    const probe = document.createElement("div");
    probe.style.color = `var(${variable})`; document.body.append(probe);
    const value = getComputedStyle(probe).color; probe.remove(); return value;
  }, name);
  const color = (locator, property) => locator.evaluate((node, key) => getComputedStyle(node)[key], property);

  const writes = [];
  let stored = true;
  const endpoint = "https://api.example.test/v1/cloud-v2/organizations/*/api-access";
  const handle = async route => {
    const request = route.request();
    if (request.method() === "PUT") { stored = request.postDataJSON().workspaceApiAccess; writes.push(stored); }
    await route.fulfill({ json: { workspaceApiAccess: stored } });
  };
  await page.route(endpoint, handle);
  try {
    for (const theme of ["dark", "light"]) {
      await open("state=running", theme);
      const popup = page.getByRole("dialog", { name: "Cloud workspace details" });
      await expect(popup).toBeVisible();
      for (const text of ["Zeros Cloud", "Running", "Setup", "Succeeded", "Agent cost", "$1.23 · estimated", "4 cores · 12% used", "8 GB · 50% used", "64 GB · 10% used"])
        await expect(popup.getByText(text, { exact: true })).toBeVisible();
      expect(await color(popup, "backgroundColor")).toBe(await token("--bg3"));
      surfaces.set(theme, await color(popup.getByText("Zeros Cloud", { exact: true }), "color"));
      expect(surfaces.get(theme)).toBe(await token("--fg1"));
      await shoot(popup, `details-running-${theme}`);
      expect(await color(popup.locator("dt").first(), "color")).toBe(await token("--fg2"));
      const restart = popup.getByRole("button", { name: "Restart workspace" });
      let reached = false;
      for (let step = 0; step < 8 && !reached; step++) {
        await page.keyboard.press("Tab");
        reached = await restart.evaluate(node => node === document.activeElement);
      }
      expect(reached, "Tab reaches Restart").toBe(true);
      expect(await restart.evaluate(node => node.matches(":focus-visible"))).toBe(true);
      expect(await color(restart, "boxShadow")).not.toBe("none");
      await shoot(page.locator("main"), `details-running-focused-${theme}`);
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => window.__detailsFixture.calls())).toEqual(["restart"]);
      check(`Cloud details show Zeros Cloud, Restart from the keyboard and VM usage, setup status and agent cost on token colors in ${theme}`, true);

      await open("state=stopped", theme);
      const stopped = page.getByRole("dialog", { name: "Cloud workspace details" });
      await expect(stopped.getByText("Stopped", { exact: true })).toBeVisible();
      await expect(stopped.getByRole("button", { name: "Start workspace" })).toBeVisible();
      await expect(stopped.getByRole("button", { name: "Restart workspace" })).toHaveCount(0);
      for (const label of ["CPU", "Memory", "Disk", "Setup", "Agent cost"]) await expect(stopped.getByText(label, { exact: true })).toHaveCount(0);
      expect(await color(stopped, "backgroundColor")).toBe(await token("--bg3"));
      await shoot(stopped, `details-stopped-${theme}`);
      check(`A stopped cloud workspace shows Start and no usage, setup or cost rows in ${theme}`, true);

      stored = true; writes.length = 0;
      await open("view=setting", theme);
      const toggle = page.getByRole("switch", { name: "Workspace API access" });
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      // The track animates its color; wait for it to settle on each token.
      await expect.poll(() => color(toggle, "backgroundColor")).toBe(await token("--switch-on-bg"));
      await toggle.focus(); await page.keyboard.press("Space");
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect.poll(() => writes).toEqual([false]);
      await expect(toggle).toBeEnabled();
      await expect.poll(() => color(toggle, "backgroundColor")).toBe(await token("--border3"));
      await shoot(page.locator("main"), `setting-${theme}`);
      check(`Workspace API access saves from the keyboard and settles on its on and off token colors in ${theme}`, true);
    }
    expect(surfaces.get("light"), "light and dark resolve different text colors").not.toBe(surfaces.get("dark"));
  } finally { await page.unroute(endpoint, handle); }
}
