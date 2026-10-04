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
  await runCloudWorkspaceSharingSmoke({ page, check, harnessBase });
}

export async function runCloudWorkspaceSharingSmoke({ page, check, harnessBase }) {
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const ownerId = "33333333-3333-4333-8333-333333333333";
  const developerId = "44444444-4444-4444-8444-444444444444";
  const prompterId = "55555555-5555-4555-8555-555555555555";
  const viewerId = "66666666-6666-4666-8666-666666666666";
  const invitationId = "77777777-7777-4777-8777-777777777777";
  const expiresAt = "2026-11-01T00:00:00Z";
  let used = 9;
  let invitations = [];
  let conflictNextSharing = false;
  let ownerOnly = false;
  let preservedPrivate = false;
  const sharingWrites = [];
  let collaboratorReads = 0;
  const writers = () => ({ limit: 10, used, available: 10 - used });
  await page.route("https://api.example.test/v1/cloud-workspaces/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const document = await page.evaluate(() => window.cloudWorkspaceSharingFixture.document);
    const reply = (body, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname.endsWith("/collaborators") && request.method() === "GET") {
      collaboratorReads++;
      return reply({ workspaceId, organizationId, accessRevision: document.accessRevision, writers: writers(),
        members: preservedPrivate ? [{ userId: ownerId, displayName: "Fixture owner", role: "owner" }] : url.searchParams.has("memberCursor")
          ? [{ userId: developerId, displayName: "Assigned developer", role: "developer" }]
          : [{ userId: ownerId, displayName: "Fixture owner", role: "owner" }, { userId: viewerId, displayName: "Organization viewer", role: "viewer" }],
        guests: preservedPrivate ? [] : [{ id: invitationId, userId: prompterId, displayName: "Invited prompter", role: "prompter", revision: 1, expiresAt }],
        invitations, guestCursor: null, invitationCursor: null, memberCursor: preservedPrivate || url.searchParams.has("memberCursor") ? null : viewerId });
    }
    if (url.pathname.endsWith("/sharing") && request.method() === "PATCH") {
      const body = request.postDataJSON();
      sharingWrites.push(body);
      expect(body.expectedRevision).toBe(document.accessRevision);
      const next = { sharingMode: conflictNextSharing ? "organization" : body.sharingMode, accessRevision: document.accessRevision + 1 };
      await page.evaluate(next => window.cloudWorkspaceSharingFixture.publishSharing(next.sharingMode, next.accessRevision), next);
      if (conflictNextSharing) {
        conflictNextSharing = false;
        return reply({ error: { code: "cloud_workspace_access_conflict", message: "Workspace sharing changed" } }, 409);
      }
      ownerOnly = false;
      return reply(next);
    }
    if (url.pathname.endsWith("/invitations") && request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({ email: "guest@example.test", role: "developer" });
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      if (ownerOnly) return reply({ error: { code: "cloud_workspace_sharing_required", message: "Enable workspace collaboration before inviting guests" } }, 409);
      used++;
      invitations = [{ id: invitationId, role: "developer", expiresAt, deliveryState: "queued" }];
      return reply({ invitation: { id: invitationId, expiresAt }, replayed: false }, 201);
    }
    if (url.pathname.endsWith(`/invitations/${invitationId}`) && request.method() === "DELETE") {
      used--; invitations = [];
      return reply({ revoked: true });
    }
    if (url.pathname.endsWith(workspaceId) && request.method() === "GET") return reply({ workspace: document });
    throw new Error(`Unexpected sharing fixture request: ${request.method()} ${url.pathname}`);
  });
  await page.goto(`${harnessBase}/harness-cloud-workspace.html?sharing=1`);
  const button = page.getByRole("button", { name: "Cloud workspace details", exact: true });
  await button.hover();
  await expect.poll(() => collaboratorReads).toBe(1);
  await button.click();
  const details = page.getByRole("dialog", { name: "Cloud workspace details" });
  await details.getByRole("button", { name: "Manage sharing", exact: true }).click();
  await expect(details.getByText("9 / 10 writer slots used", { exact: true })).toBeVisible();
  expect(collaboratorReads).toBe(1);
  await expect(details.getByRole("combobox", { name: "Role for You" })).toHaveCount(0);
  await details.getByRole("button", { name: "More members", exact: true }).click();
  await expect(details.getByText("Assigned developer", { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "More members", exact: true })).toHaveCount(0);
  await page.screenshot({ path: ".context/e5-sharing-ui.png" });

  await details.getByRole("combobox", { name: "Workspace sharing scope", exact: true }).click();
  await page.getByRole("option", { name: "Private", exact: true }).click();
  await expect.poll(() => sharingWrites.length).toBe(1);
  expect(sharingWrites[0]).toEqual({ sharingMode: "private", expectedRevision: 2 });
  await expect(details.getByRole("combobox", { name: "Workspace sharing scope", exact: true })).toContainText("Private");
  conflictNextSharing = true;
  await expect(details.getByRole("combobox", { name: "Workspace sharing scope", exact: true })).toBeEnabled();
  await details.getByRole("combobox", { name: "Workspace sharing scope", exact: true }).click();
  await page.getByRole("option", { name: "Organization", exact: true }).click();
  await expect(page.getByText("Workspace sharing changed", { exact: true })).toBeVisible();
  expect(sharingWrites).toEqual([{ sharingMode: "private", expectedRevision: 2 }, { sharingMode: "organization", expectedRevision: 3 }]);
  await expect(details.getByRole("combobox", { name: "Workspace sharing scope", exact: true })).toBeEnabled();
  await expect(details.getByRole("combobox", { name: "Workspace sharing scope", exact: true })).toContainText("Organization");

  await details.getByRole("textbox", { name: "Collaborator email", exact: true }).fill("guest@example.test");
  await details.getByRole("combobox", { name: "Invitation role", exact: true }).click();
  await page.getByRole("option", { name: "Developer", exact: true }).click();
  await details.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(details.getByText("10 / 10 writer slots used", { exact: true })).toBeVisible();
  await expect(details.getByText("All writer slots are in use. Invite a viewer or downgrade a writer first.", { exact: true })).toBeVisible();
  await details.getByRole("combobox", { name: "Role for Organization viewer", exact: true }).click();
  await expect(page.getByRole("option", { name: "Developer", exact: true })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await details.getByRole("button", { name: "Cancel invitation", exact: true }).click();
  await expect(details.getByText("9 / 10 writer slots used", { exact: true })).toBeVisible();
  await expect(details.getByText("No pending invitations.", { exact: true })).toBeVisible();

  for (const [fixture, role] of [["Developer fixture", "Developer"], ["Prompter fixture", "Prompter"], ["Viewer admin fixture", "Viewer"]]) {
    const before = collaboratorReads;
    await page.getByRole("button", { name: fixture, exact: true }).click();
    await button.click();
    await expect(details).toContainText(`${role} ·`);
    await expect(details.getByRole("button", { name: "Manage sharing", exact: true })).toHaveCount(0);
    await expect(details.getByRole("textbox", { name: "Collaborator email", exact: true })).toHaveCount(0);
    expect(collaboratorReads).toBe(before);
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button", { name: "Owner fixture", exact: true }).click();
  await button.click();
  await details.getByRole("button", { name: "Manage sharing", exact: true }).click();
  await expect(details.getByRole("textbox", { name: "Collaborator email", exact: true })).toBeVisible();
  await page.evaluate(() => window.cloudWorkspaceSharingFixture.setPage("dashboard"));
  await expect(details).toHaveCount(0);
  const hiddenReads = collaboratorReads;
  await button.hover();
  await page.evaluate(() => window.cloudWorkspaceSharingFixture.setPage("workspace"));
  await expect(details).toHaveCount(0);
  expect(collaboratorReads).toBe(hiddenReads);
  await page.getByRole("button", { name: "Flag off", exact: true }).click();
  await button.click();
  await expect(details.getByRole("region", { name: "Workspace sharing", exact: true })).toHaveCount(0);
  expect(collaboratorReads).toBe(hiddenReads);
  // Preserved owner-only workspaces start Private. Selecting that same scope
  // is a no-op; enabling collaboration must be an explicit versioned write.
  ownerOnly = true; preservedPrivate = true; used = 1;
  await page.goto(`${harnessBase}/harness-cloud-workspace.html?sharing=1`);
  await page.evaluate(() => window.cloudWorkspaceSharingFixture.publishSharing("private", 2));
  await button.click();
  await details.getByRole("button", { name: "Manage sharing", exact: true }).click();
  await details.getByRole("textbox", { name: "Collaborator email", exact: true }).fill("guest@example.test");
  await details.getByRole("combobox", { name: "Invitation role", exact: true }).click();
  await page.getByRole("option", { name: "Developer", exact: true }).click();
  await details.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByText("Enable workspace collaboration before inviting guests", { exact: true })).toBeVisible();
  expect(invitations).toEqual([]);
  const beforeEnable = sharingWrites.length;
  await details.getByRole("combobox", { name: "Workspace sharing scope", exact: true }).click();
  await page.getByRole("option", { name: "Private", exact: true }).click();
  expect(sharingWrites.length).toBe(beforeEnable);
  await details.getByRole("button", { name: "Enable collaboration", exact: true }).click();
  await expect(details.getByRole("button", { name: "Invite", exact: true })).toBeEnabled();
  expect(sharingWrites.at(-1)).toEqual({ sharingMode: "private", expectedRevision: 2 });
  await details.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(details.getByText("2 / 10 writer slots used", { exact: true })).toBeVisible();
  await expect(details.getByRole("combobox", { name: "Workspace sharing scope", exact: true })).toContainText("Private");
  check("Preserved owner-only private workspaces enable collaboration with exact CAS and invite without changing scope", true);
  await page.unrouteAll({ behavior: "wait" });
  check("Staff sharing respects roles, writer slots, pagination, CAS, account switches and inactive surfaces", true);
  await runCloudWorkspaceSharingWarmingSmoke({ page, check, harnessBase });
}

export async function runCloudWorkspaceSharingWarmingSmoke({ page, check, harnessBase }) {
  for (const departure of ["hidden", "unmounted", "account replaced", "visible"]) {
    let collaboratorReads = 0;
    let detailsRequested = false;
    let releaseDetails;
    const heldDetails = new Promise(resolve => { releaseDetails = resolve; });
    await page.mouse.move(0, 0);
    await page.goto(`${harnessBase}/harness-cloud-workspace.html?sharing=1`);
    await page.route("https://api.example.test/v1/cloud-workspaces/**", async route => {
      if (new URL(route.request().url()).pathname.endsWith("/collaborators")) {
        collaboratorReads++;
        return route.fulfill({ status: 500, json: { error: { code: "fixture_read_failed", message: "Fixture read failed" } } });
      }
      const document = await page.evaluate(() => window.cloudWorkspaceSharingFixture.document);
      detailsRequested = true;
      await heldDetails;
      return route.fulfill({ json: { workspace: { ...document, version: document.version + 1 } } });
    });
    await page.evaluate(() => {
      window.cloudWorkspaceSharingFixture.setPage("workspace");
      window.cloudWorkspaceSharingFixture.invalidateDetails();
    });
    const failedWarm = page.waitForResponse(response => response.url().includes("/collaborators"));
    await page.getByRole("button", { name: "Cloud workspace details", exact: true }).hover();
    await (await failedWarm).finished();
    await expect.poll(() => detailsRequested).toBe(true);
    expect(collaboratorReads).toBe(1);
    if (departure === "hidden") await page.evaluate(() => window.cloudWorkspaceSharingFixture.setPage("dashboard"));
    else if (departure !== "visible") await page.getByRole("button", { name: departure === "unmounted" ? "Local fixture" : "Owner fixture", exact: true }).click();
    const response = page.waitForResponse(reply => !reply.url().includes("/collaborators") && reply.url().includes("/v1/cloud-workspaces/"));
    releaseDetails();
    await (await response).finished();
    if (departure !== "account replaced") await expect.poll(() => page.evaluate(() => window.cloudWorkspaceSharingFixture.details?.version)).toBe(2);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(collaboratorReads).toBe(departure === "visible" ? 2 : 1);
    await expect(page.getByRole("dialog", { name: "Cloud workspace details" })).toHaveCount(0);
    await page.unrouteAll({ behavior: "wait" });
    check(departure === "visible" ? "Delayed details response still warms collaborators for the current visible owner" :
      `Delayed details response leaves collaborator reads inert after the sharing surface is ${departure}`, true);
  }
}
