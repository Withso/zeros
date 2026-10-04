import { describe, expect, it } from "vitest";

import type { AgentMessage, AgentTextMessage } from "../use-agent-session";
import type { Turn } from "../turn-container";
import { stabilizeTurns } from "../stable-turns";
import { groupMessagesIntoTurns, turnKey } from "../turn-grouping";

function text(id: string, value: string): AgentTextMessage {
  return {
    id,
    kind: "text",
    role: "agent",
    text: value,
    createdAt: 1,
  } as AgentTextMessage;
}

function turn(
  userPrompt: AgentTextMessage | null,
  events: AgentMessage[],
): Turn {
  return {
    userPrompt,
    recordedTurnId: userPrompt?.id ?? null,
    recordedStartedAt: userPrompt?.createdAt ?? events[0]?.createdAt ?? 0,
    isSteer: false,
    events,
    providerEvents: events,
  };
}

describe("stabilizeTurns", () => {
  it("preserves the partial leading turn's key when pagination prepends its older events", () => {
    const retained = text("retained", "Recorded work");
    const previous = groupMessagesIntoTurns([retained]);
    const paged = stabilizeTurns(previous, groupMessagesIntoTurns([
      text("older", "Earlier work"), retained,
    ]));

    expect(turnKey(paged[0])).toBe(turnKey(previous[0]));
    expect(paged[0].events.map((event) => event.id)).toEqual(["older", "retained"]);
    expect(previous[0].events).toEqual([retained]);
  });

  it("preserves that subtree when the opening prompt of a stopped steered turn finally loads", () => {
    const retained = text("retained", "Recorded work");
    const opening = { ...text("opening", "Opening request"), role: "user" as const };
    const steer = { ...text("steer", "Steered request"), role: "user" as const, steeredTurnId: opening.id };
    const tail = text("tail", "Stopped output");
    const previous = groupMessagesIntoTurns([retained, steer, tail]);
    const restored = stabilizeTurns(previous, groupMessagesIntoTurns([opening, retained, steer, tail]));

    expect(turnKey(restored[0])).toBe(turnKey(previous[0]));
    expect(turnKey(restored[1])).toBe(turnKey(previous[1]));
    expect(restored[0].userPrompt).toBe(opening);
    expect(restored[1].providerEvents).toEqual([retained, tail]);
    expect(previous[0].userPrompt).toBeNull();
  });

  it("keeps the inherited key through later updates without changing the grouped input", () => {
    const retained = text("retained", "Recorded work");
    const opening = { ...text("opening", "Request"), role: "user" as const };
    const partial = groupMessagesIntoTurns([retained]);
    const grouped = groupMessagesIntoTurns([opening, retained]);
    const loaded = stabilizeTurns(partial, grouped);
    const updated = stabilizeTurns(loaded, groupMessagesIntoTurns([opening, text("retained", "Updated work")]));

    expect(turnKey(updated[0])).toBe(turnKey(partial[0]));
    expect(grouped[0].renderKey).toBeUndefined();
    expect(partial[0].renderKey).toBeUndefined();
  });

  it("does not transfer a partial turn's key by matching text or a shared provider owner", () => {
    const previous = groupMessagesIntoTurns([text("retained", "Same text")]);
    const unrelated = groupMessagesIntoTurns([text("unrelated", "Same text")]);
    expect(stabilizeTurns(previous, unrelated)).toEqual(unrelated);
    expect(turnKey(unrelated[0])).not.toBe(turnKey(previous[0]));

    const opening = { ...text("opening", "Request"), role: "user" as const };
    const steer = { ...text("steer", "Request"), role: "user" as const, steeredTurnId: opening.id };
    const turns = stabilizeTurns(previous, groupMessagesIntoTurns([opening, text("retained", "Same text"), steer, text("tail", "Same text")]));
    expect(turnKey(turns[0])).toBe(turnKey(previous[0]));
    expect(turnKey(turns[1])).toBe("turn-steer");
    expect(new Set(turns.map(turnKey)).size).toBe(turns.length);
  });

  it("drops inherited identities when their resident subtree is evicted", () => {
    const retained = text("retained", "Recorded work");
    const opening = { ...text("opening", "Request"), role: "user" as const };
    const loaded = stabilizeTurns(groupMessagesIntoTurns([retained]), groupMessagesIntoTurns([opening, retained]));
    const empty = stabilizeTurns(loaded, []);
    const restored = stabilizeTurns(empty, groupMessagesIntoTurns([opening, retained]));

    expect(empty).toEqual([]);
    expect(turnKey(restored[0])).toBe("turn-opening");
    expect(restored[0].renderKey).toBeUndefined();
  });

  it("keeps the remaining subtree when the bounded resident window trims its prompt", () => {
    const retained = text("retained", "Recorded work");
    const opening = { ...text("opening", "Request"), role: "user" as const };
    const full = groupMessagesIntoTurns([opening, text("older", "Earlier work"), retained]);
    const trimmed = stabilizeTurns(full, groupMessagesIntoTurns([retained]));

    expect(turnKey(trimmed[0])).toBe(turnKey(full[0]));
    expect(trimmed[0].userPrompt).toBeNull();
    expect(trimmed[0].events).toEqual([retained]);
  });

  it("reuses every unchanged historical turn and only replaces the streamed tail", () => {
    const prompt = text("prompt", "question");
    const settled = text("settled", "answer");
    const streaming = text("streaming", "a");
    const previous: Turn[] = [
      turn(prompt, [settled]),
      turn(null, [streaming]),
    ];
    const next: Turn[] = [
      turn(prompt, [settled]),
      turn(null, [text("streaming", "answer growing") as AgentMessage]),
    ];

    const stable = stabilizeTurns(previous, next);
    expect(stable[0]).toBe(previous[0]);
    expect(stable[1]).toBe(next[1]);
  });

  it("returns the prior array when grouping produced no semantic changes", () => {
    const event = text("event", "same");
    const previous: Turn[] = [turn(null, [event])];
    expect(stabilizeTurns(previous, [turn(null, [event])])).toBe(previous);
  });
});
