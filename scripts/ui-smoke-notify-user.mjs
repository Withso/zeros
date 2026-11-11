import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** NotifyUser in the app: the transcript names the call "Notified you: <title>"
 * for every adapter's shape on token colors, a refused call reads
 * "Notification not sent"; an attention update marks its
 * chat unread unless that chat is on screen, and never adds a transcript row. */
export async function runNotifyUserSmoke({ page, harnessBase, check }) {
  const base = `${new URL(harnessBase).origin}/apps/desktop/src/renderer/harnesses/harness-notify-user.html`;
  const shots = process.env.ZEROS_SMOKE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shoot = async (locator, name) => { if (shots) await locator.screenshot({ path: join(shots, `${name}.png`) }); };
  const token = name => page.evaluate(variable => {
    const probe = document.createElement("div");
    probe.style.color = `var(${variable})`; document.body.append(probe);
    const value = getComputedStyle(probe).color; probe.remove(); return value;
  }, name);
  const color = (locator, property) => locator.evaluate((node, key) => getComputedStyle(node)[key], property);

  for (const theme of ["dark", "light"]) {
    await page.goto(`${base}?theme=${theme}`);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    for (const provider of ["codex", "claude", "cursor"]) {
      const label = page.locator(`[data-notify-row="${provider}"]`).getByText("Notified you: Ready for review", { exact: true });
      await expect(label).toBeVisible();
    }
    // A refused call says so in plain words on a neutral row, naming what was not sent: never a generic Error.
    const failed = page.locator('[data-notify-row="failed"]');
    await expect(failed.getByText("Notification not sent", { exact: true })).toBeVisible();
    await expect(failed.getByText("Ready for review", { exact: true })).toBeVisible();
    await expect(failed.getByText("Error", { exact: true })).toHaveCount(0);
    expect(await color(failed.getByText("Notification not sent", { exact: true }), "color")).toBe(await token("--fg1"));
    await expect(page.getByText("mcp__zeros_workspace__NotifyUser")).toHaveCount(0);
    const first = page.locator('[data-notify-row="codex"]').getByText("Notified you: Ready for review", { exact: true });
    expect(await color(first, "color")).not.toBe("rgba(0, 0, 0, 0)");
    await shoot(page.locator("main"), `notify-user-rows-${theme}`);
    check(`NotifyUser rows read "Notified you: <title>" for Codex, Claude and Cursor, and a refused one reads "Notification not sent" with its title, in ${theme}`, true);

    await page.evaluate(() => globalThis.__notifyUser.view(["login"]));
    await page.evaluate(() => { globalThis.__notifyUser.deliver("simulator"); globalThis.__notifyUser.deliver("login"); });
    await expect(page.getByRole("tab", { name: "Simulator, unread" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Fix login", exact: true })).toBeVisible();
    const dot = page.getByRole("tab", { name: "Simulator, unread" }).locator("[data-chat-unread] span");
    expect(await color(dot, "backgroundColor")).toBe(await token("--brown-fg"));
    expect(await page.evaluate(() => [globalThis.__notifyUser.transcript("simulator"), globalThis.__notifyUser.transcript("login")])).toEqual([0, 0]);
    await shoot(page.getByRole("tablist", { name: "Chats" }), `notify-user-unread-${theme}`);
    check(`An attention update marks only an off-screen chat unread, on its token, without a transcript row, in ${theme}`, true);
  }
}
