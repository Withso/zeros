import { expect } from "@playwright/test";

export async function runCloudSettingsSmoke({ page, check, harnessBase }) {
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const userA = "44444444-4444-4444-8444-444444444444";
  const workspaceA = "22222222-2222-4222-8222-222222222222";
  const revoked = { id: "66666666-6666-4666-8666-666666666666", kind: "claude-api-key", displayName: "Revoked credential", revision: 1, revoked: true };
  const saved = [];
  const grants = [];
  const requests = [];
  const compute = { trust: "zeros-managed", fingerprint: "a".repeat(64) };
  await page.route("https://api.example.test/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON();
    requests.push({ path, method, body });
    let result;
    if (path === "/v1/cloud-agent-credentials" && method === "GET") result = { credentials: [revoked, ...saved] };
    else if (path.endsWith("/agent-credentials") && method === "GET") result = { compute,
      delegations: grants.filter(row => path.includes(row.workspaceId)) };
    else if (method === "PUT") {
      const credential = { id: path.split("/").at(-1), kind: body.material.kind, displayName: body.displayName, revision: 1, revoked: false };
      saved.push(credential); result = { credential };
    } else if (path.endsWith("/delegations") && method === "POST") {
      const credential = saved.find(row => row.id === body.credentialId);
      grants.push({ ...body, kind: credential.kind, ownerUserId: userA });
      result = { delegation: { id: body.id } };
    } else if (method === "DELETE") {
      const index = grants.findIndex(row => path.endsWith(row.id));
      if (index >= 0) grants.splice(index, 1);
      result = { revoked: true };
    } else throw new Error(`Unexpected fixture request: ${method} ${path}`);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) });
  });
  await page.goto(`${harnessBase}/harness-cloud-settings.html`);
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  await connect.click();
  const dialog = page.getByRole("dialog", { name: "Claude", exact: true });
  await expect(dialog.getByText("Claude Opus 5", { exact: true })).toBeVisible();
  await dialog.getByRole("combobox", { name: "Cloud credential" }).click();
  await expect(page.getByRole("option", { name: "Revoked credential" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await dialog.getByLabel("Cloud API key", { exact: true }).fill("synthetic-cloud-test-key");
  await dialog.getByRole("button", { name: "Authorize workspace" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connected", exact: true })).toBeVisible();
  const grant = requests.find(row => row.path.endsWith("/delegations") && row.method === "POST")?.body;
  expect(grant).toMatchObject({ workspaceId: workspaceA, granteeUserId: userA, computeConsent: compute });
  expect(grant.models.length).toBeGreaterThan(0);
  expect(grant.models).toContain("claude-opus-5[1m]");
  await page.getByRole("combobox", { name: "Cloud agent workspace" }).click();
  await page.getByRole("option", { name: "Workspace B", exact: true }).click();
  await expect(connect).toBeVisible();
  await page.getByRole("combobox", { name: "Cloud agent workspace" }).click();
  await page.getByRole("option", { name: "Workspace A", exact: true }).click();
  await page.getByRole("button", { name: "Connected", exact: true }).click();
  await dialog.getByRole("button", { name: "Disconnect workspace" }).click();
  await expect(dialog.getByRole("button", { name: "Disconnect workspace" })).toHaveCount(0);
  expect(requests.filter(row => row.method === "DELETE")).toEqual([expect.objectContaining({ path: `/v1/cloud-agent-credentials/delegations/${grant.id}` })]);
  await dialog.getByLabel("Cloud API key", { exact: true }).fill("unsaved-secret-for-account-a");
  await page.getByRole("button", { name: "Account B", exact: true, includeHidden: true }).evaluate(element => element.click());
  await expect(dialog).toHaveCount(0);
  await connect.click();
  await expect(dialog.getByLabel("Cloud API key", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Cloud API key", { exact: true }).fill("unsaved-secret-for-hidden-surface");
  await page.getByRole("button", { name: "Toggle settings activity", includeHidden: true }).evaluate(element => element.click());
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle settings activity" }).click();
  await connect.click();
  await expect(dialog.getByLabel("Cloud API key", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Reload membership" }).click();
  await expect(page.getByText("Loading organization agent settings…", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  check("Organization settings authorize exact cloud workspaces, isolate accounts, clear secrets, and never use Mac credentials", true);
}
