import { describe, expect, it } from "vitest";

import {
  agentControlConfirmationContext,
  agentControlConfirmationTitle,
  isAgentControlConfirmationDecision,
  isAgentControlConfirmationRequest,
  type AgentControlConfirmationRequest,
} from "../agent-control";

const request: AgentControlConfirmationRequest = {
  id: "confirm-1",
  kind: "device",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  agent: "codex",
  subject: "iPhone 16 Pro",
  subjectId: "1A2B3C4D-0000-4000-8000-000000000001",
  createdAt: 1,
};

describe("agent control confirmations", () => {
  it("asks in the agent's name about the exact device", () => {
    expect(agentControlConfirmationTitle(request)).toBe(
      "Allow Codex to use iPhone 16 Pro?",
    );
    expect(
      agentControlConfirmationTitle({
        ...request,
        agent: "claude",
        kind: "device-boot",
        subject: "iPhone 16 Pro",
      }),
    ).toBe("Allow Claude Code to start iPhone 16 Pro?");
    expect(
      agentControlConfirmationTitle({
        ...request,
        agent: "cursor",
        kind: "device",
        subject: "Pixel 9",
      }),
    ).toBe("Allow Cursor to use Pixel 9?");
    expect(agentControlConfirmationContext("device")).toMatch(/this chat/);
  });

  it("accepts only main-shaped requests and the two decisions", () => {
    expect(isAgentControlConfirmationRequest(request)).toBe(true);
    for (const broken of [
      { ...request, kind: "desktop" },
      // Apps need no approval any more.
      { ...request, kind: "app" },
      { ...request, agent: "gemini" },
      { ...request, subject: " " },
      { ...request, subjectId: "1A2B3C4D; rm" },
      { ...request, conversationId: "a/b" },
      { ...request, createdAt: -1 },
      null,
      [],
    ]) {
      expect(isAgentControlConfirmationRequest(broken)).toBe(false);
    }
    expect(isAgentControlConfirmationDecision("allow")).toBe(true);
    expect(isAgentControlConfirmationDecision("allow-site")).toBe(false);
  });
});
