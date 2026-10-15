import { expect } from "@playwright/test";

const states = [
  { id: "claude", agent: "Claude Code", model: "claude-opus-5-5[1m]", name: "Opus 5.5", effort: "Medium" },
  { id: "codex", agent: "Codex", model: "gpt-6.1-sol", name: "GPT-6.1 Sol", effort: "Max" },
  { id: "cursor", agent: "Cursor", model: "grok-4.7", name: "Grok 4.7", effort: "Extra High" },
  { id: "saved", agent: "Claude Code", model: "claude-sonnet-5-5[1m]", name: "Sonnet 5.5", effort: "High" },
  { id: "remembered", agent: "Claude Code", model: "claude-opus-5-5[1m]", name: "Opus 5.5", effort: "High" },
];

export async function runSharedDefaultModelSmoke({ page, harnessBase, check }) {
  const harness = `${harnessBase}/harness-model-menu.html`;
  await runUnavailableModelSmoke({ page, harnessBase, check });
  for (const placement of ["local", "cloud"]) for (const theme of ["dark", "light"]) for (const state of states) {
    const query = `defaults=${state.id}&placement=${placement}&theme=${theme}`;
    await page.goto(`${harness}?${query}`);
    const fixture = page.locator(`[data-default-model-scenario="${state.id}"]`);
    const pill = fixture.getByRole("button", { name: /^Model:/ });
    await expect(pill.locator("[data-model-pill-label]")).toHaveText(`${state.name} ${state.effort}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const born = await page.evaluate(() => globalThis.defaultPolicyFixture.born);
    check(`${placement}/${theme}/${state.id} starts with Fast off`, born.fast === false);
    const authenticated = await page.evaluate(() => globalThis.defaultPolicyFixture.authenticated());
    if (placement === "cloud" && state.id === "codex") {
      check("Cloud provider priority uses actor grants instead of the device's three connections", authenticated.filter(agent => agent.authenticated).map(agent => agent.id).join() === "codex");
    }
    await pill.click();
    if (state.id === "saved") await expect(page.getByRole("switch", { name: /Fast mode/ })).toHaveCount(0);
    else await expect(page.getByRole("switch", { name: /Fast mode/ })).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("selected-model-browser").hover();
    const catalog = page.getByTestId("model-catalog-sidecar");
    const defaultRow = catalog.locator(`[data-model-catalog-item][data-model-value="${state.model}"]`);
    await expect(defaultRow.locator("[data-default-model-indicator]")).toHaveCount(1);
    await expect(catalog.locator("[data-default-model-indicator]")).toHaveCount(1);
    if (state.id === "saved") {
      await expect(defaultRow).toHaveAttribute("aria-disabled", "true");
      await expect(defaultRow.getByRole("button")).toBeDisabled();
      await expect(catalog.getByRole("group", { name: "Claude Code", exact: true }).locator("[data-model-catalog-item]")).toHaveCount(1);
    }
    const selection = await page.evaluate(() => globalThis.defaultPolicyFixture.selection());
    check(`${placement}/${theme}/${state.id} preserves explicit versus implicit preference`, state.id === "saved"
      ? selection?.model === state.model : selection === null);
    check(`${placement}/${theme}/${state.id} new-chat pill and single catalog star agree`, true);

    await page.goto(`${harness}?${query}&settings`);
    const settings = page.locator("#default-model-settings");
    await expect(settings.locator("[data-default-agent-picker]")).toHaveText(state.agent);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(settings.locator("[data-default-model-picker]")).toHaveText(state.name);
    check(`${placement}/${theme}/${state.id} Settings uses the same effective default`, true);
  }

  await page.goto(`${harness}?defaults=claude&owner=organization&placement=local`);
  await expect(page.locator("[data-model-pill-label]")).toHaveText("Opus 5.5 Medium");
  await page.goto(`${harness}?defaults=claude&owner=organization&placement=local&settings`);
  await expect(page.locator("#default-model-settings [data-default-agent-picker]")).toHaveText("Claude Code");
  check("An organization-owned Local workspace follows the same birth policy", true);
}

export async function runUnavailableModelSmoke({ page, harnessBase, check }) {
  const harness = `${harnessBase}/harness-model-menu.html`;
  for (const scope of ["placement=local", "owner=organization&placement=local", "placement=cloud"]) {
    for (const theme of ["dark", "light"]) {
      await page.goto(`${harness}?defaults=cursor&unavailableModel&${scope}&theme=${theme}`);
      await page.getByRole("button", { name: /^Model:/ }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("radio")).toHaveCount(0);
      await page.getByTestId("selected-model-browser").hover();
      const catalog = page.getByTestId("model-catalog-sidecar");
      const row = catalog.locator('[data-model-catalog-item][data-model-value="grok-4.7"]');
      await expect(row).toHaveAttribute("aria-disabled", "true");
      await expect(row.getByRole("button", { name: /^Select/ })).toBeDisabled();
      await expect(row.getByText("Unavailable for this account.", { exact: true })).toBeVisible();
      await catalog.getByRole("button", { name: "Show available models", exact: true }).click();
      await expect(catalog.locator("[data-model-unavailable]")).toHaveCount(0);
      await catalog.locator('[data-model-catalog-item][data-model-value="composer-2.5"]').getByRole("button", { name: /^Select/ }).click({ position: { x: 12, y: 12 } });
      await expect(page.locator("[data-model-pill-name]")).toHaveText("Composer 2.5");
      check(`${scope}/${theme} rejected model explains unavailability and offers an eligible choice`, true);
    }
  }
}
