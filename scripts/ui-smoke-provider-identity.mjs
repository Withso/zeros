import { expect } from "@playwright/test";

export async function runProviderIdentitySmoke({ page, check }) {
  const base = new URL(page.url()).origin;
  const dialog = page.getByRole("dialog");
  const counts = () => page.evaluate(() => window.__providerIdentity.counts());
  const focus = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const setCli = (provider, state, email) => page.evaluate(
    ({ provider, state, email }) => window.__providerIdentity.setCli(provider, state, email),
    { provider, state, email },
  );
  const visibility = (hidden) => page.evaluate(hidden => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: hidden ? "hidden" : "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

  for (const provider of ["claude", "codex", "cursor"]) {
    await page.goto(`${base}/apps/desktop/src/renderer/harnesses/harness-subscription.html?usage=${provider}&identity`);
    await page.getByRole("button", { name: "Connected via subscription", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("user@example.test is connected");
    const before = await counts();

    if (provider === "cursor") {
      await expect(dialog.getByRole("button", { name: "CLI", exact: true })).toHaveCount(0);
    } else {
      await dialog.getByRole("button", { name: "CLI", exact: true }).click();
      await expect(dialog.getByRole("status")).toHaveText("cli@example.test is connected");
      await expect(page.getByRole("button", { name: "Connected via CLI", exact: true, includeHidden: true })).toHaveCount(1);
      await expect(dialog.getByRole("button", { name: "Open terminal", exact: true })).toBeVisible();
      expect((await counts()).terminals).toBe(before.terminals);
      expect((await counts()).browser).toBe(before.browser);

      await setCli(provider, "connected", "external@example.test");
      await focus();
      await expect(dialog.getByRole("status")).toHaveText("external@example.test is connected");

      // A focus arriving during an older native read must get one fresh read.
      await page.evaluate(() => window.__providerIdentity.hold());
      await dialog.getByRole("button", { name: /^Refresh .* subscription$/ }).click();
      await expect.poll(() => page.evaluate(() => window.__providerIdentity.pending())).toBe(1);
      await setCli(provider, "connected", "newer@example.test");
      await focus();
      await page.evaluate(() => window.__providerIdentity.release());
      await expect(dialog.getByRole("status")).toHaveText("newer@example.test is connected");

      await page.clock.install();
      await page.evaluate(() => window.__providerIdentity.hold());
      await dialog.getByRole("button", { name: /^Refresh .* subscription$/ }).click();
      await expect.poll(() => page.evaluate(() => window.__providerIdentity.pending())).toBe(1);
      await focus();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Toggle retained surface" }).click();
      const retained = await counts();
      await setCli(provider, "connected", "revealed@example.test");
      await focus();
      await page.evaluate(() => window.__providerIdentity.release());
      await page.clock.fastForward(1000);
      expect((await counts()).reads).toBe(retained.reads);
      await page.getByRole("button", { name: "Toggle retained surface" }).click();
      await page.getByRole("button", { name: "Connected via CLI", exact: true }).click();
      await expect(dialog.getByRole("status")).toHaveText("revealed@example.test is connected");

      await visibility(true);
      const hidden = await counts();
      await setCli(provider, "connected", "returned@example.test");
      await focus();
      await page.clock.fastForward(31_000);
      expect((await counts()).reads).toBe(hidden.reads);
      await visibility(false);
      await focus();
      await expect(dialog.getByRole("status")).toHaveText("returned@example.test is connected");

      await setCli(provider, "connected");
      await focus();
      await expect(dialog.getByRole("status")).toHaveText("CLI is connected");
      await expect(dialog).not.toContainText("returned@example.test");
      const info = page.locator(`[aria-label="${provider === "claude" ? "Claude" : "Codex"} account information"]`);
      await expect(info.getByRole("button", { name: /Refresh .* usage/, includeHidden: true })).toBeDisabled();
      await expect(info).not.toContainText("Try refreshing.");

      await setCli(provider, "disconnected");
      await focus();
      await expect(dialog.getByRole("status")).toHaveCount(0);
      await expect(dialog.locator('[aria-label="Connected"]')).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Open terminal", exact: true })).toBeVisible();

      // CLI metadata must not leak back into the saved subscription choice.
      await dialog.getByRole("button", { name: "Account", exact: true }).click();
      await expect(dialog.getByRole("status")).toHaveText("user@example.test is connected");
      check(`${provider}: existing CLI detection, external account changes, logout and hidden observation`, true);
    }

    await dialog.getByRole("button", { name: "API", exact: true }).click();
    const vendor = { claude: "Anthropic", codex: "OpenAI", cursor: "Cursor" }[provider];
    await dialog.getByLabel(`${vendor} API key`).fill("fixture-api-key");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("API key is connected");
    await expect(dialog).not.toContainText("user@example.test");
    await expect(dialog).not.toContainText("cli@example.test");
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Account", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("user@example.test is connected");
    check(`${provider}: Account and API feedback use only the selected connection`, true);
  }
}
