import { expect } from "@playwright/test";

/** The cloud-workspace scenario already owns the page clock and real details
 * panel. This fixture exercises only synthetic account/workspace HTTP state. */
export async function runCloudRuntimeUpgradeSmoke({ page, check, harnessBase }) {
  const organizationId = "11111111-1111-4111-8111-111111111111", workspaceId = "22222222-2222-4222-8222-222222222222";
  const runtimeA = `r1-${"a".repeat(64)}`, runtimeB = `r1-${"b".repeat(64)}`;
  let latestRuntimeId = runtimeB, transition = null, rejectBusy = false, availabilityReads = 0;
  const mutations = [];
  await page.route("https://api.example.test/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const document = await page.evaluate(() => window.cloudRuntimeFixture.document);
    if (path.endsWith("/runtime-upgrade")) {
      if (request.method() === "GET") {
        availabilityReads++;
        return route.fulfill({ json: { organizationId, workspaceId, generation: document.generation.number,
          currentRuntimeId: document.generation.number === 1 ? runtimeA : runtimeB, latestRuntimeId,
          updateAvailable: document.generation.number === 1 || latestRuntimeId !== runtimeB,
          unavailableReason: ["draining", "provisioning", "setting_up", "rolling_back"].includes(transition?.state)
            ? "cloud_generation_transition_active" : document.status === "busy" ? "cloud_workspace_busy" : null,
          transition } });
      }
      const body = request.postDataJSON();
      mutations.push(body);
      expect(Object.keys(body).sort()).toEqual(["expectedGeneration", "operationId"]);
      expect(request.headers()["idempotency-key"]).toBe(body.operationId);
      if (rejectBusy) return route.fulfill({ status: 409, json: { error: { code: "cloud_workspace_busy", message: "Stop running agents before updating." } } });
      transition = { id: "77777777-7777-4777-8777-777777777777", generation: body.expectedGeneration + 1,
        runtimeId: latestRuntimeId, state: "draining", error: null };
      return route.fulfill({ status: 202, json: { operationId: body.operationId, sourceGeneration: body.expectedGeneration,
        generation: transition.generation, runtimeId: transition.runtimeId, transitionId: transition.id, unchanged: false } });
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
  await expect(page.getByText("Runtime update available.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Update runtime…", exact: true }).click();
  await expect(page.getByPlaceholder("Search models…")).toHaveCount(0);
  const details = page.getByRole("dialog", { name: "Cloud workspace details", exact: true });
  const runtime = details.getByRole("region", { name: "Workspace runtime", exact: true });
  const update = runtime.getByRole("button", { name: "Update runtime", exact: true });
  await expect(runtime).toContainText("Runtime · r1-aaaaaaaa");
  await expect(runtime.getByText("Update available", { exact: true })).toBeVisible();
  await expect(update).toBeFocused();
  expect(mutations).toHaveLength(0);
  await update.click();
  const confirmation = page.getByRole("dialog", { name: "Update cloud runtime?", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  for (const text of ["save a checkpoint and restart", "Git changes and history", "chats, transcripts", "Terminals and setup or preview processes stop", "Ignored and secret files"])
    await expect(confirmation).toContainText(text);
  await page.screenshot({ path: ".context/cloud-runtime-upgrade-confirmation.png" });
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(update).toBeFocused();
  expect(mutations).toHaveLength(0);
  await update.click();
  await confirmation.getByRole("button", { name: "Update runtime", exact: true }).click();
  await expect(runtime).toContainText("Updating runtime…");
  await page.clock.fastForward(2_001);
  await expect(runtime).toContainText("Saving checkpoint…");
  expect(mutations).toHaveLength(1);
  expect(mutations[0].expectedGeneration).toBe(1);
  await expect(details.getByText("Running", { exact: true })).toBeVisible();
  transition.state = "setting_up";
  await page.evaluate(() => {
    const fixture = window.cloudRuntimeFixture;
    fixture.publish({ status: "setting_up", generation: { ...fixture.document.generation, number: 2 } });
  });
  await page.clock.fastForward(2_001);
  await expect(runtime).toContainText("Setting up workspace…");
  transition.state = "succeeded";
  await page.evaluate(() => window.cloudRuntimeFixture.publish({ status: "ready" }));
  await page.clock.fastForward(2_001);
  await expect(runtime).toContainText("Runtime · r1-bbbbbbbb");
  await expect(runtime.getByText("Updating runtime…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Cloud runtime updated", { exact: true })).toBeVisible();
  await runtime.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".context/cloud-runtime-upgraded.png" });
  latestRuntimeId = `r1-${"c".repeat(64)}`;
  rejectBusy = true;
  await page.clock.fastForward(5_001);
  await expect(update).toBeEnabled();
  await update.click();
  await confirmation.getByRole("button", { name: "Update runtime", exact: true }).click();
  await expect(page.getByText("Couldn't update cloud runtime", { exact: true })).toBeVisible();
  await expect(page.getByText("Stop running agents before updating.", { exact: true })).toBeVisible();
  expect(mutations).toHaveLength(2);
  expect(mutations[1].expectedGeneration).toBe(2);
  expect(mutations[1].operationId).not.toBe(mutations[0].operationId);
  await page.evaluate(() => window.cloudRuntimeFixture.publish({ status: "busy" }));
  await expect(update).toBeDisabled();
  await page.clock.fastForward(5_001);
  await expect(runtime).toContainText("Stop running agents and active workspace work");
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  const closedReads = availabilityReads;
  await page.clock.fastForward(10_001);
  expect(availabilityReads).toBe(closedReads);
  await page.clock.fastForward(30_001);
  await expect.poll(() => availabilityReads).toBeGreaterThan(closedReads);
  await detailsButton.click();
  await expect(runtime).toBeVisible();
  await expect(details.getByRole("button", { name: "Manage sharing", exact: true })).toBeFocused();
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
  await expect(page.getByRole("button", { name: "Update runtime…", exact: true })).toHaveCount(0);
  const localReads = availabilityReads;
  await page.clock.fastForward(40_001);
  expect(availabilityReads).toBe(localReads);
  expect(mutations).toHaveLength(2);
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Search models…")).toHaveCount(0);
  check("Composer opens the staff runtime row; update confirms preservation, waits for readiness, toasts failures, and stays inert while hidden or unauthorized", true);
  check("Local chat tabs and model-menu behavior stay unchanged and perform no runtime discovery or upgrade HTTP", true);
}
