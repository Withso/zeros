import { randomUUID } from "node:crypto";
import type { AttentionUpdate } from "@zeros/protocol/agent-events";
import type { NotifyUserInput, NotifyUserWorkerRequest } from "@zeros/protocol/notify-user";

/** How one NotifyUser call ended. `unreachable` still reached attached apps. */
export type NotifyUserOutcome = "sent" | "unreachable" | "already_notified" | "rate_limited" | "no_turn";
export type NotifyUserDelivery = "sent" | "already_notified" | "rate_limited";

const MAX_REMEMBERED_TURNS = 512;

/** notify-user-v1: once per turn here, and again on the server (409). Best
 * effort: delivery never blocks or fails the turn. */
export class NotifyUserService {
  private readonly notified = new Set<string>();
  constructor(private readonly deps: {
    /** The turn the tool's grant is running; `executionId` is the native execution identity, not the grant id. */
    activeTurn(grantId: string): { chatId: string; turnId: string; executionId: string } | undefined;
    /** The live `attention` update to every attached app. */
    publish(executionId: string, update: Omit<AttentionUpdate, "sessionUpdate">): Promise<void>;
    /** The worker route; absent without a control plane that supports it. */
    deliver?(request: NotifyUserWorkerRequest, signal: AbortSignal): Promise<NotifyUserDelivery>;
  }) {}

  async notify(grantId: string, input: NotifyUserInput, signal: AbortSignal): Promise<NotifyUserOutcome> {
    const turn = this.deps.activeTurn(grantId);
    if (!turn) return "no_turn";
    const key = `${turn.chatId}\n${turn.turnId}`;
    if (this.notified.has(key)) return "already_notified";
    this.notified.add(key);
    if (this.notified.size > MAX_REMEMBERED_TURNS) this.notified.delete(this.notified.values().next().value!);
    const notificationId = randomUUID();
    let outcome: NotifyUserOutcome = "unreachable";
    if (this.deps.deliver) {
      try { outcome = await this.deps.deliver({ notificationId, chatId: turn.chatId, userMessageId: turn.turnId, executionId: turn.executionId, ...input }, signal); }
      catch { outcome = "unreachable"; }
    }
    if (outcome === "sent" || outcome === "unreachable")
      await this.deps.publish(grantId, { notificationId, kind: input.kind, title: input.title, message: input.message }).catch(() => {});
    return outcome;
  }
}
