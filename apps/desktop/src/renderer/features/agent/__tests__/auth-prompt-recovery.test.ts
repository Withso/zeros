import { describe, expect, it } from "vitest";
import {
  AuthPromptRecovery,
  authenticationTurn,
  authenticationTurnOutput,
  authenticationFailureMessage,
  authenticationTurnState,
  pendingAuthenticationPrompts,
} from "../auth-prompt-recovery";
import type { AgentMessage, AgentTextMessage } from "../use-agent-session";

describe("authentication recovery", () => {
  it("renders a persisted organization refusal once, while retaining child notices and real work", () => {
    const message = "Your organization's Claude settings were refused for this sign-in. Sign in again or ask your administrator.";
    const terminal = { id: "terminal", kind: "error_notice", code: "org_config_refused", message: "Native settings rejection",
      severity: "error", recoverable: false, turnFailure: { turnId: "u", kind: "auth-required" }, createdAt: 2 } as AgentMessage;
    const child = { ...terminal, id: "child", parentToolId: "agent" } as AgentMessage;
    const work = { id: "work", kind: "tool", toolCallId: "work", toolKind: "read" } as AgentMessage;
    const events = JSON.parse(JSON.stringify([work, child, terminal]));
    expect(authenticationFailureMessage(events)).toBe(message);
    expect(authenticationTurnOutput(events).map(event => event.id)).toEqual(["work", "child"]);
  });
  it.each(["rate-limited", "protocol-error", "session-expired", "transport-closed"])("does not override %s with legacy sign-in wording", (kind) => {
    const events = [{ kind: "text", role: "agent", text: "Unauthorized request for the selected model." }] as AgentMessage[];
    expect(authenticationTurn(events, kind)).toBe(false);
    expect(authenticationTurnState({ userPrompt: { id: "u", kind: "text", role: "user", text: "hi", createdAt: 1 }, events, failureKind: kind, isTail: true, inFlight: false })).toBeNull();
    const reloaded = JSON.parse(JSON.stringify([...events, { id: "failure", kind: "error_notice", message: "Provider rejected the request.", severity: "error", turnFailure: { turnId: "u", kind } }]));
    expect(authenticationTurn(reloaded)).toBe(false);
  });

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

  it("does not replay or gate a turn whose typed failure superseded an auth notice", () => {
    const nativeFailure = { id: "native", kind: "error_notice", severity: "error", message: "Request throttled.", turnFailure: { turnId: blocked.id, kind: "rate-limited" } } as AgentMessage;
    const legacy = { id: "legacy", kind: "text", role: "agent", text: "Unauthorized request." } as AgentMessage;
    const next = { ...blocked, id: "next", authRecovery: undefined, text: "Continue" };
    expect(authenticationTurnState({ userPrompt: blocked, events: [legacy, nativeFailure], failureKind: "rate-limited", isTail: true, inFlight: false })).toBeNull();
    expect(pendingAuthenticationPrompts([blocked, legacy, nativeFailure, next], next.id)).toEqual([]);
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
