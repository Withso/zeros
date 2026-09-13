import { describe, expect, it } from "vitest";

import type { AgentMessage, AgentTextMessage } from "../use-agent-session";
import {
  activeProviderTurnId,
  groupMessagesIntoTurns,
  isProviderTurnTail,
  isTailProviderTurnSegment,
  turnKey,
} from "../turn-grouping";
import { stabilizeTurns } from "../stable-turns";

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

function startupWarning(id: string): AgentMessage {
  return {
    id,
    kind: "error_notice",
    code: "mcp_startup_status",
    severity: "warning",
    message: "cloudflare-api MCP is failed.",
    recoverable: true,
    createdAt: 1,
  };
}

describe("groupMessagesIntoTurns — background MCP status", () => {
  it("does not create a system turn for startup notices restored from older builds", () => {
    expect(
      groupMessagesIntoTurns([
        startupWarning("status-1"),
        startupWarning("status-2"),
      ]),
    ).toEqual([]);
  });

  it("hides only startup notices while retaining tool errors, sign-in failures and other warnings", () => {
    const failedTool: AgentMessage = {
      ...event("mcp-call"),
      kind: "tool",
      toolKind: "mcp",
      status: "failed",
      rawOutput: { message: "Authentication required" },
    } as AgentMessage;
    const signInFailure = {
      ...startupWarning("oauth"),
      code: "mcp_oauth_failed",
    };
    const unrelatedWarning = { ...startupWarning("warning"), code: undefined };
    const messages = [
      startupWarning("before-prompt"),
      user("u1", "List workers"),
      startupWarning("during-prompt"),
      failedTool,
      signInFailure,
      unrelatedWarning,
      startupWarning("after-prompt"),
    ];
    const original = [...messages];
    const turns = groupMessagesIntoTurns(messages);

    expect(turns).toHaveLength(1);
    expect(turns[0].userPrompt?.id).toBe("u1");
    expect(turns[0].events).toEqual([
      failedTool,
      signInFailure,
      unrelatedWarning,
    ]);
    expect(turns[0].providerEvents).toBe(turns[0].events);
    expect(turns[0].events[0]).toBe(failedTool);
    expect(messages).toEqual(original);
  });

  it("retains visible turn references when an older engine sends more startup notices", () => {
    const messages = [user("u1", "Hello"), event("result")];
    const previous = groupMessagesIntoTurns(messages);
    const refreshed = groupMessagesIntoTurns([
      ...messages,
      startupWarning("refresh"),
    ]);

    expect(stabilizeTurns(previous, refreshed)).toBe(previous);
  });
});

describe("groupMessagesIntoTurns — mid-turn steering", () => {
  it("coalesces duplicate durable ids before producing React turn keys", () => {
    const turns = groupMessagesIntoTurns([
      user("u1", "initial request"),
      event("answer"),
      // A renderer/engine reconcile may replay the same durable user row after
      // its answer. It is one logical message, not a second visual turn.
      user("u1", "initial request"),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].events.map((message) => message.id)).toEqual(["answer"]);
    expect(new Set(turns.map(turnKey)).size).toBe(turns.length);
  });

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
