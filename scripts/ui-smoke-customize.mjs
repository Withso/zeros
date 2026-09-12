import { expect } from "@playwright/test";

export async function runCustomizeSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-customize.html`,
  );
  const providerTabs = page.getByRole("tablist", { name: "Agent provider" });
  await expect(providerTabs.getByRole("tab")).toHaveText([
    "Zeros",
    "Claude",
    "Codex",
    "Cursor",
  ]);
  await page.getByRole("button", { name: "New skill", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("review-changes");
  await page.getByLabel("When to use it").fill("Review changed code");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Inspect the diff and verify behavior.");
  await page.getByRole("button", { name: "Save skill", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "review-changes", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#last-write")).toContainText(
    '"expectedRevision":null',
  );
  check("Zeros skills save and return to a refreshed inventory", true);

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Unsaved user draft");
  await page.getByRole("button", { name: "Customize scope" }).click();
  await page.getByRole("menuitem").filter({ hasText: "Repo A" }).click();
  await expect(
    page.getByRole("button", { name: "Save skill", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "New skill", exact: true }).click();
  await expect(page.getByLabel("Instructions", { exact: true })).toHaveValue(
    "",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  check(
    "scope switching cannot move an unsaved skill draft into another repository",
    true,
  );

  for (const category of ["Plugins", "Apps"]) {
    await page.getByRole("tab", { name: category, exact: true }).click();
    await expect(providerTabs.getByRole("tab")).toHaveText([
      "Claude",
      "Codex",
      "Cursor",
    ]);
    await expect(
      page.getByRole("button", { name: /New skill|New MCP/ }),
    ).toHaveCount(0);
  }
  await page.getByRole("tab", { name: "Codex", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Cloud notes", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Available", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Unavailable in Zeros", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Some features require the native app/),
  ).toBeVisible();
  check(
    "account apps distinguish callable tools from native surface limitations",
    true,
  );
  await page.screenshot({
    path: ".context/customize-codex-apps.png",
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Claude", exact: true }).click();
  await page.getByRole("tab", { name: "MCP", exact: true }).click();
  await expect(providerTabs.getByRole("tab")).toHaveText([
    "Zeros",
    "Claude",
    "Codex",
    "Cursor",
  ]);
  await expect(
    page.getByRole("heading", { name: "claude fixture", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /New MCP server/ }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Zeros", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /New MCP server/ }),
  ).toBeVisible();
  check(
    "provider rows and creation controls match every Customize category",
    true,
  );
  await page.screenshot({
    path: ".context/customize-final.png",
    fullPage: true,
  });
}
