import { describe, expect, it, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { readClaudeDiscovery } from "../extensions";

describe("Claude disposable discovery", () => {
  it("reads actual skill definitions rather than conflating every slash command with a skill", async () => {
    const query = {
      reloadSkills: vi.fn().mockResolvedValue({
        skills: [{ name: "review", description: "Review changes" }],
      }),
      supportedCommands: vi.fn(),
    };
    const result = await readClaudeDiscovery(
      query as unknown as Query,
      "skills",
    );
    expect(result.entries.map((entry) => entry.name)).toEqual(["review"]);
    expect(query.supportedCommands).not.toHaveBeenCalled();
    expect(result.sources?.[1].state).toBe("unsupported");
  });
  it("preserves partial plugin errors and emits no raw provider data", async () => {
    const query = {
      reloadPlugins: vi.fn().mockResolvedValue({
        plugins: [{ name: "review", path: "/plugins/review", version: "1.0" }],
        error_count: 1,
        commands: [],
        agents: [],
        mcpServers: [{ secret: "private" }],
      }),
    };
    const result = await readClaudeDiscovery(
      query as unknown as Query,
      "plugins",
    );
    expect(result.partial).toBe(true);
    expect(result.sources?.[0].state).toBe("partial");
    expect(result.entries[0].sourcePath).toBe("/plugins/review");
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("does not interpret an empty SDK status list as a confirmed empty cloud account", async () => {
    const query = { mcpServerStatus: vi.fn().mockResolvedValue([]) };
    const result = await readClaudeDiscovery(query as unknown as Query, "apps");
    expect(result.partial).toBe(true);
    expect(result.sources?.[0].state).toBe("partial");
  });
});
