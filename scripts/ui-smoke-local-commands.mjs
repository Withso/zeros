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
    // Wire v1.3: the reason is a muted line under the title.
    expect(await color(card.locator("[data-local-command-reason]"), "color")).toBe(await token("--fg3"));
    await expect(card.locator("[data-local-command-reason]")).toHaveText("Verify the iOS build");
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
    // Both ToolSearch rows stay hidden: the finished one loading it, and a pending one (no "Finding tools" flash).
    await expect(transcript.locator("[data-local-command-row]")).toHaveCount(5);
    await expect(transcript.getByText(/Finding tools|Loading tool/)).toHaveCount(0);
    for (const [row, said] of [["waiting", "Waiting for approval on Studio"], ["denied", "Denied"], ["exit", "Failed with exit code 3"]]) {
      const item = transcript.locator(`[data-local-command-row="${row}"]`);
      await expect(item.getByText("List booted simulators", { exact: true })).toBeVisible();
      await expect(item.getByText(said, { exact: true })).toBeVisible();
    }
    // Always allow (nothing held for that chat): the running row, with no approval claim; a success adds no words.
    for (const row of ["running", "ran"]) {
      const item = transcript.locator(`[data-local-command-row="${row}"]`);
      await expect(item.getByText("List booted simulators", { exact: true })).toBeVisible();
      await expect(item.getByText(/Waiting for approval|Ran on/)).toHaveCount(0);
    }
    // Two glyphs, a laptop and then a terminal prompt, on every row.
    for (const row of ["waiting", "running", "ran", "denied", "exit"])
      expect(await transcript.locator(`[data-local-command-row="${row}"] button svg`).evaluateAll(nodes => nodes.slice(0, 2).map(node => node.getAttribute("class")?.match(/lucide-(laptop|terminal)\b/)?.[1])))
        .toEqual(["laptop", "terminal"]);
    // The held approval's card is in its chat's dock.
    await expect(page.getByRole("region", { name: "Chat A dock" }).getByRole("group", { name: "Run a command on Studio" })).toBeVisible();
    await expect(transcript.getByText("xcrun simctl list devices | grep Booted").first()).toBeVisible();
    // Wire v1.3: a muted reason line above the row, only where the agent gave one.
    const reason = transcript.locator("[data-local-command-reason]");
    await expect(reason).toHaveCount(1);
    await expect(reason).toHaveText("The simulator only runs on the Mac.");
    expect(await color(reason, "color")).toBe(await token("--fg3"));
    await expect(transcript.getByText(/mcp__|Loading tool/)).toHaveCount(0);
    await expect(transcript.getByText("Error", { exact: true })).toHaveCount(0);
    expect(await color(transcript.locator('[data-local-command-row="denied"]').getByText("List booted simulators", { exact: true }), "color")).toBe(await token("--fg1"));
    await shoot(transcript, `local-command-transcript-${theme}`);
    // Always allow everywhere: no card and no waiting text.
    await open("view=transcript&approval=none", theme);
    await expect(page.locator("[data-local-command-card]")).toHaveCount(0);
    await expect(page.getByText(/Waiting for approval/)).toHaveCount(0);
    check(`RunLocalCommand rows show the laptop and prompt pair, the description and command, waiting only on a held approval (its card in the chat), plain-word endings and no Ran on, never mcp__ names, a tool search row or Error, in ${theme}`, true);

    // 12.z: a switch under each connected Mac, from the keyboard; This Mac's status dot, folder and menu.
    await open("view=sync&sync=off", theme);
    const offPopup = page.getByRole("dialog", { name: "Cloud workspace details" });
    const mine = offPopup.getByRole("switch", { name: "Sync to a local directory on Alex's MacBook Pro" });
    const studio = offPopup.getByRole("switch", { name: "Sync to a local directory on Studio" });
    await expect(mine).toHaveAttribute("aria-checked", "false");
    await expect(studio).toHaveAttribute("aria-checked", "true");
    await expect(offPopup.getByRole("group", { name: "Sync on Studio" }).getByRole("status")).toHaveText("Syncing");
    await mine.focus(); await page.keyboard.press("Space");
    expect((await calls()).at(-1)).toBe("sync:enable");
    await studio.focus(); await page.keyboard.press("Space");
    expect((await calls()).at(-1)).toBe("wanted:d2:false");
    await expect(offPopup.locator("[data-sync-path]")).toHaveCount(0);
    await shoot(offPopup, `workspace-sync-off-${theme}`);
    // A control plane without 12.z: only This Mac's switch is live.
    await open("view=sync&sync=off&old=1", theme);
    await expect(page.getByRole("switch", { name: "Sync to a local directory on Studio" })).toBeDisabled();
    await expect(page.getByRole("switch", { name: "Sync to a local directory on Alex's MacBook Pro" })).toBeEnabled();
    for (const [state, label, dot] of [["syncing", "Syncing (12 files)", "--fg3"], ["in_sync", "In sync", "--green-primary"], ["paused", "Paused (workspace asleep)", "--fg3"], ["error", "Error (more than 5 GB)", "--red-primary"]]) {
      await open(`view=sync&sync=${state}`, theme);
      const group = page.getByRole("group", { name: "Sync on Alex's MacBook Pro" });
      const status = group.getByRole("status");
      await expect(status).toHaveText(label);
      expect(await color(status, "color")).toBe(await token(state === "error" ? "--red-primary" : "--fg2"));
      expect(await color(group.locator(`[data-sync-dot="${state}"]`), "backgroundColor")).toBe(await token(dot));
      await expect(group.locator("[data-sync-path]")).toContainText("~/zeros/cloud-sync/zeros/w-19");
      if (state === "in_sync") {
        const menu = group.getByRole("button", { name: "Sync folder actions" });
        for (const [item, call] of [["Open in Finder", "sync:reveal"], ["Open terminal here", "sync:terminal"], ["Copy path", "sync:copy"], ["Choose another folder…", "sync:choose"]]) {
          await menu.focus(); await page.keyboard.press("Enter");
          await page.getByRole("menuitem", { name: item }).focus(); await page.keyboard.press("Enter");
          expect((await calls()).at(-1)).toBe(call);
        }
        const toggle = group.getByRole("switch");
        await toggle.focus(); await page.keyboard.press("Space");
        expect((await calls()).at(-1)).toBe("sync:stop");
        await shoot(group, `workspace-sync-in-sync-${theme}`);
      }
    }
    check(`Each connected Mac's sync switch works from the keyboard (This Mac at once, another Mac's wanted state, disabled on an older control plane), with each status dot and This Mac's folder menu, in ${theme}`, true);
  }
}
