import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CursorSdkTranslator } from "../translator";
import { parseSubagentTranscript } from "../subagent-transcript";

describe("Cursor child checkpoint delivery", () => {
  it.each(["", "[REDACTED]"])(
    "retires live text when a later checkpoint replaces it with %j",
    async (replacement) => {
      let content = "A provisional child answer";
      let messages: AgentMessage[] = [];
      const translator = new CursorSdkTranslator({
        sessionId: "session",
        emit: (event) => {
          messages = applyUpdate(messages, event);
        },
        loadSubagentTranscript: () =>
          parseSubagentTranscript(
            JSON.stringify({
              role: "assistant",
              message: {
                id: "reply",
                content: [{ type: "text", text: content }],
              },
            }),
          ),
      });
      translator.feed({
        type: "tool_call",
        call_id: "task",
        name: "task",
        status: "running",
        args: { agentId: "child", description: "Audit" },
      });
      await translator.pollSubagents();
      const id = messages[1].id;
      content = replacement;
      await translator.pollSubagents();
      expect(messages.filter((message) => message.kind === "text")).toEqual([
        expect.objectContaining({ id, text: "" }),
      ]);
    },
  );
  it("reconciles corrected text in a checkpoint using its native message and block identity", async () => {
    let content = "Initial draft";
    let messages: AgentMessage[] = [];
    const translator = new CursorSdkTranslator({
      sessionId: "session",
      emit: (event) => {
        messages = applyUpdate(messages, event);
      },
      loadSubagentTranscript: () =>
        parseSubagentTranscript(
          JSON.stringify({
            role: "assistant",
            message: {
              id: "reply",
              content: [{ type: "text", text: content }],
            },
          }),
        ),
    });
    translator.feed({
      type: "tool_call",
      call_id: "task",
      name: "task",
      status: "running",
      args: { description: "Audit", prompt: "Inspect source" },
    });
    translator.feed({
      type: "tool_call",
      call_id: "task",
      name: "task",
      status: "running",
      args: { agentId: "child" },
    });
    await translator.pollSubagents();
    const id = messages[1].id;
    content = "Corrected answer";
    await translator.pollSubagents();
    await translator.flushSubagents();
    expect(messages.filter((message) => message.kind === "text")).toEqual([
      expect.objectContaining({ id, text: content }),
    ]);
  });
  it("streams narration and tools in order before completion and reconciles repeated checkpoints", async () => {
    const records: unknown[] = [];
    let messages: AgentMessage[] = [];
    const translator = new CursorSdkTranslator({
      sessionId: "session",
      emit: (event) => {
        messages = applyUpdate(messages, event);
      },
      loadSubagentTranscript: () =>
        parseSubagentTranscript(
          records.map((r) => JSON.stringify(r)).join("\n"),
        ),
    });
    translator.feed({
      type: "tool_call",
      call_id: "task",
      name: "task",
      status: "running",
      args: {
        agentId: "child",
        description: "Audit",
        prompt: "Inspect source",
      },
    });
    const parent = messages[0].kind === "tool" ? messages[0].toolCallId : "";
    records.push({
      role: "assistant",
      message: {
        id: "first",
        content: [{ type: "text", text: "Inspecting source." }],
      },
    });
    await translator.pollSubagents();
    expect(messages).toContainEqual(
      expect.objectContaining({
        kind: "text",
        text: "Inspecting source.",
        parentToolId: parent,
      }),
    );
    records.push({
      role: "assistant",
      message: {
        id: "tool",
        content: [
          {
            type: "tool_use",
            id: "native-read",
            name: "Read",
            input: { path: "a.ts" },
          },
        ],
      },
    });
    await translator.pollSubagents();
    const ids = messages.map((m) => m.id);
    await translator.pollSubagents();
    expect(messages.map((m) => m.id)).toEqual(ids);
    expect(messages.slice(1).map((m) => m.kind)).toEqual(["text", "tool"]);
    records.push({
      role: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "native-read",
            content: "Permission denied",
            is_error: true,
          },
        ],
      },
    });
    records.push({
      role: "assistant",
      message: {
        id: "last",
        content: [{ type: "text", text: "Audit finished." }],
      },
    });
    await translator.pollSubagents();
    translator.feed({
      type: "tool_call",
      call_id: "task",
      name: "task",
      status: "completed",
      result: { status: "success", value: { agentId: "child" } },
    });
    await translator.flushSubagents();
    expect(
      messages.filter((m) => m.kind === "text").map((m) => m.text),
    ).toEqual(["Inspecting source.", "Audit finished."]);
    expect(messages).toContainEqual(
      expect.objectContaining({ id: ids[2], status: "failed" }),
    );
  });
});
