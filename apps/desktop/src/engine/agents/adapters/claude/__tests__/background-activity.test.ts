import { describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "../../../types";
import { ClaudeStreamTranslator } from "../translator";

function session() {
  const updates: SessionNotification[] = [];
  const translator = new ClaudeStreamTranslator({
    sessionId: "claude-1",
    emit: (n) => updates.push(n),
  });
  const snapshot = () =>
    updates
      .map((n) => n.update)
      .filter((u) => u.sessionUpdate === "background_tasks_update")
      .at(-1);
  const startTask = (extra = {}) =>
    translator.feed({
      type: "system",
      subtype: "task_started",
      task_id: "test-1",
      description: "Run tests",
      is_backgrounded: true,
      ...extra,
    });
  return { translator, updates, snapshot, startTask };
}

describe("Claude parent activity across background continuations", () => {
  it("keeps an async Agent group running until its native task completes", () => {
    const { translator: t, updates } = session();
    t.beginTurn();
    t.feed({
      type: "assistant",
      message: {
        id: "launch",
        content: [
          {
            type: "tool_use",
            id: "agent-call",
            name: "Agent",
            input: { description: "Audit source", run_in_background: true },
          },
        ],
      },
    });
    t.feed({
      type: "system",
      subtype: "task_started",
      task_id: "child",
      tool_use_id: "agent-call",
      is_backgrounded: true,
      task_type: "local_agent",
    });
    t.feed({
      type: "user",
      tool_use_result: {
        status: "async_launched",
        agentId: "child",
        resolvedModel: "claude-opus-4-6",
      },
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "agent-call",
            content: "Async agent launched successfully. Internal metadata.",
          },
        ],
      },
    });
    const groupId = updates
      .map((n) => n.update)
      .find((u) => u.sessionUpdate === "tool_call" && u.kind === "subagent")!;
    if (!("toolCallId" in groupId)) throw new Error("Missing Agent call");
    const groupUpdates = () =>
      updates
        .filter(
          (n) =>
            "toolCallId" in n.update &&
            n.update.toolCallId === groupId.toolCallId,
        )
        .map((n) => n.update);
    expect(groupUpdates().at(-1)).toMatchObject({
      status: "in_progress",
      rawOutput: { status: "async_launched", resolvedModel: "claude-opus-4-6" },
      content: null,
    });
    t.feed({
      type: "system",
      subtype: "task_notification",
      task_id: "child",
      tool_use_id: "agent-call",
      status: "completed",
      summary: "Audit complete",
    });
    expect(groupUpdates().at(-1)).toMatchObject({ status: "completed" });
  });
  it("keeps a terminal child failure through a late launch acknowledgement", () => {
    const { translator: t, updates } = session();
    t.beginTurn();
    t.feed({
      type: "assistant",
      message: {
        id: "launch",
        content: [
          {
            type: "tool_use",
            id: "agent-call",
            name: "Agent",
            input: { description: "Audit source", run_in_background: true },
          },
        ],
      },
    });
    t.feed({
      type: "system",
      subtype: "task_notification",
      task_id: "child",
      tool_use_id: "agent-call",
      status: "failed",
      summary: "Child transport disconnected",
    });
    t.feed({
      type: "user",
      tool_use_result: {
        status: "async_launched",
        agentId: "child",
        resolvedModel: "claude-opus-4-6",
      },
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "agent-call",
            content: "Async agent launched successfully.",
          },
        ],
      },
    });
    const group = updates.find(
      (n) =>
        n.update.sessionUpdate === "tool_call" && n.update.kind === "subagent",
    )!.update;
    if (!("toolCallId" in group)) throw new Error("Missing Agent call");
    const final = updates
      .filter(
        (n) =>
          "toolCallId" in n.update && n.update.toolCallId === group.toolCallId,
      )
      .at(-1)!.update;
    expect(final).toMatchObject({
      status: "failed",
      rawOutput: { message: "Child transport disconnected" },
      content: [{ content: { text: "Child transport disconnected" } }],
    });
  });
  it("stops the child group on disposal without accepting a late launch as new work", () => {
    const { translator: t, updates } = session();
    t.beginTurn();
    t.feed({
      type: "assistant",
      message: {
        id: "launch",
        content: [
          {
            type: "tool_use",
            id: "agent-call",
            name: "Agent",
            input: { description: "Audit source" },
          },
        ],
      },
    });
    t.feed({
      type: "system",
      subtype: "task_started",
      task_id: "child",
      tool_use_id: "agent-call",
      task_type: "local_agent",
      is_backgrounded: true,
    });
    t.endActivity();
    t.feed({
      type: "user",
      tool_use_result: { status: "async_launched", agentId: "child" },
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "agent-call",
            content: "Async agent launched successfully.",
          },
        ],
      },
    });
    const groupUpdates = updates
      .map((n) => n.update)
      .filter(
        (u) =>
          (u.sessionUpdate === "tool_call_update" ||
            u.sessionUpdate === "tool_call") &&
          u.kind !== "background_task",
      );
    expect(groupUpdates.at(-1)).toMatchObject({
      status: "failed",
      rawOutput: { message: "Agent ended before reporting completion." },
    });
  });
  it("correlates a completion without tool_use_id when the late launch supplies the child task id", () => {
    const { translator: t, updates } = session();
    t.beginTurn();
    t.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "agent-call",
            name: "Agent",
            input: { description: "Audit source" },
          },
        ],
      },
    });
    t.feed({
      type: "system",
      subtype: "task_notification",
      task_id: "child",
      status: "failed",
      summary: "Child disconnected before launch delivery",
    });
    t.feed({
      type: "system",
      subtype: "task_started",
      task_id: "child",
      tool_use_id: "agent-call",
      task_type: "local_agent",
      is_backgrounded: true,
    });
    t.feed({
      type: "user",
      tool_use_result: { status: "async_launched", agentId: "child" },
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "agent-call",
            content: "Async agent launched successfully.",
          },
        ],
      },
    });
    expect(updates.at(-1)?.update).toMatchObject({
      status: "failed",
      rawOutput: { message: "Child disconnected before launch delivery" },
    });
  });
  it("uses the native completed child report instead of its transport bookkeeping", () => {
    const { translator: t, updates } = session();
    t.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "agent-call",
            name: "Agent",
            input: { description: "Audit source" },
          },
        ],
      },
    });
    t.feed({
      type: "user",
      tool_use_result: {
        status: "completed",
        agentId: "child",
        resolvedModel: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Source audit complete" }],
      },
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "agent-call",
            content:
              "Source audit complete\n<usage>total_tokens: 15000</usage>",
          },
        ],
      },
    });
    expect(updates.at(-1)?.update).toMatchObject({
      content: [{ content: { text: "Source audit complete" } }],
    });
  });
  it("waits for the remaining child when an autonomous reply ends before the held-back result", () => {
    const { translator: t, startTask, snapshot } = session();
    t.beginTurn();
    startTask();
    startTask({ task_id: "test-2" });
    t.feed({ type: "result", subtype: "success", uuid: "initial" });
    t.feed({
      type: "system",
      subtype: "task_notification",
      task_id: "test-1",
      status: "completed",
    });
    t.feed({
      type: "assistant",
      message: {
        id: "continuation",
        content: [{ type: "text", text: "One agent is still working." }],
        stop_reason: "end_turn",
      },
    });
    expect(snapshot()).toMatchObject({
      waiting: true,
      tasks: [{ taskId: "test-2" }],
      activity: { state: "idle" },
    });
    t.feed({
      type: "system",
      subtype: "task_progress",
      task_id: "test-2",
      summary: "Finishing",
    });
    expect(snapshot()).toMatchObject({
      waiting: true,
      tasks: [{ taskId: "test-2" }],
    });
  });
  it("parks on a result without an idle edge and retains the original clock on automatic resume", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const { translator: t, snapshot, startTask } = session();
      t.beginTurn();
      startTask();
      now.mockReturnValue(5_000);
      t.feed({ type: "result", subtype: "success" });
      expect(snapshot()).toMatchObject({
        waiting: true,
        tasks: [{ taskId: "test-1" }],
        activity: { state: "idle", startedAt: 1_000 },
      });
      t.feed({
        type: "assistant",
        parent_tool_use_id: "child",
        message: { content: [{ type: "text", text: "child progress" }] },
      });
      t.feed({
        type: "stream_event",
        parent_tool_use_id: "child",
        event: { type: "message_start" },
      });
      expect(snapshot()).toMatchObject({
        waiting: true,
        activity: { state: "idle", startedAt: 1_000 },
      });
      t.feed({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
      });
      now.mockReturnValue(9_000);
      t.feed({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Tests passed. Reviewing changes." }],
        },
      });
      expect(snapshot()).toMatchObject({
        waiting: false,
        tasks: [],
        activity: { state: "running", startedAt: 1_000 },
      });
      t.feed({ type: "result", subtype: "success" });
      expect(snapshot()).toMatchObject({
        waiting: false,
        activity: { state: "idle", startedAt: 1_000 },
      });
      t.beginTurn();
      expect(snapshot()).toMatchObject({
        activity: { state: "running", startedAt: 9_000 },
      });
    } finally {
      now.mockRestore();
    }
  });

  it("excludes ambient work from the active set and synthetic transcript rows", () => {
    const { translator: t, snapshot, startTask, updates } = session();
    t.beginTurn();
    startTask({ ambient: true });
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "test-1", ambient: true }],
    });
    t.feed({ type: "result", subtype: "success" });
    expect(snapshot()).toMatchObject({ tasks: [], waiting: false });
    expect(
      updates.some(
        (n) =>
          n.update.sessionUpdate === "tool_call" &&
          n.update.kind === "background_task",
      ),
    ).toBe(false);
  });

  it("honors an authoritative ambient flag changing back to user work", () => {
    const { translator: t, snapshot } = session();
    t.beginTurn();
    t.feed({
      type: "system",
      subtype: "task_started",
      task_id: "watcher",
      ambient: true,
    });
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "watcher", ambient: true }],
    });
    t.feed({ type: "result", subtype: "success" });
    expect(snapshot()).toMatchObject({ tasks: [], waiting: false });
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "watcher", ambient: false }],
    });
    expect(snapshot()).toMatchObject({
      tasks: [{ taskId: "watcher" }],
      waiting: true,
    });
  });

  it("clears live ownership on Stop/EOF and ignores late task and activity edges until a new prompt", () => {
    const { translator: t, snapshot, startTask } = session();
    t.beginTurn();
    startTask();
    t.endActivity();
    startTask();
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "test-1" }],
    });
    t.feed({
      type: "system",
      subtype: "session_state_changed",
      state: "running",
    });
    t.feed({ type: "result", subtype: "success" });
    expect(snapshot()).toMatchObject({
      tasks: [],
      waiting: false,
      activity: null,
    });
    t.beginTurn();
    startTask({ task_id: "test-2" });
    expect(snapshot()).toMatchObject({
      tasks: [{ taskId: "test-2" }],
      activity: { state: "running" },
    });
  });
});
