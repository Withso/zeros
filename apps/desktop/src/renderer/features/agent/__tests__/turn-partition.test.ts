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
const phasedAgentText = (
  id: string,
  phase: "commentary" | "final_answer",
): AgentMessage =>
  ({ kind: "text", role: "agent", id, phase }) as unknown as AgentMessage;
const systemText = (id: string): AgentMessage =>
  ({ kind: "text", role: "system", id }) as unknown as AgentMessage;
const thought = (id: string): AgentMessage =>
  ({ kind: "text", role: "thought", id }) as unknown as AgentMessage;
const backgroundTask = (
  id: string,
  status: "in_progress" | "completed" | "failed" = "completed",
): AgentMessage =>
  ({
    kind: "tool",
    id,
    toolKind: "background_task",
    status,
  }) as unknown as AgentMessage;
const liveTool = (
  id: string,
  status: "pending" | "in_progress" | "completed" | "failed",
  settledAt: number,
  updatedAt = settledAt,
): AgentMessage =>
  ({
    kind: "tool",
    id,
    toolCallId: id,
    toolKind: "read",
    status,
    createdAt: 1,
    updatedAt,
    ...(status === "completed" || status === "failed" ? { settledAt } : {}),
  }) as unknown as AgentMessage;

const ids = (xs: AgentMessage[]) => xs.map((m) => (m as { id: string }).id);

describe("partitionTurn", () => {
  it("pulls the trailing agent text out as the final answer", () => {
    const { working, finalOutput } = partitionTurn([tool("a"), agentText("b")]);
    expect(ids(working)).toEqual(["a"]);
    expect(ids(finalOutput)).toEqual(["b"]);
  });

  it("keeps Codex commentary in working history and shows only its final answer", () => {
    const { working, finalOutput } = partitionTurn([
      phasedAgentText("interim", "commentary"),
      phasedAgentText("answer", "final_answer"),
    ]);
    expect(ids(working)).toEqual(["interim"]);
    expect(ids(finalOutput)).toEqual(["answer"]);
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

  it("keeps a late settled background task in the working group without hiding the answer", () => {
    const { working, finalOutput } = partitionTurn([
      tool("t1"),
      agentText("answer"),
      backgroundTask("background-settled"),
    ]);
    expect(ids(working)).toEqual(["t1", "background-settled"]);
    expect(ids(finalOutput)).toEqual(["answer"]);
  });

  it("keeps a settled background task grouped when it is the only event", () => {
    const { working, finalOutput } = partitionTurn([
      backgroundTask("background-settled"),
    ]);
    expect(ids(working)).toEqual(["background-settled"]);
    expect(finalOutput).toEqual([]);
  });

  it("extracts the complete answer across multiple late background settlements", () => {
    const budgetStop = {
      kind: "tool",
      id: "budget-stop",
      toolKind: "budget_stop",
    } as unknown as AgentMessage;
    const { working, finalOutput } = partitionTurn([
      tool("t1"),
      agentText("answer-a"),
      backgroundTask("background-a"),
      systemText("answer-b"),
      backgroundTask("background-b", "failed"),
      budgetStop,
    ]);
    expect(ids(working)).toEqual(["t1", "background-a", "background-b"]);
    expect(ids(finalOutput)).toEqual(["answer-a", "answer-b", "budget-stop"]);
  });

  it("does not promote a still-running background task into final output", () => {
    const { working, finalOutput } = partitionTurn([
      agentText("provisional"),
      backgroundTask("background-running", "in_progress"),
    ]);
    expect(ids(working)).toEqual(["provisional", "background-running"]);
    expect(finalOutput).toEqual([]);
  });

  it("handles an empty turn", () => {
    expect(partitionTurn([])).toEqual({ working: [], finalOutput: [] });
  });

  describe("live turns defer the answer boundary", () => {
    it("withholds provisional prose and unfinished tools", () => {
      const events = [
        agentText("provisional"),
        liveTool("pending", "pending", 10),
        liveTool("running", "in_progress", 20),
      ];
      const { working, finalOutput } = partitionTurn(events, { live: true });
      expect(working).toEqual([]);
      expect(finalOutput).toEqual([]);
    });

    it("reveals completed and failed tools in completion order", () => {
      // Concurrent calls are stored in start order. If the second one finishes
      // first, the first completed row must stay put when the earlier call
      // later settles; otherwise the live list visibly jumps.
      const events = [
        liveTool("finished-second", "completed", 30, 40),
        liveTool("finished-first", "failed", 20, 100),
        agentText("still-provisional"),
      ];
      const { working, finalOutput } = partitionTurn(events, { live: true });
      expect(ids(working)).toEqual(["finished-first", "finished-second"]);
      expect(finalOutput).toEqual([]);
    });

    it("matches the settled split once live is false", () => {
      const events = [tool("a"), agentText("b")];
      expect(partitionTurn(events, { live: false })).toEqual(
        partitionTurn(events),
      );
    });

    it("a live turn of only text stays unmounted until it is final", () => {
      const { working, finalOutput } = partitionTurn([agentText("only")], {
        live: true,
      });
      expect(working).toEqual([]);
      expect(finalOutput).toEqual([]);
    });
  });

  describe("compaction rows", () => {
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
