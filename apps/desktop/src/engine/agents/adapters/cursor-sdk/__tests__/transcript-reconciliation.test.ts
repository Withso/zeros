import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CursorSdkTranslator } from "../translator";
import { partitionTurn } from "@/renderer/features/agent/turn-partition";

function capture() {
  let messages: AgentMessage[] = [];
  const t = new CursorSdkTranslator({
    sessionId: "session",
    emit: (e) => {
      messages = applyUpdate(messages, e);
    },
  });
  return {
    t,
    messages: () => messages,
    text: () => messages.filter((m) => m.kind === "text"),
    tools: () => messages.filter((m) => m.kind === "tool"),
  };
}
const assistant = (text: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const completedTool = (id: string) => ({
  type: "tool_call",
  call_id: id,
  name: "shell",
  status: "completed",
  args: { command: "check" },
  result: {
    status: "success",
    value: { exitCode: 1, stderr: "Permission denied" },
  },
});

describe("Cursor mixed delivery reconciliation", () => {
  it("does not duplicate the same final result after late tool bookkeeping", () => {
    const c = capture();
    c.t.recoverFinalAnswer("Done");
    c.t.feed(completedTool("late"));
    c.t.recoverFinalAnswer("Done");
    expect(c.text().map((m) => m.text)).toEqual(["Done"]);
  });

  it("keeps the final answer visible when a delayed tool mirror appears after it", () => {
    const c = capture();
    c.t.feed(assistant("Final answer"));
    c.t.recoverFinalAnswer("Final answer");
    c.t.feed(completedTool("late"));
    expect(partitionTurn(c.messages()).finalOutput).toEqual([
      expect.objectContaining({ text: "Final answer" }),
    ]);
  });

  it("keeps a completed tool unchanged when its native completion is replayed", () => {
    const c = capture();
    c.t.feed(completedTool("call"));
    const settled = c.tools()[0];
    c.t.feed(completedTool("call"));
    expect(c.tools()[0]).toBe(settled);
  });

  it("reconciles the SDK callback order when the stream drains afterwards", () => {
    const c = capture();
    c.t.feedDelta({ type: "text-delta", text: "Working" });
    c.t.feedStep({ type: "assistantMessage", message: { text: "Working" } });
    const event = completedTool("call");
    const toolCall = {
      type: event.name,
      args: event.args,
      result: event.result,
    };
    c.t.feedDelta({
      type: "tool-call-started",
      callId: "call",
      toolCall: { type: event.name, args: event.args },
    });
    c.t.feedStep({ type: "toolCall", message: toolCall });
    c.t.feedDelta({ type: "tool-call-completed", callId: "call", toolCall });
    c.t.feedDelta({ type: "thinking-delta", text: "Thinking" });
    c.t.feedStep({ type: "thinkingMessage", message: { text: "Thinking" } });
    c.t.feedDelta({ type: "text-delta", text: "Final " });
    c.t.feedDelta({ type: "text-delta", text: "answer" });
    c.t.feedStep({
      type: "assistantMessage",
      message: { text: "Final answer" },
    });
    c.t.feed(assistant("Working"));
    c.t.feed({ ...event, status: "running", result: undefined });
    c.t.feed(event);
    c.t.feed({ type: "thinking", text: "Thinking" });
    c.t.feed({ type: "thinking", text: "", thinking_duration_ms: 100 });
    c.t.feed(assistant("Final "));
    c.t.feed(assistant("answer"));
    c.t.recoverFinalAnswer("Final answer");
    expect(c.text().map((m) => [m.text, m.durationMs])).toEqual([
      ["Working", undefined],
      ["Thinking", 100],
      ["Final answer", undefined],
    ]);
    expect(c.tools()).toHaveLength(1);
  });

  it.each(["tool_call", "assistant"])(
    "binds a delayed %s start to an already completed anonymous step",
    (source) => {
      const c = capture();
      const event = completedTool("call");
      c.t.feedStep({
        type: "toolCall",
        message: { type: event.name, args: event.args, result: event.result },
      });
      if (source === "tool_call")
        c.t.feed({ ...event, status: "running", result: undefined });
      else
        c.t.feed({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "call",
                name: event.name,
                input: event.args,
              },
            ],
          },
        });
      c.t.feed(event);
      expect(c.tools()).toEqual([
        expect.objectContaining({ status: "failed", nativeToolCallId: "call" }),
      ]);
    },
  );

  it("rejects replay from another native run or agent", () => {
    const c = capture();
    c.t.bindRunIdentity("agent", "current");
    c.t.feed({ ...assistant("Wrong run"), agent_id: "agent", run_id: "old" });
    c.t.feed({
      ...completedTool("call"),
      agent_id: "child",
      run_id: "current",
    });
    c.t.feed({
      ...assistant("Current answer"),
      agent_id: "agent",
      run_id: "current",
    });
    expect(c.messages()).toEqual([
      expect.objectContaining({ text: "Current answer" }),
    ]);
  });

  it("waits for native identity when identical parallel tools make a completed step ambiguous", () => {
    const c = capture();
    const event = completedTool("one");
    const toolCall = {
      type: event.name,
      args: event.args,
      result: event.result,
    };
    for (const id of ["one", "two"])
      c.t.feedDelta({
        type: "tool-call-started",
        callId: id,
        toolCall: { type: event.name, args: event.args },
      });
    c.t.feedStep({ type: "toolCall", message: toolCall });
    c.t.feedDelta({ type: "tool-call-completed", callId: "two", toolCall });
    expect(c.tools().map((m) => [m.nativeToolCallId, m.status])).toEqual([
      ["one", "in_progress"],
      ["two", "failed"],
    ]);
  });

  it("does not merge identical commentary and final answers across a tool boundary", () => {
    const c = capture();
    c.t.feed(assistant("Done"));
    c.t.feed(completedTool("call"));
    c.t.recoverFinalAnswer("Done");
    c.t.recoverFinalAnswer("Done");
    expect(c.text().map((m) => m.text)).toEqual(["Done", "Done"]);
  });

  it("consumes callback deltas mirrored after stream text without duplicating the answer", () => {
    const c = capture();
    c.t.feed(assistant("Final "));
    c.t.feedDelta({ type: "text-delta", text: "Final " });
    c.t.feedDelta({ type: "text-delta", text: "answer" });
    c.t.feedStep({
      type: "assistantMessage",
      message: { text: "Final answer" },
    });
    c.t.feed(assistant("answer"));
    expect(c.text().map((m) => m.text)).toEqual(["Final answer"]);
  });

  it("uses one tool row when the SDK completes an anonymous step before its native callback", () => {
    const c = capture();
    const event = completedTool("call");
    const toolCall = {
      type: event.name,
      args: event.args,
      result: event.result,
    };
    c.t.feedDelta({
      type: "tool-call-started",
      callId: "call",
      toolCall: { type: event.name, args: event.args },
    });
    c.t.feedStep({ type: "toolCall", message: toolCall });
    c.t.feedDelta({ type: "tool-call-completed", callId: "call", toolCall });
    c.t.feed(event);
    expect(c.tools()).toEqual([
      expect.objectContaining({ status: "failed", nativeToolCallId: "call" }),
    ]);
  });

  it.each(["Final ", "Final answer"])(
    "reconciles a completed step after stream-only text %j",
    (text) => {
      const c = capture();
      c.t.feed(assistant(text));
      c.t.feedStep({
        type: "assistantMessage",
        message: { text: "Final answer" },
      });
      expect(c.text().map((m) => m.text)).toEqual(["Final answer"]);
    },
  );

  it("consumes identical anonymous tool steps separately when their native ids arrive", () => {
    const c = capture();
    const event = completedTool("one");
    const message = {
      type: event.name,
      args: event.args,
      result: event.result,
    };
    c.t.feedStep({ type: "toolCall", message });
    c.t.feedStep({ type: "toolCall", message: { ...message } });
    c.t.feed(event);
    c.t.feed(completedTool("two"));
    c.t.feed(event);
    expect(c.tools().map((m) => m.nativeToolCallId)).toEqual(["one", "two"]);
  });

  it.each(["stream", "step"] as const)(
    "recovers a completion suffix from %s after partial callbacks",
    (source) => {
      const c = capture();
      c.t.feedDelta({ type: "text-delta", text: "Final " });
      if (source === "stream") c.t.feed(assistant("Final answer"));
      else
        c.t.feedStep({
          type: "assistantMessage",
          message: { text: "Final answer" },
        });
      expect(c.text().map((m) => m.text)).toEqual(["Final answer"]);
    },
  );

  it("updates a callback-started tool from a stream-only completion, once", () => {
    const c = capture();
    c.t.feedDelta({
      type: "tool-call-started",
      callId: "call",
      toolCall: { type: "shell", args: { command: "check" } },
    });
    c.t.feed(completedTool("call"));
    c.t.feed(completedTool("call"));
    c.t.feedDelta({
      type: "tool-call-started",
      callId: "call",
      toolCall: { type: "shell", args: {} },
    });
    expect(c.tools()).toEqual([
      expect.objectContaining({
        status: "failed",
        rawOutput: expect.objectContaining({
          value: expect.objectContaining({ stderr: "Permission denied" }),
        }),
      }),
    ]);
  });

  it("keeps a later stream-only answer after earlier callbacks and tools", () => {
    const c = capture();
    c.t.feedDelta({ type: "text-delta", text: "Working" });
    c.t.feed(assistant("Working"));
    c.t.feed(completedTool("call"));
    c.t.feed(assistant("Final answer"));
    expect(c.text().map((m) => m.text)).toEqual(["Working", "Final answer"]);
  });

  it("does not collapse distinct native calls with identical arguments and results", () => {
    const c = capture();
    c.t.feed(completedTool("one"));
    c.t.feed(completedTool("two"));
    expect(c.tools()).toHaveLength(2);
  });

  it("reconciles a correcting full callback snapshot instead of concatenating the draft", () => {
    const c = capture();
    c.t.feedDelta({ type: "text-delta", text: "Draft" });
    c.t.feedStep({
      type: "assistantMessage",
      message: { text: "Correct final" },
    });
    c.t.feed(assistant("Correct final"));
    expect(c.text().map((m) => m.text)).toEqual(["Correct final"]);
  });
});
