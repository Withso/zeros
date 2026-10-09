import { expect } from "@playwright/test";
import { runCloudComputerV2Smoke } from "./ui-smoke-cloud-computer-v2.mjs";
import { runCloudComputerRefreshSmoke, runCloudComputerSlowRefreshSmoke } from "./ui-smoke-cloud-computer.mjs";

export async function runCloudSettingsSmoke({ page, check, harnessBase, releaseChecksOnly = false }) {
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const userA = "44444444-4444-4444-8444-444444444444";
  const orgA = "11111111-1111-4111-8111-111111111111";
  const accounts = new Map(),
    requests = [];
  const designations = new Map(), designationOperations = new Map();
  const removals = new Map();
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  let runningAgents = false;
  let ownerMode = false, designationSequence = 10, loseDesignationResponse = false;
  let designationResponseHold = null;
  const account = (key) => {
    if (!accounts.has(key))
      accounts.set(key, { credentials: [], connections: [] });
    return accounts.get(key);
  };
  const remove = (operation) => {
    const { state, target } = operation;
    if (target.kind === "disconnect-provider") {
      const connection = state.connections.find(row => row.provider === target.provider);
      expect(connection.revision).toBe(target.expectedConnectionRevision);
      state.connections = state.connections.map(row => row.provider === target.provider
        ? { ...row, revision: row.revision + 1, credentialId: null, connected: false } : row);
    } else {
      expect(target.kind).toBe("remove-organization-credential");
      expect(state.credentials.find(row => row.id === target.credentialId).revision).toBe(target.expectedCredentialRevision);
      // Remove this organization association, leaving other account/org lists alone.
      state.credentials = state.credentials.filter(row => row.id !== target.credentialId);
    }
  };
  await page.route("https://api.example.test/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method(),
      body = request.postDataJSON();
    const user = request
      .headers()
      .authorization?.replace("Bearer fixture-", "");
    const removalPath = path.match(/^\/v1\/cloud-agent-credentials\/removals\/([^/]+)(?:\/(confirm|cancel))?$/);
    const priorRemoval = removalPath && removals.get(removalPath[1]);
    const org =
      path.match(/\/organizations\/([^/]+)/)?.[1] ?? body?.organizationId ?? body?.target?.organizationId ??
      (priorRemoval?.user === user ? priorRemoval.organizationId : undefined);
    const state = account(`${user}:${org}`);
    requests.push({ path, method, body, user });
    let result;
    const designationPath = path.match(/^\/v1\/cloud-agent-credentials\/([^/]+)\/release-canary$/);
    if (path === "/v1/cloud-agent-credentials/removals/prepare" && method === "POST") {
      expect(Object.keys(body).sort()).toEqual(["operationId", "target", "version"]);
      expect(body.version).toBe(1);
      expect(body.operationId).toMatch(uuid);
      expect(user).toMatch(uuid);
      expect(body.target.organizationId).toMatch(uuid);
      expect(body.target.organizationId).toBe(org);
      const previous = removals.get(body.operationId);
      if (previous) {
        expect(previous.user).toBe(user); expect(previous.body).toEqual(body); result = previous.outcome;
      } else {
        if (body.target.kind === "disconnect-provider") {
          expect(Object.keys(body.target).sort()).toEqual(["expectedConnectionRevision", "kind", "organizationId", "provider"]);
          expect(state.connections.find(row => row.provider === body.target.provider).revision).toBe(body.target.expectedConnectionRevision);
        } else {
          expect(body.target.kind).toBe("remove-organization-credential");
          expect(Object.keys(body.target).sort()).toEqual(["credentialId", "expectedCredentialRevision", "kind", "organizationId"]);
          expect(body.target.credentialId).toMatch(uuid);
          expect(state.credentials.find(row => row.id === body.target.credentialId).revision).toBe(body.target.expectedCredentialRevision);
        }
        const outcome = runningAgents
          ? { version: 1, operationId: body.operationId, revision: 2, state: "awaiting-confirmation",
            confirmedRunning: true, expiresAt: new Date(Date.now() + 60_000).toISOString() }
          : { version: 1, operationId: body.operationId, revision: 3, state: "removed" };
        const operation = { user, organizationId: org, state, target: body.target, body, outcome };
        if (!runningAgents) remove(operation);
        removals.set(body.operationId, operation); result = outcome;
      }
    } else if (removalPath) {
      const operation = removals.get(removalPath[1]);
      expect(operation).toBeDefined(); expect(operation.user).toBe(user); expect(operation.organizationId).toBe(org);
      if (method === "GET" && !removalPath[2]) {
        if (operation.outcome.state === "pending") {
          const confirmed = operation.outcome.phase === "removing";
          if (confirmed) remove(operation);
          operation.outcome = { version: 1, operationId: removalPath[1], revision: 4, state: confirmed ? "removed" : "cancelled" };
        }
      } else {
        expect(method).toBe("POST"); expect(["confirm", "cancel"]).toContain(removalPath[2]);
        expect(Object.keys(body).sort()).toEqual(["expectedRevision", "requestId", "version"]);
        expect(body).toMatchObject({ version: 1, expectedRevision: 2 });
        expect(body.requestId).toMatch(uuid);
        if (operation.decision) expect(operation.decision).toEqual({ action: removalPath[2], body });
        else {
          expect(operation.outcome.state).toBe("awaiting-confirmation");
          operation.decision = { action: removalPath[2], body };
          operation.outcome = { version: 1, operationId: removalPath[1], revision: 3, state: "pending",
            phase: removalPath[2] === "confirm" ? "removing" : "cancelling", retryAfterMs: 1000 };
        }
      }
      result = operation.outcome;
    } else if (designationPath) {
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
    } else throw new Error(`Unexpected settings request: ${method} ${path}`);

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
  const disconnectedRevision = account(`${userA}:${orgA}`).connections.find(row => row.provider === "claude").revision;
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Use account", exact: true }),
  ).toHaveCount(2);
  const removeDialog = page.getByRole("dialog", { name: "Remove this connection?", exact: true });
  await expect(removeDialog).toHaveCount(0);
  const disconnected = [...removals.values()].find(row => row.target.kind === "disconnect-provider");
  expect(disconnected).toMatchObject({ user: userA, organizationId: orgA,
    target: { organizationId: orgA, provider: "claude", expectedConnectionRevision: disconnectedRevision },
    outcome: { revision: 3, state: "removed" } });
  expect(disconnected.decision).toBeUndefined();
  const replay = await page.evaluate(async input => {
    const removal = await import("/apps/desktop/src/renderer/features/settings/cloud-credential-removal.ts");
    return { prepare: await removal.prepareCloudCredentialRemoval(input.operationId, input.target),
      status: await removal.readCloudCredentialRemoval(input.operationId) };
  }, disconnected.body);
  expect(replay).toEqual({ prepare: disconnected.outcome, status: disconnected.outcome });
  // Positive running proof alone shows the dialog. No preserves the exact
  // organization association; Yes waits for pending Stop and the status receipt.
  runningAgents = true;
  const apiCredential = account(`${userA}:${orgA}`).credentials.find(row => row.displayName === "Second API");
  const otherOrg = "33333333-3333-4333-8333-333333333333";
  account(`${userA}:${otherOrg}`).credentials.push({ ...apiCredential });
  const apiAccountRow = page.getByText("Second API", { exact: true }).locator("..").locator("..");
  await apiAccountRow.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(removeDialog.getByText("All running agents will be stopped", { exact: true })).toBeVisible();
  const cancelled = [...removals.values()].at(-1);
  expect(cancelled).toMatchObject({ user: userA, organizationId: orgA,
    target: { kind: "remove-organization-credential", organizationId: orgA, credentialId: apiCredential.id,
      expectedCredentialRevision: apiCredential.revision }, outcome: { revision: 2, state: "awaiting-confirmation", confirmedRunning: true } });
  await removeDialog.getByRole("button", { name: "No", exact: true }).click();
  await expect(removeDialog).toHaveCount(0);
  await expect.poll(() => cancelled.outcome.state).toBe("cancelled");
  await expect(page.getByText("Second API", { exact: true })).toBeVisible();
  await apiAccountRow.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(removeDialog.getByText("All running agents will be stopped", { exact: true })).toBeVisible();
  const confirmed = [...removals.values()].at(-1);
  await removeDialog.getByRole("button", { name: "Yes, remove", exact: true }).click();
  await expect(removeDialog).toHaveCount(0);
  await expect(page.getByText("Second API", { exact: true })).toHaveCount(0);
  expect(confirmed).toMatchObject({ outcome: { revision: 4, state: "removed" }, decision: { action: "confirm" } });
  expect(cancelled).toMatchObject({ outcome: { revision: 4, state: "cancelled" }, decision: { action: "cancel" } });
  expect(requests.some(row => row.path === `/v1/cloud-agent-credentials/removals/${confirmed.body.operationId}` && row.method === "GET")).toBe(true);
  expect(account(`${userA}:${otherOrg}`).credentials).toContainEqual(apiCredential);
  expect(requests.some(row => row.path.includes("/agent-connections/accounts/") && row.method === "DELETE")).toBe(false);
  runningAgents = false;
  check("Cloud credential removal keeps no-agent Disconnect immediate, shows only positive running proof, and preserves No/Yes and organization scope", true);
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
  const computerPage = await page.context().browser().newPage();
  try {
    await runCloudComputerV2Smoke({ page: computerPage, check, harnessBase });
  } finally {
    await computerPage.close();
  }
  const refreshPage = await page.context().browser().newPage();
  try {
    await runCloudComputerRefreshSmoke({ page: refreshPage, check, harnessBase });
  } finally {
    await refreshPage.close();
  }
  const slowPage = await page.context().browser().newPage();
  try {
    await runCloudComputerSlowRefreshSmoke({ page: slowPage, check, harnessBase });
  } finally {
    await slowPage.close();
  }
}
