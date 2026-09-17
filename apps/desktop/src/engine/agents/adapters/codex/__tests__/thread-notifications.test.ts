import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CodexAppServerTranslator } from "../app-server-translator";
import { CodexThreadNotifications } from "../thread-notifications";
import type { SessionNotification } from "@zeros/protocol/agent-events";

describe("Codex notification ownership", () => {
  it("retires the preceding parent turn at the local prompt boundary without silencing children", () => {
    const t = setup();
    t.router.handle("turn/started", { threadId: "parent", turn: { id: "old" } });
    t.router.handle("turn/completed", { threadId: "parent", turn: { id: "old", status: "completed" } });
    t.router.startRootTurn();
    const reroute = { threadId: "parent", turnId: "old", fromModel: "gpt-6", toModel: "gpt-5.6", reason: "highRiskCyberActivity" };
    t.router.handle("model/rerouted", reroute);
    t.router.handle("turn/started", { threadId: "parent", turn: { id: "old" } });
    t.router.handle("item/completed", { threadId: "parent", turnId: "old", item: { type: "agentMessage", id: "stale", text: "Stale output" } });
    expect(t.messages()).toEqual([]);

    t.router.handle("item/completed", { threadId: "child", turnId: "background", item: { type: "agentMessage", id: "child-result", text: "Child finished" } });
    expect(t.messages()).toHaveLength(1);
    t.router.handle("turn/started", { threadId: "parent", turn: { id: "new" } });
    t.router.handle("model/rerouted", { ...reroute, turnId: "new" });
    expect(t.messages().at(-1)).toMatchObject({ modelFallback: { fromModel: "gpt-6", toModel: "gpt-5.6", scope: "session" } });
  });

  it("keeps parent context readings isolated from retired turns and child usage", () => {
    const readings: number[] = [];
    const root = new CodexAppServerTranslator({
      sessionId: "session",
      emit: (event: SessionNotification) => {
        if (event.update.sessionUpdate === "usage_update") readings.push(event.update.used!);
      },
    });
    const router = new CodexThreadNotifications("parent", root);
    const usage = (threadId: string, turnId: string, used: number) => router.handle("thread/tokenUsage/updated", {
      threadId, turnId,
      tokenUsage: { last: { totalTokens: used, inputTokens: used, outputTokens: 0 }, modelContextWindow: 100 },
    });
    router.handle("turn/started", { threadId: "parent", turn: { id: "old" } });
    usage("parent", "old", 90);
    router.handle("turn/started", { threadId: "parent", turn: { id: "current" } });
    usage("parent", "current", 20);
    usage("parent", "old", 95);
    router.handle("turn/started", { threadId: "child", turn: { id: "child-turn" } });
    usage("child", "child-turn", 80);
    // A legitimate current-turn compaction is allowed to lower the reading.
    usage("parent", "current", 10);
    expect(readings).toEqual([90, 20, 10]);
  });
  it("keeps child fallback prose local and dedupes native reroute replay", () => {
    const t = setup();
    t.router.handle("item/started", { threadId: "parent", item: { type: "subAgentActivity", id: "spawn", kind: "started", agentThreadId: "child", agentPath: "/root/audit" } });
    const fallback = { threadId: "child", turnId: "turn", fromModel: "gpt-6", toModel: "gpt-5.6", reason: "highRiskCyberActivity" };
    t.router.handle("model/rerouted", fallback); t.router.handle("model/rerouted", fallback);
    const tools = t.messages().filter((m) => m.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(t.messages().at(-1)).toMatchObject({ kind: "text", phase: "commentary", parentToolId: tools[0].toolCallId,
      modelFallback: { scope: "local", reason: "cybersecurity" } });
    expect(t.messages()).toHaveLength(2);
  });
  it("groups native subAgentActivity by child identity across item bookends and late completion", () => {
    const t = setup();
    t.router.handle("item/completed", {
      threadId: "child",
      item: { type: "agentMessage", id: "early", text: "Inspecting source" },
    });
    const activity = {
      type: "subAgentActivity",
      id: "spawn",
      kind: "started",
      agentThreadId: "child",
      agentPath: "/root/source_audit",
    };
    t.router.handle("item/started", { threadId: "parent", item: activity });
    t.router.handle("item/completed", { threadId: "parent", item: activity });
    const group = t.messages().find((m) => m.kind === "tool")!;
    expect(group).toMatchObject({
      toolKind: "subagent",
      title: "Agent",
      status: "in_progress",
      rawInput: { description: "Source audit" },
    });
    expect(t.messages()[0]).toMatchObject({ parentToolId: group.toolCallId });
    t.router.handle("item/completed", {
      threadId: "child",
      item: {
        type: "agentMessage",
        id: "result",
        text: "Audit complete",
        phase: "final_answer",
      },
    });
    const done = { ...activity, id: "done", kind: "completed" };
    t.router.handle("item/started", { threadId: "parent", item: done });
    t.router.handle("item/completed", { threadId: "parent", item: done });
    t.router.handle("item/completed", { threadId: "parent", item: activity });
    expect(t.messages().filter((m) => m.kind === "tool")).toEqual([
      expect.objectContaining({ id: group.id, status: "completed" }),
    ]);
    expect(
      t
        .messages()
        .filter(
          (m) => "parentToolId" in m && m.parentToolId === group.toolCallId,
        ),
    ).toHaveLength(2);
  });
  it("resumes the same group for a new interaction but ignores replayed lifecycle events", () => {
    const t = setup();
    const activity = {
      type: "subAgentActivity",
      id: "spawn",
      kind: "started",
      agentThreadId: "child",
      agentPath: "/root/audit",
    };
    const feed = (item: typeof activity) =>
      t.router.handle("item/completed", { threadId: "parent", item });
    feed(activity);
    feed({ ...activity, id: "done", kind: "completed" });
    t.root.startTurn();
    feed({ ...activity, id: "followup", kind: "interacted" });
    feed({ ...activity, id: "done", kind: "completed" });
    expect(t.messages().filter((m) => m.kind === "tool")).toEqual([
      expect.objectContaining({ status: "in_progress" }),
    ]);
    feed({ ...activity, id: "stop", kind: "interrupted" });
    feed(activity);
    expect(t.messages().filter((m) => m.kind === "tool")).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
  });
  it("retains legacy spawn ownership until a child state confirms completion", () => {
    const t = setup();
    const spawn = {
      type: "collabAgentToolCall",
      id: "spawn",
      tool: "spawnAgent",
      prompt: "Audit source",
      model: "gpt-6",
      receiverThreadIds: ["child"],
      status: "completed",
      agentsStates: { child: { status: "running" } },
    };
    t.router.handle("item/completed", { threadId: "parent", item: spawn });
    const group = t.messages().find((m) => m.kind === "tool")!;
    expect(group.status).toBe("in_progress");
    t.router.handle("item/completed", {
      threadId: "parent",
      item: {
        type: "subAgentActivity",
        id: "native-start",
        kind: "started",
        agentThreadId: "child",
        agentPath: "/root/audit",
      },
    });
    expect(t.messages().filter((m) => m.kind === "tool")).toHaveLength(1);
    expect(t.messages().find((m) => m.kind === "tool")!.rawInput).toMatchObject(
      { prompt: "Audit source", model: "gpt-6" },
    );
    t.router.handle("item/completed", {
      threadId: "parent",
      item: {
        ...spawn,
        id: "wait",
        tool: "wait",
        agentsStates: {
          child: { status: "completed", message: "Source audit complete" },
        },
      },
    });
    expect(t.messages().find((m) => m.id === group.id)).toMatchObject({
      status: "completed",
      rawOutput: { report: "Source audit complete" },
    });
  });
  it("releases running group loaders on cancellation or transport disposal", () => {
    const t = setup();
    const activity = {
      type: "subAgentActivity",
      id: "spawn",
      kind: "started",
      agentThreadId: "child",
      agentPath: "/root/audit",
    };
    t.router.handle("item/completed", { threadId: "parent", item: activity });
    t.router.endAgentActivity();
    t.router.handle("item/completed", {
      threadId: "parent",
      item: { ...activity, id: "late", kind: "interacted" },
    });
    expect(t.messages().filter((m) => m.kind === "tool")).toEqual([
      expect.objectContaining({
        status: "failed",
        rawOutput: {
          status: "interrupted",
          message: "Agent ended before reporting completion.",
        },
      }),
    ]);
  });
  it("accepts a correcting terminal kind on the same native activity item", () => {
    const t = setup();
    const activity = {
      type: "subAgentActivity",
      id: "spawn",
      kind: "started",
      agentThreadId: "child",
      agentPath: "/root/audit",
    };
    t.router.handle("item/started", { threadId: "parent", item: activity });
    t.router.handle("item/completed", {
      threadId: "parent",
      item: { ...activity, kind: "completed" },
    });
    expect(t.messages().filter((m) => m.kind === "tool")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
  });
  it("settles the known child group when its own terminal turn arrives without a parent activity edge", () => {
    const t = setup();
    t.router.handle("item/completed", {
      threadId: "parent",
      item: {
        type: "subAgentActivity",
        id: "spawn",
        kind: "started",
        agentThreadId: "child",
        agentPath: "/root/audit",
      },
    });
    t.router.handle("turn/started", {
      threadId: "child",
      turn: { id: "child-turn" },
    });
    t.router.handle("turn/completed", {
      threadId: "child",
      turn: { id: "child-turn", status: "completed" },
    });
    expect(t.messages().filter((m) => m.kind === "tool")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(t.root.sawTurnTerminal).toBe(false);
  });
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

  it.each([
    { type: "commandExecution", id: "same", command: "check", status: "completed", exitCode: 1, aggregatedOutput: "Permission denied" },
    { type: "mcpToolCall", id: "same", server: "example", tool: "read", arguments: {}, status: "completed", result: { isError: true, content: [{ type: "text", text: "Permission denied" }] } },
  ])("preserves failed child $type output independently of its wrapper and parent", (item) => {
    const env = setup();
    env.router.handle("item/started", { threadId: "parent", item: { type: "commandExecution", id: "same", command: "parent work" } });
    env.router.handle("item/started", { threadId: "child", item: { ...item, status: "inProgress", exitCode: undefined, result: undefined } });
    expect(env.messages().filter((m) => m.kind === "tool").map((m) => m.status)).toEqual(["in_progress", "in_progress"]);
    env.router.handle("item/completed", { threadId: "child", item });
    const tools = env.messages().filter((m) => m.kind === "tool");
    expect(tools[0].status).toBe("in_progress");
    expect(tools[1]).toMatchObject({ status: "failed", content: [{ type: "content", content: { type: "text", text: "Permission denied" } }] });
    expect(env.root.sawTurnTerminal).toBe(false);
  });

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

  it("parents early child output using a recovered spawn from the terminal snapshot", () => {
    const t = setup();
    t.router.handle("item/completed", { threadId: "child", item: { type: "agentMessage", id: "answer", text: "Child answer" } });
    t.router.handle("turn/completed", { threadId: "parent", turn: { id: "turn", status: "completed", itemsView: "full", items: [{ type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"] }] } });
    const parent = t.messages().find((m) => m.kind === "tool")!;
    expect(t.messages()[0]).toMatchObject({ parentToolId: parent.toolCallId });
  });
});
