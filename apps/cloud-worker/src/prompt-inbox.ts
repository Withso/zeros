import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { CLOUD_V2_PROMPT_POLL_MS, CloudV2PromptPullReplySchema, CloudV2PromptStateSchema, CloudV2PromptStopReplySchema,
  type CloudV2PromptDelivery, type CloudV2PromptState } from "@zeros/protocol/cloud-v2-prompts";
import type { Agents } from "./agents";
import type { InboxEntry, SessionStore } from "./sessions/session-store";
import type { PromptOperation, PromptRequest } from "./transport";
import { WorkspaceError } from "./workspace/scope";

const ack = z.object({ state: CloudV2PromptStateSchema }).strict();
const begin = ack.extend({ dispatch: z.boolean() });
const terminal = (entry: InboxEntry) => entry.state !== "queued" && entry.state !== "running";
const httpStatus = (error: unknown) => error && typeof error === "object" && "status" in error ? error.status : undefined;

/** One process-owned outbound inbox. App sockets carry no delivery authority.
 * Only explicit sends exist here; polling never reports activity or wakes a VM.
 * Persist/ACK and provider dispatch are separate, durable checkpoints. */
export class PromptInbox {
  private readonly lifetime = new AbortController();
  private readonly held = new Set<string>();
  private polling?: AbortController;
  private hinted = true;
  private task?: Promise<void>;
  private unsubscribe?: () => void;

  constructor(private readonly store: SessionStore, private readonly agents: Agents, private readonly request: PromptRequest) {
    agents.setOutboxDispatch(entry => this.dispatch(entry), async (chatId, throughEpoch) => {
      const reply = CloudV2PromptStopReplySchema.parse(await this.call("stop", { chatId, throughEpoch }));
      if (reply.chatId !== chatId) throw new Error("Invalid conversation Stop receipt.");
      return reply.epoch;
    });
  }

  start(): void {
    if (this.task || this.lifetime.signal.aborted) return;
    this.unsubscribe = this.store.onChange(change => { if (change.flush) this.hint(); });
    this.task = this.run();
  }
  hint(): void { this.hinted = true; this.polling?.abort(); }
  async dispose(): Promise<void> {
    this.unsubscribe?.(); this.lifetime.abort(); this.polling?.abort();
    this.agents.setOutboxDispatch();
    await this.task;
  }

  private async call(operation: PromptOperation, body: unknown): Promise<unknown> {
    let attempt = 0;
    while (!this.lifetime.signal.aborted) {
      try { return await this.request(operation, body, this.lifetime.signal); }
      catch (error) {
        if (httpStatus(error) === 401) { this.fence(); throw error; }
        if ([400, 403, 404, 409].includes(Number(httpStatus(error)))) throw error;
        await delay(Math.min(2_000, 100 * 2 ** Math.min(attempt++, 5)), undefined, { signal: this.lifetime.signal, ref: false });
      }
    }
    throw new Error("Prompt delivery stopped.");
  }

  private fence(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(); this.polling?.abort(); this.unsubscribe?.();
    this.agents.setOutboxDispatch();
    // Do not await a route from its own begin() stack. The local Stop fence is
    // applied synchronously and its durable completion follows independently.
    void this.agents.fenceOutbox().catch(() => {});
  }

  private async dispatch(entry: InboxEntry): Promise<boolean> {
    const input = entry.outbox;
    if (!input?.acknowledged || !input.dispatchId) throw new Error("Prompt has no durable dispatch intent.");
    const reply = begin.parse(await this.call("begin", { userMessageId: entry.userMessageId,
      deliveryId: input.deliveryId, dispatchId: input.dispatchId }));
    return reply.dispatch;
  }

  private async report(): Promise<void> {
    for (const { chatId, entry } of this.store.outboxEntries()) {
      const outbox = entry.outbox!;
      const state: CloudV2PromptState | undefined = terminal(entry) ? entry.state as CloudV2PromptState
        : outbox.accepted && outbox.dispatchId ? "accepted" : undefined;
      if (!state || outbox.reported === state) continue;
      try {
        await this.call("outcome", { userMessageId: entry.userMessageId,
          ...(outbox.dispatchId ? { dispatchId: outbox.dispatchId } : { deliveryId: outbox.deliveryId }), state });
      } catch (error) {
        // Chat erasure and already-fenced receipts need no further repair. A
        // new boot never invents a new dispatch just to clear an old receipt.
        if (![404, 409].includes(Number(httpStatus(error)))) throw error;
      }
      await this.store.reportOutbox(chatId, entry.requestId, state);
      if (terminal(entry)) this.held.delete(entry.userMessageId);
    }
  }

  private async receive(item: CloudV2PromptDelivery): Promise<void> {
    let entry: InboxEntry;
    try { entry = await this.agents.receiveOutbox(item); }
    catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      // A refused provider/chat selection must unblock later messages, while
      // the CP retains this exact payload for a visible failure and explicit retry.
      await this.call("outcome", { userMessageId: item.receipt.userMessageId, deliveryId: item.deliveryId, state: "failed" });
      return;
    }
    const reply = ack.parse(await this.call("ack", { userMessageId: entry.userMessageId, deliveryId: item.deliveryId }));
    await this.store.acknowledgeOutbox(item.payload.chatId, entry.requestId, reply.state);
    this.held.add(entry.userMessageId);
    this.agents.resumeOutbox(item.payload.chatId);
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.lifetime.signal.aborted) {
      const started = Date.now();
      let hintAbortedPoll = false;
      try {
        await this.report();
        const controller = new AbortController(); this.polling = controller;
        const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
        const waitMs = this.hinted ? 0 : CLOUD_V2_PROMPT_POLL_MS; this.hinted = false;
        let batch;
        try { batch = CloudV2PromptPullReplySchema.parse(await this.request("pull", { waitMs, held: [...this.held] }, signal)); }
        catch (error) { hintAbortedPoll = controller.signal.aborted; throw error; }
        finally { this.polling = undefined; }
        for (const stop of batch.stops) {
          await this.agents.stopOutbox(stop.chatId, stop.epoch);
          await this.call("stop-ack", stop);
        }
        for (const item of batch.prompts) await this.receive(item);
        attempt = 0;
        // A proxy that prematurely ends an empty poll cannot create a hot loop.
        if (!batch.prompts.length && !batch.stops.length && Date.now() - started < 250)
          await delay(250, undefined, { signal: this.lifetime.signal, ref: false });
      } catch (error) {
        if (this.lifetime.signal.aborted) break;
        if (httpStatus(error) === 401) { this.fence(); break; }
        if (hintAbortedPoll && this.hinted) continue;
        try { await delay(Math.min(5_000, 250 * 2 ** Math.min(attempt++, 5)), undefined, { signal: this.lifetime.signal, ref: false }); }
        catch { break; }
      }
    }
  }
}
