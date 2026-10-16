import { useCallback, useSyncExternalStore } from "react";
import {
  agentControlConfirmationContext,
  agentControlConfirmationTitle,
  isAgentControlConfirmationRequest,
  type AgentControlConfirmationDecision,
  type AgentControlConfirmationRequest,
} from "@zeros/protocol/agent-control";

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "../../platform/bridge/agent-events";
import { nativeInvoke } from "../../platform/runtime";

// App and simulator approvals that Electron main asks for. They are retained
// by exact conversation and answered from that chat's PermissionCard, like
// Browser website approvals.

export const MAX_AGENT_CONTROL_CONFIRMATIONS = 16;

let queue: AgentControlConfirmationRequest[] = [];
const listenersByConversation = new Map<string, Set<() => void>>();

export function enqueueAgentControlConfirmation(
  current: AgentControlConfirmationRequest[],
  request: AgentControlConfirmationRequest,
): AgentControlConfirmationRequest[] {
  if (current.some((candidate) => candidate.id === request.id)) return current;
  if (current.length >= MAX_AGENT_CONTROL_CONFIRMATIONS) return current;
  return [...current, request];
}

/** Requests from a post-subscribe recovery read that the live channels have
 * not already shown or settled. */
export function unseenAgentControlConfirmations(
  snapshot: readonly unknown[],
  observedConfirmationIds: ReadonlySet<string>,
): AgentControlConfirmationRequest[] {
  return snapshot.filter(
    (request): request is AgentControlConfirmationRequest =>
      isAgentControlConfirmationRequest(request) &&
      !observedConfirmationIds.has(request.id),
  );
}

/** Publish one request. Returns false only for a new request that overflows
 * the queue; the caller must deny it so main does not wait for a timeout. */
export function publishAgentControlConfirmation(
  request: AgentControlConfirmationRequest,
): boolean {
  const previous = queue;
  const next = enqueueAgentControlConfirmation(previous, request);
  if (next === previous) {
    return previous.some((candidate) => candidate.id === request.id);
  }
  queue = next;
  notifyConversation(request.conversationId);
  return true;
}

export function removeAgentControlConfirmation(id: string): void {
  const existing = queue.find((request) => request.id === id);
  if (!existing) return;
  queue = queue.filter((request) => request.id !== id);
  notifyConversation(existing.conversationId);
}

/** Clear every request and return it, so unmount or reload can deny them. */
export function drainAgentControlConfirmations(): AgentControlConfirmationRequest[] {
  if (queue.length === 0) return [];
  const drained = queue;
  queue = [];
  for (const conversationId of new Set(
    drained.map((request) => request.conversationId),
  )) {
    notifyConversation(conversationId);
  }
  return drained;
}

function notifyConversation(conversationId: string): void {
  for (const listener of listenersByConversation.get(conversationId) ?? []) {
    listener();
  }
}

function subscribeConversation(
  conversationId: string,
  listener: () => void,
): () => void {
  let listeners = listenersByConversation.get(conversationId);
  if (!listeners) {
    listeners = new Set();
    listenersByConversation.set(conversationId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners!.delete(listener);
    if (listeners!.size === 0) listenersByConversation.delete(conversationId);
  };
}

export function useAgentControlConfirmation(
  conversationId: string | null | undefined,
): AgentControlConfirmationRequest | null {
  const key = conversationId ?? "";
  const subscribe = useCallback(
    (listener: () => void) => subscribeConversation(key, listener),
    [key],
  );
  const getSnapshot = useCallback(
    () =>
      key
        ? (queue.find((request) => request.conversationId === key) ?? null)
        : null,
    [key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

const ALLOW_OPTION_ID = "allow";
const DENY_OPTION_ID = "deny";

export function agentControlConfirmationToPermissionRequest(
  request: AgentControlConfirmationRequest,
): RequestPermissionRequest {
  const allowName =
    request.kind === "device-boot" ? "Allow" : "Allow for this chat";
  return {
    sessionId: request.conversationId,
    title: agentControlConfirmationTitle(request),
    toolCall: {
      toolCallId: request.id,
      title: request.subject,
      kind: "other",
      status: "pending",
      rawInput: {
        description: request.subject,
        subjectId: request.subjectId,
        kind: request.kind,
      },
    },
    options: [
      { optionId: ALLOW_OPTION_ID, name: allowName, kind: "allow_once" },
      { optionId: DENY_OPTION_ID, name: "Deny", kind: "reject_once" },
    ],
    contextItems: [
      agentControlConfirmationContext(request.kind),
      request.subjectId,
    ],
    useOptionNames: true,
    allowLocalPolicies: false,
    nativeRequestId: request.id,
  };
}

export function agentControlDecisionForResponse(
  response: RequestPermissionResponse,
): AgentControlConfirmationDecision {
  return response.outcome.outcome === "selected" &&
    response.outcome.optionId === ALLOW_OPTION_ID
    ? "allow"
    : "deny";
}

export async function respondToAgentControlConfirmation(
  request: AgentControlConfirmationRequest,
  response: RequestPermissionResponse,
): Promise<void> {
  // False means main already settled it, by timeout, Stop or the chat
  // closing. The card is stale either way.
  await nativeInvoke<boolean>("agent_control_confirmation_respond", {
    confirmationId: request.id,
    decision: agentControlDecisionForResponse(response),
  });
  removeAgentControlConfirmation(request.id);
}

export function denyAgentControlConfirmation(confirmationId: string): void {
  void nativeInvoke("agent_control_confirmation_respond", {
    confirmationId,
    decision: "deny",
  }).catch(() => {});
}
