import { describe, expect, it } from "vitest";
import type { SessionNotification } from "../../../types";
import { CodexAppServerTranslator } from "../app-server-translator";

function fixture() {
  const events: SessionNotification[] = [];
  const translator = new CodexAppServerTranslator({ sessionId: "review-session", emit: event => events.push(event) });
  const item = (type: string, id: string, fields: Record<string, unknown> = {}, method = "item/completed") =>
    translator.handle(method, { threadId: "thread-review", turnId: "turn-review", item: { type, id, ...fields } });
  const finish = (status = "completed", fields: Record<string, unknown> = {}) =>
    translator.handle("turn/completed", { threadId: "thread-review", turn: { id: "turn-review", status, ...fields } });
  const messages = () => events.flatMap(({ update }) =>
    update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update] : []);
  return { translator, item, finish, messages, events };
}

describe("Codex native review output", () => {
  it("renders the completed review without requiring an agentMessage companion", () => {
    const test = fixture();
    // Native review mode markers may share the turn ID. Their lifecycles
    // must not cause the exit result to be mistaken for a replayed entry.
    test.item("enteredReviewMode", "turn-review", { review: "current changes" }, "item/started");
    test.item("enteredReviewMode", "turn-review", { review: "current changes" });
    test.item("exitedReviewMode", "turn-review", { review: "No blocking findings." }, "item/started");
    expect(test.messages()).toEqual([]);
    test.item("exitedReviewMode", "turn-review", { review: "No blocking findings." });
    test.finish();
    expect(test.messages()).toHaveLength(1);
    expect(test.messages()[0]).toMatchObject({ phase: "final_answer", content: { type: "text", text: "No blocking findings." } });
    const originalId = test.messages()[0].messageId;
    test.item("exitedReviewMode", "turn-review", { review: "No blocking findings." });
    test.finish();
    expect(test.messages()).toHaveLength(1);
    expect(test.messages()[0].messageId).toBe(originalId);
    expect(test.events.some(({ update }) => update.sessionUpdate === "tool_call")).toBe(false);
  });

  it.each(["commentary", undefined])("keeps earlier %s output separate from the completed review", phase => {
    const test = fixture();
    test.item("agentMessage", "progress", { text: "Inspecting the change.", phase });
    test.item("exitedReviewMode", "review-exit", { review: "Found a missing bounds check." });
    test.finish();
    expect(test.messages().map(message => message.content)).toEqual([
      { type: "text", text: "Inspecting the change." },
      { type: "text", text: "Found a missing bounds check." },
    ]);
  });

  it.each(["before", "after", "legacy-after"])("does not duplicate a native final message delivered %s the exit", order => {
    const test = fixture();
    const final = () => test.item("agentMessage", "review-final", { text: "The final native review.",
      ...(order === "legacy-after" ? {} : { phase: "final_answer" }) });
    if (order === "before") final();
    test.item("exitedReviewMode", "review-exit", { review: "The review payload." });
    if (order !== "before") final();
    test.finish();
    // Selection follows native final-message semantics, never text equality.
    expect(test.messages().map(message => message.content)).toEqual([{ type: "text", text: "The final native review." }]);
  });

  it("recovers the review from a complete terminal snapshot", () => {
    const test = fixture();
    test.finish("completed", { itemsView: "full", items: [
      { type: "enteredReviewMode", id: "turn-review", review: "current changes" },
      { type: "exitedReviewMode", id: "turn-review", review: "Recovered review result." },
    ] });
    expect(test.messages().map(message => message.content)).toEqual([{ type: "text", text: "Recovered review result." }]);
  });

  it.each(["failed", "interrupted"])("does not turn a %s review into a final answer", status => {
    const test = fixture();
    test.item("exitedReviewMode", "review-exit", { review: "Unconfirmed result." });
    test.finish(status);
    expect(test.messages()).toEqual([]);
    test.translator.startTurn();
    test.finish();
    expect(test.messages()).toEqual([]);
  });

  it("requires completed result evidence and resets between turns", () => {
    const test = fixture();
    test.item("exitedReviewMode", "review-exit", { review: "Started only." }, "item/started");
    test.finish();
    expect(test.messages()).toEqual([]);
    test.translator.startTurn();
    test.item("exitedReviewMode", "review-exit", { review: "First result." });
    test.finish();
    test.translator.startTurn();
    test.item("exitedReviewMode", "review-exit", { review: "Second result." });
    test.finish();
    expect(test.messages().map(message => message.content)).toEqual([
      { type: "text", text: "First result." }, { type: "text", text: "Second result." },
    ]);
    expect(test.messages()[0].messageId).not.toBe(test.messages()[1].messageId);
  });
});
