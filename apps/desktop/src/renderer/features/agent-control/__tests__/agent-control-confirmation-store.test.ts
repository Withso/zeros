import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentControlConfirmationRequest } from "@zeros/protocol/agent-control";
import type { RequestPermissionResponse } from "../../../platform/bridge/agent-events";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => true) }));
vi.mock("../../../platform/runtime", () => ({
  nativeInvoke: mocks.invoke,
}));

import {
  MAX_AGENT_CONTROL_CONFIRMATIONS,
  agentControlConfirmationToPermissionRequest,
  agentControlDecisionForResponse,
  denyAgentControlConfirmation,
  drainAgentControlConfirmations,
  enqueueAgentControlConfirmation,
  publishAgentControlConfirmation,
  removeAgentControlConfirmation,
  respondToAgentControlConfirmation,
  unseenAgentControlConfirmations,
} from "../agent-control-confirmation-store";
import {
  nativeConfirmationFailureText,
  nativeConfirmationToPermissionRequest,
  nextNativeConfirmation,
  respondToNativeConfirmation,
} from "../native-confirmation";
import type { BrowserConfirmationEvent } from "../../browser/browser-confirmation-store";

function request(
  id: string,
  conversationId = "conversation-a",
  createdAt = 1,
): AgentControlConfirmationRequest {
  return {
    id,
    kind: "app",
    workspaceId: "workspace-a",
    conversationId,
    agent: "codex",
    subject: "Safari",
    subjectId: "com.apple.Safari",
    createdAt,
  };
}

function browserEvent(createdAt: number): BrowserConfirmationEvent {
  return {
    id: `browser-${createdAt}`,
    browserSessionId: "browser-a",
    workspaceId: "workspace-a",
    conversationId: "conversation-a",
    category: "payment",
    origin: "https://example.com",
    url: "https://example.com/checkout",
    label: "Pay now",
    createdAt,
  };
}

beforeEach(() => {
  drainAgentControlConfirmations();
  vi.clearAllMocks();
});

describe("agent control confirmation queue", () => {
  it("deduplicates replays, preserves order, and stays bounded", () => {
    const first = request("confirmation-1");
    expect(enqueueAgentControlConfirmation([first], first)).toEqual([first]);
    expect(
      enqueueAgentControlConfirmation([first], request("confirmation-2")),
    ).toHaveLength(2);
    const full = Array.from(
      { length: MAX_AGENT_CONTROL_CONFIRMATIONS },
      (_, index) => request(`confirmation-${index}`),
    );
    expect(enqueueAgentControlConfirmation(full, request("overflow"))).toBe(
      full,
    );
  });

  it("replays only valid snapshot requests not already observed live", () => {
    const live = request("confirmation-live");
    const missed = request("confirmation-missed");
    expect(
      unseenAgentControlConfirmations(
        [live, missed, { ...missed, id: "unsafe/id" }, null],
        new Set([live.id]),
      ),
    ).toEqual([missed]);
  });

  it("publishes, reports overflow, removes and drains", () => {
    expect(publishAgentControlConfirmation(request("confirmation-1"))).toBe(
      true,
    );
    expect(publishAgentControlConfirmation(request("confirmation-1"))).toBe(
      true,
    );
    removeAgentControlConfirmation("confirmation-1");
    for (let index = 0; index < MAX_AGENT_CONTROL_CONFIRMATIONS; index += 1) {
      expect(
        publishAgentControlConfirmation(request(`confirmation-${index}`)),
      ).toBe(true);
    }
    expect(publishAgentControlConfirmation(request("overflow"))).toBe(false);
    expect(drainAgentControlConfirmations()).toHaveLength(
      MAX_AGENT_CONTROL_CONFIRMATIONS,
    );
    expect(drainAgentControlConfirmations()).toEqual([]);
  });

  it("adapts an app approval into the PermissionCard contract", () => {
    const card = agentControlConfirmationToPermissionRequest(
      request("confirmation-1"),
    );
    expect(card).toMatchObject({
      sessionId: "conversation-a",
      title: "Allow Codex to control Safari?",
      useOptionNames: true,
      allowLocalPolicies: false,
      nativeRequestId: "confirmation-1",
      toolCall: {
        toolCallId: "confirmation-1",
        title: "Safari",
        kind: "other",
      },
    });
    expect(card.options.map((option) => [option.optionId, option.name])).toEqual(
      [
        ["allow", "Allow for this chat"],
        ["deny", "Deny"],
      ],
    );
    expect(card.contextItems).toEqual([
      "Controlling an app on your Mac, for this chat",
      "com.apple.Safari",
    ]);
  });

  it("names simulator approvals after their moment", () => {
    expect(
      agentControlConfirmationToPermissionRequest({
        ...request("confirmation-device"),
        kind: "device",
        subject: "iPhone 16 Pro",
        subjectId: "UDID-1",
      }).title,
    ).toBe("Allow Codex to use iPhone 16 Pro?");
    expect(
      agentControlConfirmationToPermissionRequest({
        ...request("confirmation-boot"),
        kind: "device-boot",
        subject: "iPhone 16 Pro",
        subjectId: "UDID-1",
      }).options[0]?.name,
    ).toBe("Allow");
  });

  it("maps only an explicit Allow selection to allow", () => {
    expect(
      agentControlDecisionForResponse({
        outcome: { outcome: "selected", optionId: "allow" },
      }),
    ).toBe("allow");
    expect(
      agentControlDecisionForResponse({
        outcome: { outcome: "selected", optionId: "allow-once" },
      }),
    ).toBe("deny");
    expect(
      agentControlDecisionForResponse({
        outcome: { outcome: "cancelled" },
      } as RequestPermissionResponse),
    ).toBe("deny");
  });

  it("answers main and clears the card even when it already settled", async () => {
    const pending = request("confirmation-1");
    publishAgentControlConfirmation(pending);
    mocks.invoke.mockResolvedValueOnce(false);
    await respondToAgentControlConfirmation(pending, {
      outcome: { outcome: "selected", optionId: "allow" },
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent_control_confirmation_respond",
      { confirmationId: "confirmation-1", decision: "allow" },
    );
    expect(drainAgentControlConfirmations()).toEqual([]);

    denyAgentControlConfirmation("confirmation-9");
    await Promise.resolve();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent_control_confirmation_respond",
      { confirmationId: "confirmation-9", decision: "deny" },
    );
  });
});

describe("native confirmation selection", () => {
  it("shows the chat's oldest main-process approval first", () => {
    const control = request("confirmation-control", "conversation-a", 10);
    expect(nextNativeConfirmation(null, null)).toBeNull();
    expect(nextNativeConfirmation(null, control)).toEqual({
      source: "agent-control",
      request: control,
    });
    expect(nextNativeConfirmation(browserEvent(5), control)).toMatchObject({
      source: "browser",
    });
    expect(nextNativeConfirmation(browserEvent(15), control)).toMatchObject({
      source: "agent-control",
      request: control,
    });
  });

  it("keeps browser approvals on their existing card adapter", async () => {
    const browser = browserEvent(1);
    const confirmation = nextNativeConfirmation(browser, null);
    expect(confirmation).toEqual({ source: "browser", request: browser });
    expect(
      nativeConfirmationToPermissionRequest(confirmation!),
    ).toMatchObject({ title: "Allow this browser action?" });
    expect(nativeConfirmationFailureText(confirmation!)).toContain("browser");

    const control = nextNativeConfirmation(null, request("confirmation-1"));
    expect(nativeConfirmationFailureText(control!)).toBe(
      "Couldn't respond to the approval request.",
    );
    mocks.invoke.mockResolvedValueOnce(true);
    await respondToNativeConfirmation(control!, {
      outcome: { outcome: "selected", optionId: "deny" },
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent_control_confirmation_respond",
      { confirmationId: "confirmation-1", decision: "deny" },
    );
  });
});
