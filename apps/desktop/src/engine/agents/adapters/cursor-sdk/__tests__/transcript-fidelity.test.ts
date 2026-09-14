import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { partitionTurn } from "@/renderer/features/agent/turn-partition";
import { formatTranscript } from "@/renderer/features/agent/transcript-format";
import { CursorSdkTranslator } from "../translator";

function transcript() {
  let messages: AgentMessage[] = [];
  const translator = new CursorSdkTranslator({
    sessionId: "session",
    emit: (event) => {
      messages = applyUpdate(messages, event);
    },
  });
  return { translator, messages: () => messages };
}

describe("Cursor transcript boundaries", () => {
  it.each(["delta", "step", "stream"] as const)(
    "keeps the final answer after tools with the %s source",
    (source) => {
      const t = transcript();
      const text = (value: string) => {
        if (source === "delta")
          t.translator.feedDelta({ type: "text-delta", text: value });
        else if (source === "step")
          t.translator.feedStep({
            type: "assistantMessage",
            message: { text: value },
          });
        else
          t.translator.feed({
            type: "assistant",
            message: { content: [{ type: "text", text: value }] },
          });
      };
      const tool = {
        type: "readToolCall",
        args: { path: "a.ts" },
        result: { success: { content: "const a = 1;" } },
      };
      text("I will inspect the file.");
      if (source === "delta") {
        t.translator.feedDelta({
          type: "tool-call-started",
          callId: "read",
          toolCall: tool,
        });
        t.translator.feedDelta({
          type: "tool-call-completed",
          callId: "read",
          toolCall: tool,
        });
      } else if (source === "step")
        t.translator.feedStep({ type: "toolCall", message: tool });
      else
        t.translator.feed({
          type: "tool_call",
          call_id: "read",
          name: tool.type,
          args: tool.args,
          result: tool.result,
          status: "completed",
        });
      text("The answer is ");
      text("42.");

      const { working, finalOutput } = partitionTurn(t.messages());
      expect(working).toHaveLength(2);
      expect(finalOutput).toEqual([
        expect.objectContaining({ kind: "text", text: "The answer is 42." }),
      ]);
      expect(t.messages()[0]).toMatchObject({
        text: "I will inspect the file.",
      });
      const copied = formatTranscript(t.messages(), "concise").text;
      expect(copied).toContain("The answer is 42.");
      expect(copied).not.toContain("I will inspect the file.");
    },
  );

  it("preserves separate reasoning and narration segments and their final answer", () => {
    const t = transcript();
    t.translator.feedDelta({ type: "thinking-delta", text: "First thought" });
    t.translator.feedDelta({ type: "text-delta", text: "Working narration" });
    t.translator.feedDelta({ type: "thinking-delta", text: "Second thought" });
    t.translator.feedDelta({ type: "text-delta", text: "Final " });
    // Late duration metadata updates the last thought without splitting prose.
    t.translator.feedDelta({
      type: "thinking-completed",
      thinkingDurationMs: 1200,
    });
    t.translator.feedDelta({ type: "text-delta", text: "answer" });
    expect(t.messages()).toEqual([
      expect.objectContaining({ text: "First thought", role: "thought" }),
      expect.objectContaining({ text: "Working narration", role: "agent" }),
      expect.objectContaining({
        text: "Second thought",
        role: "thought",
        durationMs: 1200,
      }),
      expect.objectContaining({ text: "Final answer", role: "agent" }),
    ]);
    expect(partitionTurn(t.messages()).finalOutput).toEqual([t.messages()[3]]);
  });

  it("keeps one answer through updates to an already visible tool", () => {
    const t = transcript();
    const toolCall = { type: "readToolCall", args: { path: "a.ts" } };
    t.translator.feedDelta({
      type: "tool-call-started",
      callId: "read",
      toolCall,
    });
    t.translator.feedDelta({ type: "text-delta", text: "Final " });
    t.translator.feedDelta({
      type: "partial-tool-call",
      callId: "read",
      toolCall,
    });
    t.translator.feedDelta({
      type: "tool-call-completed",
      callId: "read",
      toolCall: { ...toolCall, result: { success: { content: "a" } } },
    });
    t.translator.feedDelta({ type: "text-delta", text: "answer" });
    expect(t.messages()).toHaveLength(2);
    expect(partitionTurn(t.messages()).finalOutput).toEqual([
      expect.objectContaining({ text: "Final answer" }),
    ]);
  });
});
