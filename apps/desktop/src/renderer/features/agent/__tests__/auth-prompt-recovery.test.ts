import { describe, expect, it } from "vitest";
import {
  AuthPromptRecovery,
  authenticationTurn,
  authenticationTurnOutput,
  authenticationTurnState,
  pendingAuthenticationPrompts,
} from "../auth-prompt-recovery";
import type { AgentMessage, AgentTextMessage } from "../use-agent-session";

describe("authentication recovery", () => {
  const blocked: AgentTextMessage = {
    id: "blocked",
    kind: "text",
    role: "user",
    text: "@file",
    createdAt: 1,
    authRecovery: { text: "Original expanded prompt" },
  };
  it("shows sign-in only on the blocked tail, then a stopped footer when another message arrives", () => {
    const facts = {
      userPrompt: blocked,
      events: [],
      isTail: true,
      inFlight: false,
    };
    expect(authenticationTurnState(facts)).toBe("sign-in");
    expect(authenticationTurnState({ ...facts, isTail: false })).toBe(
      "stopped",
    );
    // An in-flight newer turn must not revive the historical auth failure.
    expect(
      authenticationTurnState({ ...facts, isTail: false, inFlight: true }),
    ).toBe("stopped");
    expect(authenticationTurnState({ ...facts, inFlight: true })).toBeNull();
  });
  it("carries only consecutive blocked messages as context for a new send, including after reload", () => {
    const next = {
      ...blocked,
      id: "next",
      authRecovery: undefined,
      text: "Continue",
    };
    const messages = [blocked, next];
    expect(pendingAuthenticationPrompts(messages, next.id)).toEqual([blocked]);
    expect(
      pendingAuthenticationPrompts(
        JSON.parse(JSON.stringify(messages)),
        next.id,
      ),
    ).toEqual([blocked]);
    expect(pendingAuthenticationPrompts(messages)).toEqual([]);
    const again = { ...next, authRecovery: { text: "Continue" } };
    expect(pendingAuthenticationPrompts([blocked, again])).toEqual([
      blocked,
      again,
    ]);
  });
  it("retains the exact expanded prompt and attachments only for the matching chat, agent, and turn", () => {
    const recovery = new AuthPromptRecovery();
    const payload: Parameters<
      import("../sessions-context").SessionsActions["sendPrompt"]
    > = [
      "chat-a",
      "expanded original",
      "@file",
      [{ type: "text", text: "file content" }],
    ];
    recovery.remember("chat-a", "claude", "turn-a", payload);
    expect(recovery.read("chat-a", "claude", "turn-a")).toBe(payload);
    expect(recovery.read("chat-b", "claude", "turn-a")).toBeUndefined();
    expect(recovery.read("chat-a", "codex", "turn-a")).toBeUndefined();
    expect(recovery.read("chat-a", "claude", "turn-b")).toBeUndefined();
    recovery.delete("chat-a");
    expect(recovery.read("chat-a", "claude", "turn-a")).toBeUndefined();
  });
  it("recovers a legacy authentication failure after reload, without replaying a completed turn", () => {
    const hi = { ...blocked, text: "hi", authRecovery: undefined };
    const failure = {
      id: "failure",
      kind: "text",
      role: "agent",
      text: "Failed to authenticate: OAuth session expired",
      createdAt: 2,
    } as AgentMessage;
    const next = { ...hi, id: "next", text: "Continue", createdAt: 3 };
    const history = JSON.parse(JSON.stringify([hi, failure, next]));
    expect(pendingAuthenticationPrompts(history, next.id)).toEqual([
      { ...hi, authRecovery: { text: "hi" } },
    ]);
    expect(pendingAuthenticationPrompts(history)).toEqual([]);
  });
  it("renders legacy auth failures separately while retaining real work", () => {
    const events = [
      {
        id: "fallback",
        kind: "tool",
        toolKind: "model_switch",
        rawInput: { toModel: "<synthetic>" },
      },
      {
        id: "error",
        kind: "text",
        role: "agent",
        text: "Failed to authenticate: OAuth session expired",
      },
      { id: "actual", kind: "tool", toolKind: "read" },
    ] as AgentMessage[];
    expect(authenticationTurn(events)).toBe(true);
    expect(authenticationTurnOutput(events).map((e) => e.id)).toEqual([
      "actual",
    ]);
    expect(
      authenticationTurn([
        {
          kind: "text",
          role: "agent",
          text: "Here is how OAuth works",
        } as AgentMessage,
      ]),
    ).toBe(false);
  });
});
