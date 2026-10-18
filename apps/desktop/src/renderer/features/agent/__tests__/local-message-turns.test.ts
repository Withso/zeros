import { describe, expect, it } from "vitest";
import { Terminal } from "lucide-react";
import type { AgentTextMessage } from "@zeros/protocol/agent-messages";
import { groupMessagesIntoTurns, isProviderTurnTail } from "../turn-grouping";
import { countEventSummary, summaryIcons } from "../renderers/tool-summary";
import { partitionTurn } from "../turn-partition";

const prompt = (id: string, text = "A human message"): AgentTextMessage => ({
  id,
  kind: "text",
  role: "user",
  text,
  createdAt: 10,
});
const note = (steeredTurnId?: string): AgentTextMessage => ({
  ...prompt("note", "Chat finished"),
  createdAt: 30,
  steeredTurnId,
  localNote: {
    chatId: "child",
    title: "Research",
    agentId: "codex",
    link: "zeros-dev://chat/child",
    event: "done",
    status: "completed",
  },
});

describe("Local orchestration transcript activity", () => {
  it("keeps a steered note in the running turn without a second user header or clock", () => {
    const human = prompt("human");
    const activity = note(human.id);
    const turns = groupMessagesIntoTurns([human, activity]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      userPrompt: human,
      recordedTurnId: human.id,
      recordedStartedAt: 10,
      events: [activity],
    });
    expect(isProviderTurnTail(turns, 0)).toBe(true);
  });

  it("gives an idle note its own provider turn and events, with no user prompt bubble", () => {
    const activity = note();
    const reply = {
      ...prompt("reply", "Done"),
      role: "agent" as const,
      createdAt: 40,
    };
    const turns = groupMessagesIntoTurns([prompt("human"), activity, reply]);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      userPrompt: null,
      recordedTurnId: "note",
      recordedStartedAt: 30,
      events: [activity, reply],
    });
    expect(turns[1].providerEvents).toEqual([activity, reply]);
  });

  it("counts notes as shell activity, while human question answers remain messages", () => {
    const answer = prompt("answer", "Answering your question(s): Yes");
    expect(countEventSummary([note(), answer])).toEqual({
      toolCalls: 1,
      messages: 1,
      agents: 0,
    });
    expect(summaryIcons([note()])).toEqual([Terminal]);
    expect(groupMessagesIntoTurns([answer])[0].userPrompt).toBe(answer);
  });

  it("keeps agent-sent bodies as prompts and never infers provenance from text", () => {
    const sent = {
      ...prompt("sent", "The result"),
      localFrom: {
        chatId: "child",
        title: "Research",
        agentId: "claude",
        link: "zeros-dev://chat/child",
      },
    };
    const legacy = prompt(
      "legacy",
      '[Zeros] Chat "Example" finished its turn: cancelled.',
    );
    const turns = groupMessagesIntoTurns([sent, legacy]);
    expect(turns.map((turn) => turn.userPrompt)).toEqual([sent, legacy]);
  });

  it("does not demote a settled legacy answer when a note arrives after it", () => {
    const answer = { ...prompt("reply", "The answer"), role: "agent" as const };
    const activity = note("human");
    const partition = partitionTurn([answer, activity]);
    expect(partition.finalOutput).toEqual([answer]);
    expect(partition.working).toEqual([activity]);
  });
});
