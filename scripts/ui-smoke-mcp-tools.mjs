import { expect } from "@playwright/test";

/** Real editor, fixture bridge: inventory, policy writes and exact-key refresh. */
export async function runMcpToolsSmoke({ page: parent, check }) {
  const context = await parent.context().browser().newContext({ viewport: { width: 1200, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const button = name => page.getByRole("button", { name, exact: true });
  const tools = () => page.getByRole("region", { name: "Tools", exact: true });
  const allow = name => tools().getByRole("switch", { name: `Allow ${name}`, exact: true });
  const add = () => page.getByRole("button", { name: /New MCP server/ }).click();
  try {
    await page.goto(new URL("/apps/desktop/src/renderer/harnesses/harness-customize.html", parent.url()).href);
    await page.getByRole("tab", { name: "MCP", exact: true }).click();
    await add();
    await page.getByLabel("Name", { exact: true }).fill("tool-policy");
    await page.getByRole("combobox", { name: "Transport" }).click();
    await page.getByRole("option", { name: "Streamable HTTP", exact: true }).click();
    await page.getByLabel("URL", { exact: true }).fill("https://tools.example.test/mcp");
    await page.getByRole("radio", { name: /^API key/ }).click();
    await button("Add header").click();
    await page.getByLabel("Header name 1").fill("Authorization");
    await page.getByLabel("Header value 1").fill("fixture-tools-key");
    await expect(allow("delete_file")).toBeEnabled();
    const probes = await page.evaluate(() => window.mcpFormFixture.probeCount);
    await allow("delete_file").click();
    // Cover the real 600 ms connection debounce: policy edits must not reconnect.
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.mcpFormFixture.probeCount)).toBe(probes);
    await page.evaluate(() => { window.mcpFormFixture.failSave = true; });
    await button("Add server").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "MCP secrets could not be saved securely" })).toBeVisible();
    await expect(allow("delete_file")).not.toBeChecked();
    await page.evaluate(() => { window.mcpFormFixture.failSave = false; });
    await button("Add server").click();
    await expect(button("Edit tool-policy")).toBeVisible();
    expect(JSON.parse(await page.locator("#last-write").textContent()).server.disabled_tools).toEqual(["delete_file"]);
    await button("Edit tool-policy").click();
    await expect(allow("delete_file")).not.toBeChecked();
    await expect(allow("read_file")).toBeChecked();
    check("Connected MCP tools include disabled names, save with the draft, and do not reconnect for policy edits", true);

    await page.evaluate(() => { window.mcpFormFixture.failProbe = true; });
    await tools().getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Could not refresh tools" })).toBeVisible();
    await expect(allow("delete_file")).not.toBeChecked();
    await page.evaluate(() => { window.mcpFormFixture.failProbe = false; window.mcpFormFixture.toolNames.push("new_tool"); });
    await tools().getByRole("button", { name: "Test", exact: true }).click();
    await expect(allow("new_tool")).toBeVisible();
    await expect(allow("delete_file")).not.toBeChecked();
    await page.evaluate(() => { window.mcpFormFixture.holdProbe = true; window.mcpFormFixture.releaseProbe = undefined; });
    await tools().getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean(window.mcpFormFixture.releaseProbe))).toBe(true);
    await allow("read_file").click();
    await button("Save changes").click();
    await expect(button("Edit tool-policy")).toBeVisible();
    await expect(button("Edit tool-policy").locator("..")).toContainText("Connected");
    expect(JSON.parse(await page.locator("#last-write").textContent()).server.disabled_tools).toEqual(["delete_file", "read_file"]);
    await page.evaluate(() => { window.mcpFormFixture.holdProbe = false; window.mcpFormFixture.releaseProbe(); window.mcpFormFixture.releaseProbe = undefined; });
    await button("Edit tool-policy").click();
    await expect(allow("read_file")).not.toBeChecked();
    await expect(allow("delete_file")).not.toBeChecked();
    check("Saving tool choices during discovery preserves the exact confirmed connection and catalog", true);
    // Error feedback has the shared six-second lifetime. Keep the pointer off
    // the toast stack so its intentional hover pause cannot hold the capture.
    await page.mouse.move(0, 0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 8000 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('input[autocomplete="off"]')).color === getComputedStyle(document.querySelector("h1")).color)).toBe(true);
      await page.screenshot({ path: `.context/mcp-tools-${theme}.png` });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; window.mcpFormFixture.toolNames = ["other_tool"]; });
    await page.getByLabel("URL", { exact: true }).fill("https://other.example.test/mcp");
    await expect(allow("read_file")).toHaveCount(0);
    await expect(allow("other_tool")).toBeVisible();
    await page.evaluate(() => { window.mcpFormFixture.holdProbe = true; window.mcpFormFixture.releaseProbe = undefined; window.mcpFormFixture.toolNames = ["retired_tool"]; });
    await tools().getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean(window.mcpFormFixture.releaseProbe))).toBe(true);
    await expect(allow("other_tool")).toBeVisible();
    await page.evaluate(() => { window.mcpFormFixture.holdProbe = false; window.mcpFormFixture.toolNames = ["current_tool"]; });
    await page.getByLabel("URL", { exact: true }).fill("https://current.example.test/mcp");
    await expect(allow("other_tool")).toHaveCount(0);
    await expect(allow("current_tool")).toBeVisible();
    await page.evaluate(() => window.mcpFormFixture.releaseProbe());
    await expect(allow("retired_tool")).toHaveCount(0);
    await expect(allow("current_tool")).toBeVisible();
    check("Tool refresh retains the confirmed inventory on failure and fences it when the endpoint changes", true);

    await button("MCP").click();
    await add();
    await page.getByLabel("Name", { exact: true }).fill("direct-tools");
    await page.getByRole("combobox", { name: "Transport" }).click();
    await page.getByRole("option", { name: "Streamable HTTP", exact: true }).click();
    await page.getByLabel("URL", { exact: true }).fill("https://direct.example.test/mcp");
    await expect(allow("current_tool")).toBeDisabled();
    await expect(allow("current_tool")).toBeChecked();
    await page.evaluate(() => { window.mcpFormFixture.toolNames = Array.from({ length: 137 }, (_, i) => `tool_${i}`); });
    await tools().getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(tools().getByRole("switch")).toHaveCount(50);
    await tools().getByRole("button", { name: "Next tools", exact: true }).click();
    await expect(allow("tool_50")).toBeVisible();
    await tools().getByRole("button", { name: "Previous tools", exact: true }).click();
    await expect(allow("tool_0")).toBeVisible();
    await tools().getByLabel("Search tools").fill("tool_136");
    await expect(allow("tool_136")).toBeDisabled();
    await expect(tools().getByRole("switch")).toHaveCount(1);
    await page.evaluate(() => { window.mcpFormFixture.toolNames = ["small_catalog"]; });
    await tools().getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(tools()).toContainText("No tools match your search.");
    await tools().getByLabel("Search tools").fill("");
    await expect(allow("small_catalog")).toBeDisabled();
    await page.evaluate(() => { window.mcpFormFixture.toolNames = []; });
    await tools().getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(tools()).toContainText("This server has no tools.");
    await expect(tools().getByRole("switch")).toHaveCount(0);
    expect(errors).toEqual([]);
    check("Uncontrolled connections have disabled switches, large inventories have bounded rows, and empty catalogs are explicit", true);
  } finally {
    await context.close();
  }
}
