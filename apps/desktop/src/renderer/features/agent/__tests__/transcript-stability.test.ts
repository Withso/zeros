import { describe, expect, it } from "vitest";
import { shareMap, shareMessageBuckets, shareSet } from "../transcript-stability";
import type { AgentMessage } from "../use-agent-session";

const message = (id: string): AgentMessage =>
  ({ id, kind: "text", role: "agent", text: id, createdAt: 1 }) as AgentMessage;

describe("transcript structural sharing", () => {
  it("keeps an equal set and replaces a changed one", () => {
    const previous = new Set(["question-1", "tool-2"]);
    expect(shareSet(previous, new Set(["tool-2", "question-1"]))).toBe(previous);
    const grown = new Set(["question-1", "tool-2", "tool-3"]);
    expect(shareSet(previous, grown)).toBe(grown);
    const swapped = new Set(["question-1", "tool-9"]);
    expect(shareSet(previous, swapped)).toBe(swapped);
    const empty = new Set<string>();
    expect(shareSet(new Set<string>(), empty)).not.toBe(empty);
    expect(shareSet(undefined, empty)).toBe(empty);
  });

  it("keeps a map with identical values and replaces one whose value changed", () => {
    const previous = new Map([["edit-1", "old file"], ["edit-2", "other file"]]);
    expect(shareMap(previous, new Map([["edit-2", "other file"], ["edit-1", "old file"]]))).toBe(previous);
    const changed = new Map([["edit-1", "new file"], ["edit-2", "other file"]]);
    expect(shareMap(previous, changed)).toBe(changed);
    const removed = new Map([["edit-1", "old file"]]);
    expect(shareMap(previous, removed)).toBe(removed);
  });

  it("reuses unchanged buckets and the whole map while another message streams", () => {
    const parent = [message("child-1"), message("child-2")];
    const other = [message("child-3")];
    const previous = new Map([["agent-a", parent], ["agent-b", other]]);
    // A streamed chunk elsewhere rebuilds the buckets with the same messages.
    const rebuilt = new Map([["agent-a", [...parent]], ["agent-b", [...other]]]);
    expect(shareMessageBuckets(previous, rebuilt)).toBe(previous);

    // A child of agent-b streams: only its bucket is new.
    const streamed = { ...other[0] } as AgentMessage;
    const next = shareMessageBuckets(previous, new Map([["agent-a", [...parent]], ["agent-b", [streamed]]]));
    expect(next).not.toBe(previous);
    expect(next.get("agent-a")).toBe(parent);
    expect(next.get("agent-b")).toEqual([streamed]);
    expect(next.get("agent-b")).not.toBe(other);

    // A removed owner is a change even when the remaining buckets are equal.
    const removed = shareMessageBuckets(previous, new Map([["agent-a", [...parent]]]));
    expect(removed).not.toBe(previous);
    expect(removed.get("agent-a")).toBe(parent);
    expect(removed.has("agent-b")).toBe(false);
  });
});
