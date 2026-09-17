import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { ClaudeStreamTranslator } from "../translator";
import type { SessionNotification } from "../../../types";

function capture() {
  let messages: AgentMessage[] = [];
  const updates: SessionNotification[] = [];
  const t = new ClaudeStreamTranslator({
    sessionId: "session",
    streamPartials: true,
    emit: (n) => {
      updates.push(n);
      messages = applyUpdate(messages, n);
    },
  });
  return {
    t,
    updates,
    messages: () => messages,
    texts: () =>
      messages
        .filter((m) => m.kind === "text" && m.text)
        .map((m) => m.kind === "text" && m.text),
    tools: () => messages.filter((m) => m.kind === "tool"),
  };
}
const assistant = (uuid: string, text: string, extra = {}) => ({
  type: "assistant",
  uuid,
  message: { id: uuid, content: [{ type: "text", text }] },
  ...extra,
});
const fallback = (uuid: string, scope = "session", extra = {}) => ({
  type: "system",
  subtype: "model_refusal_fallback",
  uuid,
  scope,
  original_model: "claude-opus-5",
  fallback_model: "claude-sonnet-5",
  ...extra,
});
const result = (uuid: string, error = true, parent: string | null = null) => ({
  type: "user",
  uuid,
  parent_tool_use_id: parent,
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "read",
        is_error: error,
        content: error ? "Withdrawn failure" : "Actual source",
      },
    ],
  },
});
const tool = (uuid = "tool", parent: string | null = null) => ({
  type: "assistant",
  uuid,
  parent_tool_use_id: parent,
  message: {
    id: uuid,
    content: [
      {
        type: "tool_use",
        id: "read",
        name: "Read",
        input: { file_path: "a.ts" },
      },
    ],
  },
});

describe("Claude SDK refusal replacement", () => {
  it("withdraws descendants of a replaced Agent and suppresses late child output", () => {
    const c = capture();
    const owner = tool("owner");
    c.t.feed({
      ...owner,
      message: {
        ...owner.message,
        content: [
          {
            type: "tool_use",
            id: "read",
            name: "Agent",
            input: { description: "Old task" },
          },
        ],
      },
    });
    c.t.feed(
      assistant("child", "Withdrawn child", { parent_tool_use_id: "read" }),
    );
    c.t.feed(tool("sibling", "sibling-parent"));
    c.t.feed(assistant("replacement", "New answer", { supersedes: ["owner"] }));
    c.t.feed(
      assistant("late-child", "Late withdrawn child", {
        parent_tool_use_id: "read",
      }),
    );
    expect(c.texts()).toEqual(["New answer"]);
    expect(c.tools()).toHaveLength(1);
  });
  it("ignores malformed audit fields while retaining valid fallback narration", () => {
    const c = capture();
    expect(() =>
      c.t.feed(
        fallback("notice", "local", { retracted_message_uuids: "invalid" }),
      ),
    ).not.toThrow();
    expect(c.texts()).toHaveLength(1);
  });
  it("keeps result ownership when completed arguments arrive after a result", () => {
    const c = capture();
    c.t.feed({
      type: "stream_event",
      event: { type: "message_start", message: { id: "api" } },
    });
    c.t.feed({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "read",
          name: "Read",
          input: {},
        },
      },
    });
    c.t.feed(result("bad"));
    const full = tool();
    c.t.feed({ ...full, message: { ...full.message, id: "api" } });
    c.t.feed(assistant("new", "Replacement", { supersedes: ["bad"] }));
    expect(c.tools()[0]).toMatchObject({
      status: "pending",
      rawOutput: undefined,
    });
  });
  it("does not let a withdrawn synthetic authentication failure classify a later result", () => {
    const c = capture();
    c.t.feed(
      assistant("bad", "Authentication failure", {
        error: "authentication_failed",
      }),
    );
    c.t.feed(
      fallback("notice", "session", { retracted_message_uuids: ["bad"] }),
    );
    c.t.feed({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Unexpected transport failure"],
    });
    expect(c.t.terminalFailure?.code).not.toBe("authentication_failed");
  });
  it("retires the named assistant frame and ignores its late replay", () => {
    const c = capture();
    const old = assistant("old", "Refused");
    c.t.feed(old);
    const replacement = assistant("new", "Replacement", {
      supersedes: ["old"],
    });
    c.t.feed(replacement);
    c.t.feed(old);
    c.t.feed(replacement);
    expect(c.texts()).toEqual(["Replacement"]);
  });
  it("applies an audit-only retraction once and leaves unknown UUIDs alone", () => {
    const c = capture();
    c.t.feed(assistant("old", "Refused"));
    const notice = fallback("notice", "local", {
      retracted_message_uuids: ["old", "unknown"],
    });
    c.t.feed(notice);
    const before = c.messages();
    c.t.feed(notice);
    expect(c.texts()).not.toContain("Refused");
    expect(c.messages()).toBe(before);
  });
  it("applies new replacement markers even on a repeated replacement frame", () => {
    const c = capture();
    c.t.feed(assistant("old", "Refused"));
    c.t.feed(assistant("new", "Replacement"));
    c.t.feed(assistant("new", "Replacement", { supersedes: ["old"] }));
    expect(c.texts()).toEqual(["Replacement"]);
  });
  it("preserves another SDK block sharing the same API message id", () => {
    const c = capture();
    const frame = (uuid: string, text: string) => ({
      type: "assistant",
      uuid,
      message: { id: "shared", content: [{ type: "text", text }] },
    });
    c.t.feed(frame("one", "Withdrawn"));
    c.t.feed(frame("two", "Keep"));
    c.t.feed(assistant("new", "Replacement", { supersedes: ["one"] }));
    expect(c.texts()).toEqual(["Keep", "Replacement"]);
  });
  it("retracts the result without erasing the actual tool call, and accepts its corrected result", () => {
    const c = capture();
    c.t.feed(tool());
    c.t.feed(result("bad"));
    const id = c.tools()[0].id;
    c.t.feed(assistant("new", "Retrying", { supersedes: ["bad"] }));
    expect(c.tools()).toEqual([
      expect.objectContaining({
        id,
        status: "pending",
        rawOutput: undefined,
        content: undefined,
      }),
    ]);
    c.t.feed({ type: "system", subtype: "task_notification", task_id: "late", tool_use_id: "read", status: "completed", resource_links: [{ uri: ".context/local/artifacts/withdrawn.html", name: "Withdrawn" }] });
    expect(c.tools()[0].content).toBeUndefined();
    c.t.feed(result("good", false));
    c.t.feed(result("bad"));
    expect(c.tools()).toEqual([
      expect.objectContaining({
        id,
        status: "completed",
        rawOutput: "Actual source",
      }),
    ]);
  });
  it("does not retract another parent's result with the same native tool id", () => {
    const c = capture();
    c.t.feed(tool("left", "left-parent"));
    c.t.feed(tool("right", "right-parent"));
    c.t.feed(result("left-result", true, "left-parent"));
    c.t.feed(result("right-result", true, "right-parent"));
    c.t.feed(
      assistant("replacement", "Retrying", {
        supersedes: ["left-result"],
        parent_tool_use_id: "left-parent",
      }),
    );
    expect(c.tools().map((m) => m.status)).toEqual(["pending", "failed"]);
  });
  it("does not erase a corrected result when the old audit receipt arrives later", () => {
    const c = capture();
    c.t.feed(tool());
    c.t.feed(result("bad"));
    c.t.feed(assistant("new", "Retrying", { supersedes: ["bad"] }));
    c.t.feed(result("good", false));
    c.t.feed(fallback("notice", "local", { retracted_message_uuids: ["bad"] }));
    expect(c.tools()[0]).toMatchObject({
      status: "completed",
      rawOutput: "Actual source",
    });
  });
  it("retires a withdrawn tool-use row rather than leaving an orphan running tool", () => {
    const c = capture();
    c.t.feed(tool());
    c.t.feed(assistant("new", "Replacement", { supersedes: ["tool"] }));
    c.t.feed(result("late"));
    c.t.feed(tool());
    expect(c.tools()).toHaveLength(0);
    expect(c.texts()).toEqual(["Replacement"]);
  });
});

describe("Claude fallback narration", () => {
  it("does not duplicate an inferred fallback when the same request's explicit notice arrives", () => {
    const c = capture();
    c.t.armFallbackDetection("claude-opus-5", true);
    c.t.feed({
      type: "assistant",
      uuid: "reply",
      request_id: "request",
      message: {
        id: "reply",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "Answer" }],
      },
    });
    c.t.feed(fallback("notice", "session", { request_id: "request" }));
    expect(
      c.messages().filter((m) => m.kind === "text" && m.modelFallback),
    ).toHaveLength(1);
    expect(c.texts()[0]).toMatch(/^Model switched to /);
  });
  it("dedupes legacy notices without UUIDs within one turn", () => {
    const c = capture();
    const notice = { ...fallback("unused"), uuid: undefined };
    c.t.feed(notice);
    c.t.feed(notice);
    expect(c.texts()).toHaveLength(1);
  });
  it("does not invent session scope for an unknown future SDK scope", () => {
    const c = capture();
    c.t.feed(fallback("future", "unknown-scope"));
    expect(c.messages().at(-1)).toMatchObject({
      modelFallback: { scope: "local" },
    });
  });
  it("emits plain commentary and keeps local and session notices independent", () => {
    const c = capture();
    c.t.feed(fallback("local", "local"));
    c.t.feed(fallback("session"));
    expect(c.tools()).toHaveLength(0);
    expect(c.texts()).toHaveLength(2);
    expect(c.texts()[0]).toMatch(/^Model fallback used /);
    expect(c.texts()[1]).toMatch(/^Model switched to /);
    expect(
      c.messages().every((m) => m.kind === "text" && m.phase === "commentary"),
    ).toBe(true);
  });
  it("keeps local narration under a known child and does not invent ownership", () => {
    const c = capture();
    c.t.feed(tool("parent"));
    c.t.feed(
      assistant("child", "Refused", {
        parent_tool_use_id: "read",
        request_id: "request",
      }),
    );
    c.t.feed(
      fallback("notice", "local", {
        request_id: "request",
        retracted_message_uuids: ["child"],
      }),
    );
    expect(c.messages().at(-1)).toMatchObject({
      kind: "text",
      parentToolId: c.tools()[0].toolCallId,
    });
  });
});
