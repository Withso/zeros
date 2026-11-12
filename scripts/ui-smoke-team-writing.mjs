import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Team sharing slice C with production components: a member of an activated
 * workspace restarts it, is asked for their own agent account when a send is
 * refused, sees who a running turn acts as, and reads the personal-secret
 * notice. Every control-plane route is intercepted. PNGs only when
 * ZEROS_SMOKE_SHOTS names a directory. */
export async function runTeamWritingSmoke({ page, harnessBase, check }) {
  const base = `${new URL(harnessBase).origin}/apps/desktop/src/renderer/harnesses/harness-team-writing.html`;
  const shots = process.env.ZEROS_SMOKE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  // The most recently added route wins: the catch-all first, then the roster.
  await page.route("https://api.example.test/**", route => route.fulfill({ status: 404, json: { error: { code: "not_found", message: "Not in this fixture" } } }));
  await page.route("https://api.example.test/v1/organizations/*/members", route => route.fulfill({ json: { members: [
    { id: "44444444-4444-4444-8444-444444444444", display_name: "Alex Rivera", email: "alex@example.test", avatar_url: null, role: "member" },
    { id: "11111111-1111-4111-8111-111111111111", display_name: "Fixture", email: "fixture@example.test", avatar_url: null, role: "member" },
  ] } }));
  for (const theme of ["dark", "light"]) {
    await page.goto(`${base}?theme=${theme}`);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    const details = page.getByRole("region", { name: "Details" });
    await expect(details.getByRole("button", { name: "Restart workspace" })).toBeVisible();
    await expect(details.getByRole("button", { name: "Stop workspace" })).toBeVisible();
    const turn = page.getByLabel("Running turn");
    await expect(turn.getByText("Acting as Alex Rivera", { exact: true })).toBeVisible();
    const card = page.locator("[data-turn-failure-card]");
    await expect(card.getByText("Connect your Claude account to send messages in this workspace.")).toBeVisible();
    await expect(card.getByRole("button", { name: "Reconnect provider account" })).toHaveCount(0);
    await card.getByRole("button", { name: "Connect your Claude account" }).click();
    await card.getByRole("button", { name: "Retry" }).click();
    await details.getByRole("button", { name: "Restart workspace" }).click();
    expect(await page.evaluate(() => window.__teamWritingFixture.calls())).toEqual(["connect:claude", "retry", "restart"]);
    await expect(page.locator("[data-team-writing-notice]")).toHaveText(/members can read the agent login and personal secrets/);
    if (shots) await page.locator("main").screenshot({ path: join(shots, `team-writing-${theme}.png`) });
    check(`A writing member restarts, connects their own account, retries, and sees who a turn acts as and the secret notice in ${theme}`, true);
  }
  for (const theme of ["dark", "light"]) {
    await page.goto(`${base}?theme=${theme}&view=ended`);
    await expect(page.getByRole("status").getByText("You no longer have access to w-7", { exact: true })).toBeVisible();
    await expect(page.getByText("Your drafts stay on this Mac.", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Workspace").getByRole("button")).toHaveCount(0);
    await expect(page.getByLabel("Sync status")).toHaveText("Stopped: you no longer have access");
    if (shots) await page.locator("main").screenshot({ path: join(shots, `team-writing-ended-${theme}.png`) });
    check(`A member who lost access sees it plainly, with no action and sync stopped, in ${theme}`, true);
  }
  await page.goto(`${base}?theme=dark&actor=me`);
  await expect(page.getByLabel("Running turn").getByText("Acting as you", { exact: true })).toBeVisible();
  check("A member's own running turn says Acting as you", true);
}
