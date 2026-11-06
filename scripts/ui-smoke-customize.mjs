import { expect } from "@playwright/test";
import { runMcpConnectionSmoke } from "./ui-smoke-mcp-connection.mjs";
import { runMcpFormSmoke } from "./ui-smoke-mcp-form.mjs";
import { runOrganizationMcpSmoke } from "./ui-smoke-mcp-organization.mjs";
import { runMcpToolsSmoke } from "./ui-smoke-mcp-tools.mjs";

export async function runCustomizeSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-customize.html`,
  );
  const providerTabs = page.getByRole("tablist", { name: "Agent provider" });
  await expect(providerTabs).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveText(["MCP servers", "Skills"]);
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await page.getByRole("button", { name: "New skill", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("review-changes");
  await page.getByLabel("When to use it").fill("Review changed code");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Inspect the diff and verify behavior.");
  await page.getByRole("button", { name: "Save skill", exact: true }).click();
  await expect(page.getByText("review-changes", { exact: true })).toBeVisible();
  await expect(page.locator("#last-write")).toContainText(
    '"expectedRevision":null',
  );
  check("Zeros skills save and return to a refreshed inventory", true);

  // Edit lives in the row's ⋯ menu.
  await page.getByRole("button", { name: "More actions for review-changes", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
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
  // The breadcrumb goes back; the form has no Cancel.
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("button", { name: "Skills", exact: true }).click();
  check(
    "scope switching cannot move an unsaved skill draft into another repository",
    true,
  );

  await page.getByRole("tab", { name: "MCP servers", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add server", exact: true }),
  ).toBeVisible();
  check("Customize exposes only Zeros MCP and skills editing", true);

  const queriedProviders = JSON.parse(
    await page.locator("#inventory-providers").textContent(),
  );
  expect(queriedProviders.length).toBeGreaterThan(0);
  expect(queriedProviders.every((provider) => provider === "zeros")).toBe(true);
  check("Customize does not start hidden provider discovery", true);
  await runMcpFormSmoke({ page, check });
  const authUrl = new URL(page.url());
  authUrl.searchParams.set("gatewayState", "needs-auth");
  await page.goto(authUrl.href);
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  // Sign-in without a browser lives in the row's ⋯ menu.
  const moreGateway = page.getByRole("button", { name: "More actions for gateway-error", exact: true });
  const headlessItem = page.getByRole("menuitem", { name: "Sign in without a browser", exact: true });
  await moreGateway.click();
  await expect(headlessItem).toBeVisible();
  await page.keyboard.press("Escape");
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
  await moreGateway.click();
  await headlessItem.click();
  const signIn = page.getByRole("dialog", { name: "Sign in to gateway-error" });
  await signIn.getByPlaceholder("code=… or the full …/callback?code=… URL").fill("fixture-code");
  await signIn.getByRole("button", { name: "Finish sign-in", exact: true }).click();
  await expect(signIn.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await signIn.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(signIn).toHaveCount(0);
  await expect(moreGateway).toBeEnabled();
  await moreGateway.click();
  await expect(headlessItem).toBeEnabled();
  await page.keyboard.press("Escape");
  check("Sign-in can be cancelled during token exchange without a late response reopening it", true);
  await page.screenshot({
    path: ".context/customize-final.png",
    fullPage: true,
  });
  await runMcpConcurrentAuthSmoke({ page, check });
  await runMcpLargeCatalogSmoke({ page, check });
  await runMcpToolsSmoke({ page, check });
  await runOrganizationMcpSmoke({ page, check });
  await runMcpConnectionSmoke({ page, check });
}

export async function runMcpLargeCatalogSmoke({ page, check }) {
  const url = new URL("/apps/desktop/src/renderer/harnesses/harness-customize.html", page.url());
  url.searchParams.set("gatewayState", "needs-auth");
  await page.goto(url.href);
  await page.getByRole("tab", { name: "MCP servers", exact: true }).click();
  await page.evaluate(() => { window.mcpFormFixture.gatewayToolNames = Array.from({ length: 59 }, (_, i) => `tool_${i}`); });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  // The row count and any total come from one status snapshot, so a limit
  // notice would already be on screen once the row shows 59 tools.
  await expect(page.getByRole("button", { name: "59 tools", exact: true })).toBeVisible();
  await expect(page.getByText(/allows about|Turn some off/)).toHaveCount(0);
  check("A gateway server with more than 40 tools shows no tool-limit notice", true);
}

export async function runMcpConcurrentAuthSmoke({ page, check }) {
  const url = new URL("/apps/desktop/src/renderer/harnesses/harness-customize.html", page.url());
  url.searchParams.set("gatewayState", "needs-auth");
  url.searchParams.set("gatewayServers", "multiple");
  await page.goto(url.href);
  await page.getByRole("tab", { name: "MCP servers", exact: true }).click();
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
  // Rows are addressed by their name button; while a row signs in it offers
  // only Cancel, and sign-in without a browser lives in its ⋯ menu.
  const row = (server) => page.getByRole("button", { name: `Edit ${server}`, exact: true, includeHidden: true }).locator("..");
  const connect = (server) => row(server).getByRole("button", { name: "Connect", exact: true, includeHidden: true });
  const more = (server) => page.getByRole("button", { name: `More actions for ${server}`, exact: true, includeHidden: true });
  const cancel = () => page.getByRole("button", { name: "Cancel", exact: true });
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Connect", exact: true }).evaluateAll((buttons) => {
    buttons[0].click();
    buttons[1].click();
  });
  await expect(connect("gateway-second")).toBeDisabled();
  await expect(more("gateway-second")).toBeDisabled();
  await expect(cancel()).toBeEnabled();
  await page.evaluate(() => window.mcpAuthSmoke.finish());
  await expect(connect("gateway-second")).toBeEnabled();
  await expect(more("gateway-second")).toBeEnabled();
  await expect(cancel()).toHaveCount(0);

  await more("gateway-second").click();
  await page.getByRole("menuitem", { name: "Sign in without a browser", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in to gateway-second" });
  await expect(dialog).toBeVisible();
  await expect(connect("gateway-error")).toBeDisabled();
  await expect(more("gateway-error")).toBeDisabled();
  await dialog.getByPlaceholder("code=… or the full …/callback?code=… URL").fill("fixture-code");
  await dialog.getByRole("button", { name: "Finish sign-in", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(connect("gateway-error")).toBeEnabled();
  await connect("gateway-error").click();
  // A cancelled token exchange can answer after another server owns the UI.
  await page.evaluate(() => window.mcpAuthSmoke.finishCancelled());
  await expect(cancel()).toBeEnabled();
  await expect(connect("gateway-second")).toBeDisabled();
  await page.evaluate(() => window.mcpAuthSmoke.finish());
  await expect(connect("gateway-second")).toBeEnabled();
  expect(await page.evaluate(() => window.mcpAuthSmoke.calls)).toEqual([
    { op: "mcp.gateway.authorize", server: "gateway-error" },
    { op: "mcp.gateway.beginAuth", server: "gateway-second" },
    { op: "mcp.gateway.completeAuth", server: "gateway-second" },
    { op: "mcp.gateway.cancelAuth", server: "gateway-second" },
    { op: "mcp.gateway.authorize", server: "gateway-error" },
  ]);
  check("MCP sign-ins serialize across servers and preserve cancellation through browser and paste-code flows", true);
}
