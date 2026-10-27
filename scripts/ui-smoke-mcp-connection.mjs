import { expect } from "@playwright/test";

/** User-visible recovery from an HTTP auth challenge, through the real editor. */
export async function runMcpConnectionSmoke({ page: parent, check }) {
  const context = await parent.context().browser().newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const button = name => page.getByRole("button", { name, exact: true });
  const connection = () => page.getByRole("region", { name: "Connection", exact: true });
  const chooseAuth = async name => {
    await page.getByRole("combobox", { name: "Authentication", exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  try {
    await page.goto(new URL("/apps/desktop/src/renderer/harnesses/harness-customize.html?gatewayState=needs-auth", parent.url()).href);
    await page.getByRole("tab", { name: "MCP", exact: true }).click();
    await page.getByRole("button", { name: /New MCP server/ }).click();
    await page.getByLabel("Name", { exact: true }).fill("account-tools");
    await page.getByRole("combobox", { name: "Transport", exact: true }).click();
    await page.getByRole("option", { name: "Streamable HTTP", exact: true }).click();
    await page.evaluate(() => { window.mcpFormFixture.requiresAuth = true; });
    await page.getByLabel("URL", { exact: true }).fill("https://account.example.test/mcp");
    await expect(connection()).toContainText("Sign-in required");
    await expect(button("Save & connect")).toBeEnabled();

    await page.evaluate(() => { window.mcpFormFixture.failSave = true; });
    await button("Save & connect").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "MCP secrets could not be saved securely" })).toBeVisible();
    expect(await page.evaluate(() => window.mcpFormFixture.authorizations)).toEqual([]);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("account-tools");

    await page.evaluate(() => { window.mcpFormFixture.failSave = false; });
    await button("Save & connect").click();
    await expect(connection()).toContainText("Connected");
    expect(await page.evaluate(() => window.mcpFormFixture.authorizations)).toEqual(["account-tools"]);
    expect(await page.evaluate(() => window.mcpFormFixture.saveCount)).toBe(1);
    expect(JSON.parse(await page.locator("#last-write").textContent()).server.auth).toBe("oauth");
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("account-tools");
    check("An HTTP authentication challenge offers save-and-connect; failed saves never authorize and retry keeps one server", true);

    await page.evaluate(() => { window.mcpFormFixture.requiresAuth = false; });
    await chooseAuth("API key");
    await button("Add header").click();
    await page.getByLabel("Header name 1", { exact: true }).fill("X-Api-Key");
    await page.getByLabel("Header value 1", { exact: true }).fill("fixture-header");
    await chooseAuth("Sign in");
    await expect(page.getByLabel("Header value 1", { exact: true })).toHaveValue("fixture-header");
    await chooseAuth("No sign-in");
    await expect(page.getByLabel("Header value 1", { exact: true })).toHaveCount(0);
    await chooseAuth("API key");
    await expect(page.getByLabel("Header value 1", { exact: true })).toHaveValue("fixture-header");
    await chooseAuth("No sign-in");
    await button("Save changes").click();
    expect(JSON.parse(await page.locator("#last-write").textContent()).server).not.toHaveProperty("headers");
    check("Authentication choices retain entered headers while No sign-in omits them from the saved connection", true);

    await page.getByRole("button", { name: /New MCP server/ }).click();
    await page.getByLabel("Name", { exact: true }).fill("api-key-tools");
    await page.getByRole("combobox", { name: "Transport", exact: true }).click();
    await page.getByRole("option", { name: "Streamable HTTP", exact: true }).click();
    await page.evaluate(() => { window.mcpFormFixture.requiresAuth = true; });
    await page.getByLabel("URL", { exact: true }).fill("https://api-key.example.test/mcp");
    await chooseAuth("API key");
    await button("Add header").click();
    await page.getByLabel("Header name 1", { exact: true }).fill("Authorization");
    await button("Add server").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Enter a value for the Authorization header." })).toBeVisible();
    await page.getByLabel("Header value 1", { exact: true }).fill("fixture-rejected-key");
    await expect(connection()).toContainText("Check API key");
    await expect(button("Save & connect")).toHaveCount(0);
    const authorized = await page.evaluate(() => window.mcpFormFixture.authorizations.length);
    const probes = await page.evaluate(() => window.mcpFormFixture.probeCount);
    await button("Retry").click();
    await expect.poll(() => page.evaluate(() => window.mcpFormFixture.probeCount)).toBeGreaterThan(probes);
    expect(await page.evaluate(() => window.mcpFormFixture.authorizations.length)).toBe(authorized);
    await button("MCP").click();
    await page.evaluate(() => { window.mcpFormFixture.requiresAuth = false; });
    check("Missing API keys are validated before saving and rejected keys never launch OAuth", true);

    await page.getByRole("button", { name: /New MCP server/ }).click();
    await page.getByLabel("Name", { exact: true }).fill("saved-sign-in");
    await page.getByRole("combobox", { name: "Transport", exact: true }).click();
    await page.getByRole("option", { name: "Streamable HTTP", exact: true }).click();
    await page.getByLabel("URL", { exact: true }).fill("https://saved.example.test/mcp");
    await chooseAuth("Sign in");
    await expect(connection()).toContainText("Sign-in required");
    await button("Add server").click();
    const row = button("Edit saved-sign-in").locator("..").locator("..");
    await expect(row).toContainText("Sign-in required");
    await row.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(row).toContainText("Connected");
    await expect(row.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
    check("Connecting a saved list row replaces its earlier authentication-required check", true);

    await page.evaluate(async () => {
      const { RuntimeClient } = await import("/apps/desktop/src/renderer/platform/bridge/ws-client.ts");
      const request = RuntimeClient.prototype.request;
      window.mcpGatewayHealthFixture = { unavailable: true, reconnects: 0 };
      RuntimeClient.prototype.request = function (message, ...args) {
        const response = result => ({ type: "WORKSPACE_RESPONSE", requestId: message.requestId, result });
        if (message.op === "mcp.gateway.status" && window.mcpGatewayHealthFixture.unavailable)
          return Promise.resolve(response({ running: false, error: "Fixture gateway unavailable", servers: [] }));
        if (message.op === "mcp.gateway.reconnect") {
          window.mcpGatewayHealthFixture.unavailable = false;
          window.mcpGatewayHealthFixture.reconnects++;
          return Promise.resolve(response({ ok: true }));
        }
        return request.call(this, message, ...args);
      };
      window.dispatchEvent(new Event("focus"));
    });
    await expect(row).toContainText("Connection failed");
    await row.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(row).toContainText("Connected");
    expect(await page.evaluate(() => window.mcpGatewayHealthFixture.reconnects)).toBe(1);
    check("A failed gateway supersedes a saved successful check and Retry restores the connection", true);

    await page.getByRole("button", { name: /New MCP server/ }).click();
    await page.getByLabel("Name", { exact: true }).fill("detected-sign-in");
    await page.getByRole("combobox", { name: "Transport", exact: true }).click();
    await page.getByRole("option", { name: "Streamable HTTP", exact: true }).click();
    await page.evaluate(() => { window.mcpFormFixture.requiresAuth = true; });
    await page.getByLabel("URL", { exact: true }).fill("https://detected.example.test/mcp");
    await expect(connection()).toContainText("Sign-in required");
    await button("Add server").click();
    const detectedRow = button("Edit detected-sign-in").locator("..").locator("..");
    await detectedRow.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(connection()).toContainText("Connected");
    expect(JSON.parse(await page.locator("#last-write").textContent()).server.auth).toBe("oauth");
    await button("MCP").click();
    await expect(detectedRow).toContainText("Connected");
    await expect(button("Edit detected-sign-in")).toHaveCount(1);
    check("Connect on a saved HTTP row with detected authentication opens the editor and authorizes the same server", true);

    await page.goto(new URL("/apps/desktop/src/renderer/harnesses/harness-customize.html?gatewayState=needs-auth", parent.url()).href);
    await page.getByRole("tab", { name: "MCP", exact: true }).click();
    await button("Edit gateway-error").click();
    await expect(connection()).toContainText("Sign-in required");
    await page.evaluate(async () => {
      const { RuntimeClient } = await import("/apps/desktop/src/renderer/platform/bridge/ws-client.ts");
      const request = RuntimeClient.prototype.request;
      const pending = [];
      window.mcpCancelFixture = { calls: 0, cancellations: 0, finishFirst: () => pending[0]?.() };
      RuntimeClient.prototype.request = function (message, ...args) {
        const response = result => ({ type: "WORKSPACE_RESPONSE", requestId: message.requestId, result });
        if (message.op === "mcp.gateway.authorize") {
          window.mcpCancelFixture.calls++;
          return new Promise(resolve => pending.push(() => resolve(response({ status: { name: message.params.server, state: "connected", toolCount: 1 } }))));
        }
        // A cancellation ACK does not require the earlier RPC to settle yet.
        if (message.op === "mcp.gateway.cancelAuth") {
          window.mcpCancelFixture.cancellations++;
          if (window.mcpCancelFixture.rejectCancellation) return Promise.reject(new Error("Fixture cancellation connection lost"));
          return Promise.resolve(response({ ok: true }));
        }
        return request.call(this, message, ...args);
      };
    });
    await button("Connect").click();
    await expect(button("Cancel")).toBeEnabled();
    await button("Cancel").click();
    await expect(button("Connect")).toBeEnabled();
    await button("Connect").click();
    await expect.poll(() => page.evaluate(() => window.mcpCancelFixture.calls)).toBe(2);
    await page.evaluate(() => window.mcpCancelFixture.finishFirst());
    await expect(button("Cancel")).toBeEnabled();
    await page.evaluate(() => window.mcpFormFixture.setSurfaceActive(false));
    await expect.poll(() => page.evaluate(() => window.mcpCancelFixture.cancellations)).toBe(2);
    await page.evaluate(() => window.mcpFormFixture.setSurfaceActive(true));
    await expect(button("Connect")).toBeEnabled();
    check("Cancel permits an immediate retry while retired replies stay inert, and hiding the editor cancels sign-in", true);

    await button("MCP").click();
    const cancelledRow = button("Edit gateway-error").locator("..").locator("..");
    await page.evaluate(() => { window.mcpCancelFixture.rejectCancellation = true; });
    await cancelledRow.getByRole("button", { name: "Connect", exact: true }).click();
    await cancelledRow.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(cancelledRow.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
    await cancelledRow.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.mcpCancelFixture.calls)).toBe(4);
    check("A failed cancellation request still releases the list controls so sign-in can be retried", true);

    await page.goto(new URL("/apps/desktop/src/renderer/harnesses/harness-customize.html?gatewayState=needs-auth", parent.url()).href);
    await page.getByRole("tab", { name: "MCP", exact: true }).click();
    await button("Edit gateway-error").click();
    await expect(connection()).toContainText("Sign-in required");
    await page.evaluate(async () => {
      const { RuntimeClient } = await import("/apps/desktop/src/renderer/platform/bridge/ws-client.ts");
      const request = RuntimeClient.prototype.request;
      window.mcpHeadlessFixture = { opened: [], completed: 0 };
      window.__ZEROS_NATIVE__ = { on: () => () => {}, invoke: async (command, args) => {
        if (command === "shell_open_url") window.mcpHeadlessFixture.opened.push(args.url);
        return null;
      } };
      RuntimeClient.prototype.request = function (message, ...args) {
        const response = result => ({ type: "WORKSPACE_RESPONSE", requestId: message.requestId, result });
        if (message.op === "mcp.gateway.authorize") return Promise.reject(Object.assign(new Error("Use the device browser"), { code: "REMOTE_OP_NOT_ALLOWED" }));
        if (message.op === "mcp.gateway.beginAuth") return Promise.resolve(response({ authorizationUrl: "https://identity.example.test/authorize" }));
        if (message.op === "mcp.gateway.completeAuth") {
          window.mcpHeadlessFixture.completed++;
          return Promise.resolve(response({ status: { name: message.params.server, state: "connected", toolCount: 1 } }));
        }
        return request.call(this, message, ...args);
      };
    });
    await button("Connect").click();
    const dialog = page.getByRole("dialog", { name: "Sign in to gateway-error" });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => window.mcpHeadlessFixture.opened)).toEqual(["https://identity.example.test/authorize"]);
    await expect(dialog.getByLabel("Authorization URL", { exact: true })).toHaveValue("https://identity.example.test/authorize");
    await dialog.getByLabel("Code or redirect URL", { exact: true }).fill("fixture-code");
    await dialog.getByLabel("Code or redirect URL", { exact: true }).press("Enter");
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.mcpHeadlessFixture.completed)).toBe(1);
    check("An engine without a browser offers the same paste-code sign-in from the editor", true);
    await runMcpAuthorizationRefreshRaceSmoke({ page, check });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}

export async function runMcpAuthorizationRefreshRaceSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-customize.html?gatewayState=needs-auth`);
  await page.getByRole("tab", { name: "MCP", exact: true }).click();
  await page.getByRole("button", { name: "Edit gateway-error", exact: true }).click();
  const connection = page.getByRole("region", { name: "Connection", exact: true });
  await expect(connection).toContainText("Sign-in required");
  await expect.poll(() => page.evaluate(() => window.mcpFormFixture.probeCount)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const { RuntimeClient } = await import("/apps/desktop/src/renderer/platform/bridge/ws-client.ts");
    const { mcpGatewayStatusCache } = await import("/apps/desktop/src/renderer/state/read-caches.ts");
    const request = RuntimeClient.prototype.request;
    window.mcpAuthRefreshFixture = { statusReads: 0, release: null };
    RuntimeClient.prototype.request = function (message, ...args) {
      if (message.op === "mcp.gateway.status") {
        window.mcpAuthRefreshFixture.statusReads++;
        const response = request.call(this, message, ...args);
        if (window.mcpAuthRefreshFixture.statusReads === 1) {
          return Promise.resolve(response).then(stale => new Promise(resolve => {
            window.mcpAuthRefreshFixture.release = () => resolve(stale);
          }));
        }
        return response;
      }
      return request.call(this, message, ...args);
    };
    // Hold automatic probes so they cannot repair a stale gateway response
    // before the successful authorization's own status refresh is observed.
    window.mcpFormFixture.holdProbe = true;
    mcpGatewayStatusCache.invalidateAll();
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.mcpAuthRefreshFixture.release))).toBe(true);
  try {
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(connection).toContainText("Connected");
    await page.evaluate(() => window.mcpAuthRefreshFixture.release());
    await expect.poll(() => page.evaluate(async () => {
      const { mcpGatewayStatusCache } = await import("/apps/desktop/src/renderer/state/read-caches.ts");
      return mcpGatewayStatusCache.keys().every(key => !mcpGatewayStatusCache.getSnapshot(key).refreshing);
    })).toBe(true);
    await expect(connection).toContainText("Connected");
    expect(await page.evaluate(() => window.mcpAuthRefreshFixture.statusReads)).toBe(2);
    check("A gateway read begun before authorization cannot restore Sign-in required after Connect succeeds", true);
  } finally {
    await page.evaluate(() => {
      window.mcpAuthRefreshFixture.release?.();
      window.mcpFormFixture.holdProbe = false;
      window.mcpFormFixture.releaseProbe?.();
    });
  }
}
