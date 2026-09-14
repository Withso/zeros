import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CodexAppServerTranslator } from "../app-server-translator";
import { CodexThreadNotifications } from "../thread-notifications";

describe("Codex notification ownership", () => {
  function setup() {
    let messages: AgentMessage[] = [];
    const root = new CodexAppServerTranslator({
      sessionId: "session",
      emit: (event) => {
        messages = applyUpdate(messages, event);
      },
    });
    const router = new CodexThreadNotifications("parent", root);
    return { root, router, messages: () => messages };
  }

  it("isolates child terminal failures and token usage from the parent", () => {
    const { root, router } = setup();
    router.handle("turn/started", { threadId: "parent", turn: { id: "turn" } });
    router.handle("thread/tokenUsage/updated", {
      threadId: "parent",
      tokenUsage: {
        total: { inputTokens: 1000, outputTokens: 100 },
        last: { inputTokens: 1000, outputTokens: 100 },
      },
    });
    const usage = root.turnUsage;
    router.handle("thread/tokenUsage/updated", {
      threadId: "child",
      tokenUsage: { total: { inputTokens: 12 }, last: { inputTokens: 12 } },
    });
    router.handle("error", {
      threadId: "child",
      error: { message: "Unauthorized", codexErrorInfo: "unauthorized" },
      willRetry: false,
    });
    router.handle("turn/completed", {
      threadId: "child",
      turn: {
        id: "child-turn",
        status: "failed",
        error: { codexErrorInfo: "unauthorized" },
      },
    });
    expect(root.authQuotaFailure).toBeNull();
    expect(root.sawTurnTerminal).toBe(false);
    expect(usage?.inputTokens).toBe(1000);
    expect(root.turnUsage).toEqual(usage);
    router.handle("turn/completed", {
      threadId: "parent",
      turn: { id: "turn", status: "completed" },
    });
    expect(root.stopReason).toBe("end_turn");
  });

  it("correlates interleaved children, including events before spawn completion", () => {
    const t = setup();
    t.router.handle("item/started", {
      threadId: "parent",
      item: {
        type: "collabAgentToolCall",
        id: "spawn",
        tool: "spawnAgent",
        receiverThreadIds: [],
      },
    });
    t.router.handle("item/completed", {
      threadId: "child",
      item: {
        type: "commandExecution",
        id: "same-id",
        command: "pwd",
        exitCode: 0,
      },
    });
    t.router.handle("item/completed", {
      threadId: "child",
      item: {
        type: "agentMessage",
        id: "reply",
        text: "Child result",
        phase: "final_answer",
      },
    });
    t.router.handle("item/completed", {
      threadId: "parent",
      item: {
        type: "collabAgentToolCall",
        id: "spawn",
        tool: "spawnAgent",
        receiverThreadIds: ["child"],
        status: "completed",
      },
    });
    t.router.handle("item/completed", {
      threadId: "parent",
      item: {
        type: "commandExecution",
        id: "same-id",
        command: "ls",
        exitCode: 0,
      },
    });
    const parent = t.root.toolCallIdFor("spawn");
    expect(
      t
        .messages()
        .filter((m) => "parentToolId" in m && m.parentToolId === parent),
    ).toEqual([
      expect.objectContaining({
        kind: "tool",
        rawInput: expect.objectContaining({ command: "pwd" }),
      }),
      expect.objectContaining({ kind: "text", text: "Child result" }),
    ]);
    expect(t.messages().filter((m) => m.kind === "tool")).toHaveLength(3);
  });

  it("ignores stale parent terminal state from an older turn", () => {
    const t = setup();
    t.router.handle("turn/started", {
      threadId: "parent",
      turn: { id: "old" },
    });
    t.root.startTurn();
    t.router.handle("turn/started", {
      threadId: "parent",
      turn: { id: "new" },
    });
    t.router.handle("turn/completed", {
      threadId: "parent",
      turn: {
        id: "old",
        status: "failed",
        error: { codexErrorInfo: "unauthorized" },
      },
    });
    expect(t.root.authQuotaFailure).toBeNull();
    expect(t.root.sawTurnTerminal).toBe(false);
  });

  it("gives an autonomous parent follow-up fresh item and terminal state", () => {
    const t = setup();
    t.router.handle("turn/started", {
      threadId: "parent",
      turn: { id: "first" },
    });
    t.router.handle("item/completed", {
      threadId: "parent",
      turnId: "first",
      item: {
        type: "commandExecution",
        id: "command",
        command: "first",
        exitCode: 0,
      },
    });
    t.router.handle("turn/completed", {
      threadId: "parent",
      turn: { id: "first", status: "completed" },
    });
    // A child report or native goal can wake the parent without adapter.prompt().
    t.router.handle("turn/started", {
      threadId: "parent",
      turn: { id: "follow-up" },
    });
    expect(t.root.sawTurnTerminal).toBe(false);
    t.router.handle("item/completed", {
      threadId: "parent",
      turnId: "follow-up",
      item: {
        type: "commandExecution",
        id: "command",
        command: "second",
        exitCode: 0,
      },
    });
    expect(t.messages()).toEqual([
      expect.objectContaining({
        rawInput: expect.objectContaining({ command: "first" }),
      }),
      expect.objectContaining({
        rawInput: expect.objectContaining({ command: "second" }),
      }),
    ]);
  });

  it("does not apply an old turn's replayed start or completion to a reused native item id", () => {
    const t = setup();
    t.router.handle("turn/started", {
      threadId: "parent",
      turn: { id: "old" },
    });
    t.root.startTurn();
    t.router.handle("turn/started", {
      threadId: "parent",
      turn: { id: "new" },
    });
    t.router.handle("item/started", {
      threadId: "parent",
      turnId: "new",
      item: { type: "commandExecution", id: "same", command: "current" },
    });
    t.router.handle("turn/started", {
      threadId: "parent",
      turn: { id: "old" },
    });
    t.router.handle("item/completed", {
      threadId: "parent",
      turnId: "old",
      item: {
        type: "commandExecution",
        id: "same",
        command: "old",
        status: "failed",
      },
    });
    expect(t.messages()[0]).toMatchObject({
      status: "in_progress",
      rawInput: { command: "current" },
    });
  });
});
