import { expect } from "@playwright/test";

export async function runContextGaugeSmoke({ page, harnessBase }) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${harnessBase}/harness-context-gauge.html`);
  const trigger = page.getByRole("button", { name: /^Context ·/ });
  await trigger.focus();
  await trigger.press("Enter");
  const panel = page.locator('[data-zeros-native-overlay="popover"]');
  const row = (name) => panel.getByText(name, { exact: true }).locator("..");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("80.0k / 200k");
  await expect(row("Free space")).toHaveText("Free space50.0%");
  await expect(row("Messages")).toHaveText("Messages30.0%");
  await expect(row("Autocompact buffer")).toHaveText("Autocompact buffer10.0%");
  await expect(panel).not.toContainText("Available room");
  await expect(panel).not.toContainText("On-demand tools");
  await expect(panel).not.toContainText("Not included");
  await expect(panel).not.toContainText("deferred");
  // The category rows are one continuous list. Only the existing action footer
  // has a divider; no new deferred section or explanatory paragraph.
  await expect(panel.locator(".border-t")).toHaveCount(1);
  await expect(panel.locator("p")).toHaveCount(0);
  await panel.getByRole("button", { name: "Compact now" }).click();
  expect(await page.evaluate(() => window.contextCompactions)).toBe(1);

  // A refresh updates the open popover in place. Native zero free space must
  // not be replaced by the computed remainder.
  await page.evaluate(() =>
    window.setContextFixture({
      compactDisabled: true,
      usage: {
        size: 100,
        used: 30,
        categories: [
          { name: "Available", tokens: 0, kind: "free" },
          { name: "Tools", tokens: 30, kind: "used" },
        ],
      },
    }),
  );
  await expect(panel).toContainText("30 / 100");
  await expect(row("Free space")).toHaveText("Free space0.0%");
  await expect(row("Tools")).toHaveText("Tools30.0%");
  await expect(
    panel.getByRole("button", { name: "Compact now" }),
  ).toBeDisabled();
  await page.evaluate(() =>
    window.setContextFixture({
      usage: {
        size: 100,
        used: 30,
        categories: [{ name: "Tools", tokens: 30, kind: "deferred" }],
      },
    }),
  );
  await expect(panel.getByText("Tools", { exact: true })).toHaveCount(0);
  await expect(row("Used")).toHaveText("Used30.0%");

  // Older snapshots have names only; providers without categories retain the
  // same Used/Free display. Compaction may validly reduce the reading to zero.
  await page.evaluate(() =>
    window.setContextFixture({
      usage: {
        size: 100,
        used: 30,
        categories: [
          { name: "Messages", tokens: 30 },
          { name: "Compact buffer", tokens: 10 },
          { name: "MCP tools (deferred)", tokens: 500 },
        ],
      },
    }),
  );
  await expect(row("Free space")).toHaveText("Free space60.0%");
  await expect(panel).not.toContainText("deferred");
  await page.evaluate(() =>
    window.setContextFixture({ usage: { size: 100, used: 0, categories: [] } }),
  );
  await expect(row("Free space")).toHaveText("Free space100.0%");
  await expect(row("Used")).toHaveText("Used0.0%");
  await expect(panel.getByText("Messages", { exact: true })).toHaveCount(0);

  await page.evaluate(() => {
    globalThis.contextMcpFixture = {
      size: 200_000, used: 80_000, categories: [
        { id: "messages", name: "Messages", tokens: 55_000, kind: "used" },
        { id: "free_space", name: "Available", tokens: 100_000, kind: "free" },
        { id: "system_prompt", name: "System prompt", tokens: 4_000, kind: "used" },
        { id: "system_tools", name: "System tools", tokens: 3_000, kind: "used" },
        { id: "skills", name: "Skills", tokens: 5_000, kind: "used" },
        { id: "mcp_tools", name: "Connected tools", tokens: 10_000, kind: "used", mcpServers: [
          { serverName: "Team_Docs", tokens: 4_000 }, { serverName: "build_ops", tokens: 3_000 },
          { serverName: "search", tokens: 1_500 }, { serverName: "alerts", tokens: 1_000 }, { serverName: "git", tokens: 500 },
        ] },
        { id: "mcp_instructions", name: "Server guidance", tokens: 3_000, kind: "used", mcpServers: [
          { serverName: "Team Docs", tokens: 1_000 }, { serverName: "build.ops", tokens: 1_000 },
          { serverName: "search", tokens: 500 }, { serverName: "alerts", tokens: 300 }, { serverName: "git", tokens: 200 },
        ] },
        { id: "autocompact_buffer", name: "Autocompact buffer", tokens: 20_000, kind: "buffer" },
        { id: "mcp_tools_deferred", name: "Unloaded tools", tokens: 90_000, kind: "deferred" },
      ],
    };
    globalThis.setContextFixture({ usage: globalThis.contextMcpFixture });
  });
  const servers = panel.getByRole("button", { name: "MCP servers", exact: true });
  await expect(servers).toHaveAttribute("aria-expanded", "false");
  await expect(servers).toContainText("6.5%");
  await expect(row("Skills")).toHaveText("Skills2.5%");
  await servers.focus(); await servers.press("Enter");
  await expect(servers).toHaveAttribute("aria-expanded", "true");
  await expect(row("Team Docs")).toHaveText("Team Docs2.5%");
  await expect(row("build.ops")).toHaveText("build.ops2.0%");
  await expect(row("search")).toHaveText("search1.0%");
  const more = panel.getByRole("button", { name: "2 more MCP servers" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toContainText("1.0%");
  await expect(panel.getByText("alerts", { exact: true })).toHaveCount(0);
  await more.focus(); await more.press("Space");
  await expect(row("alerts")).toHaveText("alerts0.7%");
  await expect(row("git")).toHaveText("git0.3%");
  await expect(panel.getByText("Unloaded tools", { exact: true })).toHaveCount(0);
  // Stable row IDs preserve disclosure state and keyboard focus when native
  // labels/order change during a refresh. No owner-global selection is added.
  const less = panel.getByRole("button", { name: "Show fewer MCP servers" });
  await expect(less).toBeFocused();
  await page.evaluate(() => globalThis.setContextFixture({ usage: {
    ...globalThis.contextMcpFixture,
    categories: globalThis.contextMcpFixture.categories.toReversed().map(category =>
      category.id === "mcp_tools" ? { ...category, name: "Renamed connected tools" } : category),
  } }));
  await expect(servers).toHaveAttribute("aria-expanded", "true");
  await expect(less).toBeFocused();
  await expect(row("alerts")).toHaveText("alerts0.7%");
  await less.press("Enter");
  await expect(more).toBeFocused();
  await expect(panel.getByText("alerts", { exact: true })).toHaveCount(0);
  await servers.focus(); await servers.press("Space");
  await expect(servers).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByText("Team Docs", { exact: true })).toHaveCount(0);

  await page.evaluate(() =>
    window.setContextFixture({ usage: { size: 100, used: 120 } }),
  );
  await expect(panel).toContainText("120 / 100");
  await expect(row("Free space")).toHaveText("Free space0.0%");
  await expect(
    page.getByRole("img", { name: "Context 100% used" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(panel).toBeVisible();

  await page.evaluate(() =>
    window.setContextFixture({
      usage: null,
      unavailableReason: "Context usage is not available for this agent.",
    }),
  );
  await expect(panel).toHaveText(
    "Context usage is not available for this agent.",
  );
  await expect(panel.getByRole("button", { name: "Compact now" })).toHaveCount(
    0,
  );
  expect(errors).toEqual([]);
  console.log(
    "  [ok] context categories: native/legacy IDs and kinds, MCP shares/disclosures, stable focus, reserve, deferred hiding, live refresh and compaction",
  );
}
