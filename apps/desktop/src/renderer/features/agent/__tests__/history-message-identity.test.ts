import { describe, expect, it } from "vitest";
import type { AgentToolMessage } from "@zeros/protocol/agent-messages";
import { reconcileHistoryMessages } from "../history-message-identity";

const tool = (id: string, rawInput?: unknown): AgentToolMessage => ({
  id,
  kind: "tool",
  toolCallId: id,
  nativeToolCallId: `native-${id}`,
  title: "Tool",
  toolKind: "other",
  status: "completed",
  rawInput,
  rawOutput: `Output for ${id}`,
  createdAt: 1,
  updatedAt: 2,
});

describe("persisted transcript identity", () => {
  it.each([undefined, { command: "check" }])(
    "retains distinct calls with equal input %j",
    (input) => {
      const messages = [tool("one", input), tool("two", input)];
      expect(reconcileHistoryMessages(messages)).toEqual(messages);
    },
  );

  it("retains the newer snapshot of the same durable row", () => {
    const started = { ...tool("one"), status: "in_progress" as const };
    const completed = tool("one");
    expect(reconcileHistoryMessages([started, completed])).toEqual([completed]);
  });

  it("does not replace a settled tool with a replayed start at the same timestamp", () => {
    const completed = tool("one");
    const started = {
      ...completed,
      status: "in_progress" as const,
      rawOutput: undefined,
    };
    expect(reconcileHistoryMessages([completed, tool("two"), started])).toEqual(
      [completed, tool("two")],
    );
  });

  it("reuses an unchanged history window and rejects an older overlapping snapshot", () => {
    const messages = [tool("one"), tool("two")];
    expect(reconcileHistoryMessages(messages)).toBe(messages);
    expect(
      reconcileHistoryMessages([...messages, { ...tool("one"), updatedAt: 0 }]),
    ).toEqual(messages);
  });

  it("does not collapse equal native tool ids from separate durable executions", () => {
    const messages = [
      tool("one"),
      { ...tool("two"), nativeToolCallId: "native-one" },
    ];
    expect(reconcileHistoryMessages(messages)).toEqual(messages);
  });
});
