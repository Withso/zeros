import { describe, expect, it, vi } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CursorSdkTranslator } from "../translator";
import { parseSubagentTranscript } from "../subagent-transcript";
import type { TranscriptCapture } from "../subagent-transcript-reader";

function setup() {
  let messages: AgentMessage[] = [];
  const read = vi.fn(
    async (): Promise<TranscriptCapture> => ({
      steps: [],
      finalText: "",
      captureIssue: "unavailable" as const,
    }),
  );
  const translator = new CursorSdkTranslator({
    sessionId: "session",
    readSubagentTranscript: read,
    emit: (event) => {
      messages = applyUpdate(messages, event);
    },
  });
  return { translator, read, messages: () => messages };
}
const start = (callId: string) => ({
  type: "tool-call-started",
  callId,
  toolCall: {
    type: "task",
    args: { description: `Inspect ${callId}`, agentId: `child-${callId}` },
  },
});
const child = (callId: string, taskUpdate: unknown) => ({
  type: "tool-call-delta",
  callId,
  modelCallId: "parent-model-call",
  taskUpdate,
});
const readStart = {
  type: "tool-call-started",
  callId: "same-native-read-id",
  toolCall: { type: "read", args: { path: "report.md" } },
};
const checkpoint = (text: string) =>
  parseSubagentTranscript(
    JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "text", text }] },
    }),
  );

describe("Cursor native child deltas", () => {
  it.each([
    { type: "text-delta", text: "" },
    { type: "thinking-delta", text: null },
    { type: "tool-call-started", callId: "read" },
    { type: "tool-call-completed", callId: "", toolCall: { type: "read" } },
  ])(
    "does not let malformed $type disable checkpoint capture",
    async (update) => {
      const c = setup();
      c.read.mockResolvedValue(checkpoint("Captured report"));
      c.translator.feedDelta(start("a"));
      c.translator.feedDelta(child("a", update));
      await c.translator.pollSubagents();
      expect(c.read).toHaveBeenCalledOnce();
      expect(c.messages()).toContainEqual(
        expect.objectContaining({ text: "Captured report" }),
      );
      expect(c.messages().filter((m) => m.kind === "tool")).toHaveLength(1);
    },
  );

  it("discards an in-flight checkpoint when native deltas claim the child", async () => {
    const c = setup();
    let resolve!: (value: TranscriptCapture) => void;
    c.read.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    c.translator.feedDelta(start("a"));
    const poll = c.translator.pollSubagents();
    c.translator.feedDelta(
      child("a", { type: "text-delta", text: "Live report" }),
    );
    resolve(checkpoint("Stale checkpoint"));
    await poll;
    await c.translator.pollSubagents();
    expect(c.read).toHaveBeenCalledOnce();
    expect(c.messages().filter((m) => m.kind === "text")).toEqual([
      expect.objectContaining({ text: "Live report" }),
    ]);
  });

  it("retains an established checkpoint feed when later native text has no message identity", async () => {
    const c = setup();
    c.read.mockResolvedValue(checkpoint("Captured report"));
    c.translator.feedDelta(start("a"));
    await c.translator.pollSubagents();
    c.translator.feedDelta(
      child("a", { type: "text-delta", text: "Captured report" }),
    );
    await c.translator.pollSubagents();
    expect(c.read).toHaveBeenCalledTimes(2);
    expect(c.messages().filter((m) => m.kind === "text")).toEqual([
      expect.objectContaining({ text: "Captured report" }),
    ]);
  });

  it("streams interleaved children under their native parent calls before either finishes", async () => {
    const c = setup();
    for (const id of ["a", "b"]) {
      c.translator.feedDelta(start(id));
      c.translator.feedDelta(
        child(id, { type: "thinking-delta", text: `Thinking ${id}` }),
      );
      c.translator.feedDelta(child(id, readStart));
    }
    c.translator.feedDelta(
      child("a", {
        ...readStart,
        type: "tool-call-completed",
        toolCall: {
          ...readStart.toolCall,
          result: { status: "error", error: { message: "Permission denied" } },
        },
      }),
    );
    c.translator.feedDelta(
      child("b", { type: "text-delta", text: "Child B report" }),
    );
    const groups = c
      .messages()
      .filter((m) => m.kind === "tool" && !m.parentToolId);
    expect(groups).toHaveLength(2);
    const [a, b] = groups.map((m) => m.kind === "tool" && m.toolCallId);
    expect(c.messages()).toContainEqual(
      expect.objectContaining({
        kind: "text",
        parentToolId: a,
        text: "Thinking a",
      }),
    );
    expect(c.messages()).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        parentToolId: a,
        status: "failed",
        rawOutput: expect.objectContaining({
          error: { message: "Permission denied" },
        }),
      }),
    );
    expect(c.messages()).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        parentToolId: b,
        status: "in_progress",
      }),
    );
    expect(c.messages()).toContainEqual(
      expect.objectContaining({
        kind: "text",
        parentToolId: b,
        text: "Child B report",
      }),
    );
    await c.translator.pollSubagents();
    expect(c.read).not.toHaveBeenCalled();
    const end = {
      type: "tool-call-completed",
      callId: "b",
      toolCall: {
        ...start("b").toolCall,
        result: {
          status: "success",
          value: { isBackground: false, agentId: "child-b" },
        },
      },
    };
    c.translator.feedDelta(end);
    c.translator.feedDelta(end);
    expect(c.messages()).toContainEqual(
      expect.objectContaining({
        kind: "text",
        parentToolId: b,
        text: "Child B report",
        phase: "final_answer",
      }),
    );
    await c.translator.flushSubagents();
    expect(c.read).not.toHaveBeenCalled();
    expect(
      c.messages().filter((m) => m.kind === "tool" && m.parentToolId),
    ).toHaveLength(2);
    const stopped = c.messages();
    c.translator.feedDelta(
      child("a", { type: "text-delta", text: "Late after Stop" }),
    );
    expect(c.messages()).toBe(stopped);
  });

  it("binds missing-start child output to the later named Agent group", () => {
    const c = setup();
    c.translator.feedDelta(child("a", { type: "text-delta", text: "Working" }));
    c.translator.feedDelta(start("a"));
    const groups = c
      .messages()
      .filter((m) => m.kind === "tool" && !m.parentToolId);
    expect(groups).toEqual([
      expect.objectContaining({
        rawInput: expect.objectContaining({ description: "Inspect a" }),
      }),
    ]);
    expect(c.messages()).toContainEqual(
      expect.objectContaining({
        text: "Working",
        parentToolId: groups[0].kind === "tool" && groups[0].toolCallId,
      }),
    );
  });

  it("recovers a file-only final report without replaying native child tools", async () => {
    const c = setup();
    c.read.mockResolvedValue(checkpoint("Report only in the final file"));
    c.translator.feedDelta(start("a"));
    c.translator.feedDelta(
      child("a", { type: "text-delta", text: "Inspecting the file" }),
    );
    c.translator.feedDelta(child("a", readStart));
    c.translator.feedDelta(
      child("a", {
        ...readStart,
        type: "tool-call-completed",
        toolCall: {
          ...readStart.toolCall,
          result: { status: "success", value: { content: "file" } },
        },
      }),
    );
    c.translator.feedDelta({
      ...start("a"),
      type: "tool-call-completed",
      toolCall: {
        ...start("a").toolCall,
        result: {
          status: "success",
          value: { agentId: "child-a", isBackground: false },
        },
      },
    });
    await c.translator.flushSubagents();
    expect(c.read).toHaveBeenCalledOnce();
    expect(c.messages().filter((m) => m.kind === "tool")).toHaveLength(2);
    expect(c.messages().filter((m) => m.kind === "text")).toEqual([
      expect.objectContaining({ text: "Inspecting the file" }),
      expect.objectContaining({
        text: "Report only in the final file",
        phase: "final_answer",
      }),
    ]);
  });

  it("drops a file-only report when Stop occurs during its final read", async () => {
    const c = setup();
    let resolve!: (value: TranscriptCapture) => void;
    let stopped = false;
    c.read.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    c.translator.feedDelta(start("a"));
    c.translator.feedDelta(child("a", readStart));
    c.translator.feedDelta({
      ...start("a"),
      type: "tool-call-completed",
      toolCall: {
        ...start("a").toolCall,
        result: {
          status: "success",
          value: { agentId: "child-a", isBackground: false },
        },
      },
    });
    const finish = c.translator.flushSubagents({
      canReadFinal: () => !stopped,
    });
    stopped = true;
    resolve(checkpoint("Late file-only report"));
    await finish;
    expect(c.messages().filter((m) => m.kind === "text")).toEqual([]);
    expect(c.messages()).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        status: "pending",
        rawOutput: { _zerosToolCompletion: "unreported" },
      }),
    );
  });

  it.each(["native", "protobuf"])(
    "recovers a completion-only child report from %s result steps",
    (shape) => {
      const c = setup();
      c.translator.feedDelta(start("a"));
      c.translator.feedDelta(child("a", readStart));
      const report = { text: "Recovered report" };
      c.translator.feedDelta({
        type: "tool-call-completed",
        callId: "a",
        toolCall: {
          ...start("a").toolCall,
          result: {
            status: "success",
            value: {
              isBackground: false,
              agentId: "child-a",
              conversationSteps: [
                shape === "native"
                  ? { type: "assistantMessage", message: report }
                  : { assistantMessage: report },
              ],
            },
          },
        },
      });
      expect(c.messages()).toContainEqual(
        expect.objectContaining({
          text: "Recovered report",
          phase: "final_answer",
        }),
      );
      expect(c.messages().filter((m) => m.kind === "tool")).toHaveLength(2);
    },
  );
});
