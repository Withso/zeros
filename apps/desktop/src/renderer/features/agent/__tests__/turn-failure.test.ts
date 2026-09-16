import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { turnFailureForCard } from "../turn-failure";
import { TurnFailureCard } from "../turn-failure-card";

const notice: AgentMessage = {
  id: "n1",
  kind: "error_notice",
  severity: "error",
  recoverable: false,
  message: "Selected model is at capacity. Please try a different model.",
  createdAt: 2,
  turnFailure: { turnId: "u1", kind: "protocol-error" },
};

describe("persistent turn failure card", () => {
  it.each([
    ["protocol-error", "Unexpected provider error. Check your API key settings.", false],
    ["protocol-error", "Claude model unavailable: Selection rejected.", false],
    ["rate-limited", "Provider refused this request.", false],
    ["auth-required", "Credential rejected.", false],
    ["session-expired", "Stored session was removed.", true],
    ["protocol-error", "Context window exceeded.", true],
  ])("offers new-chat recovery only for session-related failures: %s / %s", (kind, message, expected) => {
    const event = { ...notice, message, turnFailure: { turnId: "u1", kind } } as AgentMessage;
    const failure = turnFailureForCard({ events: JSON.parse(JSON.stringify([event])), turnId: "u1" });
    expect(failure?.message).toBe(message);
    expect(failure?.newChatAllowed).toBe(expected);
  });

  it("shows an autonomous failure after a successful foreground result and requires recovery evidence to clear it", () => {
    const backgroundFailure = { ...notice, code: "claude-background-transport-closed" };
    expect(turnFailureForCard({ events: [backgroundFailure], turnId: "u1", status: "completed" })?.message).toBe(notice.message);
    expect(turnFailureForCard({ events: [backgroundFailure, { ...notice, id: "recovered", code: "claude-background-recovered", severity: "warning", recoverable: true }], turnId: "u1", status: "completed" })).toBeNull();
    expect(turnFailureForCard({ events: [backgroundFailure], turnId: "u1", status: "completed", stopReason: "cancelled" })).toBeNull();
  });
  it("shows the actionable reason outside collapsed activity", () => {
    const failure = turnFailureForCard({ events: [notice], turnId: "u1" });
    expect(failure?.message).toBe(notice.message);
    expect(failure?.newChatAllowed).toBe(false);
    const html = renderToStaticMarkup(
      createElement(TurnFailureCard, { failure: failure!, onRetry: vi.fn() }),
    );
    expect(html).toContain(notice.message);
    expect(html).toContain("bg-brown-bg");
    expect(html).toContain("text-fg1");
    expect(html).toContain("text-brown-fg");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Retry in new chat");
  });

  it("does not turn provider automatic retry or a child error into a terminal card", () => {
    expect(
      turnFailureForCard({
        events: [{ ...notice, turnFailure: undefined, recoverable: true }],
        turnId: "u1",
      }),
    ).toBeNull();
    expect(
      turnFailureForCard({
        events: [{ ...notice, parentToolId: "child" }],
        turnId: "u1",
      }),
    ).toBeNull();
  });

  it.each([
    { live: true },
    { retrying: true },
    { stopReason: "cancelled" },
    { status: "completed" },
    { status: "cancelled" },
  ])(
    "hides errors while recovered, running or stopped by the user: %j",
    (state) => {
      expect(
        turnFailureForCard({ events: [notice], turnId: "u1", ...state }),
      ).toBeNull();
    },
  );

  it("never attributes another turn's late error to this turn", () => {
    expect(turnFailureForCard({ events: [notice], turnId: "u2" })).toBeNull();
  });

  it("retains safe links and escapes provider HTML while offering fresh-chat recovery for a lost session", () => {
    const failure = turnFailureForCard({
      events: [],
      turnId: "u1",
      fallback: {
        kind: "session-expired",
        stage: "prompt",
        message:
          "Session expired. <script>alert(1)</script> See https://example.com/help",
      },
    });
    expect(failure?.newChatAllowed).toBe(true);
    const html = renderToStaticMarkup(
      createElement(TurnFailureCard, {
        failure: failure!,
        onRetry: vi.fn(),
        onRetryNewChat: vi.fn(),
      }),
    );
    expect(html).toContain("Retry in new chat");
    expect(html).toContain('href="https://example.com/help"');
    expect(html).not.toContain("<script>");
  });
});
