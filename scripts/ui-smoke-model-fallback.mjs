import { expect } from "@playwright/test";

export async function runModelFallbackSmoke({ page, check }) {
  const fixture = page.locator("#model-fallback-fixture");
  const selected = fixture.locator("[data-model-pill-name]");
  await expect(selected).toContainText("Fable 5");
  await fixture
    .getByRole("button", { name: "Local fallback", exact: true })
    .click();
  await fixture
    .getByRole("button", { name: "Agent Fallback audit", exact: true })
    .click();
  await expect(
    fixture
      .locator("[data-agent-children]")
      .getByText("Model fallback used Opus 5", { exact: true }),
  ).toBeVisible();
  await expect(selected).toContainText("Fable 5");
  await fixture
    .getByRole("button", { name: "Local fallback", exact: true })
    .click();
  await expect(
    fixture.getByText("Model fallback used Opus 5", { exact: true }),
  ).toHaveCount(1);
  await fixture
    .getByRole("button", { name: "Session fallback", exact: true })
    .click();
  await expect(
    fixture.getByText("Model switched to Sonnet 5", { exact: true }),
  ).toBeVisible();
  await expect(selected).toContainText("Sonnet 5");
  await fixture
    .getByRole("button", { name: "Codex safety fallback", exact: true })
    .click();
  await expect(
    fixture.getByText(
      "Model fallback to Sol 5.6 because of a cybersecurity-related safety check",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(selected).toContainText("GPT-5.6 Sol");
  await fixture.getByRole("button", { name: /^Model:/ }).click();
  await expect(page.locator("[cmdk-root]")).toBeVisible();
  await page.keyboard.press("Escape");
  const legacy = fixture.locator("[data-legacy-fallback]");
  await legacy.getByRole("button", { name: "1 message", exact: true }).click();
  await expect(
    legacy.getByText("Model switched to Haiku 4.5", { exact: true }),
  ).toBeVisible();
  await expect(
    fixture.getByRole("button", { name: /^(Model fallback|Model switched)/ }),
  ).toHaveCount(0);
  await expect(fixture.locator("[data-tool-detail]")).toHaveCount(0);
  check(
    "Fallbacks are plain narration, scoped to the owning response, with the active composer model",
    true,
  );
}
