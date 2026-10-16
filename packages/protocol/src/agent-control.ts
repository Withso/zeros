// Approvals for Zeros-owned control of apps and simulators.
//
// Electron main creates every request; tool arguments never choose its id,
// owner or subject. The renderer shows it in the chat's PermissionCard next to
// browser website approvals and answers through a trusted IPC command.

import {
  agentControlName,
  isAgentControlFamily,
  isBrowserProductId,
  type AgentControlFamily,
} from "./browser-tools";
import type { ConversationId, WorkspaceId } from "./identities";

export const AGENT_CONTROL_CONFIRMATION_KINDS = [
  "app",
  "device",
  "device-boot",
] as const;
export type AgentControlConfirmationKind =
  (typeof AGENT_CONTROL_CONFIRMATION_KINDS)[number];

export const AGENT_CONTROL_CONFIRMATION_DECISIONS = ["allow", "deny"] as const;
export type AgentControlConfirmationDecision =
  (typeof AGENT_CONTROL_CONFIRMATION_DECISIONS)[number];

export interface AgentControlConfirmationRequest {
  id: string;
  kind: AgentControlConfirmationKind;
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
  agent: AgentControlFamily;
  /** What the user knows it as, such as "Safari" or "iPhone 16 Pro". */
  subject: string;
  /** A bundle ID or a device UDID. */
  subjectId: string;
  createdAt: number;
}

const SUBJECT_ID = /^[A-Za-z0-9._:-]{1,255}$/;

export function isAgentControlConfirmationDecision(
  value: unknown,
): value is AgentControlConfirmationDecision {
  return (
    typeof value === "string" &&
    (AGENT_CONTROL_CONFIRMATION_DECISIONS as readonly string[]).includes(value)
  );
}

export function isAgentControlConfirmationRequest(
  value: unknown,
): value is AgentControlConfirmationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<AgentControlConfirmationRequest>;
  return (
    isBrowserProductId(request.id) &&
    (AGENT_CONTROL_CONFIRMATION_KINDS as readonly unknown[]).includes(
      request.kind,
    ) &&
    isBrowserProductId(request.workspaceId) &&
    isBrowserProductId(request.conversationId) &&
    isAgentControlFamily(request.agent) &&
    typeof request.subject === "string" &&
    request.subject.trim().length > 0 &&
    request.subject.length <= 200 &&
    typeof request.subjectId === "string" &&
    SUBJECT_ID.test(request.subjectId) &&
    Number.isSafeInteger(request.createdAt) &&
    Number(request.createdAt) >= 0
  );
}

/** The PermissionCard question, such as "Allow Codex to control Safari?" */
export function agentControlConfirmationTitle(
  request: Pick<AgentControlConfirmationRequest, "kind" | "agent" | "subject">,
): string {
  const agent = agentControlName(request.agent);
  switch (request.kind) {
    case "app":
      return `Allow ${agent} to control ${request.subject}?`;
    case "device":
      return `Allow ${agent} to use ${request.subject}?`;
    case "device-boot":
      return `Allow ${agent} to start ${request.subject}?`;
  }
}

/** The card's context line under the title. */
export function agentControlConfirmationContext(
  kind: AgentControlConfirmationKind,
): string {
  switch (kind) {
    case "app":
      return "Controlling an app on your Mac, for this chat";
    case "device":
      return "Using a simulator, for this chat";
    case "device-boot":
      return "Starting a simulator";
  }
}
