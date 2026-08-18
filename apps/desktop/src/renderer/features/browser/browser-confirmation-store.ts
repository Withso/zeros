import { useCallback, useSyncExternalStore } from "react";
import {
  BROWSER_RISK_CATEGORIES,
  isBrowserProductId,
  type BrowserConfirmationDecision,
  type BrowserConfirmationRequest,
  type BrowserRiskCategory,
} from "@zeros/protocol/browser-tools";

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "../../platform/bridge/agent-events";
import { nativeInvoke } from "../../platform/runtime";

export const MAX_BROWSER_CONFIRMATIONS = 16;

export type BrowserConfirmationEvent = BrowserConfirmationRequest;
export type BrowserConfirmationCategory = BrowserRiskCategory;

/** The existing provider permission remains the head gate. Claude plan review
 * is deliberately non-blocking, however, so an asynchronous browser/device or
 * download confirmation must take the composer instead of being stranded
 * behind a plan card that leaves the composer live. */
export function browserConfirmationShouldTakeComposer(input: {
  browserPending: boolean;
  providerPermissionPending: boolean;
  providerIsPlanReview: boolean;
}): boolean {
  return (
    input.browserPending &&
    (!input.providerPermissionPending || input.providerIsPlanReview)
  );
}

let queue: BrowserConfirmationEvent[] = [];
const listenersByConversation = new Map<string, Set<() => void>>();

export function enqueueBrowserConfirmation(
  current: BrowserConfirmationEvent[],
  request: BrowserConfirmationEvent,
): BrowserConfirmationEvent[] {
  if (current.some((candidate) => candidate.id === request.id)) return current;
  if (current.length >= MAX_BROWSER_CONFIRMATIONS) return current;
  return [...current, request];
}

export function confirmationsForConversation(
  current: BrowserConfirmationEvent[],
  conversationId: string,
): BrowserConfirmationEvent[] {
  return current.filter((request) => request.conversationId === conversationId);
}

/** Filter a post-subscribe recovery snapshot against request or settlement
 * ids already seen on the live channels. Both channels are installed first,
 * closing the startup race without repainting a request that just resolved. */
export function unseenBrowserConfirmations(
  snapshot: readonly unknown[],
  observedConfirmationIds: ReadonlySet<string>,
): BrowserConfirmationEvent[] {
  return snapshot.filter(
    (request): request is BrowserConfirmationEvent =>
      validBrowserConfirmationRequest(request) &&
      !observedConfirmationIds.has(request.id),
  );
}

export function clearBrowserSessionConfirmations(
  current: BrowserConfirmationEvent[],
  browserSessionId: string,
): BrowserConfirmationEvent[] {
  return current.filter(
    (request) => request.browserSessionId !== browserSessionId,
  );
}

/** Publish one main-owned request. Returns false only for a new overflow item;
 * callers must deny that request immediately so the host cannot remain parked. */
export function publishBrowserConfirmation(
  request: BrowserConfirmationEvent,
): boolean {
  const previous = queue;
  const next = enqueueBrowserConfirmation(previous, request);
  if (next === previous) {
    return previous.some((candidate) => candidate.id === request.id);
  }
  queue = next;
  notifyConversation(request.conversationId);
  return true;
}

export function removeBrowserConfirmation(id: string): void {
  const existing = queue.find((request) => request.id === id);
  if (!existing) return;
  queue = queue.filter((request) => request.id !== id);
  notifyConversation(existing.conversationId);
}

/** A host timeout, close, disable, or revoked confirmation surface resolves
 * the action without a renderer click. Remove those cards as soon as the
 * authoritative session leaves awaiting-confirmation. */
export function removeBrowserConfirmationsForSession(
  browserSessionId: string,
): void {
  const removed = queue.filter(
    (request) => request.browserSessionId === browserSessionId,
  );
  if (removed.length === 0) return;
  queue = clearBrowserSessionConfirmations(queue, browserSessionId);
  for (const conversationId of new Set(
    removed.map((request) => request.conversationId),
  )) {
    notifyConversation(conversationId);
  }
}

/** Clear every retained request and return it to the trusted-surface owner so
 * unmount/reload can fail all outstanding actions closed. */
export function drainBrowserConfirmations(): BrowserConfirmationEvent[] {
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

export function useBrowserConfirmation(
  conversationId: string | null | undefined,
): BrowserConfirmationEvent | null {
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

export function browserConfirmationToPermissionRequest(
  request: BrowserConfirmationEvent,
): RequestPermissionRequest {
  const options: RequestPermissionRequest["options"] = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    ...(request.category === "browser-permission" ||
    request.category === "navigation"
      ? [
          {
            optionId: "allow-site",
            name: "Allow for this site",
            kind: "allow_always" as const,
          },
        ]
      : []),
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];
  return {
    sessionId: request.browserSessionId,
    title:
      request.category === "navigation"
        ? "Allow Browser use to open this website?"
        : "Allow this browser action?",
    toolCall: {
      toolCallId: request.id,
      title: request.label,
      kind: "other",
      status: "pending",
      rawInput: {
        description: request.label,
        origin: request.origin,
        category: request.category,
      },
    },
    options,
    contextItems: [
      browserConfirmationCategoryLabel(request.category),
      request.origin,
    ],
    useOptionNames: true,
    allowLocalPolicies: false,
    nativeRequestId: request.id,
  };
}

export function browserConfirmationDecisionForResponse(
  request: BrowserConfirmationEvent,
  response: RequestPermissionResponse,
): BrowserConfirmationDecision {
  if (response.outcome.outcome !== "selected") return "deny";
  if (response.outcome.optionId === "allow-once") return "allow-once";
  if (
    response.outcome.optionId === "allow-site" &&
    (request.category === "browser-permission" ||
      request.category === "navigation")
  ) {
    return "allow-site";
  }
  return "deny";
}

export async function respondToBrowserConfirmation(
  request: BrowserConfirmationEvent,
  response: RequestPermissionResponse,
): Promise<void> {
  const decision = browserConfirmationDecisionForResponse(request, response);
  const accepted = await nativeInvoke<boolean>("browser_confirmation_respond", {
    confirmationId: request.id,
    decision,
  });
  // A false response means the host already timed out/revoked the request. It
  // is still safe to remove the stale card; there is no action left to approve.
  void accepted;
  removeBrowserConfirmation(request.id);
}

export function validBrowserConfirmationRequest(
  value: unknown,
): value is BrowserConfirmationEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<BrowserConfirmationEvent>;
  if (
    isBrowserProductId(request.id) &&
    isBrowserProductId(request.browserSessionId) &&
    isBrowserProductId(request.workspaceId) &&
    isBrowserProductId(request.conversationId) &&
    typeof request.origin === "string" &&
    request.origin.length <= 2_048 &&
    typeof request.url === "string" &&
    request.url.length <= 8_192 &&
    typeof request.label === "string" &&
    request.label.trim().length > 0 &&
    request.label.length <= 300 &&
    (request.scope === undefined ||
      (typeof request.scope === "string" && request.scope.length <= 100)) &&
    (BROWSER_RISK_CATEGORIES as readonly unknown[]).includes(
      request.category,
    ) &&
    Number.isSafeInteger(request.createdAt) &&
    Number(request.createdAt) >= 0
  ) {
    try {
      const origin = new URL(request.origin);
      const url = new URL(request.url);
      return (
        (origin.protocol === "http:" || origin.protocol === "https:") &&
        (url.protocol === "http:" || url.protocol === "https:") &&
        !origin.username &&
        !origin.password &&
        !url.username &&
        !url.password &&
        origin.origin === request.origin &&
        origin.origin === url.origin
      );
    } catch {
      return false;
    }
  }
  return false;
}

export function browserConfirmationCategoryLabel(
  category: BrowserConfirmationCategory,
): string {
  switch (category) {
    case "navigation":
      return "Opening a website";
    case "authentication":
      return "Authentication or account connection";
    case "payment":
      return "Purchase, payment, or transfer";
    case "publishing":
      return "Publishing or making content public";
    case "destructive":
      return "Destructive or access-removal action";
    case "external-submit":
      return "Submitting information to an external service";
    case "file-upload":
      return "Uploading a local workspace file to this site";
    case "download":
      return "Downloading a file from this site";
    case "browser-permission":
      return "Browser or device permission";
  }
}
