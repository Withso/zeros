import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { partitionTurn } from "@/renderer/features/agent/turn-partition";
import { CursorSdkTranslator } from "../translator";

function capture() {
  let messages: AgentMessage[] = [];
  const translator = new CursorSdkTranslator({
    sessionId: "session",
    emit: (event) => {
      messages = applyUpdate(messages, event);
    },
  });
  return { translator, messages: () => messages };
}

const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

describe("Cursor same-run background continuations", () => {
  it("preserves stream-only reports using native per-turn usage boundaries", () => {
    const c = capture();
    for (const report of ["First report", "Second report"]) {
      c.translator.feed(assistant(report));
      c.translator.feed({
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    }
    c.translator.recoverFinalAnswer("Second report");
    expect(c.messages()).toEqual([
      expect.objectContaining({ text: "First report", phase: "final_answer" }),
      expect.objectContaining({ text: "Second report", phase: "final_answer" }),
    ]);
  });

  it("does not let a delayed usage mirror close the next callback turn", () => {
    const c = capture();
    c.translator.feedDelta({ type: "text-delta", text: "First report" });
    c.translator.feedStep({
      type: "assistantMessage",
      message: { text: "First report" },
    });
    const usage = { inputTokens: 1, outputTokens: 1 };
    c.translator.feedDelta({ type: "turn-ended", usage });
    c.translator.feedDelta({ type: "text-delta", text: "Second " });
    c.translator.feed(assistant("First report"));
    c.translator.feed({ type: "usage", usage });
    c.translator.feedDelta({ type: "text-delta", text: "report" });
    c.translator.feedStep({
      type: "assistantMessage",
      message: { text: "Second report" },
    });
    c.translator.feedDelta({ type: "turn-ended", usage });
    c.translator.feed(assistant("Second report"));
    c.translator.feed({ type: "usage", usage });
    c.translator.recoverFinalAnswer("Second report");
    expect(c.messages()).toEqual([
      expect.objectContaining({ text: "First report", phase: "final_answer" }),
      expect.objectContaining({ text: "Second report", phase: "final_answer" }),
    ]);
  });

  it.each([10, 20])(
    "does not consume a later turn's usage (%s tokens) when an earlier mirror never arrived",
    (secondInput) => {
      const c = capture();
      c.translator.feedDelta({ type: "text-delta", text: "First report" });
      c.translator.feedDelta({
        type: "turn-ended",
        usage: { inputTokens: 10 },
      });
      // The first turn's stream mirror was lost. Later stream-only turns still
      // own their boundaries; receipt counts alone cannot correlate them.
      for (const [text, inputTokens] of [
        ["Second report", secondInput],
        ["Third report", 30],
      ] as const) {
        c.translator.feed(assistant(text));
        c.translator.feed({ type: "usage", usage: { inputTokens } });
      }
      c.translator.recoverFinalAnswer("Third report");
      expect(c.messages()).toEqual([
        expect.objectContaining({
          text: "First report",
          phase: "final_answer",
        }),
        expect.objectContaining({
          text: "Second report",
          phase: "final_answer",
        }),
        expect.objectContaining({
          text: "Third report",
          phase: "final_answer",
        }),
      ]);
    },
  );

  it("retains each native report across consecutive turns without an intervening tool", () => {
    const c = capture();
    for (const report of ["First report", "Second report"]) {
      c.translator.feedDelta({ type: "text-delta", text: report });
      c.translator.feedStep({
        type: "assistantMessage",
        message: { text: report },
      });
      c.translator.feedDelta({ type: "turn-ended" });
    }
    // The stream may drain after the callback lane; these are mirrors, not
    // extra turns. wait().result repeats only the final native report.
    c.translator.feed(assistant("First report"));
    c.translator.feed(assistant("Second report"));
    c.translator.recoverFinalAnswer("Second report");
    expect(
      c
        .messages()
        .map((message) => [
          message.kind === "text" && message.text,
          message.kind === "text" && message.phase,
        ]),
    ).toEqual([
      ["First report", "final_answer"],
      ["Second report", "final_answer"],
    ]);
    expect(partitionTurn(c.messages()).finalOutput).toHaveLength(2);
  });

  it("keeps a confirmed report visible when a later continuation runs tools", () => {
    const c = capture();
    c.translator.feedDelta({ type: "text-delta", text: "First report" });
    c.translator.feedStep({
      type: "assistantMessage",
      message: { text: "First report" },
    });
    c.translator.feedDelta({ type: "turn-ended" });
    c.translator.feedDelta({ type: "turn-ended" });
    c.translator.feed({
      type: "tool_call",
      call_id: "read",
      name: "read",
      status: "running",
      args: { path: "report.md" },
    });
    c.translator.feedDelta({ type: "text-delta", text: "Still working" });
    expect(partitionTurn(c.messages()).finalOutput).toContainEqual(
      expect.objectContaining({ text: "First report", phase: "final_answer" }),
    );
    expect(c.messages().filter((m) => m.kind === "text")).toHaveLength(2);
  });

  it("does not promote commentary followed by a tool at a stream-only turn boundary", () => {
    const c = capture();
    c.translator.feed(assistant("Inspecting the report"));
    c.translator.feed({
      type: "tool_call",
      call_id: "read",
      name: "read",
      status: "completed",
      args: { path: "report.md" },
      result: { status: "success", value: { content: "Report" } },
    });
    c.translator.feed({ type: "usage", usage: { inputTokens: 10 } });
    expect(c.messages()[0]).not.toHaveProperty("phase", "final_answer");
  });

  it("does not merge equal reports from separate native turns", () => {
    const c = capture();
    for (let i = 0; i < 2; i++) {
      c.translator.feedDelta({ type: "text-delta", text: "Done" });
      c.translator.feedStep({
        type: "assistantMessage",
        message: { text: "Done" },
      });
      c.translator.feedDelta({ type: "turn-ended" });
    }
    c.translator.recoverFinalAnswer("Done");
    expect(c.messages()).toHaveLength(2);
    expect(new Set(c.messages().map((message) => message.id)).size).toBe(2);
    expect(c.messages()).toEqual([
      expect.objectContaining({ text: "Done", phase: "final_answer" }),
      expect.objectContaining({ text: "Done", phase: "final_answer" }),
    ]);
  });

  it("keeps a background launch active until native child completion", async () => {
    const c = capture();
    const tool = {
      type: "tool_call",
      call_id: "task-a",
      name: "task",
      args: { description: "Inspect", agentId: "child-a" },
    };
    c.translator.feed({ ...tool, status: "running" });
    const launch = {
      status: "success",
      value: {
        agentId: "child-a",
        isBackground: true,
        backgroundReason: "queuedFollowUp",
      },
    };
    c.translator.feed({ ...tool, status: "completed", result: launch });
    expect(c.messages()[0]).toMatchObject({
      kind: "tool",
      status: "in_progress",
    });
    c.translator.feed({
      ...tool,
      status: "completed",
      result: {
        status: "success",
        value: {
          agentId: "child-a",
          isBackground: false,
          finalMessage: "Done",
        },
      },
    });
    expect(c.messages()[0]).toMatchObject({
      kind: "tool",
      status: "completed",
    });
    c.translator.feed({ ...tool, status: "completed", result: launch });
    expect(c.messages()[0]).toMatchObject({
      kind: "tool",
      status: "completed",
    });
    await c.translator.flushSubagents();
    expect(
      c.messages().filter((message) => message.kind === "tool"),
    ).toHaveLength(1);
  });
});
