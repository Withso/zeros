import { expect } from "@playwright/test";

/** The cloud scenario owns the page clock. All account/runtime HTTP is a
 * synthetic fixture; the real details panel and composer are exercised. */
export async function runCloudRuntimeUpgradeSmoke({ page, check, harnessBase }) {
  const organizationId = "11111111-1111-4111-8111-111111111111", workspaceId = "22222222-2222-4222-8222-222222222222";
  const runtimeA = `r1-${"a".repeat(64)}`, runtimeB = `r1-${"b".repeat(64)}`;
  let transition = null, availabilityReads = 0;
  const mutations = [];
  await page.route("https://api.example.test/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const document = await page.evaluate(() => window.cloudRuntimeFixture.document);
    if (path.endsWith("/runtime-upgrade")) {
      if (request.method() !== "GET") {
        mutations.push(request.method());
        return route.fulfill({ status: 405, json: {} });
      }
      availabilityReads++;
      return route.fulfill({ json: { organizationId, workspaceId, generation: document.generation.number,
        currentRuntimeId: document.generation.number === 1 ? runtimeA : runtimeB, latestRuntimeId: runtimeB,
        updateAvailable: document.generation.number === 1,
        unavailableReason: ["draining", "provisioning", "setting_up", "rolling_back"].includes(transition?.state)
          ? "cloud_generation_transition_active" : null, transition } });
    }
    if (path.endsWith("/collaborators")) return route.fulfill({ json: { organizationId, workspaceId, accessRevision: 2,
      writers: { limit: 10, used: 1, available: 9 }, members: [], guests: [], invitations: [],
      guestCursor: null, invitationCursor: null, memberCursor: null } });
    if (path.endsWith(workspaceId)) return route.fulfill({ json: { workspace: document } });
    throw new Error(`Unexpected runtime fixture request: ${request.method()} ${path}`);
  });
  await page.goto(`${harnessBase}/harness-cloud-workspace.html?runtime=1`);
  const detailsButton = page.getByRole("button", { name: "Cloud workspace details", exact: true });
  await page.getByRole("button", { name: /^Model:/ }).click();
  await expect(page.getByText("No connected agents.", { exact: true })).toBeVisible();
  await expect(page.getByText("Updates automatically the next time this workspace wakes.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Update runtime/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await detailsButton.click();
  const details = page.getByRole("dialog", { name: "Cloud workspace details", exact: true });
  const runtime = details.getByRole("region", { name: "Workspace runtime", exact: true });
  await expect(runtime).toContainText("Runtime · r1-aaaaaaaa");
  await expect(runtime).toContainText("Updates automatically the next time this workspace wakes");
  await expect(details.getByRole("button", { name: "Manage sharing", exact: true })).toBeFocused();
  await expect(details.getByRole("button", { name: /Update runtime/ })).toHaveCount(0);
  await runtime.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".context/cloud-runtime-auto-update-available.png" });
  transition = { id: "77777777-7777-4777-8777-777777777777", generation: 2,
    runtimeId: runtimeB, state: "draining", error: null };
  await page.evaluate(() => window.cloudRuntimeFixture.publish({ status: "waking" }));
  await page.clock.fastForward(5_001);
  await expect(runtime).toContainText("Starting the cloud workspace…");
  transition.state = "setting_up";
  await page.evaluate(() => {
    const fixture = window.cloudRuntimeFixture;
    fixture.publish({ status: "setting_up", generation: { ...fixture.document.generation, number: 2 } });
  });
  await page.clock.fastForward(2_001);
  await expect(runtime).toContainText("Runtime · r1-bbbbbbbb");
  await expect(runtime).toContainText("Starting the cloud workspace…");
  transition.state = "succeeded";
  await page.evaluate(() => window.cloudRuntimeFixture.publish({ status: "ready" }));
  await page.clock.fastForward(2_001);
  await expect(runtime.getByRole("status")).toHaveCount(0);
  await expect(runtime).not.toContainText("Updates automatically");
  await runtime.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".context/cloud-runtime-auto-updated.png" });
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  const closedReads = availabilityReads;
  await page.clock.fastForward(10_001);
  expect(availabilityReads).toBe(closedReads);
  await page.clock.fastForward(30_001);
  await expect.poll(() => availabilityReads).toBeGreaterThan(closedReads);
  await detailsButton.click();
  await expect(runtime).toBeVisible();
  await page.getByRole("button", { name: "Hide workspace", exact: true }).click();
  await expect(details).toHaveCount(0);
  const hiddenReads = availabilityReads;
  await page.clock.fastForward(40_001);
  expect(availabilityReads).toBe(hiddenReads);
  await page.getByRole("button", { name: "Show workspace", exact: true }).click();
  await page.evaluate(() => window.cloudRuntimeFixture.setStaff(null));
  await detailsButton.click();
  await expect(details).toBeVisible();
  await expect(runtime).toHaveCount(0);
  const nonStaffReads = availabilityReads;
  await page.clock.fastForward(40_001);
  expect(availabilityReads).toBe(nonStaffReads);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.cloudRuntimeFixture.setStaff("developer"));
  await page.getByRole("button", { name: "Local fixture", exact: true }).click();
  await expect(detailsButton).toHaveCount(0);
  await page.getByRole("button", { name: /^Model:/ }).click();
  await expect(page.getByText("No connected agents.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Updates automatically/)).toHaveCount(0);
  const localReads = availabilityReads;
  await page.clock.fastForward(40_001);
  expect(availabilityReads).toBe(localReads);
  expect(mutations).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Search models…")).toHaveCount(0);
  check("Staff runtime details and composer explain automatic updates, follow wake/readiness, and stay inert while hidden or unauthorized", true);
  check("Local chat tabs and model menu retain their behavior, with no runtime discovery or mutation HTTP", true);
}
