import { describe, expect, it } from "vitest";
import { ClaudeStreamTranslator } from "../translator";
import type { SessionNotification } from "../../../types";

function collect() {
  const updates: SessionNotification["update"][] = [];
  const translator = new ClaudeStreamTranslator({
    sessionId: "detached-tools",
    emit: ({ update }) => updates.push(update),
  });
  translator.beginTurn();
  return {
    translator,
    calls: () => updates.filter((update) => update.sessionUpdate === "tool_call"),
    results: () => updates.filter((update) => update.sessionUpdate === "tool_call_update"),
  };
}

function start(name: string, parent?: string) {
  return {
    type: "assistant",
    uuid: `start-${parent ?? "root"}`,
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id: "web-call", name, input: { query: "release notes" } }] },
  };
}

function result(options: { parent?: string; detached?: unknown; error?: boolean } = {}) {
  return {
    type: "user",
    uuid: `${options.detached === true ? "detached" : "result"}-${options.parent ?? "root"}`,
    parent_tool_use_id: options.parent,
    ...(options.detached !== undefined ? { tool_use_result: { detachedToolCall: options.detached } } : {}),
    message: { content: [{
      type: "tool_result",
      tool_use_id: "web-call",
      is_error: options.error ?? false,
      content: options.error ? "Search failed" : options.detached === true ? "Call continues in the background" : "Verified release notes",
    }] },
  };
}

describe("Claude detached web tool results", () => {
  it.each(["WebFetch", "WebSearch"])("keeps %s and its process alive until the real result in a later turn", (name) => {
    const { translator, calls, results } = collect();
    translator.feed(start(name));
    const toolCallId = calls()[0].toolCallId;
    translator.feed(result({ detached: true }));
    expect(results()).toEqual([]);
    expect(translator.hasProcessWork).toBe(true);

    translator.feed({ type: "result", subtype: "success", result: "Steering accepted", num_turns: 1 });
    expect(translator.hasProcessWork).toBe(true);
    translator.beginTurn();
    translator.feed(result());
    expect(results()).toEqual([expect.objectContaining({
      toolCallId,
      status: "completed",
      rawOutput: "Verified release notes",
      content: [{ type: "content", content: { type: "text", text: "Verified release notes" } }],
    })]);
    expect(translator.hasProcessWork).toBe(false);

    translator.feed(result({ detached: true }));
    translator.feed(result());
    expect(results()).toHaveLength(1);
    expect(calls()).toHaveLength(1);
    expect(translator.hasProcessWork).toBe(false);
  });

  it("isolates parent ownership and lets a terminal error settle a detached call", () => {
    const { translator, calls, results } = collect();
    translator.feed(start("WebSearch", "parent-a"));
    translator.feed(start("WebSearch", "parent-b"));
    const [first, second] = calls();
    translator.feed(result({ parent: "parent-a", detached: true }));
    translator.feed(result({ parent: "parent-b" }));
    expect(results()).toEqual([expect.objectContaining({ toolCallId: second.toolCallId, status: "completed" })]);
    expect(translator.hasProcessWork).toBe(true);

    translator.feed(result({ parent: "parent-a", detached: true, error: true }));
    expect(results().at(-1)).toMatchObject({ toolCallId: first.toolCallId, status: "failed", rawOutput: "Search failed" });
    expect(translator.hasProcessWork).toBe(false);
    translator.feed(result({ parent: "parent-a", detached: true }));
    expect(results()).toHaveLength(2);
    expect(translator.hasProcessWork).toBe(false);
  });

  it("does not attribute a batched envelope's detached marker to either result", () => {
    const { translator, results } = collect();
    const invocation = start("WebSearch");
    invocation.message.content.push({ type: "tool_use", id: "second-call", name: "WebSearch", input: { query: "compatibility" } });
    translator.feed(invocation);
    const batch = result({ detached: true });
    batch.message.content.push({ type: "tool_result", tool_use_id: "second-call", is_error: false, content: "Second result" });
    translator.feed(batch);
    expect(results()).toHaveLength(2);
    expect(results().every((update) => update.status === "completed")).toBe(true);
    expect(translator.hasProcessWork).toBe(false);
  });

  it.each([false, "true", 1])("does not treat %s as the native detached marker", (detached) => {
    const { translator, results } = collect();
    translator.feed(start("WebSearch"));
    translator.feed(result({ detached }));
    expect(results().at(-1)).toMatchObject({ status: "completed", rawOutput: "Verified release notes" });
    expect(translator.hasProcessWork).toBe(false);
  });

  it("releases detached process work on Stop and ignores late acknowledgements", () => {
    const { translator, results } = collect();
    translator.feed(start("WebFetch"));
    translator.feed(result({ detached: true }));
    expect(translator.hasProcessWork).toBe(true);
    translator.endActivity();
    translator.feed(result({ detached: true }));
    expect(translator.hasProcessWork).toBe(false);
    expect(results()).toEqual([]);
  });

  it("releases detached work when the native invocation is retracted", () => {
    const { translator } = collect();
    translator.feed(start("WebFetch"));
    translator.feed(result({ detached: true }));
    expect(translator.hasProcessWork).toBe(true);
    translator.feed({ type: "assistant", uuid: "replacement", supersedes: ["start-root"], message: { content: [] } });
    expect(translator.hasProcessWork).toBe(false);
  });
});
