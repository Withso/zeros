import { describe, expect, it } from "vitest";

import {
  browserConfirmationToPermissionRequest,
  browserConfirmationShouldTakeComposer,
  browserConfirmationDecisionForResponse,
  clearBrowserSessionConfirmations,
  confirmationsForConversation,
  enqueueBrowserConfirmation,
  MAX_BROWSER_CONFIRMATIONS,
  unseenBrowserConfirmations,
  validBrowserConfirmationRequest,
  type BrowserConfirmationEvent,
} from "../../features/browser/browser-confirmation-store";

describe("Zeros browser confirmation queue", () => {
  it("lets a hard provider gate lead, but does not strand browser approval behind plan review", () => {
    expect(
      browserConfirmationShouldTakeComposer({
        browserPending: true,
        providerPermissionPending: false,
        providerIsPlanReview: false,
      }),
    ).toBe(true);
    expect(
      browserConfirmationShouldTakeComposer({
        browserPending: true,
        providerPermissionPending: true,
        providerIsPlanReview: false,
      }),
    ).toBe(false);
    expect(
      browserConfirmationShouldTakeComposer({
        browserPending: true,
        providerPermissionPending: true,
        providerIsPlanReview: true,
      }),
    ).toBe(true);
  });

  it("deduplicates replayed requests and preserves browser ownership", () => {
    const first = event("confirmation-1", "browser-a");
    expect(enqueueBrowserConfirmation([first], first)).toEqual([first]);
    expect(
      enqueueBrowserConfirmation([first], event("confirmation-2", "browser-b")),
    ).toEqual([first, event("confirmation-2", "browser-b")]);
  });

  it("replays only valid snapshot requests not already observed live", () => {
    const live = event("confirmation-live", "browser-live");
    const missed = event("confirmation-missed", "browser-missed");
    expect(
      unseenBrowserConfirmations(
        [live, missed, { ...missed, id: "unsafe/id" }],
        new Set([live.id]),
      ),
    ).toEqual([missed]);
  });

  it("bounds retained confirmations", () => {
    const full = Array.from({ length: MAX_BROWSER_CONFIRMATIONS }, (_, index) =>
      event(`confirmation-${index}`, `browser-${index}`),
    );
    expect(
      enqueueBrowserConfirmation(full, event("overflow", "browser-overflow")),
    ).toBe(full);
  });

  it("routes requests only to their exact Zeros conversation", () => {
    const first = event("confirmation-1", "browser-a", "conversation-a");
    const second = event("confirmation-2", "browser-b", "conversation-b");
    expect(
      confirmationsForConversation([first, second], "conversation-a"),
    ).toEqual([first]);
    expect(
      confirmationsForConversation([first, second], "conversation-missing"),
    ).toEqual([]);
  });

  it("clears stale cards when their host session times out, closes, or is disabled", () => {
    const first = event("confirmation-1", "browser-a", "conversation-a");
    const second = event("confirmation-2", "browser-b", "conversation-b");
    expect(
      clearBrowserSessionConfirmations([first, second], "browser-a"),
    ).toEqual([second]);
    expect(
      clearBrowserSessionConfirmations([first, second], "browser-missing"),
    ).toEqual([first, second]);
  });

  it("adapts browser decisions into the existing PermissionCard contract", () => {
    const request = event("confirmation-1", "browser-a", "conversation-a");
    const card = browserConfirmationToPermissionRequest(request);
    expect(card).toMatchObject({
      sessionId: "browser-a",
      title: "Allow this browser action?",
      useOptionNames: true,
      allowLocalPolicies: false,
      toolCall: {
        toolCallId: "confirmation-1",
        title: "Pay now",
        kind: "other",
      },
    });
    expect(card.options.map((option) => option.optionId)).toEqual([
      "allow-once",
      "deny",
    ]);
    expect(
      browserConfirmationDecisionForResponse(request, {
        outcome: { outcome: "selected", optionId: "allow-once" },
      }),
    ).toBe("allow-once");
    expect(
      browserConfirmationDecisionForResponse(request, {
        outcome: { outcome: "selected", optionId: "unknown" },
      }),
    ).toBe("deny");

    const sitePermission = browserConfirmationToPermissionRequest({
      ...request,
      category: "browser-permission",
      scope: "notifications",
    });
    expect(sitePermission.options.map((option) => option.optionId)).toEqual([
      "allow-once",
      "allow-site",
      "deny",
    ]);
  });

  it("rejects malformed main-process events before they enter a chat", () => {
    expect(
      validBrowserConfirmationRequest(event("confirmation-1", "browser-a")),
    ).toBe(true);
    expect(
      validBrowserConfirmationRequest({
        ...event("confirmation-1", "browser-a"),
        conversationId: "conversation/unsafe",
      }),
    ).toBe(false);
    expect(
      validBrowserConfirmationRequest({
        ...event("confirmation-1", "browser-a"),
        origin: "https://attacker.example",
      }),
    ).toBe(false);
    expect(
      validBrowserConfirmationRequest({
        ...event("confirmation-1", "browser-a"),
        label: "x".repeat(301),
      }),
    ).toBe(false);
    expect(validBrowserConfirmationRequest(null)).toBe(false);
  });
});

function event(
  id: string,
  browserSessionId: string,
  conversationId = `conversation-${browserSessionId}`,
): BrowserConfirmationEvent {
  return {
    id,
    browserSessionId,
    workspaceId: "workspace-a",
    conversationId,
    category: "payment",
    origin: "https://example.com",
    url: "https://example.com/checkout",
    label: "Pay now",
    createdAt: 1,
  };
}
