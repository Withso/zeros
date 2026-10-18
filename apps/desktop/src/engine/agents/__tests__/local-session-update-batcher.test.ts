import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification, SessionUpdate } from "@zeros/protocol/agent-events";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { LocalSessionUpdateBatcher } from "../local-session-update-batcher";

const text = (body: string, messageId = "reply"): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: body },
});
const output = (body: string, toolCallId = "tool"): SessionUpdate => ({
  sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", rawOutput: body,
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
afterEach(() => { vi.useRealTimers(); });

function fixture() {
  const emit = vi.fn<(agentId: string, notification: SessionNotification) => void>();
  const batcher = new LocalSessionUpdateBatcher(emit);
  const push = (update: SessionUpdate, sessionId = "execution", local = true) => batcher.push("codex", { sessionId, update }, local);
  return { emit, batcher, push, updates: () => emit.mock.calls.map(([, notification]) => notification.update) };
}

describe("Local session update batching", () => {
  it("shows first prose immediately and joins following deltas within 50 ms", () => {
    const f = fixture();
    f.push(text("First "));
    expect(f.updates()).toEqual([text("First ")]);
    for (let index = 0; index < 20; index += 1) f.push(text(`${index} `));
    expect(f.emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(49);
    expect(f.emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(f.updates()).toEqual([text("First "), text(Array.from({ length: 20 }, (_, index) => `${index} `).join(""))]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains only the newest simple output snapshot and flushes before completion or error", () => {
    const f = fixture();
    f.push({ sessionUpdate: "tool_call", toolCallId: "tool", title: "Command", status: "in_progress" });
    for (let index = 0; index < 25; index += 1) f.push(output(`output ${index}`));
    expect(f.emit).toHaveBeenCalledTimes(2);
    f.push({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "failed", rawOutput: "Command failed" });
    expect(f.emit).toHaveBeenCalledTimes(4);
    expect(f.updates().at(-1)).toMatchObject({ status: "failed", rawOutput: "Command failed" });
    expect(f.updates().at(-2)).toMatchObject({ rawOutput: "output 24" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes exact-message text before corrections, phase changes, retractions and Stop", () => {
    const f = fixture();
    f.push(text("draft "));
    f.push(text("tail"));
    f.push({ ...text("corrected"), textMode: "replace" } as SessionUpdate);
    expect(f.updates()).toEqual([text("draft "), text("tail"), { ...text("corrected"), textMode: "replace" }]);
    f.push(text(" more"));
    f.push({ ...text("", "reply"), phase: "partial_answer" } as SessionUpdate);
    f.push({ sessionUpdate: "message_retraction", messageIds: ["reply"] });
    f.push(text("next", "next-reply"));
    f.push(text(" tail", "next-reply"));
    f.push({ sessionUpdate: "turn_state", turnId: "turn", state: "cancelled", startedAt: 1_000 });
    expect(f.updates().at(-2)).toEqual(text(" tail", "next-reply"));
    expect(f.updates().at(-1)).toMatchObject({ sessionUpdate: "turn_state", state: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps concurrent chats and parent identities independent", () => {
    const f = fixture();
    f.push(text("A"), "a"); f.push(text("B"), "b");
    f.push(text(" tail A"), "a"); f.push(text(" tail B"), "b");
    expect(f.emit).toHaveBeenCalledTimes(2);
    f.batcher.flush("a");
    expect(f.emit.mock.calls.at(-1)?.[1]).toEqual({ sessionId: "a", update: text(" tail A") });
    expect(vi.getTimerCount()).toBe(1);
    f.push({ ...text("child"), parentToolId: "parent" } as SessionUpdate, "b");
    expect(f.emit.mock.calls.at(-2)?.[1]).toEqual({ sessionId: "b", update: text(" tail B") });
    expect(f.updates().at(-1)).toMatchObject({ parentToolId: "parent" });
    f.batcher.flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps cloud notifications byte-identical and immediate", () => {
    const f = fixture();
    const expected = Array.from({ length: 200 }, (_, index) => text(`${index} `));
    for (const update of expected) f.push(update, "cloud-execution", false);
    expect(f.updates()).toEqual(expected);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never merges structured output, artifact links or question stamps", () => {
    const f = fixture();
    const updates: SessionUpdate[] = [
      { sessionUpdate: "tool_call", toolCallId: "tool", title: "Question" },
      { sessionUpdate: "tool_call_update", toolCallId: "tool", rawOutput: { zerosQuestion: { outcome: "answered" } } },
      { sessionUpdate: "tool_call_update", toolCallId: "tool", rawOutput: { result: "answer" } },
      { sessionUpdate: "tool_call_update", toolCallId: "tool", resourceLinks: [{ type: "resource_link", uri: "report.csv", name: "Report" }] },
    ];
    for (const update of updates) f.push(update);
    expect(f.updates()).toEqual(updates);
    const reduce = (items: SessionUpdate[]) => items.reduce((rows, update) => applyUpdate(rows, { sessionId: "execution", update }), [] as AgentMessage[]);
    expect(reduce(f.updates())).toEqual(reduce(updates));
  });

  it("bounds retained text and drains pending work when executions retire", () => {
    const f = fixture();
    f.push(text("first"));
    f.push(text("x".repeat(40_000)));
    expect(f.emit).toHaveBeenCalledTimes(1);
    f.push(text("y".repeat(40_000)));
    expect(f.emit.mock.calls.slice(1).map(([, item]) => (item.update as ReturnType<typeof text> & { content: { text: string } }).content.text).join("")).toHaveLength(80_000);
    f.push(text("last"));
    f.batcher.flush();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(f.updates().at(-1)).toEqual(text("last"));
  });

  it("bounds retained executions and drains evicted updates without losing text", () => {
    const f = fixture();
    for (let index = 0; index < 129; index += 1) {
      f.push(text("first"), `execution-${index}`);
      f.push(text("last"), `execution-${index}`);
    }
    expect(vi.getTimerCount()).toBe(128);
    expect(f.emit).toHaveBeenCalledTimes(130);
    f.batcher.flush();
    expect(f.emit).toHaveBeenCalledTimes(258);
    expect(vi.getTimerCount()).toBe(0);
  });
});
