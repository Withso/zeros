import { expect } from "@playwright/test";

export async function runCloudWorkspaceSmoke({ page, check, harnessBase }) {
  await page.goto(`${harnessBase}/harness-cloud-workspace.html`);
  const button = page.getByRole("button", {
    name: "Cloud workspace details",
    exact: true,
  });
  const lane = page.getByRole("tablist", { name: "Chat sessions" });
  await expect(button).toBeVisible();
  const before = await button.boundingBox();
  await lane.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect
    .poll(() => lane.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  expect((await button.boundingBox()).x).toBe(before.x);
  expect((await button.boundingBox()).x + before.width).toBeLessThanOrEqual(
    (await lane.boundingBox()).x,
  );
  await button.click();
  const details = page.getByRole("dialog", { name: "Cloud workspace details" });
  await expect(details).toBeVisible();
  for (const value of [
    "example/project",
    "Setup succeeded",
    "Running",
    "2 cores",
    "4 GiB",
    "20 GiB",
  ])
    await expect(details.getByText(value, { exact: true })).toBeVisible();
  await expect(details).not.toContainText(/SSH|Agent costs|%/);
  await page.screenshot({ path: ".context/cloud-workspace-ui.png" });
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(button).toBeFocused();
  await page
    .getByRole("button", { name: "Local fixture", exact: true })
    .click();
  await expect(button).toHaveCount(0);
  await expect(lane.getByRole("tab")).toHaveCount(12);
  check(
    "Cloud details stay fixed beside the existing chat tabs, show capacities, and restore keyboard focus",
    true,
  );
}
