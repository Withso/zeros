import type { CapabilityRefreshFamily } from "./session-reload-lifecycle";

/** Which Settings change asked a chat to resume. */
export type CapabilityRefreshReason = "browser" | "computer" | "simulator";

export interface ProviderCapabilityRefreshRequest {
  revision: number;
  providerFamily: CapabilityRefreshFamily;
  reasons: ReadonlySet<CapabilityRefreshReason>;
}

export type ProviderCapabilityRefreshQueue = Map<
  string,
  ProviderCapabilityRefreshRequest
>;

/** Queue one resume per chat. A chat already queued for the same family keeps
 * its other reasons; the new revision tells an in-flight resume that started
 * before this change that it must not consume the request. */
export function queueProviderCapabilityRefresh(
  queue: ProviderCapabilityRefreshQueue,
  chatIds: readonly string[],
  input: {
    providerFamily: CapabilityRefreshFamily;
    reason: CapabilityRefreshReason;
    revision: number;
  },
  maximum: number,
): void {
  for (const chatId of chatIds) {
    const existing = queue.get(chatId);
    const reasons = new Set<CapabilityRefreshReason>(
      existing?.providerFamily === input.providerFamily ? existing.reasons : [],
    );
    reasons.add(input.reason);
    queue.delete(chatId);
    queue.set(chatId, {
      revision: input.revision,
      providerFamily: input.providerFamily,
      reasons,
    });
    while (queue.size > maximum) {
      const oldest = queue.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      queue.delete(oldest);
    }
  }
}

/** Withdraw one reason. A resume another setting still needs stays queued. */
export function cancelProviderCapabilityRefresh(
  queue: ProviderCapabilityRefreshQueue,
  input: {
    providerFamily: CapabilityRefreshFamily;
    reason: CapabilityRefreshReason;
  },
): void {
  for (const [chatId, request] of [...queue]) {
    if (
      request.providerFamily !== input.providerFamily ||
      !request.reasons.has(input.reason)
    ) {
      continue;
    }
    const reasons = new Set(request.reasons);
    reasons.delete(input.reason);
    if (reasons.size === 0) queue.delete(chatId);
    else queue.set(chatId, { ...request, reasons });
  }
}
