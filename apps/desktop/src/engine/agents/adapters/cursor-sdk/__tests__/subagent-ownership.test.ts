import { describe, expect, it, vi } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CursorSdkTranslator } from "../translator";
import {
  parseSubagentTranscript,
  type ParsedSubagentTranscript,
} from "../subagent-transcript";

function transcript(child: string) {
  return parseSubagentTranscript(
    JSON.stringify({
      role: "assistant",
      message: {
        id: "shared-message-id",
        content: [
          { type: "thinking", thinking: `${child} reasoning` },
          { type: "text", text: `${child} narration` },
          {
            type: "tool_use",
            id: "shared-tool-id",
            name: "Read",
            input: { path: `${child}.ts` },
          },
        ],
      },
    }),
  );
}

function capture() {
  let messages: AgentMessage[] = [];
  const discover = vi.fn(() => "wrong");
  const byId = vi.fn((id: string): ParsedSubagentTranscript | null =>
    transcript(id),
  );
  const byPath = vi.fn((_path: string): ParsedSubagentTranscript | null =>
    transcript("right"),
  );
  // Keep the former discovery callback in this fixture: a hint must never
  // grant ownership, even if it claims a unique prompt/recency match.
  const options = {
    sessionId: "session",
    emit: (event: Parameters<typeof applyUpdate>[1]) => {
      messages = applyUpdate(messages, event);
    },
    discoverSubagentAgentId: discover,
    loadSubagentTranscript: byId,
    loadSubagentTranscriptByPath: byPath,
  };
  const translator = new CursorSdkTranslator(options);
  return {
    translator,
    discover,
    byId,
    byPath,
    messages: () => messages,
    children: () =>
      messages.filter((m) => "parentToolId" in m && m.parentToolId),
  };
}

function start(
  t: CursorSdkTranslator,
  callId: string,
  args: Record<string, unknown> = {},
) {
  t.feed({
    type: "tool_call",
    call_id: callId,
    name: "task",
    status: "running",
    args: { description: "Audit", ...args },
  });
}

function finish(
  t: CursorSdkTranslator,
  callId: string,
  value: Record<string, unknown>,
) {
  t.feed({
    type: "tool_call",
    call_id: callId,
    name: "task",
    status: "completed",
    result: { status: "success", value },
  });
}

describe("Cursor child transcript ownership", () => {
  it.each([
    undefined,
    "Audit the project",
    "Audit the project, focusing on tests",
  ])("defers discovery for an unidentified task with prompt %j", async (prompt) => {
    const c = capture();
    start(c.translator, "task", { prompt });
    await c.translator.pollSubagents();
    await c.translator.pollSubagents();
    expect(c.children()).toEqual([]);
    expect(c.discover).not.toHaveBeenCalled();
    expect(c.byId).not.toHaveBeenCalled();
  });

  it.each(["agentId", "transcriptPath"])(
    "emits only the authoritative child's tools, narration and thinking when %s arrives late",
    async (key) => {
      const c = capture();
      start(c.translator, "task");
      await c.translator.pollSubagents();
      finish(c.translator, "task", {
        [key]: key === "agentId" ? "right" : "/parent/subagents/right.jsonl",
      });
      await c.translator.pollSubagents();
      const ids = c.messages().map((m) => m.id);
      await c.translator.flushSubagents();
      expect(c.messages().map((m) => m.id)).toEqual(ids);
      expect(c.children()).toHaveLength(3);
      expect(JSON.stringify(c.messages())).not.toContain("wrong");
      expect(c.children().find((m) => m.kind === "tool")).toMatchObject({
        rawInput: { path: "right.ts" },
        status: "pending",
      });
    },
  );

  it("keeps concurrent children separate even when their prompts and native row IDs match", async () => {
    const c = capture();
    start(c.translator, "first", { prompt: "Audit", agentId: "one" });
    start(c.translator, "second", { prompt: "Audit", agentId: "two" });
    start(c.translator, "unknown", { prompt: "Audit" });
    await c.translator.pollSubagents();
    await c.translator.pollSubagents();
    expect(c.children()).toHaveLength(6);
    const tools = c.children().filter((m) => m.kind === "tool");
    expect(tools.map((m) => m.rawInput)).toEqual([
      { path: "one.ts" },
      { path: "two.ts" },
    ]);
    expect(new Set(tools.map((m) => m.parentToolId)).size).toBe(2);
  });

  it("begins checkpoint delivery when a later native start supplies the child ID", async () => {
    const c = capture();
    start(c.translator, "task");
    await c.translator.pollSubagents();
    start(c.translator, "task", { agentId: "right" });
    await c.translator.pollSubagents();
    expect(c.children()).toHaveLength(3);
    expect(JSON.stringify(c.messages())).not.toContain("wrong");
  });

  it("does not mistake a partially streamed child ID for the completed identity", async () => {
    const c = capture();
    c.translator.feedDelta({
      type: "partial-tool-call",
      callId: "task",
      toolCall: {
        type: "task",
        args: { description: "Audit", agentId: "wrong" },
      },
    });
    await c.translator.pollSubagents();
    expect(c.children()).toEqual([]);
    c.translator.feedDelta({
      type: "tool-call-started",
      callId: "task",
      toolCall: {
        type: "task",
        args: { description: "Audit", agentId: "right" },
      },
    });
    await c.translator.pollSubagents();
    expect(c.children()).toHaveLength(3);
    expect(JSON.stringify(c.children())).not.toContain("wrong");
  });

  it("does not borrow a guessed transcript when the authoritative file is missing", async () => {
    const c = capture();
    start(c.translator, "task");
    await c.translator.pollSubagents();
    c.byPath.mockReturnValueOnce(null);
    finish(c.translator, "task", {
      transcriptPath: "/parent/subagents/right.jsonl",
      finalMessage: "Report",
    });
    await c.translator.flushSubagents();
    expect(c.children()).toEqual([]);
    expect(c.byId).not.toHaveBeenCalled();
  });

  it("does not attach any child on Stop/EOF without ownership or revive it from late completion", async () => {
    const c = capture();
    start(c.translator, "task");
    await c.translator.pollSubagents();
    await c.translator.flushSubagents();
    finish(c.translator, "task", { agentId: "right" });
    await c.translator.pollSubagents();
    await c.translator.flushSubagents();
    expect(c.children()).toEqual([]);
  });

  it("does not append fallback steps during a live poll before the authoritative file appears", async () => {
    const c = capture();
    c.byPath.mockReturnValueOnce(null);
    finish(c.translator, "task", {
      transcriptPath: "/parent/subagents/right.jsonl",
      conversationSteps: [
        { type: "assistantMessage", message: { text: "right narration" } },
      ],
    });
    await c.translator.pollSubagents();
    expect(c.children()).toEqual([]);
    await c.translator.pollSubagents();
    await c.translator.flushSubagents();
    expect(c.children()).toHaveLength(3);
  });

  it("does not bind an ID-less completion callback to another child's pending call by matching its prompt", async () => {
    const c = capture();
    const args = { description: "Audit", prompt: "Audit the project" };
    start(c.translator, "first", args);
    const first = c.messages()[0];
    c.translator.feedStep({
      type: "toolCall",
      message: {
        type: "task",
        args,
        result: { status: "success", value: { agentId: "second-child" } },
      },
    });
    await c.translator.pollSubagents();
    expect(c.children()).toEqual([]);
    start(c.translator, "second", args);
    finish(c.translator, "first", { agentId: "first-child" });
    finish(c.translator, "second", { agentId: "second-child" });
    await c.translator.pollSubagents();
    await c.translator.flushSubagents();
    const firstId = first.kind === "tool" ? first.toolCallId : "";
    expect(
      c
        .children()
        .filter((m) => m.kind === "tool" && m.parentToolId === firstId),
    ).toEqual([
      expect.objectContaining({ rawInput: { path: "first-child.ts" } }),
    ]);
    expect(c.children()).toHaveLength(6);
    expect(
      c.messages().filter((m) => m.kind === "tool" && !m.parentToolId),
    ).toHaveLength(2);
  });

  it("does not read the old child ID when the result supplies a different, unreadable exact path", async () => {
    const c = capture();
    start(c.translator, "task", { agentId: "wrong" });
    c.byPath.mockReturnValue(null);
    finish(c.translator, "task", {
      transcriptPath: "/parent/subagents/right.jsonl",
    });
    await c.translator.pollSubagents();
    await c.translator.flushSubagents();
    expect(c.children()).toEqual([]);
    expect(c.byId).not.toHaveBeenCalled();
  });

  it("retains captured rows without adding a second source when the final file disappears", async () => {
    const c = capture();
    start(c.translator, "task", { agentId: "right" });
    await c.translator.pollSubagents();
    const ids = c.messages().map((m) => m.id);
    finish(c.translator, "task", {
      agentId: "right",
      conversationSteps: [
        {
          type: "toolCall",
          message: { type: "read", args: { path: "right.ts" } },
        },
      ],
      finalMessage: "Report",
    });
    c.byId.mockReturnValue(null);
    await c.translator.flushSubagents();
    expect(c.messages().map((m) => m.id)).toEqual(ids);
    expect(c.children()).toHaveLength(3);
  });

  it.each(["callback-first", "native-first"])(
    "retains one group for repeated %s delivery",
    async (order) => {
      const c = capture();
      const result = { status: "success", value: { agentId: "right" } };
      const callback = () =>
        c.translator.feedStep({
          type: "toolCall",
          message: {
            type: "task",
            args: { description: "Audit" },
            result,
          },
        });
      start(c.translator, "task");
      if (order === "callback-first") {
        callback();
        callback();
      }
      finish(c.translator, "task", result.value);
      callback();
      callback();
      await c.translator.pollSubagents();
      const ids = c.messages().map((m) => m.id);
      await c.translator.flushSubagents();
      expect(c.messages().map((m) => m.id)).toEqual(ids);
      expect(c.children()).toHaveLength(3);
    },
  );

  it("keeps completion-only callback delivery when no native lifecycle events arrive, without replay duplicates", async () => {
    const c = capture();
    for (let i = 0; i < 2; i++) {
      c.translator.feedStep({
        type: "toolCall",
        message: {
          type: "task",
          args: { description: "Audit" },
          result: { status: "success", value: { agentId: "right" } },
        },
      });
    }
    await c.translator.pollSubagents();
    expect(c.children()).toEqual([]);
    await c.translator.flushSubagents();
    expect(
      c.messages().filter((m) => m.kind === "tool" && !m.parentToolId),
    ).toHaveLength(1);
    expect(c.children()).toHaveLength(3);
  });

  it("ignores late start identity after a terminal result, including a later metadata-only completion", async () => {
    const c = capture();
    finish(c.translator, "task", { agentId: "right" });
    await c.translator.pollSubagents();
    start(c.translator, "task", { agentId: "wrong" });
    finish(c.translator, "task", { resultSuffix: "Report" });
    c.translator.feedStep({
      type: "toolCall",
      message: {
        type: "task",
        result: { status: "success", value: { agentId: "right" } },
      },
    });
    await c.translator.pollSubagents();
    await c.translator.flushSubagents();
    expect(c.children()).toHaveLength(3);
    expect(JSON.stringify(c.children())).not.toContain("wrong");
  });

  it("reconciles an encoded child filename with the same native child ID", async () => {
    const c = capture();
    c.byPath.mockReturnValue(transcript("right/child"));
    start(c.translator, "task", { agentId: "right/child" });
    await c.translator.pollSubagents();
    const ids = c.messages().map((m) => m.id);
    finish(c.translator, "task", {
      agentId: "right/child",
      transcriptPath: "/parent/subagents/right_2Fchild.jsonl",
    });
    await c.translator.flushSubagents();
    expect(c.messages().map((m) => m.id)).toEqual(ids);
  });
});
