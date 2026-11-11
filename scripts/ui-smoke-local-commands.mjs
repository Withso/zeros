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

    await open("view=transcript", theme);
    const transcript = page.locator("main");
    await expect(transcript.locator("[data-local-command-row]")).toHaveCount(4);   // the ToolSearch row is hidden
    for (const [row, said] of [["waiting", "Waiting for approval on Studio"], ["ran", "Ran on Studio"], ["denied", "Denied"], ["exit", "Failed with exit code 3"]]) {
      const item = transcript.locator(`[data-local-command-row="${row}"]`);
      await expect(item.getByText("List booted simulators", { exact: true })).toBeVisible();
      await expect(item.getByText(said, { exact: true })).toBeVisible();
    }
    await expect(transcript.getByText("xcrun simctl list devices | grep Booted").first()).toBeVisible();
    await expect(transcript.getByText(/mcp__|Loading tool/)).toHaveCount(0);
    await expect(transcript.getByText("Error", { exact: true })).toHaveCount(0);
    expect(await color(transcript.locator('[data-local-command-row="denied"]').getByText("List booted simulators", { exact: true }), "color")).toBe(await token("--fg1"));
    await shoot(transcript, `local-command-transcript-${theme}`);
    check(`RunLocalCommand rows read the description and command with plain-word endings, never mcp__ names, Loading tool or Error, in ${theme}`, true);

    // Order 3: This Mac's sync row in the popup, off and on, from the keyboard.
    await open("view=sync&sync=off", theme);
    const offPopup = page.getByRole("dialog", { name: "Cloud workspace details" });
    await expect(offPopup.getByText("Connected · for 12 h · Syncing")).toBeVisible();
    const start = offPopup.getByRole("button", { name: "Sync to a local directory" });
    await start.focus(); await page.keyboard.press("Enter");
    expect(await calls()).toContain("sync:choose");
    await shoot(offPopup, `workspace-sync-off-${theme}`);
    for (const [state, label] of [["syncing", "Syncing (12 files)"], ["in_sync", "In sync"], ["paused", "Paused (workspace asleep)"], ["error", "Error (more than 5 GB)"]]) {
      await open(`view=sync&sync=${state}`, theme);
      const group = page.getByRole("group", { name: "Sync on this Mac" });
      const status = group.getByRole("status");
      await expect(status).toHaveText(label);
      expect(await color(status, "color")).toBe(await token(state === "error" ? "--red-primary" : "--fg1"));
      await expect(group.getByText("A local copy: changes in the cloud overwrite edits made here.")).toBeVisible();
      if (state === "in_sync") {
        await group.getByRole("button", { name: "Open terminal here" }).focus(); await page.keyboard.press("Enter");
        await group.getByRole("button", { name: "Stop sync" }).focus(); await page.keyboard.press("Enter");
        expect((await calls()).slice(-2)).toEqual(["sync:terminal", "sync:stop"]);
        await shoot(group, `workspace-sync-in-sync-${theme}`);
      }
    }
    check(`This Mac's sync row starts from the keyboard, shows each status on its token with the copy note, and opens a terminal or stops in ${theme}`, true);
  }
}
