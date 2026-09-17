import { expect } from "@playwright/test";

export async function runCustomizeSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-customize.html`,
  );
  const providerTabs = page.getByRole("tablist", { name: "Agent provider" });
  await expect(providerTabs).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveText(["MCP", "Skills"]);
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
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

  await page.getByRole("tab", { name: "MCP", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /New MCP server/ }),
  ).toBeVisible();
  check("Customize exposes only Zeros MCP and skills editing", true);

  await page.getByRole("button", { name: /New MCP server/ }).click();
  await page.getByLabel("Server name", { exact: true }).fill("sse-reports");
  await page.getByRole("combobox", { name: "Transport type" }).click();
  await expect(page.getByRole("option")).toHaveText(["STDIO", "Streamable HTTP", "SSE"]);
  await page.getByRole("option", { name: "SSE", exact: true }).click();
  await expect(page.getByText("SSE endpoint", { exact: true })).toBeVisible();
  await page.getByLabel("URL", { exact: true }).fill("https://reports.example/events");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Edit sse-reports", exact: true })).toContainText("sse");
  await expect(page.locator("#last-write")).toContainText('"transport":"sse"');
  await page.getByRole("button", { name: "Edit sse-reports", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Transport type" })).toContainText("SSE");
  await expect(page.getByLabel("URL", { exact: true })).toHaveValue("https://reports.example/events");
  await page.screenshot({ path: ".context/mcp-sse-form.png", fullPage: true });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  check("SSE saves, displays its transport badge, and reopens without conversion", true);

  await page.getByRole("button", { name: /New MCP server/ }).click();
  await page.getByRole("button", { name: "Import JSON", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import JSON" });
  await dialog.getByRole("textbox").fill(JSON.stringify({ mcpServers: {
    imported: { type: "sse", url: "https://imported.example/events" },
  } }));
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Transport type" })).toContainText("SSE");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Edit imported", exact: true })).toContainText("sse");
  check("JSON imports preserve explicit SSE in the form and saved list", true);

  await page.getByRole("button", { name: "Customize scope" }).click();
  await page.getByRole("menuitem").filter({ hasText: "User" }).click();
  await expect(page.getByRole("button", { name: "Edit gateway-error", exact: true })).toBeVisible();
  await expect(page.getByText("error", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "No browser?", exact: true })).toHaveCount(0);
  check("SSE connection errors do not offer an unrelated sign-in action", true);
  await page.getByRole("button", { name: /New MCP server/ }).click();
  await page.getByLabel("Server name", { exact: true }).fill("local-tools");
  await page.getByLabel("Command", { exact: true }).fill("node");
  await page.getByLabel("Working directory", { exact: true }).fill("/fixture/mcp tools");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(page.locator("#last-write")).toContainText('"cwd":"/fixture/mcp tools"');
  await page.getByRole("button", { name: "Edit local-tools", exact: true }).click();
  await expect(page.getByLabel("Working directory", { exact: true })).toHaveValue("/fixture/mcp tools");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  check("Local MCP working directory survives save and edit", true);

  await page.getByRole("button", { name: /New MCP server/ }).click();
  await page.getByLabel("Server name", { exact: true }).fill("oauth-config");
  await page.getByRole("combobox", { name: "Transport type" }).click();
  await page.getByRole("option", { name: "Streamable HTTP", exact: true }).click();
  await expect(page.getByLabel("Working directory", { exact: true })).toHaveCount(0);
  await page.getByLabel("URL", { exact: true }).fill("https://oauth.example/mcp");
  await page.getByRole("combobox", { name: "Authentication" }).click();
  await page.getByRole("option", { name: "OAuth (via gateway)", exact: true }).click();
  await page.getByLabel("Client ID", { exact: true }).fill("configured-client");
  await page.getByLabel("Scopes", { exact: true }).fill("read write");
  await page.getByLabel("Client secret", { exact: true }).fill("fixture-secret-never-persist");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(page.locator("#last-write")).toContainText('"oauth_scopes":["read","write"]');
  await expect(page.locator("#last-write")).not.toContainText("fixture-secret-never-persist");
  await page.getByRole("button", { name: "Edit oauth-config", exact: true }).click();
  await expect(page.getByLabel("Client ID", { exact: true })).toHaveValue("configured-client");
  await expect(page.getByLabel("Scopes", { exact: true })).toHaveValue("read write");
  await expect(page.getByLabel("Client secret", { exact: true })).toHaveValue("");
  await page.screenshot({ path: ".context/mcp-oauth-form.png", fullPage: true });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  check("OAuth options persist and client secrets never enter settings or the reopened form", true);
  const queriedProviders = JSON.parse(
    await page.locator("#inventory-providers").textContent(),
  );
  expect(queriedProviders.length).toBeGreaterThan(0);
  expect(queriedProviders.every((provider) => provider === "zeros")).toBe(true);
  check("Customize does not start hidden provider discovery", true);
  const authUrl = new URL(page.url());
  authUrl.searchParams.set("gatewayState", "needs-auth");
  await page.goto(authUrl.href);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "No browser?", exact: true })).toBeVisible();
  check("SSE authentication failures retain both existing sign-in flows", true);
  await page.evaluate(async () => {
    const { RuntimeClient } = await import("/apps/desktop/src/renderer/platform/bridge/ws-client.ts");
    const request = RuntimeClient.prototype.request;
    let complete;
    RuntimeClient.prototype.request = function (message, ...args) {
      const response = (result) => ({ type: "WORKSPACE_RESPONSE", requestId: message.requestId, result });
      if (message.op === "mcp.gateway.beginAuth") return Promise.resolve(response({ authorizationUrl: "https://identity.example.test/authorize" }));
      if (message.op === "mcp.gateway.completeAuth") return new Promise((resolve) => { complete = resolve; });
      if (message.op === "mcp.gateway.cancelAuth") {
        complete?.(response({ status: { name: "gateway-error", state: "connected", toolCount: 1 } }));
        return Promise.resolve(response({ ok: true }));
      }
      return request.call(this, message, ...args);
    };
  });
  await page.getByRole("button", { name: "No browser?", exact: true }).click();
  const signIn = page.getByRole("dialog", { name: "Sign in to gateway-error" });
  await signIn.getByPlaceholder("code=… or the full …/callback?code=… URL").fill("fixture-code");
  await signIn.getByRole("button", { name: "Finish sign-in", exact: true }).click();
  await expect(signIn.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await signIn.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(signIn).toHaveCount(0);
  await expect(page.getByRole("button", { name: "No browser?", exact: true })).toBeEnabled();
  check("Sign-in can be cancelled during token exchange without a late response reopening it", true);
  await page.screenshot({
    path: ".context/customize-final.png",
    fullPage: true,
  });
  await runMcpConcurrentAuthSmoke({ page, check });
}

export async function runMcpConcurrentAuthSmoke({ page, check }) {
  const url = new URL("/apps/desktop/src/renderer/harnesses/harness-customize.html", page.url());
  url.searchParams.set("gatewayState", "needs-auth");
  url.searchParams.set("gatewayServers", "multiple");
  await page.goto(url.href);
  await page.getByRole("tab", { name: "MCP", exact: true }).click();
  await page.evaluate(async () => {
    const { RuntimeClient } = await import("/apps/desktop/src/renderer/platform/bridge/ws-client.ts");
    const request = RuntimeClient.prototype.request;
    let activeServer = null;
    let settle;
    let settleCancelled;
    const calls = [];
    window.mcpAuthSmoke = { calls, finish: () => settle?.(), finishCancelled: () => settleCancelled?.() };
    RuntimeClient.prototype.request = function (message, ...args) {
      const response = (result) => ({ type: "WORKSPACE_RESPONSE", requestId: message.requestId, result });
      const server = message.params?.server;
      if (message.op === "mcp.gateway.authorize" || message.op === "mcp.gateway.beginAuth") {
        calls.push({ op: message.op, server });
        if (activeServer) return Promise.reject(new Error("Another MCP sign-in is already in progress."));
        activeServer = server;
        if (message.op === "mcp.gateway.beginAuth")
          return Promise.resolve(response({ authorizationUrl: "https://identity.example.test/authorize" }));
        return new Promise((resolve) => {
          settle = () => {
            activeServer = null;
            resolve(response({ status: { name: server, state: "connected", toolCount: 1 } }));
          };
        });
      }
      if (message.op === "mcp.gateway.completeAuth") {
        calls.push({ op: message.op, server });
        return new Promise((resolve) => {
          settle = () => resolve(response({ status: { name: server, state: "connected", toolCount: 1 } }));
        });
      }
      if (message.op === "mcp.gateway.cancelAuth") {
        calls.push({ op: message.op, server });
        settleCancelled = settle;
        activeServer = null;
        return Promise.resolve(response({ ok: true }));
      }
      return request.call(this, message, ...args);
    };
  });
  const signIn = page.getByRole("button", { name: /Sign in$/ });
  const headless = page.getByRole("button", { name: "No browser?", exact: true });
  await expect(signIn).toHaveCount(2);
  await signIn.evaluateAll((buttons) => {
    buttons[0].click();
    buttons[1].click();
  });
  await expect(signIn.nth(1)).toBeDisabled();
  await expect(headless.nth(1)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await page.evaluate(() => window.mcpAuthSmoke.finish());
  await expect(signIn.nth(1)).toBeEnabled();
  await expect(headless.nth(1)).toBeEnabled();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);

  await headless.nth(1).click();
  const dialog = page.getByRole("dialog", { name: "Sign in to gateway-second" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: /Sign in$/, includeHidden: true }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "No browser?", exact: true, includeHidden: true }).first()).toBeDisabled();
  await dialog.getByPlaceholder("code=… or the full …/callback?code=… URL").fill("fixture-code");
  await dialog.getByRole("button", { name: "Finish sign-in", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(signIn.first()).toBeEnabled();
  await signIn.first().click();
  // A cancelled token exchange can answer after another server owns the UI.
  await page.evaluate(() => window.mcpAuthSmoke.finishCancelled());
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await expect(signIn.nth(1)).toBeDisabled();
  await page.evaluate(() => window.mcpAuthSmoke.finish());
  await expect(signIn.nth(1)).toBeEnabled();
  expect(await page.evaluate(() => window.mcpAuthSmoke.calls)).toEqual([
    { op: "mcp.gateway.authorize", server: "gateway-error" },
    { op: "mcp.gateway.beginAuth", server: "gateway-second" },
    { op: "mcp.gateway.completeAuth", server: "gateway-second" },
    { op: "mcp.gateway.cancelAuth", server: "gateway-second" },
    { op: "mcp.gateway.authorize", server: "gateway-error" },
  ]);
  check("MCP sign-ins serialize across servers and preserve cancellation through browser and paste-code flows", true);
}
