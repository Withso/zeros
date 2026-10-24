import { describe, expect, it } from "vitest";
import { contextGaugeData } from "../context-usage";

describe("context gauge categories", () => {
  it("uses stable IDs to join MCP tools and instructions while showing reported Skills", () => {
    const data = contextGaugeData({ size: 100, used: 25, categories: [
      { id: "mcp_tools", name: "Connected tools", tokens: 10, kind: "used", mcpServers: [
        { serverName: "Team_Docs", tokens: 8 }, { serverName: "build_ops", tokens: 2 },
      ] },
      { id: "mcp_instructions", name: "Guidance", tokens: 8, kind: "used", mcpServers: [
        { serverName: "Team Docs", tokens: 5 }, { serverName: "build.ops", tokens: 3 },
      ] },
      { id: "skills", name: "Skills", tokens: 3, kind: "used" },
      { id: "messages", name: "MCP tools", tokens: 4, kind: "used" },
      { id: "mcp_tools_deferred", name: "Available schemas", tokens: 90, kind: "deferred" },
    ] });
    expect(data?.rows.map(row => row.name)).toEqual(["Free space", "MCP servers", "MCP tools", "Skills"]);
    expect(data?.rows[1]).toMatchObject({ tokens: 18, servers: [
      { name: "Team Docs", tokens: 13 }, { name: "build.ops", tokens: 5 },
    ] });
  });

  it("treats unknown IDs as absent and keeps native kind ahead of ID and name fallbacks", () => {
    expect(contextGaugeData({ size: 100, used: 30, categories: [
      { id: "future_free" as never, name: "Free space", tokens: 60 },
      { id: "messages", name: "Messages", tokens: 30 },
      { id: "compact_buffer", name: "Reserved", tokens: 10 },
      { id: "mcp_tools_deferred", name: "Future label", tokens: 50 },
    ] })?.rows).toEqual([
      { name: "Free space", tokens: 60, kind: "free" },
      { id: "messages", name: "Messages", tokens: 30, kind: "used" },
      { id: "compact_buffer", name: "Reserved", tokens: 10, kind: "buffer" },
    ]);
    expect(contextGaugeData({ size: 100, used: 20, categories: [
      { id: "mcp_tools_deferred", name: "Tools", tokens: 20, kind: "used" },
    ] })?.rows[1]).toMatchObject({ name: "Tools", kind: "used" });
  });

  it("retains category rows when per-server detail is absent, incomplete or malformed", () => {
    for (const mcpServers of [undefined, [], [{ serverName: " ", tokens: 10 }], [{ serverName: "docs", tokens: Infinity }]]) {
      const data = contextGaugeData({ size: 100, used: 15, categories: [
        { id: "mcp_tools", name: "MCP tools", tokens: 10, kind: "used", mcpServers },
        { id: "mcp_instructions", name: "MCP server instructions", tokens: 5, kind: "used" },
      ] });
      expect(data?.rows.map(row => row.name)).toEqual(["Free space", "MCP tools", "MCP server instructions"]);
    }
  });

  it("keeps normalization collisions, delimiter-truncated names and case mismatches separate", () => {
    const group = contextGaugeData({ size: 100, used: 19, categories: [
      { id: "mcp_tools", name: "MCP tools", tokens: 9, kind: "used", mcpServers: [
        { serverName: "a_b", tokens: 4 }, { serverName: "ops", tokens: 3 }, { serverName: "github", tokens: 2 },
      ] },
      { id: "mcp_instructions", name: "MCP server instructions", tokens: 10, kind: "used", mcpServers: [
        { serverName: "a.b", tokens: 3 }, { serverName: "a/b", tokens: 2 },
        { serverName: "ops__prod", tokens: 2 }, { serverName: "ops", tokens: 1 }, { serverName: "GitHub", tokens: 2 },
      ] },
    ] })?.rows.find(row => row.name === "MCP servers");
    expect(group?.servers).toHaveLength(8);
    expect(group?.servers?.reduce((sum, row) => sum + row.tokens, 0)).toBe(19);
    expect(new Set(group?.servers?.map(row => row.key)).size).toBe(8);
    expect(new Set(group?.servers?.map(row => row.name)).size).toBe(8);
  });

  it("reconciles native estimate rounding to the group total and keeps row keys stable", () => {
    // Captured from the credential-free bundled CLI: three 192-token tool
    // estimates accompany a 575-token row; instructions already sum to 686.
    const categories = [
      { id: "mcp_tools" as const, name: "MCP tools", tokens: 575, kind: "used" as const, mcpServers: [
        { serverName: "build_ops", tokens: 192 }, { serverName: "ops", tokens: 192 }, { serverName: "Team_Docs", tokens: 192 },
      ] },
      { id: "mcp_instructions" as const, name: "MCP server instructions", tokens: 686, kind: "used" as const, mcpServers: [
        { serverName: "build.ops", tokens: 229 }, { serverName: "ops__prod", tokens: 229 }, { serverName: "Team Docs", tokens: 228 },
      ] },
    ];
    const group = contextGaugeData({ size: 10_000, used: 1261, categories })?.rows[1];
    expect(group?.tokens).toBe(1261);
    expect(group?.servers).toHaveLength(4);
    expect(group?.servers?.reduce((sum, row) => sum + row.tokens, 0)).toBe(group?.tokens);
    expect(group?.servers?.reduce((sum, row) => sum + row.percentageTenths, 0)).toBe(group?.percentageTenths);
    const reordered = contextGaugeData({ size: 10_000, used: 1261, categories: [...categories].reverse().map(row => ({ ...row, mcpServers: [...row.mcpServers].reverse() })) })?.rows[1];
    expect(reordered).toEqual(group);
  });

  it("uses name fallback to group older classified rows only when they supply server detail", () => {
    const data = contextGaugeData({ size: 100, used: 10, categories: [
      { name: "MCP tools", tokens: 7, mcpServers: [{ serverName: "docs", tokens: 7 }] },
      { name: "MCP server instructions", tokens: 3, mcpServers: [{ serverName: "docs", tokens: 3 }] },
    ] });
    expect(data?.rows[1]).toMatchObject({ name: "MCP servers", tokens: 10, servers: [{ name: "docs", tokens: 10 }] });
  });

  it("uses native free space once, keeps buffer separate, and hides deferred schemas", () => {
    const data = contextGaugeData({
      size: 200,
      used: 80,
      categories: [
        { name: "Messages", tokens: 60, kind: "used" },
        { name: "Available room", tokens: 100, kind: "free" },
        { name: "System prompt", tokens: 20, kind: "used" },
        { name: "Autocompact buffer", tokens: 20, kind: "buffer" },
        { name: "On-demand tools", tokens: 500, kind: "deferred" },
        { name: "Another free label", tokens: 100, kind: "free" },
      ],
    });
    expect(data?.fraction).toBe(0.4);
    expect(data?.rows).toEqual([
      { name: "Free space", tokens: 100, kind: "free" },
      { name: "Messages", tokens: 60, kind: "used" },
      { name: "System prompt", tokens: 20, kind: "used" },
      { name: "Autocompact buffer", tokens: 20, kind: "buffer" },
    ]);
  });

  it("does not rewrite authoritative totals to match estimated category counts", () => {
    const data = contextGaugeData({
      size: 200,
      used: 80,
      categories: [
        { name: "Messages", tokens: 75, kind: "used" },
        { name: "Available", tokens: 105, kind: "free" },
        { name: "Buffer", tokens: 20, kind: "buffer" },
      ],
    });
    expect(data).toMatchObject({ size: 200, used: 80, fraction: 0.4 });
    expect(data?.rows[0].tokens).toBe(105);
  });

  it("subtracts reserve only when computing missing free space", () => {
    const categories = [
      { name: "Reserve", tokens: 20, kind: "buffer" as const },
    ];
    expect(contextGaugeData({ size: 200, used: 80, categories })?.rows).toEqual(
      [
        { name: "Free space", tokens: 100, kind: "free" },
        { name: "Used", tokens: 80, kind: "used" },
        { name: "Reserve", tokens: 20, kind: "buffer" },
      ],
    );
    expect(
      contextGaugeData({
        size: 200,
        used: 80,
        categories: [
          ...categories,
          { name: "Available", tokens: 0, kind: "free" },
        ],
      })?.rows[0].tokens,
    ).toBe(0);
  });

  it("supports legacy snapshots and preserves native kind over a misleading name", () => {
    expect(
      contextGaugeData({
        size: 100,
        used: 30,
        categories: [
          { name: "Messages", tokens: 30 },
          { name: "MCP tools (deferred)", tokens: 500 },
          { name: "Compact buffer", tokens: 10 },
          { name: "Free space", tokens: 60 },
        ],
      })?.rows,
    ).toEqual([
      { name: "Free space", tokens: 60, kind: "free" },
      { name: "Messages", tokens: 30, kind: "used" },
      { name: "Compact buffer", tokens: 10, kind: "buffer" },
    ]);
    expect(
      contextGaugeData({
        size: 100,
        used: 30,
        categories: [{ name: "Tools (deferred)", tokens: 30, kind: "used" }],
      })?.rows[1],
    ).toEqual({ name: "Tools (deferred)", tokens: 30, kind: "used" });
  });

  it("retains Used/Free for providers without categories and after clearing context", () => {
    expect(contextGaugeData({ size: 100, used: 30 })?.rows).toEqual([
      { name: "Free space", tokens: 70, kind: "free" },
      { name: "Used", tokens: 30, kind: "used" },
    ]);
    expect(
      contextGaugeData({ size: 100, used: 0, categories: [] })?.rows,
    ).toEqual([
      { name: "Free space", tokens: 100, kind: "free" },
      { name: "Used", tokens: 0, kind: "used" },
    ]);
  });

  it("bounds free space and the ring without clamping the over-limit headline", () => {
    const data = contextGaugeData({
      size: 100,
      used: 120,
      categories: [
        { name: "Available", tokens: 50, kind: "free" },
        { name: "Messages", tokens: 120, kind: "used" },
      ],
    });
    expect(data).toMatchObject({ used: 120, size: 100, fraction: 1 });
    expect(data?.rows[0].tokens).toBe(0);
    expect(
      contextGaugeData({
        size: 100,
        used: 80,
        categories: [{ name: "Reserve", tokens: 200, kind: "buffer" }],
      })?.rows[0].tokens,
    ).toBe(0);
  });

  it.each([
    null,
    undefined,
    { size: 0, used: 0 },
    { size: Infinity, used: 20 },
    { size: 100, used: NaN },
    { size: 100, used: -1 },
    { size: 100, used: Infinity },
  ])("does not render invalid context totals: %j", (usage) => {
    expect(contextGaugeData(usage)).toBeNull();
  });

  it("ignores malformed rows without changing totals or mutating the source", () => {
    const categories = Object.freeze([
      { name: "Zero", tokens: 0, kind: "used" as const },
      { name: "Infinite", tokens: Infinity, kind: "buffer" as const },
      { name: "Negative", tokens: -1, kind: "used" as const },
      { name: " ", tokens: 20, kind: "used" as const },
      { name: "Messages", tokens: 20, kind: "used" as const },
    ]);
    expect(
      contextGaugeData({ size: 100, used: 20, categories: [...categories] })
        ?.rows,
    ).toEqual([
      { name: "Free space", tokens: 80, kind: "free" },
      { name: "Messages", tokens: 20, kind: "used" },
    ]);
  });
});
