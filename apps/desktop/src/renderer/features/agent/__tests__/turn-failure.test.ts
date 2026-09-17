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
    ["protocol-error", "Unexpected provider error. Check your API key settings.", true],
    ["protocol-error", "Claude model unavailable: Selection rejected.", true],
    ["rate-limited", "Provider refused this request.", true],
    ["rate-limited", "You've hit your usage limit. Visit https://example.com/usage to purchase more credits or try again later.", true],
    ["auth-required", "Credential rejected.", false],
    ["verification-required", "Complete verification at https://example.com/verify", false],
    ["cloud-credentials-unavailable", "Could not load Bedrock credentials. Refresh your AWS credentials and retry.", false],
    ["session-expired", "Stored session was removed.", true],
    ["protocol-error", "Context window exceeded.", true],
  ])("offers new-chat retry except for account and credential failures: %s / %s", (kind, message, expected) => {
    const event = { ...notice, message, turnFailure: { turnId: "u1", kind } } as AgentMessage;
    const failure = turnFailureForCard({ events: JSON.parse(JSON.stringify([event])), turnId: "u1" });
    expect(failure?.message).toBe(message);
    expect(failure?.newChatAllowed).toBe(expected);
    const html = renderToStaticMarkup(
      createElement(TurnFailureCard, {
        failure: failure!,
        onRetry: vi.fn(),
        onRetryNewChat: vi.fn(),
      }),
    );
    expect(html.includes("Retry in new chat")).toBe(expected);
  });

  it.each(["verification-required", "cloud-credentials-unavailable"])("retains %s recovery for autonomous results across persistence", (kind) => {
    const event = {
      ...notice, code: "claude-background-failed", turnFailure: undefined,
      failureKind: kind, message: "Resolve this at https://example.com/provider-help",
    };
    const failure = turnFailureForCard({ events: JSON.parse(JSON.stringify([event])), turnId: "u1", status: "completed" });
    expect(failure).toMatchObject({ kind, newChatAllowed: false, message: event.message });
    const html = renderToStaticMarkup(createElement(TurnFailureCard, {
      failure: failure!, onRetry: vi.fn(), onRetryNewChat: vi.fn(),
    }));
    expect(html).toContain('href="https://example.com/provider-help"');
    expect(html).toContain("Retry");
    expect(html).not.toContain("Retry in new chat");
    expect(html).not.toContain("Sign in");
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
    expect(failure?.newChatAllowed).toBe(true);
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
