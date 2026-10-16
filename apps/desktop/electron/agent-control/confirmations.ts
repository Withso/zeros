import { randomUUID } from "node:crypto";

import {
  isAgentControlConfirmationDecision,
  isAgentControlConfirmationRequest,
  type AgentControlConfirmationDecision,
  type AgentControlConfirmationRequest,
} from "@zeros/protocol/agent-control";

export type AgentControlConfirmationInput = Omit<
  AgentControlConfirmationRequest,
  "id" | "createdAt"
>;

interface PendingConfirmation {
  request: AgentControlConfirmationRequest;
  resolve: (decision: AgentControlConfirmationDecision) => void;
  timer: NodeJS.Timeout;
  detach: () => void;
}

interface AgentControlConfirmationBrokerOptions {
  onRequest?: (request: AgentControlConfirmationRequest) => void;
  onSettled?: (confirmationId: string) => void;
  timeoutMs?: number;
  maxPending?: number;
}

const DEFAULT_TIMEOUT_MS = 4 * 60_000;
const DEFAULT_MAX_PENDING = 16;

/** Main-process authority for app and simulator approvals. Requests are
 * created here, never by tool arguments, and anything other than an explicit
 * Allow from the trusted window denies: timeouts, aborts, a missing renderer
 * and a full queue. */
export class AgentControlConfirmationBroker {
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly onRequest?: (
    request: AgentControlConfirmationRequest,
  ) => void;
  private readonly onSettled?: (confirmationId: string) => void;
  private readonly timeoutMs: number;
  private readonly maxPending: number;

  constructor(options: AgentControlConfirmationBrokerOptions = {}) {
    this.onRequest = options.onRequest;
    this.onSettled = options.onSettled;
    this.timeoutMs = positive(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxPending = positive(options.maxPending ?? DEFAULT_MAX_PENDING);
  }

  confirm(
    input: AgentControlConfirmationInput,
    signal?: AbortSignal,
  ): Promise<AgentControlConfirmationDecision> {
    const request: AgentControlConfirmationRequest = {
      ...input,
      subject: input.subject.trim().replace(/\s+/g, " ").slice(0, 200),
      id: randomUUID(),
      createdAt: Date.now(),
    };
    if (
      signal?.aborted ||
      !this.onRequest ||
      this.pending.size >= this.maxPending ||
      !isAgentControlConfirmationRequest(request)
    ) {
      return Promise.resolve("deny");
    }
    return new Promise<AgentControlConfirmationDecision>((resolve) => {
      const timer = setTimeout(
        () => this.settle(request.id, "deny"),
        this.timeoutMs,
      );
      timer.unref?.();
      const onAbort = () => this.settle(request.id, "deny");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.id, {
        request,
        resolve,
        timer,
        detach: () => signal?.removeEventListener("abort", onAbort),
      });
      try {
        this.onRequest?.(request);
      } catch {
        this.settle(request.id, "deny");
      }
    });
  }

  respond(id: string, decision: AgentControlConfirmationDecision): boolean {
    if (!isAgentControlConfirmationDecision(decision)) return false;
    return this.settle(id, decision);
  }

  /** Recovery snapshot for a renderer that subscribed after a request went
   * out. A fresh array keeps renderer code from mutating main's state. */
  pendingRequests(): AgentControlConfirmationRequest[] {
    return [...this.pending.values()].map((pending) => ({
      ...pending.request,
    }));
  }

  /** Deny every request a conversation still has open. */
  denyOwner(workspaceId: string, conversationId: string): number {
    let denied = 0;
    for (const [id, pending] of [...this.pending]) {
      if (
        pending.request.workspaceId === workspaceId &&
        pending.request.conversationId === conversationId &&
        this.settle(id, "deny")
      ) {
        denied += 1;
      }
    }
    return denied;
  }

  denyPending(): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.settle(id, "deny");
    return ids.length;
  }

  private settle(id: string, decision: AgentControlConfirmationDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.detach();
    try {
      this.onSettled?.(id);
    } catch {
      // The decision stands; the renderer tombstone only clears a card.
    }
    pending.resolve(decision);
    return true;
  }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Agent control confirmation limits must be positive.");
  }
  return value;
}
