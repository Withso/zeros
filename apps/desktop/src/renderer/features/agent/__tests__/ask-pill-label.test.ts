import { describe, expect, it } from "vitest";

import { askPillAgentName } from "../ask-pill-label";

describe("the Ask pill's agent name", () => {
  it("names the three agent families", () => {
    expect(askPillAgentName("claude-code", "Claude Code")).toBe("Claude");
    expect(askPillAgentName("@anthropic-ai/claude-code", null)).toBe("Claude");
    expect(askPillAgentName("codex", "Codex CLI")).toBe("Codex");
    expect(askPillAgentName("cursor-agent", null)).toBe("Cursor");
  });

  it("falls back to the chat's agent name, then to a plain word", () => {
    expect(askPillAgentName("opencode", "OpenCode")).toBe("OpenCode");
    expect(askPillAgentName(null, "  ")).toBe("agent");
    expect(askPillAgentName(null, null)).toBe("agent");
  });
});
