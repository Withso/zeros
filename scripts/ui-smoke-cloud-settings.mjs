import { expect } from "@playwright/test";
import { runCloudComputerRefreshSmoke, runCloudComputerSlowRefreshSmoke } from "./ui-smoke-cloud-computer.mjs";

export async function runCloudSettingsSmoke({ page, check, harnessBase, releaseChecksOnly = false }) {
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const userA = "44444444-4444-4444-8444-444444444444";
  const orgA = "11111111-1111-4111-8111-111111111111";
  const qualifiedImages = new Set();
  const accounts = new Map(),
    computers = new Map(),
    requests = [];
  const resources = { cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480 };
  const designations = new Map(), designationOperations = new Map();
  let ownerMode = false, designationSequence = 10, loseDesignationResponse = false;
  let designationResponseHold = null;
  const account = (key) => {
    if (!accounts.has(key))
      accounts.set(key, { credentials: [], connections: [] });
    return accounts.get(key);
  };
  const computer = (org) => {
    if (!computers.has(org))
      computers.set(org, {
        revision: 0,
        draftVersion: 0,
        activeVersion: null,
        activeArtifactId: null,
        previousArtifactId: null,
        activeArtifact: null,
        imageBuilds: true,
        document: { repositories: [], installScript: "", timeoutSeconds: 900 },
        canManage: true,
        configured: true,
        resources,
        history: [],
      });
    return computers.get(org);
  };
  await page.route("https://api.example.test/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method(),
      body = request.postDataJSON();
    const user = request
      .headers()
      .authorization?.replace("Bearer fixture-", "");
    const org =
      path.match(/\/organizations\/([^/]+)/)?.[1] ?? body?.organizationId;
    const state = account(`${user}:${org}`);
    requests.push({ path, method, body, user });
    let result;
    const designationPath = path.match(/^\/v1\/cloud-agent-credentials\/([^/]+)\/release-canary$/);
    if (designationPath) {
      const credentialId = designationPath[1], key = `${user}:${credentialId}`;
      const credential = [...accounts.entries()].filter(([scope]) => scope.startsWith(`${user}:`))
        .flatMap(([, details]) => details.credentials).find(row => row.id === credentialId);
      if (!ownerMode || user !== userA || !credential) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "release_canary_unavailable", message: "Unavailable" } }) });
      const previous = designations.get(key) ?? { designationId: "0", credentialRevision: credential.revision, enabled: false, models: [], lastUsedAt: null };
      if (method === "GET") {
        const enabled = previous.enabled && previous.credentialRevision === credential.revision;
        result = { designationId: previous.designationId, credentialRevision: credential.revision, enabled, models: enabled ? previous.models : [], lastUsedAt: previous.lastUsedAt };
      } else if (method === "PUT") {
        const replay = designationOperations.get(body.operationId);
        if (replay) { expect(replay.body).toEqual(body); result = replay.result; }
        else {
          expect(body.expectedDesignationId).toBe(previous.designationId);
          expect(body.credentialRevision).toBe(credential.revision);
          expect(Object.keys(body).sort()).toEqual(["credentialRevision", "enabled", "expectedDesignationId", "models", "operationId"]);
          const designationId = String(++designationSequence);
          designations.set(key, { ...previous, ...body, designationId });
          result = { designationId, enabled: body.enabled }; designationOperations.set(body.operationId, { body, result });
          if (loseDesignationResponse) {
            loseDesignationResponse = false;
            await designationResponseHold;
            return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Unconfirmed fixture response" } }) });
          }
        }
      }
    } else if (path.endsWith("/agent-connections") && method === "GET") result = state;
    else if (
      /\/cloud-agent-credentials\/[^/]+$/.test(path) &&
      method === "PUT"
    ) {
      const credential = {
        id: path.split("/").at(-1),
        kind: body.material.kind,
        displayName: body.displayName,
        revision: 1,
        revoked: false,
        connectionMethod:
          body.material.kind === "claude-setup-token" ? "account" : "api",
      };
      state.credentials.push(credential);
      result = { credential };
    } else if (
      /\/agent-connections\/(claude|codex|cursor)$/.test(path) &&
      method === "PUT"
    ) {
      const provider = path.split("/").at(-1),
        revision = body.expectedRevision + 1;
      state.connections = state.connections.filter(
        (row) => row.provider !== provider,
      );
      state.connections.push({
        provider,
        revision,
        credentialId: body.credentialId,
        models: body.models ?? [],
        allModels: body.allModels ?? false,
        connected: body.credentialId !== null,
      });
      result = { revision };
    } else if (
      path.includes("/agent-connections/accounts/") &&
      method === "DELETE"
    ) {
      state.credentials = state.credentials.filter(
        (row) => !path.endsWith(row.id),
      );
      result = { removed: true };
    } else if (path.endsWith("/cloud-computer") && method === "GET")
      result = computer(org);
    else if (path.endsWith("/cloud-computer") && method === "PUT") {
      const current = computer(org);
      expect(body.expectedRevision).toBe(current.revision);
      current.document = body.document;
      current.revision++;
      current.draftVersion++;
      result = { revision: current.revision, version: current.draftVersion };
    } else if (path.endsWith("/cloud-computer/builds") && method === "POST") {
      const current = computer(org), now = new Date().toISOString();
      expect(body).toEqual({ id: expect.any(String), version: current.draftVersion, expectedRevision: current.revision });
      current.history.unshift({
        id: body.id, version: body.version, state: "building", cleanupState: "pending",
        repository: "", createdAt: now, completedAt: null, errorCode: null,
        artifact: { id: body.id, state: "creating", snapshotId: null, imageRef: null,
          buildSha256: null, baseImageRef: `boat:base@sha256:${"a".repeat(64)}`,
          sourceContract: null, createdAt: now, attestedAt: null },
      });
      result = { id: body.id };
    } else if (path.endsWith("/cancel") && method === "POST") {
      const build = computer(org).history.find(row => path.includes(row.id));
      Object.assign(build, { state: "cancelled", cleanupState: "requested", errorCode: "build_cancelled" });
      build.artifact.state = "cancelled";
      result = { cancelled: true };
    } else if (path.endsWith("/cloud-computer/activate") || path.endsWith("/cloud-computer/rollback")) {
      const current = computer(org);
      expect(body.expectedRevision).toBe(current.revision);
      const build = current.history.find(row => row.id === body.artifactId);
      expect(build.artifact.state).toBe("attested");
      if (!qualifiedImages.has(build.id)) {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: {
          code: "cloud_computer_qualification_required",
          message: "This exact image needs fresh agent qualification before activation.",
        } }) });
        return;
      }
      if (path.endsWith("/rollback")) expect(body.artifactId).toBe(current.previousArtifactId);
      else expect(body.version).toBe(build.version);
      current.revision++;
      current.previousArtifactId = current.activeArtifactId;
      current.activeArtifactId = build.id;
      current.activeArtifact = { imageRef: build.artifact.imageRef, createdAt: build.createdAt };
      current.activeVersion = build.version;
      result = { activated: true };
    } else throw new Error(`Unexpected fixture request: ${method} ${path}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(result),
    });
  });
  await page.goto(`${harnessBase}/harness-cloud-settings.html`);
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  await connect.click();
  const dialog = page.getByRole("dialog", { name: "Claude Code", exact: true });
  await expect(
    dialog.getByRole("button", { name: "CLI", exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: "Allow all models", exact: true })).toBeChecked();
  await dialog
    .getByLabel("Account name", { exact: true })
    .fill("First subscription");
  await dialog
    .getByLabel("Cloud setup token", { exact: true })
    .fill("synthetic-cloud-setup-token");
  await dialog
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("First subscription", { exact: true }),
  ).toBeVisible();
  const grant = requests.find(
    (row) =>
      row.path.endsWith("/agent-connections/claude") && row.method === "PUT",
  );
  expect(grant.body).toMatchObject({
    expectedRevision: 0,
    consent: "zeros-managed",
    allModels: true,
  });
  expect(grant.body.models).toContain("claude-opus-5[1m]");
  expect(grant.path).toContain(orgA);
  expect(grant.user).toBe(userA);
  expect(requests.some((row) => row.path.includes("/cloud-workspaces/"))).toBe(
    false,
  );
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await dialog.getByRole("button", { name: "API", exact: true }).click();
  await dialog.getByLabel("Account name", { exact: true }).fill("Second API");
  await dialog
    .getByLabel("Cloud API key", { exact: true })
    .fill("synthetic-cloud-api-key");
  await dialog
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("First subscription", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Second API", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Use for release checks", exact: true })).toHaveCount(0);
  expect(requests.some(row => row.path.endsWith("/release-canary"))).toBe(false);
  // A released connection has an explicit list and no all-model flag.
  const legacy = account(`${userA}:${orgA}`).connections.find(row => row.provider === "claude");
  delete legacy.allModels; legacy.models = ["claude-haiku-4-5"];
  await page.evaluate(async () => {
    const { cloudOrganizationConnectionsCache } = await import("/apps/desktop/src/renderer/features/settings/cloud-provider-connection.ts");
    cloudOrganizationConnectionsCache.invalidateAll();
  });
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Allow all models", exact: true })).not.toBeChecked();
  await expect(dialog.getByText("Allowed models (1)", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Connect account", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests.filter(row => row.path.endsWith("/agent-connections/claude") && row.method === "PUT").at(-1).body)
    .toMatchObject({ allModels: false, models: ["claude-haiku-4-5"] });
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await dialog.getByText("Allow all models", { exact: true }).click();
  await dialog.getByRole("button", { name: "Connect account", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests.filter(row => row.path.endsWith("/agent-connections/claude") && row.method === "PUT").at(-1).body.allModels).toBe(true);
  check("New self connections default to all models; older explicit consent changes only after Allow all models is selected", true);
  ownerMode = true;
  await page.getByRole("button", { name: "Platform owner", exact: true }).click();
  const firstRow = page.locator("[data-release-canary-control]").locator("..").filter({ has: page.getByText("First subscription", { exact: true }) });
  const releaseSwitch = firstRow.getByRole("switch", { name: "Use for release checks", exact: true });
  await expect(releaseSwitch).toBeEnabled(); await expect(releaseSwitch).not.toBeChecked();
  await expect(firstRow.getByText("Model: claude-haiku-4-5", { exact: true })).toBeVisible();
  const apiRow = page.locator("[data-release-canary-control]").locator("..").filter({ has: page.getByText("Second API", { exact: true }) });
  await expect(apiRow.getByRole("switch", { name: "Use for release checks", exact: true })).toBeDisabled();
  await releaseSwitch.click(); await expect(releaseSwitch).toBeChecked(); await expect(releaseSwitch).toBeEnabled();
  const firstCredential = account(`${userA}:${orgA}`).credentials.find(row => row.displayName === "First subscription");
  const designationKey = `${userA}:${firstCredential.id}`;
  expect(designations.get(designationKey)).toMatchObject({ enabled: true, credentialRevision: 1, models: ["claude-haiku-4-5"] });
  designations.get(designationKey).lastUsedAt = "2026-09-29T12:00:00.000Z";
  const refreshReleaseSettings = async () => page.evaluate(async () => {
    const connections = await import("/apps/desktop/src/renderer/features/settings/cloud-provider-connection.ts");
    const release = await import("/apps/desktop/src/renderer/features/settings/release-canary-designation.ts");
    connections.cloudOrganizationConnectionsCache.invalidateAll(); release.releaseCanaryDesignationsCache.invalidateAll();
  });
  await refreshReleaseSettings();
  await expect(firstRow.locator("time")).toHaveAttribute("datetime", "2026-09-29T12:00:00.000Z");
  await releaseSwitch.click(); await expect(releaseSwitch).not.toBeChecked(); await expect(releaseSwitch).toBeEnabled();
  const writesBeforeLoss = designationOperations.size; loseDesignationResponse = true;
  let releaseDesignationResponse;
  designationResponseHold = new Promise(resolve => { releaseDesignationResponse = resolve; });
  await releaseSwitch.click(); await expect.poll(() => designationOperations.size).toBe(writesBeforeLoss + 1);
  await page.getByRole("button", { name: "Toggle settings activity", exact: true }).click();
  await expect(releaseSwitch).toBeDisabled();
  const readsBeforeLostResponse = requests.filter(row => row.path.endsWith("/release-canary")).length;
  releaseDesignationResponse(); await page.waitForTimeout(150);
  expect(requests.filter(row => row.path.endsWith("/release-canary")).length).toBe(readsBeforeLostResponse);
  await expect(firstRow.getByRole("alert")).toContainText("Could not confirm the change");
  await page.getByRole("button", { name: "Toggle settings activity", exact: true }).click();
  await firstRow.getByRole("button", { name: "Retry change", exact: true }).click();
  await expect(releaseSwitch).toBeChecked(); await expect(releaseSwitch).toBeEnabled();
  designationResponseHold = null;
  expect(designationOperations.size).toBe(writesBeforeLoss + 1);
  firstCredential.revision = 2; await refreshReleaseSettings();
  await expect(releaseSwitch).not.toBeChecked(); await expect(releaseSwitch).toBeEnabled();
  if (releaseChecksOnly) await page.screenshot({ path: ".context/phase1/P3-owner-release-checks.png", fullPage: true });
  await page.getByRole("button", { name: "Toggle settings activity", exact: true }).click();
  await expect(releaseSwitch).toBeDisabled();
  const readsWhileHidden = requests.filter(row => row.path.endsWith("/release-canary")).length;
  await page.waitForTimeout(100); expect(requests.filter(row => row.path.endsWith("/release-canary")).length).toBe(readsWhileHidden);
  await page.getByRole("button", { name: "Toggle settings activity", exact: true }).click();
  await expect(releaseSwitch).toBeEnabled();
  ownerMode = false;
  await page.getByRole("button", { name: "Ordinary member", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Use for release checks", exact: true })).toHaveCount(0);
  const readsAfterRevocation = requests.filter(row => row.path.endsWith("/release-canary")).length;
  await page.waitForTimeout(100); expect(requests.filter(row => row.path.endsWith("/release-canary")).length).toBe(readsAfterRevocation);
  check("Release-check consent is owner-only, model/revision bound, lost-response safe, reconnect-off and inactive-inert", true);
  if (releaseChecksOnly) { expect(errors).toEqual([]); return; }
  await page
    .getByRole("button", { name: "Organization B", exact: true })
    .click();
  await expect(
    page.getByText("First subscription", { exact: true }),
  ).toHaveCount(0);
  await expect(connect).toBeEnabled();
  await page
    .getByRole("button", { name: "Organization A", exact: true })
    .click();
  await expect(
    page.getByText("First subscription", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Use account", exact: true }),
  ).toHaveCount(2);
  await page.getByRole("tab", { name: "Codex", exact: true }).click();
  await connect.click();
  const codex = page.getByRole("dialog", { name: "Codex", exact: true });
  await codex
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  await expect(codex.getByText("TEST-CODE", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(codex).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          globalThis.window.cloudSettingsNativeCalls.filter(
            (row) =>
              row.command === "cloud_provider_auth" && row.action === "cancel",
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Account B", exact: true }).click();
  // The selected provider belongs to the account and organization too.
  await expect(
    page.getByRole("tab", { name: "Claude Code", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await connect.click();
  await dialog
    .getByLabel("Cloud setup token", { exact: true })
    .fill("unsaved-secret");
  await page
    .getByRole("button", {
      name: "Account A",
      exact: true,
      includeHidden: true,
    })
    .evaluate((element) => element.click());
  await expect(dialog).toHaveCount(0);
  await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await expect(
    dialog.getByLabel("Cloud setup token", { exact: true }),
  ).toHaveValue("");
  await dialog
    .getByLabel("Cloud setup token", { exact: true })
    .fill("unsaved-hidden-secret");
  await page
    .getByRole("button", {
      name: "Toggle settings activity",
      includeHidden: true,
    })
    .evaluate((element) => element.click());
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle settings activity" }).click();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await expect(
    dialog.getByLabel("Cloud setup token", { exact: true }),
  ).toHaveValue("");
  await page.keyboard.press("Escape");

  await page
    .getByRole("button", { name: "Computer section", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose cloud repositories", exact: true })
    .click();
  await page
    .getByRole("button", { name: "example/project", exact: true })
    .click();
  await page.keyboard.press("Escape");
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill("printf setup-ok");
  await page
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Build computer", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Build computer", exact: true })
    .click();
  const refresh = async () => {
    const button = page.getByRole("button", { name: "Refresh Cloud Computer", exact: true });
    await button.click();
    await expect(button).toBeEnabled();
  };
  const attest = (build) => {
    const now = new Date().toISOString();
    Object.assign(build, { state: "succeeded", cleanupState: "complete", completedAt: now });
    Object.assign(build.artifact, { state: "attested", snapshotId: `snapshot-${build.id}`,
      imageRef: `boat:zeros-org-${build.id.replaceAll("-", "")}@sha256:${"b".repeat(64)}`,
      buildSha256: "b".repeat(64), sourceContract: "c".repeat(64), attestedAt: now });
  };
  await expect(page.getByText("Version 1 · creating", { exact: true })).toBeVisible();
  const first = computer(orgA).history[0];
  for (const phase of ["installing", "sanitizing", "capturing", "verifying"]) {
    first.artifact.state = phase;
    await refresh();
    await expect(page.getByText(`Version 1 · ${phase}`, { exact: true })).toBeVisible();
  }
  attest(first);
  await refresh();
  await expect(page.getByText("Version 1 · Attested", { exact: true })).toBeVisible();
  await expect(page.getByText(`Snapshot snapshot-${first.id}`, { exact: false })).toBeVisible();
  await expect(page.getByText("Built within the last hour", { exact: false })).toBeVisible();
  await expect(page.getByText("No active configuration", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Activate", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("needs fresh agent qualification");
  expect(computer(orgA).activeArtifactId).toBeNull();
  qualifiedImages.add(first.id);
  await page.getByRole("button", { name: "Activate", exact: true }).click();
  await expect(page.getByText("Active version 1", { exact: true })).toBeVisible();
  await expect(page.getByText(first.artifact.imageRef, { exact: false })).toBeVisible();

  await editor.fill("printf second-image");
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await page.getByRole("button", { name: "Build computer", exact: true }).click();
  await expect(page.getByText("Version 2 · creating", { exact: true })).toBeVisible();
  const second = computer(orgA).history[0];
  attest(second);
  qualifiedImages.add(second.id);
  await refresh();
  await page.getByRole("button", { name: "Activate", exact: true }).click();
  await expect(page.getByText("Active version 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Roll back to previous image", exact: true }).click();
  await expect(page.getByText("Active version 1", { exact: true })).toBeVisible();
  expect(computer(orgA).activeArtifactId).toBe(first.id);

  await page.getByRole("button", { name: "Build computer", exact: true }).click();
  await expect(page.getByText("Version 2 · creating", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel build", exact: true }).click();
  await expect(page.getByText("Version 2 · Cancelled", { exact: true })).toBeVisible();
  await expect(page.getByText("Builder cleanup pending", { exact: false })).toBeVisible();
  await expect(page.getByText("The build was cancelled.", { exact: false })).toBeVisible();
  const cancelled = computer(orgA).history[0];
  cancelled.cleanupState = "complete";
  cancelled.artifact.state = "retired";
  await refresh();
  await expect(page.getByText("Builder cleanup pending", { exact: false })).toHaveCount(0);
  expect(requests.some(row => row.path.endsWith("/cloud-workspaces") && row.method === "POST")).toBe(false);
  await page
    .getByRole("button", { name: "Organization B", exact: true })
    .click();
  await expect(editor).toHaveText("");
  await page
    .getByRole("button", { name: "Organization A", exact: true })
    .click();
  await expect(editor).toHaveText("printf second-image");
  await page.screenshot({
    path: ".context/organization-cloud-computer.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "GitHub section", exact: true })
    .click();
  await expect(page.getByText("example", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Disconnect", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Agents section", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reload membership", exact: true })
    .click();
  await expect(
    page.getByText("Loading organization agent settings…", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  check(
    "Organization agent, repository and computer settings work before a VM exists, isolate accounts and organizations, and cancel hidden sign-ins",
    true,
  );
  await runCloudComputerRefreshSmoke({ page, check, harnessBase });
  const slowPage = await page.context().browser().newPage();
  try {
    await runCloudComputerSlowRefreshSmoke({ page: slowPage, check, harnessBase });
  } finally {
    await slowPage.close();
  }
}
