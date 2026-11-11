import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Local commands UI on local fixtures (the device channel is not wired yet):
 * the approval card is reachable by keyboard and decides only by a focused
 * choice; Connected Macs and the Advanced setting act from the keyboard;
 * colors come from their tokens in both themes. */
export async function runLocalCommandsSmoke({ page, harnessBase, check }) {
  const base = `${new URL(harnessBase).origin}/apps/desktop/src/renderer/harnesses/harness-local-commands.html`;
  const shots = process.env.ZEROS_SMOKE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shoot = async (locator, name) => { if (shots) await locator.screenshot({ path: join(shots, `${name}.png`) }); };
  const open = async (query, theme) => {
    await page.goto(`${base}?${query}&theme=${theme}`);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  };
  const token = name => page.evaluate(variable => {
    const probe = document.createElement("div");
    probe.style.color = `var(${variable})`; document.body.append(probe);
    const value = getComputedStyle(probe).color; probe.remove(); return value;
  }, name);
  const color = (locator, property) => locator.evaluate((node, key) => getComputedStyle(node)[key], property);
  const calls = () => page.evaluate(() => globalThis.__localCommands.calls());

  for (const theme of ["dark", "light"]) {
    await open("view=card", theme);
    const card = page.getByRole("group", { name: "Run a command on Alex's MacBook Pro" });
    await expect(card).toBeVisible();
    await expect(card.getByText("xcrun simctl list devices | grep Booted")).toBeVisible();
    expect(await color(card.getByText("Run this command on Alex's MacBook Pro?"), "color")).toBe(await token("--fg1"));
    expect(await color(card.locator("pre"), "color")).toBe(await token("--fg2"));
    // No shortcut decides: Enter with nothing focused does nothing.
    await page.locator("main").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Enter"); await page.keyboard.press("Backspace");
    expect(await calls()).toEqual([]);
    const order = [];
    for (let step = 0; step < 6 && order.length < 3; step++) {
      await page.keyboard.press("Tab");
      const name = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
      if (["Deny", "Yes", "Yes always"].includes(name) && !order.includes(name)) order.push(name);
    }
    expect(order).toEqual(["Deny", "Yes", "Yes always"]);
    await shoot(card, `local-command-card-${theme}`);
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Yes");
    await page.keyboard.press("Enter");
    expect(await calls()).toEqual(["yes"]);
    check(`The local command approval card is keyboard reachable, decides only by a focused choice, and uses its tokens in ${theme}`, true);

    await open("view=card&explicit&extended", theme);
    await expect(page.getByText("Asked for this Mac from a chat whose latest message came from Alex's Mac mini.")).toBeVisible();
    await expect(page.getByText("30 min · Full archive build")).toBeVisible();
    await shoot(page.getByRole("group", { name: "Run a command on Alex's MacBook Pro" }), `local-command-card-explicit-${theme}`);
    check(`An explicit-Mac request names the chat's Mac and shows the extended timeout in ${theme}`, true);

    await open("view=macs", theme);
    const popup = page.getByRole("dialog", { name: "Cloud workspace details" });
    await expect(popup.getByText("This Mac", { exact: true })).toBeVisible();
    expect(await color(popup, "backgroundColor")).toBe(await token("--bg3"));
    const connect = popup.getByRole("button", { name: "Connect Alex's MacBook Pro" });
    let reached = false;
    for (let step = 0; step < 8 && !reached; step++) { await page.keyboard.press("Tab"); reached = await connect.evaluate(node => node === document.activeElement); }
    expect(reached).toBe(true);
    await page.keyboard.press("Enter");
    await popup.getByRole("button", { name: "Disconnect Studio" }).click();
    expect(await calls()).toEqual(["connect:d1", "disconnect:d2"]);
    await shoot(popup, `connected-macs-${theme}`);
    check(`Connected Macs connects and disconnects from the keyboard and pointer in ${theme}`, true);

    await open("view=setting", theme);
    const toggle = page.getByRole("switch", { name: "Always allow local commands" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.focus(); await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => color(toggle, "backgroundColor")).toBe(await token("--switch-on-bg"));
    expect(await calls()).toEqual(["always:true"]);
    await shoot(page.locator("main"), `local-commands-setting-${theme}`);
    check(`Always allow local commands starts off and turns on from the keyboard in ${theme}`, true);
  }
}
