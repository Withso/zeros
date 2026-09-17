import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { ClaudeStreamTranslator } from "../translator";
import type { SessionNotification } from "../../../types";
import { partitionTurn } from "@/renderer/features/agent/turn-partition";

function capture() {
  let messages: AgentMessage[] = [];
  const updates: SessionNotification[] = [];
  const t = new ClaudeStreamTranslator({
    sessionId: "session",
    streamPartials: true,
    emit: (e) => {
      updates.push(e);
      messages = applyUpdate(messages, e);
    },
  });
  return {
    t,
    updates: () => updates,
    messages: () => messages,
    text: () => messages.filter((m) => m.kind === "text"),
    tools: () => messages.filter((m) => m.kind === "tool"),
  };
}
const assistant = (id: string, content: unknown[], parent?: string) => ({
  type: "assistant",
  parent_tool_use_id: parent ?? null,
  message: { id, role: "assistant", content },
});
const start = (id: string, parent?: string) => ({
  type: "stream_event",
  parent_tool_use_id: parent ?? null,
  event: {
    type: "message_start",
    message: { id, role: "assistant", content: [] },
  },
});
const delta = (text: string, index = 0, parent?: string) => ({
  type: "stream_event",
  parent_tool_use_id: parent ?? null,
  event: {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  },
});
const tool = (id = "call") => ({
  type: "tool_use",
  id,
  name: "Read",
  input: { file_path: "a.ts" },
});
const result = (id = "call", parent?: string) => ({
  type: "user",
  parent_tool_use_id: parent ?? null,
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: "Permission denied",
        is_error: true,
      },
    ],
  },
});

describe("Claude native transcript reconciliation", () => {
  it("does not assign envelope artifacts to a batch or an ambiguous child", () => {
    const c = capture();
    c.t.feed(assistant("left", [{ type: "tool_use", id: "same", name: "mcp__reports__create", input: {} }], "parent-one"));
    c.t.feed(assistant("right", [{ type: "tool_use", id: "same", name: "mcp__reports__create", input: {} }], "parent-two"));
    c.t.feed({ type: "system", subtype: "task_notification", task_id: "task", tool_use_id: "same", status: "completed", resource_links: [{ uri: "file:///ws/report.html", name: "Report" }] });
    expect(c.tools().some(tool => tool.content?.length || tool.resourceLinks?.length)).toBe(false);
    c.t.feed({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "one", content: "One" },
      { type: "tool_result", tool_use_id: "two", content: "Two" },
    ] }, tool_use_result: { resourceLinks: [{ uri: "file:///ws/report.html", name: "Report" }] } });
    expect(c.tools().some(tool => tool.content?.some(block => block.type === "content" && block.content.type === "resource_link"))).toBe(false);
  });
  it("retains rich result links and late notification links on the original persisted tool", () => {
    const c = capture();
    c.t.feed(assistant("response", [{ type: "tool_use", id: "report", name: "mcp__reports__create", input: {} }]));
    const link = { type: "resource_link", uri: ".context/local/artifacts/report.html", name: "Report" };
    c.t.feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "report", content: "Report ready" }] }, tool_use_result: { resourceLinks: [{ ...link, type: undefined }], structuredContent: { count: 3 } } });
    expect(c.tools()[0].content).toContainEqual({ type: "content", content: link });
    expect(c.tools()[0].rawOutput).toMatchObject({ structuredContent: { count: 3 } });
    const late = { ...link, uri: ".context/local/artifacts/details.csv", name: "Details" };
    const notification = { type: "system", subtype: "task_notification", task_id: "background", tool_use_id: "report", status: "completed", resource_links: [{ ...late, type: undefined }] };
    c.t.feed(notification);
    c.t.feed(notification);
    const saved = JSON.parse(JSON.stringify(c.tools()));
    expect(saved[0].resourceLinks).toEqual([late]);
    expect(saved).toHaveLength(1);
    expect(saved[0].content).toEqual([
      { type: "content", content: { type: "text", text: "Report ready" } },
      { type: "content", content: link },
    ]);
  });
  it("assigns a late native end_turn to its own reply instead of a newer live message", () => {
    const c = capture();
    c.t.feed(start("first"));
    c.t.feed(delta("First report"));
    c.t.feed(start("second"));
    c.t.feed(delta("Checking another result"));
    const first = assistant("first", [{ type: "text", text: "First report" }]);
    c.t.feed({ ...first, message: { ...first.message, stop_reason: "end_turn" } });
    expect(c.text()).toEqual([
      expect.objectContaining({ text: "First report", phase: "final_answer" }),
      expect.objectContaining({ text: "Checking another result" }),
    ]);
    expect(c.text()[1].phase).not.toBe("final_answer");
  });
  it("enriches a provisional tool even when its result arrives before the completed SDK block", () => {
    const c = capture();
    c.t.feed(start("response"));
    c.t.feed({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "Read", input: {} } } });
    const id = c.tools()[0].id;
    c.t.feed(result());
    c.t.feed({ ...assistant("response", [tool()]), uuid: "late-block" });
    expect(c.tools()).toEqual([expect.objectContaining({ id, rawInput: { file_path: "a.ts" }, status: "failed" })]);
  });
  it("retains each SDK block sharing one API message id and replays each UUID once", () => {
    const c = capture();
    const frames = [
      { ...assistant("response", [{ type: "text", text: "Inspecting" }]), uuid: "text-frame" },
      { ...assistant("response", [tool("first")]), uuid: "first-frame" },
      { ...assistant("response", [tool("second")]), uuid: "second-frame" },
    ];
    for (const frame of frames) c.t.feed(frame);
    c.t.feed(result("first"));
    c.t.feed(result("second"));
    for (const frame of frames) c.t.feed(frame);
    expect(c.tools()).toEqual([
      expect.objectContaining({ title: expect.stringContaining("a.ts"), toolKind: "read", nativeToolCallId: "first", rawInput: { file_path: "a.ts" }, status: "failed" }),
      expect.objectContaining({ title: expect.stringContaining("a.ts"), toolKind: "read", nativeToolCallId: "second", rawInput: { file_path: "a.ts" }, status: "failed" }),
    ]);
    expect(c.text().map((m) => m.text)).toEqual(["Inspecting"]);
  });

  it("reconciles block snapshots to their stream indices instead of always index zero", () => {
    const c = capture();
    c.t.feed(start("response"));
    c.t.feed(delta("First draft", 0));
    c.t.feed({ ...assistant("response", [{ type: "text", text: "First" }]), uuid: "one" });
    c.t.feed(delta("Second draft", 1));
    c.t.feed({ ...assistant("response", [{ type: "text", text: "Second" }]), uuid: "two" });
    c.t.feed({ ...assistant("response", [{ type: "text", text: "Second" }]), uuid: "two" });
    expect(c.text().map((m) => m.text)).toEqual(["First", "Second"]);
  });

  it("announces a native tool start, enriches its inputs, and keeps the row through completion", () => {
    const c = capture();
    c.t.feed(start("response"));
    c.t.feed({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "Read", input: {} } } });
    expect(c.tools()).toHaveLength(1);
    const id = c.tools()[0].id;
    c.t.feed({ ...assistant("response", [tool()]), uuid: "call-frame" });
    c.t.feed(result());
    expect(c.tools()).toEqual([expect.objectContaining({ id, toolKind: "read", rawInput: { file_path: "a.ts" }, status: "failed" })]);
  });

  it("keeps equal answers from distinct native result identities", () => {
    const c = capture();
    c.t.feed({
      type: "result",
      subtype: "success",
      uuid: "one",
      result: "Done",
    });
    c.t.feed({
      type: "result",
      subtype: "success",
      uuid: "two",
      result: "Done",
    });
    expect(c.text().map((m) => m.text)).toEqual(["Done", "Done"]);
  });

  it("keeps every confirmed final answer visible across a native continuation", () => {
    const c = capture();
    c.t.feed(start("answer"));
    c.t.feed(delta("Draft"));
    c.t.feed(result());
    c.t.feed(assistant("answer", [{ type: "text", text: "Final answer" }]));
    c.t.feed({ type: "result", subtype: "success", result: "Final answer" });
    expect(partitionTurn(c.messages()).finalOutput).toEqual([
      expect.objectContaining({ text: "Final answer" }),
    ]);
    c.t.feed(start("continuation"));
    c.t.feed(delta("Continuing"));
    expect(c.text()[0]).toMatchObject({
      text: "Final answer",
      phase: "final_answer",
    });
    c.t.feed(assistant("continuation", [{ type: "text", text: "Continuing" }]));
    c.t.feed({ type: "result", subtype: "success", result: "Continuing" });
    expect(partitionTurn(c.messages()).finalOutput.map((m) => m.kind === "text" && m.text)).toEqual(["Final answer", "Continuing"]);
  });

  it("retains a completed reply while background work delays the SDK Result", () => {
    const c = capture();
    c.t.feed(start("report-one"));
    c.t.feed(delta("First report"));
    c.t.feed({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } });
    c.t.feed(start("more-work"));
    c.t.feed(delta("Checking another finding"));
    c.t.feed(assistant("work", [tool()]));
    expect(partitionTurn(c.messages(), { live: true }).finalOutput).toEqual([expect.objectContaining({ text: "First report", phase: "final_answer" })]);
  });

  it("settles a host-created question on its existing native identity", () => {
    const c = capture();
    const id = c.t.emitBlockingQuestionToolCall("call", "Question", {});
    c.t.feed(result());
    expect(c.tools()).toEqual([
      expect.objectContaining({ toolCallId: id, status: "failed" }),
    ]);
  });

  it("ignores a native result replay after another user turn starts", () => {
    const c = capture();
    const result = {
      type: "result",
      subtype: "success",
      result: "First",
      uuid: "first-result",
    };
    c.t.beginTurn();
    c.t.feed(result);
    c.t.beginTurn();
    c.t.feed(result);
    expect(c.updates().at(-1)?.update).toMatchObject({
      sessionUpdate: "background_tasks_update",
      activity: { state: "running" },
    });
    expect(c.text().map((m) => m.text)).toEqual(["First"]);
  });

  it("does not duplicate a completion-only final message when the SDK result follows", () => {
    const c = capture();
    c.t.feed(assistant("commentary", [{ type: "text", text: "Working" }]));
    c.t.feed(assistant("answer", [{ type: "text", text: "Final answer" }]));
    c.t.feed({ type: "result", subtype: "success", result: "Final answer" });
    expect(c.text().map((m) => m.text)).toEqual(["Working", "Final answer"]);
  });

  it.each([false, true])(
    "recovers a final result with partial streaming = %s",
    (partial) => {
      const c = capture();
      if (partial) {
        c.t.feed(start("partial"));
        c.t.feed(delta("Draft"));
      }
      c.t.feed({ type: "result", subtype: "success", result: "Final answer" });
      c.t.feed({ type: "result", subtype: "success", result: "Final answer" });
      expect(c.text().map((m) => m.text)).toEqual(["Final answer"]);
    },
  );

  it("does not project a failed result as a recovered answer", () => {
    const c = capture();
    c.t.feed({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Failure explanation",
    });
    expect(c.text()).toEqual([]);
  });

  it("attaches early child output when its parent call is recovered later", () => {
    const c = capture();
    c.t.feed(
      assistant(
        "early",
        [{ type: "text", text: "Child answer" }, tool("child-call")],
        "parent",
      ),
    );
    const ids = c.messages().map((m) => m.id);
    c.t.feed(assistant("late-parent", [{ ...tool("parent"), name: "Task" }]));
    const parent = c.tools().find((m) => m.nativeToolCallId === "parent")!;
    expect(
      c
        .messages()
        .slice(0, 2)
        .map((m) => m.id),
    ).toEqual(ids);
    expect(c.messages().slice(0, 2)).toEqual([
      expect.objectContaining({ parentToolId: parent.toolCallId }),
      expect.objectContaining({ parentToolId: parent.toolCallId }),
    ]);
  });

  it("retains native block order when tools and text share a completion", () => {
    const c = capture();
    c.t.feed(
      assistant("ordered", [tool(), { type: "text", text: "After tool" }]),
    );
    expect(c.messages().map((m) => m.kind)).toEqual(["tool", "text"]);
  });

  it("does not revive idle background activity for a replayed assistant completion", () => {
    const c = capture();
    c.t.beginTurn();
    const message = assistant("answer", [{ type: "text", text: "Done" }]);
    c.t.feed(message);
    c.t.feed({ type: "result", subtype: "success", result: "Done" });
    const before = c.updates().length;
    c.t.feed(message);
    expect(c.updates()).toHaveLength(before);
  });

  it("does not revive idle activity for delayed stream bookkeeping", () => {
    const c = capture();
    c.t.beginTurn();
    c.t.feed(start("answer"));
    c.t.feed(delta("Done"));
    c.t.feed(assistant("answer", [{ type: "text", text: "Done" }]));
    c.t.feed({ type: "result", subtype: "success", result: "Done" });
    const before = c.updates().length;
    c.t.feed({ type: "stream_event", event: { type: "message_stop" } });
    expect(c.updates()).toHaveLength(before);
  });

  it.each(["Draft with missing tail", "Corrected", "D", ""])(
    "reconciles an authoritative block to %j and ignores replay",
    (text) => {
      const c = capture();
      c.t.feed(start("message"));
      c.t.feed(delta("Draft"));
      const originalId = c.text()[0].id;
      const completion = assistant("message", [{ type: "text", text }]);
      c.t.feed(completion);
      c.t.feed(completion);
      c.t.feed(delta("stale"));
      expect(c.text().map((m) => m.text)).toEqual([text]);
      expect(c.text()[0].id).toBe(originalId);
    },
  );

  it("retains identical content from different native messages and blocks", () => {
    const c = capture();
    c.t.feed(
      assistant("one", [
        { type: "text", text: "Same" },
        { type: "text", text: "Same" },
      ]),
    );
    c.t.feed(assistant("two", [{ type: "text", text: "Same" }]));
    c.t.feed(
      assistant("one", [
        { type: "text", text: "Same" },
        { type: "text", text: "Same" },
      ]),
    );
    expect(c.text().map((m) => m.text)).toEqual(["Same", "Same", "Same"]);
  });

  it("reconciles independent parent and child blocks without mixing accumulators", () => {
    const c = capture();
    c.t.feed(assistant("spawn", [{ ...tool("parent"), name: "Task" }]));
    c.t.feed(start("root"));
    c.t.feed(delta("Root draft"));
    c.t.feed(start("child", "parent"));
    c.t.feed(delta("Child draft", 0, "parent"));
    c.t.feed(assistant("root", [{ type: "text", text: "Root final" }]));
    c.t.feed(
      assistant("child", [{ type: "text", text: "Child final" }], "parent"),
    );
    expect(c.text()).toEqual([
      expect.objectContaining({ text: "Root final" }),
      expect.objectContaining({
        text: "Child final",
        parentToolId: c.tools()[0].toolCallId,
      }),
    ]);
    expect(c.text()[0].parentToolId).toBeUndefined();
  });

  it("settles the original tool across replay, including a replay after its result", () => {
    const c = capture();
    const call = assistant("message", [tool()]);
    c.t.feed(call);
    c.t.feed(call);
    c.t.feed(result());
    c.t.feed(call);
    c.t.feed(result());
    expect(c.tools()).toEqual([
      expect.objectContaining({
        status: "failed",
        nativeToolCallId: "call",
        rawOutput: "Permission denied",
      }),
    ]);
  });

  it("materializes a result without a start and enriches that same row when the call arrives", () => {
    const c = capture();
    c.t.feed(result());
    const id = c.tools()[0]?.id;
    c.t.feed(assistant("late", [tool()]));
    expect(c.tools()).toEqual([
      expect.objectContaining({
        id,
        status: "failed",
        toolKind: "read",
        rawInput: { file_path: "a.ts" },
        rawOutput: "Permission denied",
      }),
    ]);
  });

  it("recovers completion-only thinking and keeps its native block separate from text", () => {
    const c = capture();
    const message = assistant("message", [
      { type: "thinking", thinking: "Reasoning" },
      { type: "text", text: "Answer" },
    ]);
    c.t.feed(message);
    c.t.feed(message);
    expect(c.text().map((m) => [m.role, m.text])).toEqual([
      ["thought", "Reasoning"],
      ["agent", "Answer"],
    ]);
  });

  it("isolates two parents that use the same native child tool id", () => {
    const c = capture();
    c.t.feed(
      assistant("spawns", [
        { ...tool("p1"), name: "Task" },
        { ...tool("p2"), name: "Task" },
      ]),
    );
    c.t.feed(assistant("c1", [tool()], "p1"));
    c.t.feed(assistant("c2", [tool()], "p2"));
    c.t.feed(result("call", "p1"));
    expect(
      c
        .tools()
        .slice(2)
        .map((m) => m.status),
    ).toEqual(["failed", "in_progress"]);
  });
});
