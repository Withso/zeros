import { expect } from "@playwright/test";

export async function runCloudEnvironmentSmoke({ page, check }) {
  const records = new Map(), writes = [], origin = new URL(page.url()).origin;
  const endpoint = "https://api.example.test/v1/cloud-v2/organizations/*/environment/*";
  const handle = async route => {
    const request = route.request(), parts = new URL(request.url()).pathname.split("/"), repositoryId = parts.at(-1), organization = parts.at(-3);
    const key = `${organization}:${repositoryId}`;
    let row = records.get(key) ?? { repositoryId, revision: 0, versionId: null, updatedAt: null, variables: [], files: [] };
    if (request.method() === "PATCH") {
      const input = request.postDataJSON();
      if (input.expectedRevision !== row.revision) return route.fulfill({ status: 409, json: { error: { code: "cloud_environment_changed", message: "Changed elsewhere" } } });
      const variables = new Map(row.variables.map(item => [item.name, item])), files = new Map(row.files.map(item => [item.path, item]));
      for (const [name, value] of Object.entries(input.variables ?? {})) value === null ? variables.delete(name) : variables.set(name, { name, bytes: Buffer.byteLength(value) });
      for (const file of input.files ?? []) file.content === null ? files.delete(file.path) : files.set(file.path, { path: file.path, bytes: Buffer.byteLength(file.content) });
      row = { ...row, revision: row.revision + 1, variables: input.clear ? [] : [...variables.values()], files: input.clear ? [] : [...files.values()],
        versionId: input.clear ? null : "44444444-4444-4444-8444-444444444444", updatedAt: "2026-01-01T00:00:00Z" };
      records.set(key, row); writes.push({ key, names: Object.keys(input.variables ?? {}), paths: (input.files ?? []).map(file => file.path), clear: !!input.clear });
    }
    await route.fulfill({ json: { environment: row } });
  };
  await page.route(endpoint, handle);
  try {
    await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-cloud-environment.html`);
    await expect(page.getByRole("heading", { name: "Cloud environment", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    const canary = "synthetic-browser-environment-canary";
    for (const theme of ["dark", "light"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.getByLabel("Variable name", { exact: true }).fill("APP_BROWSER");
      await page.getByLabel("New value", { exact: true }).fill(canary);
      await expect(page.getByLabel("New value", { exact: true })).toHaveAttribute("type", "password");
      await page.getByRole("button", { name: "Save variable", exact: true }).click();
      await expect(page.getByRole("button", { name: "Replace APP_BROWSER", exact: true })).toBeVisible();
      await expect(page.getByLabel("New value", { exact: true })).toHaveValue("");
      expect(await page.locator("body").innerText()).not.toContain(canary);
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(canary);
      await page.getByLabel("Destination path", { exact: true }).fill("config/.env.local");
      await page.getByLabel("Choose file", { exact: true }).setInputFiles({ name: ".env.local", mimeType: "text/plain", buffer: Buffer.from(`APP_BROWSER=${canary}\n`) });
      await page.getByRole("button", { name: "Save file", exact: true }).click();
      await expect(page.getByRole("button", { name: "Remove config/.env.local", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Clear cloud defaults", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("button", { name: "Replace APP_BROWSER", exact: true })).toBeVisible();
      check(`Cloud environment keeps write-only values, selected files and clear confirmation in ${theme}`, true);
    }
    await page.getByLabel("New value", { exact: true }).fill(canary);
    await page.getByRole("button", { name: "Hide settings", exact: true }).click();
    await expect(page.getByLabel("New value", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Show settings", exact: true }).click();
    await expect(page.getByLabel("New value", { exact: true })).toHaveValue("");

    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = function () { const file = this; return new Promise(resolve => { window.releaseEnvironmentFile = () => { File.prototype.text = original; void original.call(file).then(resolve); }; }); };
    });
    const before = writes.length;
    await page.getByLabel("Choose file", { exact: true }).setInputFiles({ name: ".env.local", mimeType: "text/plain", buffer: Buffer.from(`VALUE=${canary}\n`) });
    await page.getByRole("button", { name: "Save file", exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof window.releaseEnvironmentFile)).toBe("function");
    await page.getByRole("button", { name: "Organization B", exact: true }).click();
    await expect(page.getByRole("button", { name: "Choose cloud repositories" })).toContainText("fixture/second");
    await page.evaluate(() => window.releaseEnvironmentFile());
    await expect(page.getByLabel("New value", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "Organization A", exact: true }).click();
    await expect(page.getByRole("button", { name: "Choose cloud repositories" })).toContainText("fixture/first");
    expect(writes.length).toBe(before);
    await expect(page.getByRole("button", { name: "Replace APP_BROWSER", exact: true })).toBeVisible();
    check("Held cloud environment file reads cancel on owner change; A → B → A restores only exact-key metadata", true);

    await page.getByRole("button", { name: "Clear cloud defaults", exact: true }).click();
    await page.getByRole("button", { name: "Clear defaults", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Replace APP_BROWSER", exact: true })).toHaveCount(0);
    const count = writes.length;
    await page.getByRole("tab", { name: "Local", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Cloud environment", exact: true })).toHaveCount(0);
    expect(writes.length).toBe(count);
    check("Clearing defaults changes future pins only; switching to Local never uploads its vault", true);
  } finally { await page.unroute(endpoint, handle); }
}
