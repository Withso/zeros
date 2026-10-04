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

  await page.clock.install();
  await page.goto(`${harnessBase}/harness-cloud-native-access.html`);
  const access = page.getByRole("region", { name: "SSH and port forwarding" });
  await expect(access.getByRole("button", { name: "Open Terminal", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.cloudNativeFixture.calls.every(call =>
    ["cloud_workspace_access_context", "cloud_workspace_access_list"].includes(call.command)))).toBe(true);
  await access.getByRole("button", { name: "Copy SSH command", exact: true }).click();
  await expect(access.getByText("SSH connection", { exact: true })).toBeVisible();
  await access.getByLabel("Workspace port", { exact: true }).fill("4173");
  await access.getByLabel("Mac port", { exact: true }).fill("5173");
  await access.getByRole("button", { name: "Forward port", exact: true }).click();
  await expect(access.getByText("127.0.0.1:5173 → 4173", { exact: true })).toBeVisible();
  const mutation = await page.evaluate(() => window.cloudNativeFixture.calls.find(call => call.command === "cloud_workspace_tunnel_start"));
  expect(mutation.args).toMatchObject({ remotePort: 4173, localPort: 5173, keyVersion: 1 });
  expect(Object.keys(mutation.args).sort()).toEqual(["authorityId", "deviceId", "keyVersion", "localPort", "organizationId", "remotePort", "workspaceId"]);

  // Revalidation retains the last confirmed connections. A hidden surface
  // neither subscribes to reads nor polls while the pending read completes.
  await page.evaluate(() => { window.cloudNativeFixture.holdRead = true; });
  await page.clock.fastForward(5_001);
  await expect(access.getByText("SSH connection", { exact: true })).toBeVisible();
  await expect(access.getByText("127.0.0.1:5173 → 4173", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Toggle visibility", exact: true }).click();
  await expect(access).toHaveCount(0);
  await page.evaluate(() => { window.cloudNativeFixture.holdRead = false; window.cloudNativeFixture.releaseRead(); });
  const hiddenCalls = await page.evaluate(() => window.cloudNativeFixture.calls.length);
  await page.clock.fastForward(10_001);
  expect(await page.evaluate(() => window.cloudNativeFixture.calls.length)).toBe(hiddenCalls);
  await page.getByRole("button", { name: "Toggle visibility", exact: true }).click();
  await expect(access.getByText("SSH connection", { exact: true })).toBeVisible();
  await access.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(access.getByText("SSH connection", { exact: true })).toHaveCount(0);
  await expect(access.getByText("127.0.0.1:5173 → 4173", { exact: true })).toBeVisible();
  await page.screenshot({ path: ".context/e1-native-access-ui.png" });
  await page.getByRole("button", { name: "Toggle edit access", exact: true }).click();
  await expect(access.getByRole("button", { name: "Open Terminal", exact: true })).toBeDisabled();
  await expect(access.getByRole("button", { name: "Forward port", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Disable internal feature", exact: true }).click();
  await expect(access).toHaveCount(0);
  check("Staff native access uses exact device context, retains snapshots, isolates close and leaves hidden controls inert", true);
}
