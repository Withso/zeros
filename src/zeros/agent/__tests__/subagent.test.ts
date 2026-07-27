// matchSubagent — routes a tool to the SubagentCard by title vocabulary OR by
// carrying a subagent role field (Claude `subagent_type` / Cursor `subagentType`).

import { describe, it, expect } from "vitest";
import { matchSubagent } from "../renderers/subagent";
import type { AgentToolMessage } from "../use-agent-session";

const tool = (over: Partial<AgentToolMessage>): AgentToolMessage =>
  ({
    id: "t",
    kind: "tool",
    toolCallId: "c",
    title: "",
    toolKind: undefined,
    status: "completed",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as AgentToolMessage;

describe("matchSubagent", () => {
  it("matches Claude's snake_case subagent_type", () => {
    const info = matchSubagent(tool({ title: "Task", rawInput: { subagent_type: "explore", description: "Look around" } }));
    expect(info).toMatchObject({ subagentType: "explore", description: "Look around" });
  });

  it("matches Cursor's camelCase subagentType:{kind} even without a task-y title or kind", () => {
    // The real failing case: title is "Subagent …" (not "task") and toolKind
    // wasn't tagged subagent (old/persisted chat) — must still route to the card.
    const info = matchSubagent(
      tool({ title: "Subagent Explore architecture", rawInput: { subagentType: { kind: "explore" }, description: "Explore architecture", prompt: "do it" } }),
    );
    expect(info).not.toBeNull();
    expect(info).toMatchObject({ subagentType: "explore", description: "Explore architecture" });
  });

  it("matches by title alone (task) when no role field is present", () => {
    expect(matchSubagent(tool({ title: "task", rawInput: { prompt: "x".repeat(200) } }))).not.toBeNull();
  });

  it("returns null for an ordinary tool", () => {
    expect(matchSubagent(tool({ title: "Read", toolKind: "read", rawInput: { path: "a.ts" } }))).toBeNull();
  });

  it("returns null for kind 'task' (Cursor's raw task card, not the SubagentCard)", () => {
    // Even though it carries subagent_type/subagentType, a kind-"task" tool is
    // Cursor's RAW task card — it must NOT route to the Claude-style SubagentCard.
    expect(
      matchSubagent(tool({ title: "Subagent Explore", toolKind: "task", rawInput: { subagent_type: "explore", description: "Explore" } })),
    ).toBeNull();
    expect(
      matchSubagent(tool({ title: "task", toolKind: "task", rawInput: { subagentType: { kind: "explore" } } })),
    ).toBeNull();
  });
});
