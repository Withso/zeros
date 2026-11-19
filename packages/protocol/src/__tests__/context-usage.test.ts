import { describe, expect, it } from "vitest";
import { mapClaudeContextUsage } from "../context-usage";

describe("Claude context usage mapping shared by Local and cloud", () => {
  it("does not let a legacy name override a recognized stable category ID", () => {
    expect(mapClaudeContextUsage({ totalTokens: 30, maxTokens: 100, categories: [
      { id: "messages", name: "Tools (deferred)", tokens: 30 },
      { id: "free_space", name: "Reserve (deferred)", tokens: 60 },
      { id: "compact_buffer", name: "Free space", tokens: 10 },
    ] })?.categories).toEqual([
      { id: "messages", name: "Tools (deferred)", tokens: 30, kind: "used" },
      { id: "free_space", name: "Reserve (deferred)", tokens: 60, kind: "free" },
      { id: "compact_buffer", name: "Free space", tokens: 10, kind: "buffer" },
    ]);
  });

  it("keeps legacy snapshots compatible and treats unknown IDs as absent", () => {
    expect(mapClaudeContextUsage({ totalTokens: 30, maxTokens: 100, categories: [
      { name: " Messages ", tokens: 30, id: "future_messages" },
      { name: "Free space", tokens: 60 },
      { name: "Compact buffer", tokens: 10 },
      { name: "MCP tools", tokens: 90, isDeferred: true },
      { name: "Unclassified", tokens: 10, kind: "future_kind" },
    ] })).toEqual({ sessionUpdate: "usage_update", size: 100, used: 30, categories: [
      { name: "Messages", tokens: 30, kind: "used" },
      { name: "Free space", tokens: 60, kind: "free" },
      { name: "Compact buffer", tokens: 10, kind: "buffer" },
      { name: "MCP tools", tokens: 90, kind: "deferred" },
    ] });
  });

  it("uses category accounting to exclude deferred tools only when the CLI defers their tokens", () => {
    const usage = { totalTokens: 10, maxTokens: 100, categories: [
      { id: "mcp_tools", name: "MCP tools", tokens: 10, kind: "used" },
    ], mcpTools: [
      { name: "mcp__loaded__read", serverName: "loaded", tokens: 3, isLoaded: true },
      { name: "mcp__available__read", serverName: "available", tokens: 7, isLoaded: false },
    ] };
    // Real summary-mode CLI with tool search disabled reports isLoaded=false
    // even though its used MCP row includes those tool tokens.
    expect(mapClaudeContextUsage(usage)?.categories?.[0].mcpServers).toEqual([
      { serverName: "available", tokens: 7 }, { serverName: "loaded", tokens: 3 },
    ]);
    expect(mapClaudeContextUsage({ ...usage, categories: [
      { ...usage.categories[0], tokens: 3 },
      { id: "mcp_tools_deferred", name: "Available schemas", tokens: 7, kind: "deferred" },
    ] })?.categories?.[0].mcpServers).toEqual([{ serverName: "loaded", tokens: 3 }]);
  });

  it("preserves raw instruction identities and aggregates duplicate tool estimates", () => {
    expect(mapClaudeContextUsage({ totalTokens: 12, maxTokens: 100, categories: [
      { id: "mcp_tools", name: "Renamed tools", tokens: 7, kind: "used" },
      { id: "mcp_instructions", name: "Renamed instructions", tokens: 5, kind: "used" },
    ], mcpTools: [
      { serverName: "Team_Docs", tokens: 3 }, { serverName: "Team_Docs", tokens: 4 },
    ], mcpInstructions: [{ serverName: "Team Docs", tokens: 5 }] })?.categories).toEqual([
      { id: "mcp_tools", name: "Renamed tools", tokens: 7, kind: "used", mcpServers: [{ serverName: "Team_Docs", tokens: 7 }] },
      { id: "mcp_instructions", name: "Renamed instructions", tokens: 5, kind: "used", mcpServers: [{ serverName: "Team Docs", tokens: 5 }] },
    ]);
  });

  it("keeps valid totals when breakdowns are absent or invalid, without attaching a partial split", () => {
    expect(mapClaudeContextUsage({ totalTokens: 0, maxTokens: 100 })).toEqual({ sessionUpdate: "usage_update", size: 100, used: 0, categories: [] });
    expect(mapClaudeContextUsage({ totalTokens: 10, maxTokens: 100, categories: [
      null, { name: " ", tokens: 5 }, { name: "Bad", tokens: -1 },
      { id: "mcp_tools", name: "MCP tools", tokens: 10, kind: "used" },
    ], mcpTools: [{ serverName: "docs", tokens: 5 }, { serverName: "bad", tokens: NaN }] })?.categories).toEqual([
      { id: "mcp_tools", name: "MCP tools", tokens: 10, kind: "used" },
    ]);
  });

  it.each([null, {}, { totalTokens: -1, maxTokens: 100 }, { totalTokens: Infinity, maxTokens: 100 }, { totalTokens: 1, maxTokens: 0 }])("rejects invalid totals: %j", value => {
    expect(mapClaudeContextUsage(value)).toBeNull();
  });
});
