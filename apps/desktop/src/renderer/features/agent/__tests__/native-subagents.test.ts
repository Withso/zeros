import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { nativeSubagentsOf } from "../native-subagents";

const tool = (id: string, extra: Record<string, unknown> = {}): AgentMessage => ({
  id, kind: "tool", toolCallId: id, title: "Agent", toolKind: "subagent", status: "completed", createdAt: 1, ...extra,
} as AgentMessage);

describe("native subagents", () => {
  it("lists the subagents a chat started directly, with their run state", () => {
    const rows = nativeSubagentsOf("c1", [
      { id: "u", kind: "text", role: "user", text: "go", createdAt: 0 } as AgentMessage,
      tool("a", { title: "Explore the repo", status: "in_progress" }),
      tool("b", { title: "  " }),
      tool("nested", { parentToolId: "a" }),
      tool("edit", { toolKind: "edit" }),
    ]);
    expect(rows).toEqual([
      { id: "a", ownerChatId: "c1", title: "Explore the repo", running: true },
      { id: "b", ownerChatId: "c1", title: "Agent", running: false },
    ]);
  });
});
