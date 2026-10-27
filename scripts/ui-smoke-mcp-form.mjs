import { expect } from "@playwright/test";

/** Production Local editor and storage boundary with deterministic fixtures. */
export async function runMcpFormSmoke({ page, check }) {
  await page.goto(`${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-customize.html`);
  await page.getByRole("button", { name: "Customize scope" }).click();
  await page.getByRole("menuitem").filter({ hasText: "User" }).click();
  await page.getByRole("tab", { name: "MCP", exact: true }).click();
  const button = name => page.getByRole("button", { name, exact: true });
  const field = name => page.getByLabel(name, { exact: true });
  const select = name => page.getByRole("combobox", { name, exact: true });
  const section = name => page.getByRole("region", { name, exact: true });
  const add = () => page.getByRole("button", { name: /New MCP server/ }).click();

  const beforeLegacyProbe = await page.evaluate(() => window.mcpFormFixture.probeCount);
  await button("Edit gateway-error").click();
  await expect(select("Transport")).toContainText("Legacy SSE");
  await expect.poll(() => page.evaluate(() => window.mcpFormFixture.probeCount)).toBeGreaterThan(beforeLegacyProbe);
  await button("Connect").click();
  await expect(section("Connection")).toContainText("Connected");
  const beforeLegacyRetry = await page.evaluate(() => window.mcpFormFixture.probeCount);
  await button("Check connection").click();
  await expect.poll(() => page.evaluate(() => window.mcpFormFixture.probeCount)).toBeGreaterThan(beforeLegacyRetry);
  await button("Save changes").click();
  await expect(page.locator("#last-write")).toContainText('"transport":"sse"');
  check("Existing SSE configurations retain their transport and support connection checks", true);

  await add();
  await expect(page.getByText("Name is required.", { exact: true })).toHaveCount(0);
  await button("Add server").click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Name is required." })).toBeVisible();
  await expect(section("Server")).not.toContainText("Name is required.");
  await select("Transport").click();
  await expect(page.getByRole("option")).toHaveText(["STDIO", "Streamable HTTP"]);
  await page.keyboard.press("Escape");
  check("MCP creation offers two transports and only toasts validation on submit", true);

  await field("Name").fill("literal-tools");
  await field("Command to launch").fill("node");
  await button("Add argument").click();
  await field("Argument 1").fill("  a literal argument  ");
  await button("Add argument").click();
  await field("Working directory").fill("tools");
  await button("Add variable").click();
  await field("Variable name 1").fill("REGION");
  await field("Variable value 1").fill("fixture-value");
  await expect(field("Variable value 1")).toHaveAttribute("type", "password");
  await select("Project").click();
  expect((await page.getByRole("option").allTextContents()).sort()).toEqual(["All projects", "Repo A", "Repo B"]);
  await page.getByRole("option", { name: "Repo A", exact: true }).click();
  await button("Add server").click();
  await expect(button("Edit literal-tools")).toBeVisible();
  await expect(button("Edit literal-tools").locator("..").locator("..")).toContainText("Starts with agent");
  await expect(button("Edit literal-tools").locator("..").getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
  await expect(button("Customize scope")).toContainText("Repo A");
  const stored = JSON.parse(await page.locator("#last-write").textContent());
  expect(stored).toMatchObject({ layer: "repo-local", repoRoot: "/fixture/repo-a", server: { args: ["  a literal argument  ", ""], cwd: "tools", env: { REGION: "${zeros.secret}" } } });
  expect(JSON.stringify(stored)).not.toContain("fixture-value");
  await button("Edit literal-tools").click();
  await expect(field("Argument 1")).toHaveValue("  a literal argument  ");
  await expect(field("Argument 2")).toHaveValue("");
  await expect(field("Variable value 1")).toHaveValue("");
  await expect(field("Variable value 1")).toHaveAttribute("placeholder", "Saved value");
  check("Local project creation returns to its destination and preserves literal arguments and sealed variables", true);
  await button("MCP").click();

  await add();
  await expect(field("Configuration")).toHaveCount(0);
  await button("Import a configuration").click();
  await field("Configuration").fill(JSON.stringify({ mcpServers: { "api-tools": {
    url: "https://tools.example.test/mcp", env: { REGION: "west" }, headers: { Authorization: "fixture-api", "X-Region": "${REGION}" },
  } } }));
  const before = await page.evaluate(() => window.mcpFormFixture.saveCount);
  await button("Parse").click();
  await expect(field("Name")).toHaveValue("api-tools");
  await expect(field("URL")).toHaveValue("https://tools.example.test/mcp");
  await expect(field("Header name 2")).toHaveValue("X-Region");
  await expect(field("Variable name 1")).toHaveValue("REGION");
  expect(await page.evaluate(() => window.mcpFormFixture.saveCount)).toBe(before);
  await expect(section("Connection")).toContainText("3 tools available.");
  await page.evaluate(() => { window.mcpFormFixture.failSave = true; });
  await button("Add server").click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "MCP secrets could not be saved securely" })).toBeVisible();
  await expect(field("Name")).toHaveValue("api-tools");
  expect(await page.evaluate(() => window.mcpFormFixture.saveCount)).toBe(before);
  await page.evaluate(() => { window.mcpFormFixture.failSave = false; });
  await button("Add server").click();
  await expect(button("Edit api-tools")).toBeVisible();
  await expect(page.locator("#last-write")).not.toContainText("fixture-api");
  await button("Edit api-tools").click();
  await field("Header value 1").fill("replacement-fixture");
  await expect(section("Connection")).not.toContainText("Connected");
  check("Import fills an editable draft, masked headers stay private, and failed saves keep the draft", true);
  await button("MCP").click();

  await add();
  await field("Name").fill("oauth-tools");
  await select("Transport").click();
  await page.getByRole("option", { name: "Streamable HTTP", exact: true }).click();
  await field("URL").fill("https://oauth.example.test/mcp");
  await select("Authentication").click();
  await page.getByRole("option", { name: "Sign in", exact: true }).click();
  await button("Advanced sign-in options").click();
  await select("OAuth client").click();
  await page.getByRole("option", { name: "Your own client", exact: true }).click();
  await field("Client ID").fill("fixture-client");
  await field("Client secret").fill("fixture-client-secret");
  await field("Scopes").fill("read write");
  await button("Add server").click();
  await expect(button("Edit oauth-tools")).toBeVisible();
  await expect(page.locator("#last-write")).not.toContainText("fixture-client-secret");
  await button("Edit oauth-tools").click();
  await expect(field("Client secret")).toHaveValue("");
  await expect(section("Connection")).toContainText("Sign-in required");
  await button("Connect").click();
  await expect(section("Connection")).toContainText("Connected");
  await expect(section("Connection")).toContainText("3 tools available.");
  check("OAuth client configuration reopens without secrets and Connect refreshes the saved status", true);

  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    // Inputs animate color changes; capture the settled theme, not its first frame.
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('input[autocomplete="off"]')).color === getComputedStyle(document.querySelector("h1")).color)).toBe(true);
    await page.setViewportSize({ width: 1200, height: 2200 });
    await page.screenshot({ path: `.context/mcp-editor-${theme}.png`, fullPage: true });
    const inputs = await page.locator('input:not([type="hidden"]):not([type="file"]), textarea').evaluateAll(elements => elements.map(element => ({ font: getComputedStyle(element).fontFamily, size: getComputedStyle(element).fontSize })));
    expect(inputs.every(input => input.size === "13px" && !/mono/i.test(input.font))).toBe(true);
  }
  await page.setViewportSize({ width: 500, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await button("MCP").click();
  await button("Customize scope").click();
  await page.getByRole("menuitem").filter({ hasText: "User" }).click();
  check("MCP inputs use normal typography in both themes and the editor fits narrow windows", true);
}
