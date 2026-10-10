import { expect } from "@playwright/test";

export async function runCodexRuntimeUiSmoke({ page, check, harnessBase }) {
  for (const placement of ["local", "cloud"]) {
    for (const theme of ["dark", "light"]) {
      await page.goto(`${harnessBase}/harness-codex-runtime-ui.html?placement=${placement}&theme=${theme}`);
      const row = state => page.locator(`#codex-mcp-${state} [data-tool-id=linear]`);
      await expect(row("authenticate").getByRole("button", { name: "Authenticate linear", exact: true })).toHaveText("Authenticate");
      for (const state of ["opening", "stale-completion"]) {
        await expect(row(state).getByRole("button", { name: "Authenticate linear", exact: true })).toHaveText("Opening…");
        await expect(row(state).getByRole("button")).toBeDisabled();
        await expect(row(state).getByRole("img", { name: /Connected|Sign-in failed/ })).toHaveCount(0);
      }
      await expect(row("connected").getByRole("img", { name: "Connected", exact: true })).toBeVisible();
      await expect(row("failed").getByRole("img", { name: "Sign-in failed", exact: true })).toBeVisible();
      await row("failed").getByRole("button", { name: "Authenticate linear", exact: true }).click();
      await expect(row("failed").getByRole("button")).toHaveText("Opening…");
      await expect(row("failed").getByRole("button")).toBeDisabled();
      await page.evaluate(() => window.setCodexMcpFixture("failed", "connected"));
      await expect(row("failed").getByRole("img", { name: "Connected", exact: true })).toBeVisible();
      await row("authenticate").getByRole("button", { name: "Authenticate linear", exact: true }).click();
      await expect(row("authenticate").getByRole("button")).toHaveText("Opening…");
      for (const id of ["authenticate", "opening", "stale-completion", "connected", "failed"]) {
        await expect(page.locator(`#codex-mcp-${id} [data-tool-group-count]`)).toHaveText("3");
        await expect(page.locator(`#codex-mcp-${id} [data-tool-id=github] [role=img]`)).toHaveAttribute("aria-label", "Connected");
        await expect(page.locator(`#codex-mcp-${id} [data-tool-id=sentry] [role=img]`)).toHaveAttribute("aria-label", "Connected");
      }
      check(`MCP Authenticate, Opening, ignored stale completion, success, failure and retry render in ${placement}/${theme}`, true);

      const write = page.locator("#codex-write-access [data-permission-card]");
      await expect(write.getByText("Do you want to allow write access outside the workspace?", { exact: true })).toBeVisible();
      await expect(write.locator("[data-permission-context-item]")).toHaveText(["Write · ../shared/build"]);
      await expect(write).not.toContainText("pnpm build");
      await expect(write).not.toContainText("Reads unchanged");
      await expect(write).not.toContainText("Network unchanged");
      await expect(write.getByRole("button")).toHaveText([/Yes/, /Allow for this chat/, /No/]);
      await write.getByRole("button", { name: /^Yes/ }).click();
      await expect.poll(() => page.evaluate(() => window.codexPermissionResponses)).toEqual(["codex-write-access:accept"]);
      const ordinary = page.locator("#codex-ordinary-approval [data-permission-card]");
      await expect(ordinary).toContainText("Do you want to run this command?");
      await expect(ordinary).toContainText("Bash");
      await expect(ordinary).toContainText("pnpm test --filter engine");
      await expect(ordinary.locator("[data-permission-context-item]")).toHaveCount(0);
      await expect(ordinary.getByRole("button")).toHaveText([/Yes/, /Allow for this chat/, /No/]);
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      check(`Write access uses one chip and unchanged options; ordinary command stays visible in ${placement}/${theme}`, fits);
    }
  }
}
