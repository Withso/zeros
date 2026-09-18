import { expect } from "@playwright/test";

export async function runDesignInspectorRacesSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  await page
    .locator('#design-layers-panel [data-design-layer-id="home-heading"]')
    .click();
  await page.getByRole("button", { name: "Text details", exact: true }).click();
  const field = page.locator('[data-design-style-property="word-spacing"]');
  const input = field.locator("input");
  const heading = page
    .frameLocator(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    )
    .locator('[data-oid="home-heading"]');
  const spacing = () => heading.evaluate((node) => node.style.wordSpacing);
  await page.evaluate(() => {
    window.__zerosHarnessStyleDelay = 1500;
  });

  await input.fill("12");
  await input.press("Enter");
  await expect.poll(spacing, { timeout: 300 }).toBe("12px");
  await field.getByLabel("Unit for Word gap").click();
  await page.getByRole("option", { name: "em", exact: true }).click();
  await expect.poll(spacing, { timeout: 300 }).toBe("12em");
  await input.fill("");
  await input.press("Enter");
  await expect.poll(spacing, { timeout: 300 }).toBe("");
  check("rapid numeric commits and unit changes paint before saving", true);

  await input.fill("99");
  await input.press("Escape");
  await expect.poll(spacing, { timeout: 300 }).toBe("");
  expect(
    await page.evaluate(
      () =>
        (window.__zerosHarnessDesignShortcutOperations ?? []).filter(
          (op) => op === "style:end",
        ).length,
    ),
  ).toBe(0);
  check(
    "Escape cancels the new draft while retaining the preceding committed preview",
    true,
  );

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window.__zerosHarnessDesignShortcutOperations ?? []).filter(
              (op) => op === "style:end",
            ).length,
        ),
      { timeout: 10_000 },
    )
    .toBe(3);
  await expect.poll(spacing).toBe("");
  await expect(input).toHaveValue("0");
  check(
    "numeric saves settle once per intent without restoring an older unit or value",
    true,
  );
}
