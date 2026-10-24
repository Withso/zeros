import { BUILTIN_TOOL_NAMES, LEGACY_TOOL_NAME_ALIASES } from "@anthropic-ai/claude-agent-sdk";
import * as core from "@anthropic-ai/claude-agent-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retiredClaudeToolNames, sourceToolNameSites, toolNameSources, unknownClaudeToolNames } from "../../../../../../../../scripts/__tests__/claude-tool-contract";

describe("installed Claude tool-name contract (desktop)", () => {
  it.each(["../", "../../claude-sdk/"])("covers the actual routing in %s", directory => {
    let checked = 0;
    for (const file of toolNameSources(new URL(directory, import.meta.url))) {
      const sites = sourceToolNameSites(file, "claude");
      checked += sites.length;
      expect(unknownClaudeToolNames(sites, BUILTIN_TOOL_NAMES, LEGACY_TOOL_NAME_ALIASES, file.pathname.endsWith("/claude-sdk/adapter.ts") ? {
        ClaudeInChromeDomain: "Native Chrome domain permission-rule selector, not a built-in invocation.",
      } : {}), file.pathname).toEqual([]);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("uses the same runtime inventory through the core entry point", () => {
    expect(core.BUILTIN_TOOL_NAMES).toEqual(BUILTIN_TOOL_NAMES);
    expect(core.LEGACY_TOOL_NAME_ALIASES).toEqual(LEGACY_TOOL_NAME_ALIASES);
    for (const target of Object.values(LEGACY_TOOL_NAME_ALIASES)) expect(BUILTIN_TOOL_NAMES).toContain(target);
    for (const name of Object.keys(retiredClaudeToolNames)) {
      expect(BUILTIN_TOOL_NAMES).not.toContain(name);
      expect(LEGACY_TOOL_NAME_ALIASES).not.toHaveProperty(name);
    }
  });
});

describe("Claude subagent alias routing", () => {
  afterEach(() => { vi.doUnmock("@anthropic-ai/claude-agent-sdk"); vi.resetModules(); });

  it("derives subagent aliases from the SDK while preserving native titles and case matching", async () => {
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
