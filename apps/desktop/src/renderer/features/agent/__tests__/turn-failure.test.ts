import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { turnFailureForCard, turnFailureDisplay } from "../turn-failure";
import { TurnFailureCard } from "../turn-failure-card";
import { AgentNoticeText } from "../agent-notice";
import { metaForEvent } from "../renderers/event-meta";
import { renderDetail } from "../renderers/event-row-renderer";
import type { RendererContext } from "../renderers/types";

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
  it("keeps a persisted OpenAI model refusal's private diagnostics out of every chat presentation", () => {
    const message = "Codex: unexpected status 403 Forbidden: Project `proj_fixture` does not have access to model `gpt-6.1-sol`, url: https://proxy.example.test/v2/cloud/proxy/openai/responses, cf-ray: fixture-ray, request id: fixture-request";
    const event = JSON.parse(JSON.stringify({ ...notice, message }));
    const failure = turnFailureForCard({ events: [event], turnId: "u1", status: "failed" })!;
    const presentations = [
      renderToStaticMarkup(createElement(TurnFailureCard, { failure })),
      renderToStaticMarkup(createElement(AgentNoticeText, { message })),
      renderToStaticMarkup(renderDetail(event, {} as RendererContext)),
      metaForEvent(event).target,
    ];
    for (const text of presentations) {
      expect(text).toContain("Pick another model.");
      expect(text).toContain("GPT-6.1 Sol");
      expect(text).not.toMatch(/proj_fixture|https:|fixture-ray|fixture-request/);
    }
    expect(event.message).toBe(message); // Presentation never rewrites diagnostics/history.
  });

  it("uses the persisted organization-settings reason with a single Retry action", () => {
    const failure = turnFailureForCard({ events: JSON.parse(JSON.stringify([{ ...notice, code: "org_config_required_unavailable", message: "Native settings service is unavailable. Try to sign in." }])), turnId: "u1", status: "failed" })!;
    expect(failure).toEqual({ kind: "protocol-error", message: "Claude couldn't load your organization's required settings. Check your connection, then retry.", newChatAllowed: false });
    const html = renderToStaticMarkup(createElement(TurnFailureCard, { failure, onRetry: vi.fn(), onRetryNewChat: vi.fn() }));
    expect(html).toContain("lucide-arrow-right");
    expect(html).not.toContain("Retry in new chat");
    expect(html).not.toContain("Sign in");
  });
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

describe("a shared workspace's own-account refusal", () => {
  const recoveryFailure = { kind: "auth-required", message: "Connect your Claude account to send messages in this workspace.",
    cloud: { source: "provider" as const, provider: "claude" as const, reason: "auth-required" as const }, ownAccount: true as const };
  it("keeps its message and offers the person's own account, then a retry of the unsent message", () => {
    const failure = turnFailureForCard({ events: [], turnId: "one", recoveryFailure, status: "failed" })!;
    expect(failure).toMatchObject({ message: recoveryFailure.message, cloud: recoveryFailure.cloud, ownAccount: true });
    const onReconnect = vi.fn(), onRetry = vi.fn();
    const html = renderToStaticMarkup(createElement(TurnFailureCard, { failure, onReconnect, onRetry }));
    expect(html).toContain("Connect your Claude account");
    expect(html).not.toContain("Reconnect provider account");
    expect(html).toContain("Retry");
  });
});

describe("Creator pays: the failure card's copy and actions", () => {
  const card = (extra: Record<string, unknown>) => ({ kind: "auth-required", newChatAllowed: false, message: "m", ...extra }) as never;
  it("the Creator's missing login: names the Creator, keeps Retry, offers no connect action", () => {
    const failure = card({ cloud: { source: "provider", provider: "claude", reason: "auth-required", loginRequiredFrom: "creator" } });
    expect(turnFailureDisplay(failure, "Sam")).toEqual({ message: "Sam needs to connect Claude before messages can run here.", retry: true, reconnect: false, reconnectLabel: undefined, reassign: false });
    expect(turnFailureDisplay(failure, null).message).toBe("The workspace's Creator needs to connect Claude before messages can run here.");
  });
  it("the sender's own login keeps today's copy and the connect action", () => {
    const failure = card({ message: "Connect your Claude account to send messages in this workspace.", ownAccount: true, cloud: { source: "provider", provider: "claude", reason: "auth-required", loginRequiredFrom: "self" } });
    expect(turnFailureDisplay(failure, "Sam")).toEqual({ message: "Connect your Claude account to send messages in this workspace.", retry: true, reconnect: true, reconnectLabel: "Connect your Claude account", reassign: false });
  });
  it("3B: no Creator offers Reassign… only to someone who may reassign this workspace", () => {
    const failure = card({ kind: "creator-required", message: "This workspace has no Creator. An admin can reassign it." });
    expect(turnFailureDisplay(failure, null, true)).toMatchObject({ reassign: true, retry: true, reconnect: false });
    expect(turnFailureDisplay(failure, null, false)).toMatchObject({ reassign: false });
    expect(turnFailureDisplay(card({ cloud: { source: "provider", provider: "claude", reason: "auth-required", loginRequiredFrom: "creator" } }), "Sam", true)).toMatchObject({ reassign: false });
  });
  it("no Creator: its own copy, Retry, nothing to connect", () => {
    expect(turnFailureDisplay(card({ kind: "creator-required", message: "This workspace has no Creator. An admin can reassign it." }), null))
      .toEqual({ message: "This workspace has no Creator. An admin can reassign it.", retry: true, reconnect: false, reconnectLabel: undefined, reassign: false });
  });
});

describe("a temporary server-side failure to deliver the payer's credential", () => {
  const card = (extra: Record<string, unknown>) => ({ kind: "cloud-credentials-unavailable", newChatAllowed: false, message: "m", ...extra }) as never;
  it("reads 'Couldn't start this turn. Try again.' with Retry and no provider action, for everyone", () => {
    for (const failure of [card({ cloud: { source: "provider", provider: "claude", reason: "credentials-unavailable" } }),
      card({ ownAccount: true, cloud: { source: "provider", provider: "claude", reason: "credentials-unavailable" } })])
      expect(turnFailureDisplay(failure, "Sam")).toEqual({ message: "Couldn't start this turn. Try again.", retry: true, reconnect: false, reconnectLabel: undefined, reassign: false });
  });
  it("keeps the provider action only where the provider rejected the viewer's own login", () => {
    expect(turnFailureDisplay(card({ kind: "auth-required", cloud: { source: "provider", provider: "claude", reason: "auth-required" } }), null))
      .toMatchObject({ reconnect: true, reconnectLabel: "Reconnect provider account" });
    expect(turnFailureDisplay(card({ kind: "verification-required", cloud: { source: "provider", provider: "claude", reason: "verification-required" } }), null))
      .toMatchObject({ reconnect: true, reconnectLabel: "Check provider connection" });
  });
});
