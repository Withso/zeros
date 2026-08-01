import { describe, expect, it } from "vitest";

import type { AgentMessage, AgentTextMessage } from "../use-agent-session";
import {
  activeProviderTurnId,
  groupMessagesIntoTurns,
  isProviderTurnTail,
  isTailProviderTurnSegment,
} from "../turn-grouping";

function user(
  id: string,
  text: string,
  steeredTurnId?: string,
): AgentTextMessage {
  return {
    id,
    kind: "text",
    role: "user",
    text,
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    ...(steeredTurnId ? { steeredTurnId } : {}),
  } as AgentTextMessage;
}

function event(id: string): AgentMessage {
  return {
    id,
    kind: "tool",
    toolCallId: id,
    title: "Edit",
    toolKind: "edit",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
  } as AgentMessage;
}

describe("groupMessagesIntoTurns — mid-turn steering", () => {
  it("keeps steer bubbles as UI segments owned by the opening provider turn", () => {
    const turns = groupMessagesIntoTurns([
      user("u1", "initial request"),
      event("edit-before-steer"),
      user("u2", "also cover the edge case", "u1"),
      event("edit-after-steer"),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.recordedTurnId)).toEqual(["u1", "u1"]);
    expect(turns.map((turn) => turn.isSteer)).toEqual([false, true]);
    expect(turns[1].providerEvents.map((message) => message.id)).toEqual([
      "edit-before-steer",
      "edit-after-steer",
    ]);
    expect(
      turns.map((turn, index) => isProviderTurnTail(turns, index)),
    ).toEqual([false, true]);
    expect(
      turns.map((turn, index) => isTailProviderTurnSegment(turns, index)),
    ).toEqual([true, true]);
  });

  it("does not merge a later ordinary prompt into the steered provider turn", () => {
    const turns = groupMessagesIntoTurns([
      user("u1", "initial request"),
      user("u2", "mid-turn direction", "u1"),
      event("answer-1"),
      user("u3", "next turn"),
      event("answer-2"),
    ]);

    expect(turns.map((turn) => turn.recordedTurnId)).toEqual([
      "u1",
      "u1",
      "u3",
    ]);
    expect(
      turns.map((turn, index) => isProviderTurnTail(turns, index)),
    ).toEqual([false, true, true]);
    expect(
      turns.map((turn, index) => isTailProviderTurnSegment(turns, index)),
    ).toEqual([false, false, true]);
  });

  it("finds the opening owner for mixed-version and repeated steers", () => {
    const messages = [
      user("u1", "initial request"),
      event("edit-before-steer"),
      user("u2", "first steer", "u1"),
      event("edit-after-steer"),
      { ...user("u3", "queued steer"), queued: true },
    ];

    expect(activeProviderTurnId(messages, "u3")).toBe("u1");
  });

  it("keeps every repeated-steer segment in the same active provider run", () => {
    const turns = groupMessagesIntoTurns([
      user("u1", "initial request"),
      event("before-steers"),
      user("u2", "first steer", "u1"),
      event("between-steers"),
      user("u3", "second steer", "u1"),
    ]);

    expect(
      turns.map((turn, index) => isTailProviderTurnSegment(turns, index)),
    ).toEqual([true, true, true]);
    expect(turns[2].providerEvents.map((message) => message.id)).toEqual([
      "before-steers",
      "between-steers",
    ]);
  });
});
