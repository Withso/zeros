import { BUILTIN_TOOL_NAMES, LEGACY_TOOL_NAME_ALIASES } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceToolNameSites, toolNameSources, unknownClaudeToolNames } from "../../../../../../scripts/__tests__/claude-tool-contract";

describe("installed Claude tool-name contract (cloud worker)", () => {
  it("covers the standalone translator's actual routing names", () => {
    let checked = 0;
    for (const file of toolNameSources(new URL("../", import.meta.url))) {
      const sites = sourceToolNameSites(file, "claude");
      checked += sites.length;
      expect(unknownClaudeToolNames(sites, BUILTIN_TOOL_NAMES, LEGACY_TOOL_NAME_ALIASES), file.pathname).toEqual([]);
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("Claude subagent alias routing", () => {
  afterEach(() => { vi.doUnmock("@anthropic-ai/claude-agent-sdk"); vi.resetModules(); });

  it("derives subagent aliases from the worker SDK while retaining native titles and case matching", async () => {
    vi.resetModules();
    vi.doMock("@anthropic-ai/claude-agent-sdk", async importOriginal => ({
      ...await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>(),
      LEGACY_TOOL_NAME_ALIASES: { ...LEGACY_TOOL_NAME_ALIASES, LegacyAgentFixture: "Agent" },
    }));
    const { describeTool, mapToolKind } = await import("../translator");
    for (const name of ["Agent", "Task", "agent", "tAsK", "LegacyAgentFixture", "legacyagentfixture"]) {
      expect(mapToolKind(name), name).toBe("subagent");
      expect(describeTool(name, {})).toBe(name);
    }
    for (const name of ["TaskCreate", "TaskStop", " Agent", "Task ", "mcp__test__Agent"]) {
      expect(mapToolKind(name), name).not.toBe("subagent");
    }
  });
});
