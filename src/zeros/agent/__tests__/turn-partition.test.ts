// Pure-function coverage for splitting a turn into its working group
// (reasoning + tools, dimmed/collapsible) vs. the final answer (bright).
// The boundary is the trailing run of agent/system TEXT — reasoning
// ("thought") is working content, never the answer.

import { describe, it, expect } from "vitest";
import { partitionTurn } from "../turn-partition";
import type { AgentMessage } from "../use-agent-session";

const tool = (id: string): AgentMessage =>
  ({ kind: "tool", id, toolKind: "read" }) as unknown as AgentMessage;
const agentText = (id: string): AgentMessage =>
  ({ kind: "text", role: "agent", id }) as unknown as AgentMessage;
const systemText = (id: string): AgentMessage =>
  ({ kind: "text", role: "system", id }) as unknown as AgentMessage;
const thought = (id: string): AgentMessage =>
  ({ kind: "text", role: "thought", id }) as unknown as AgentMessage;

const ids = (xs: AgentMessage[]) => xs.map((m) => (m as { id: string }).id);

describe("partitionTurn", () => {
  it("pulls the trailing agent text out as the final answer", () => {
    const { working, finalOutput } = partitionTurn([tool("a"), agentText("b")]);
    expect(ids(working)).toEqual(["a"]);
    expect(ids(finalOutput)).toEqual(["b"]);
  });

  it("keeps in-between narration in the working group", () => {
    const { working, finalOutput } = partitionTurn([
      agentText("intro"),
      tool("t1"),
      agentText("answer"),
    ]);
    expect(ids(working)).toEqual(["intro", "t1"]);
    expect(ids(finalOutput)).toEqual(["answer"]);
  });

  it("treats a turn of only text as a pure answer (no working group)", () => {
    const { working, finalOutput } = partitionTurn([agentText("only")]);
    expect(working).toEqual([]);
    expect(ids(finalOutput)).toEqual(["only"]);
  });

  it("groups a trailing run of consecutive answer texts together", () => {
    const { working, finalOutput } = partitionTurn([
      tool("t1"),
      agentText("a"),
      systemText("b"),
    ]);
    expect(ids(working)).toEqual(["t1"]);
    expect(ids(finalOutput)).toEqual(["a", "b"]);
  });

  it("yields no final answer when the turn ends on a tool", () => {
    const { working, finalOutput } = partitionTurn([tool("t1"), tool("t2")]);
    expect(ids(working)).toEqual(["t1", "t2"]);
    expect(finalOutput).toEqual([]);
  });

  it("never treats trailing thinking as the answer", () => {
    const { working, finalOutput } = partitionTurn([tool("t1"), thought("th")]);
    expect(ids(working)).toEqual(["t1", "th"]);
    expect(finalOutput).toEqual([]);
  });

  it("handles an empty turn", () => {
    expect(partitionTurn([])).toEqual({ working: [], finalOutput: [] });
  });

  describe("live turns defer the answer boundary", () => {
    it("keeps trailing text in the working group while live", () => {
      // The provisional tail must stay in the feed (uniform spacing) instead
      // of peeling out as a separated answer that snaps back the moment the
      // next tool lands. See turn-event-list.tsx + globals.css .zeros-working-feed.
      const events = [tool("a"), agentText("b")];
      const { working, finalOutput } = partitionTurn(events, { live: true });
      expect(ids(working)).toEqual(["a", "b"]);
      expect(finalOutput).toEqual([]);
    });

    it("matches the settled split once live is false", () => {
      const events = [tool("a"), agentText("b")];
      expect(partitionTurn(events, { live: false })).toEqual(
        partitionTurn(events),
      );
    });

    it("a live turn of only text stays working (no premature answer)", () => {
      const { working, finalOutput } = partitionTurn([agentText("only")], {
        live: true,
      });
      expect(ids(working)).toEqual(["only"]);
      expect(finalOutput).toEqual([]);
    });
  });

  describe("compaction rows (2026-07-12 user spec)", () => {
    const compaction = (id: string, trigger?: string): AgentMessage =>
      ({
        kind: "tool",
        id,
        toolKind: "compaction",
        ...(trigger ? { rawInput: { trigger } } : {}),
      }) as unknown as AgentMessage;

    it("a MANUAL compaction row renders standalone (final output), not in the chip", () => {
      const { working, finalOutput } = partitionTurn([
        tool("t1"),
        agentText("answer"),
        compaction("c1", "manual"),
      ]);
      expect(ids(working)).toEqual(["t1"]);
      expect(ids(finalOutput)).toEqual(["answer", "c1"]);
    });

    it("a manual compaction alone (Compact now on an idle chat) is standalone", () => {
      const { working, finalOutput } = partitionTurn([
        agentText("hello reply"),
        compaction("c1", "manual"),
      ]);
      expect(working).toEqual([]);
      expect(ids(finalOutput)).toEqual(["hello reply", "c1"]);
    });

    it("an AUTO compaction stays in the working group like any tool call", () => {
      const { working, finalOutput } = partitionTurn([
        tool("t1"),
        compaction("c1", "auto"),
        agentText("answer"),
      ]);
      expect(ids(working)).toEqual(["t1", "c1"]);
      expect(ids(finalOutput)).toEqual(["answer"]);
    });

    it("a trigger-less compaction (older persisted rows) stays grouped", () => {
      const { working, finalOutput } = partitionTurn([
        tool("t1"),
        compaction("c1"),
      ]);
      expect(ids(working)).toEqual(["t1", "c1"]);
      expect(finalOutput).toEqual([]);
    });
  });
});
