import { randomUUID } from "node:crypto";
import {
  CloudCommandClientRequestSchema, CloudCommandSnapshotSchema, CloudCommandEntrySchema, CloudCommandClaimSchema,
  type CloudCommandEngineRequest, type CloudCommandClaim, type CloudCommandResult, type CloudQueuedPrompt,
} from "@zeros/protocol/cloud-commands";
import { CloudCommandRuntimeError } from "./cloud-command-client";

type Dependencies = {
  request(input: CloudCommandEngineRequest,actorSessionId?:string): Promise<unknown>;
  validate(conversationId: string, payload?: CloudQueuedPrompt): void;
  execution(conversationId: string): string | null;
  /** Admission is engine-owned and may cold-resume without a connected device. */
  prepare?(claim:CloudCommandClaim):Promise<void>;
  /** Required with prepare: prove retirement before publishing the receipt. */
  retire?(claim:CloudCommandClaim):Promise<void>;
  dispatch(claim: CloudCommandClaim): Promise<Pick<CloudCommandResult, "state" | "resultCode">>;
  cancel(conversationId: string): Promise<void>;
  changed(conversationId: string): void;
};

/** Devices submit intentions. Only this engine-owned pump dispatches prompts.
 * No socket, client callback or renderer lifetime owns an accepted command. */
export class CloudCommandRuntime {
  private readonly pumping = new Map<string, { requested: boolean; task: Promise<void> }>();
  private readonly controls = new Map<string, { revision: number; paused: boolean }>();
  private readonly pendingConversations = new Set<string>();
  private readonly stopping = new Map<string, Set<symbol>>();
  private readonly unacknowledgedStop = new Set<string>();
  private readonly active = new Map<string, string>();
  private readonly claiming = new Set<string>();
  private readonly pendingClaims = new Map<string, { claimId: string; executionId: string }>();
  private readonly cancelledClaims = new Set<string>();
  private readonly unsettled = new Map<string, CloudCommandResult>();
  private readonly receiptRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryDelays = new Map<string, number>();
  private closed = false;
  constructor(private readonly dependencies: Dependencies) {
    if(Boolean(dependencies.prepare)!==Boolean(dependencies.retire))throw new Error("Cloud command admission requires paired retirement");
  }

  async handle(value: unknown,actorSessionId?:string): Promise<unknown> {
    const parsed = CloudCommandClientRequestSchema.safeParse(value);
    if (!parsed.success) throw new CloudCommandRuntimeError("invalid_command");
    const request = parsed.data;
    if (this.closed) throw new CloudCommandRuntimeError("engine_authority_rejected");
    const conversationId = request.kind === "read" ? null : request.kind === "mutate" ? request.mutation.conversationId : request.conversationId;
    let engineRequest: CloudCommandEngineRequest;
    if (request.kind === "mutate") {
      let admissionError: "command_context_changed" | "command_not_found" | null = null;
      try {
        this.dependencies.validate(request.mutation.conversationId);
        if (request.mutation.action.kind === "enqueue" || request.mutation.action.kind === "edit")
          this.dependencies.validate(request.mutation.conversationId, request.mutation.action.payload);
      } catch (error) {
        admissionError = error instanceof CloudCommandRuntimeError && error.code === "command_not_found"
          ? "command_not_found" : "command_context_changed";
      }
      // Only the authenticated engine supplies this field. CP resolves an old
      // operation receipt first, then rejects new work with stale context.
      engineRequest = { ...request, admissionError };
    } else {
      if (conversationId) this.dependencies.validate(conversationId);
      engineRequest = request;
    }
    // Block the local claim→dispatch gap immediately, before the Stop roundtrip.
    const stopIntent = request.kind === "stop" ? Symbol() : null;
    const stopCommand = conversationId ? this.active.get(conversationId) : undefined;
    if (request.kind === "stop" && stopIntent) {
      const intents = this.stopping.get(request.conversationId) ?? new Set<symbol>();
      intents.add(stopIntent); this.stopping.set(request.conversationId, intents);
    }
    let raw: unknown;
    try { raw = await (actorSessionId?this.dependencies.request(engineRequest,actorSessionId):this.dependencies.request(engineRequest)); }
    catch (error) {
      // Even an unacknowledged Stop cancels local activity. The caller receives
      // an error and can retry its same durable identity after recovery.
      if (request.kind === "stop" && stopIntent) {
        this.removeStopIntent(request.conversationId, stopIntent);
        // A definite rejection is not an unacknowledged Stop. A stale actor
        // cannot cancel another member's turn through the local fallback.
        if (error instanceof CloudCommandRuntimeError && ["cloud_actor_authority_rejected","invalid_command","engine_authority_rejected"].includes(error.code)) throw error;
        this.unacknowledgedStop.add(request.conversationId);
        if (stopCommand && this.active.get(request.conversationId) === stopCommand)
          await this.dependencies.cancel(request.conversationId);
      }
      throw error;
    }
    if (request.kind === "read") {
      const entry = CloudCommandEntrySchema.extend({ conversationId: CloudCommandSnapshotSchema.shape.conversationId }).parse(raw);
      if (entry.commandId !== request.commandId) throw new CloudCommandRuntimeError("command_response_invalid");
      this.dependencies.validate(entry.conversationId);
      return entry;
    }
    const snapshot = CloudCommandSnapshotSchema.parse(raw);
    if (snapshot.conversationId !== conversationId) throw new CloudCommandRuntimeError("command_response_invalid");
    this.observe(snapshot);
    if (request.kind === "stop" && stopIntent) {
      this.removeStopIntent(request.conversationId, stopIntent);
    }
    // An explicit successful Resume resolves a previously unacknowledged Stop.
    if (request.kind === "mutate" && request.mutation.action.kind === "resume" && !snapshot.paused &&
      this.controls.get(snapshot.conversationId)?.revision === snapshot.revision) this.unacknowledgedStop.delete(snapshot.conversationId);
    if (request.kind === "stop" && !snapshot.replayed) {
      const dispatched = snapshot.pending.find(command => command.state === "dispatching");
      if (dispatched) {
        if (this.active.get(request.conversationId) === dispatched.commandId) await this.dependencies.cancel(request.conversationId);
        else if (this.claiming.has(request.conversationId)) this.cancelledClaims.add(dispatched.commandId);
      }
    }
    this.dependencies.changed(snapshot.conversationId);
    this.kick(snapshot.conversationId);
    return snapshot;
  }

  kick(conversationId: string): void {
    if (this.closed) return;
    const existing = this.pumping.get(conversationId);
    if (existing) { existing.requested = true; return; }
    // CP accepts at most 32 pending commands per workspace. Bound even reads
    // of thousands of empty conversations while an endpoint is unavailable.
    if (this.pumping.size >= 32) return;
    if (!this.pendingClaims.has(conversationId) && !this.unsettled.has(conversationId) &&
      new Set([...this.pumping.keys(), ...this.pendingClaims.keys(), ...this.unsettled.keys()]).size >= 32) return;
    const state = { requested: true, task: Promise.resolve() };
    this.pumping.set(conversationId, state);
    state.task = Promise.resolve().then(async () => {
      do { state.requested = false; await this.drain(conversationId); }
      while (state.requested && !this.closed);
    }).catch(() => {
      // Retain the same claim identity until its response is known. No native
      // prompt starts before that response, and receipt retries never dispatch.
      this.dependencies.changed(conversationId);
    }).finally(() => {
      this.pumping.delete(conversationId);
      if (!this.closed && (this.unsettled.has(conversationId) || this.pendingClaims.has(conversationId)) && !this.receiptRetries.has(conversationId)) {
        const delay = this.retryDelays.get(conversationId) ?? 1000;
        this.retryDelays.set(conversationId, Math.min(delay * 2, 30000));
        const timer = setTimeout(() => { this.receiptRetries.delete(conversationId); this.kick(conversationId); }, delay);
        timer.unref?.(); this.receiptRetries.set(conversationId, timer);
      }
    });
  }

  /** A recovered durable channel or completed session admission can make a
   * queued conversation runnable without any client issuing another request. */
  wakePending(): void { for (const conversationId of this.pendingConversations) this.kick(conversationId); }

  private observe(snapshot: ReturnType<typeof CloudCommandSnapshotSchema.parse>): void {
    const previous = this.controls.get(snapshot.conversationId);
    if (previous && snapshot.revision < previous.revision) return;
    this.controls.set(snapshot.conversationId, { revision: snapshot.revision, paused: snapshot.paused });
    if (snapshot.pending.length) this.pendingConversations.add(snapshot.conversationId);
    else this.pendingConversations.delete(snapshot.conversationId);
  }

  private async drain(conversationId: string): Promise<void> {
    const unsettled = this.unsettled.get(conversationId);
    if (unsettled) {
      this.observe(CloudCommandSnapshotSchema.parse(await this.dependencies.request({ kind: "settle", result: unsettled })));
      this.unsettled.delete(conversationId);
      this.clearReceiptRetry(conversationId);
      this.dependencies.changed(conversationId);
    }
    while (!this.closed && (!this.blocked(conversationId) || this.pendingClaims.has(conversationId))) {
      const previous = this.pendingClaims.get(conversationId);
      const executionId = previous?.executionId ?? (this.dependencies.prepare?randomUUID():this.dependencies.execution(conversationId));
      if (!executionId) return; // Explicit session admission is still required.
      const intent = previous ?? { claimId: randomUUID(), executionId };
      this.pendingClaims.set(conversationId, intent);
      let raw: unknown;
      this.claiming.add(conversationId);
      try { raw = await this.dependencies.request({ kind: "claim", conversationId, ...intent }); }
      finally { this.claiming.delete(conversationId); }
      if (raw === null) { this.pendingClaims.delete(conversationId); this.clearReceiptRetry(conversationId); return; }
      const claim = CloudCommandClaimSchema.parse(raw);
      if (claim.conversationId !== conversationId || claim.executionId !== executionId || claim.claimId !== intent.claimId)
        throw new CloudCommandRuntimeError("command_response_invalid");
      this.pendingClaims.delete(conversationId);
      this.clearReceiptRetry(conversationId);
      this.dependencies.changed(conversationId);
      let result: Pick<CloudCommandResult, "state" | "resultCode">;
      const cancelledClaim = this.cancelledClaims.delete(claim.commandId);
      if (claim.dispatchAllowed===false) result={state:"cancelled",resultCode:"actor_authority_revoked"};
      else if (this.closed || this.blocked(conversationId) || cancelledClaim) result = { state: "cancelled", resultCode: "stopped_before_dispatch" };
      else {
        try {
          // Mode and execution may have changed while the claim was in flight.
          this.dependencies.validate(conversationId, claim.payload);
          this.active.set(conversationId, claim.commandId);
          await this.dependencies.prepare?.(claim);
          if(this.closed||this.blocked(conversationId))result={state:"cancelled",resultCode:"stopped_before_dispatch"};
          else {
            this.dependencies.validate(conversationId,claim.payload);
            if (this.dependencies.execution(conversationId) !== executionId) throw new Error("execution changed");
            result = await this.dependencies.dispatch(claim);
          }
        } catch { result = { state: "failed", resultCode: "command_dispatch_rejected" }; }
        // Dispatch is caught above, so retirement always runs. Its failure
        // closes the pump before a terminal receipt can be published.
        try { await this.dependencies.retire?.(claim); }
        catch(error) { this.close(); throw error; }
        finally { this.active.delete(conversationId); }
      }
      const receipt = { commandId: claim.commandId, claimId: claim.claimId, ...result };
      this.unsettled.set(conversationId, receipt);
      this.observe(CloudCommandSnapshotSchema.parse(await this.dependencies.request({ kind: "settle", result: receipt })));
      this.unsettled.delete(conversationId);
      this.clearReceiptRetry(conversationId);
      this.dependencies.changed(conversationId);
    }
  }

  private blocked(conversationId: string): boolean {
    return this.controls.get(conversationId)?.paused === true || this.stopping.has(conversationId) || this.unacknowledgedStop.has(conversationId);
  }
  private removeStopIntent(conversationId: string, intent: symbol): void {
    this.stopping.get(conversationId)?.delete(intent);
    if (this.stopping.get(conversationId)?.size === 0) this.stopping.delete(conversationId);
  }
  private clearReceiptRetry(conversationId: string): void {
    const timer = this.receiptRetries.get(conversationId); if (timer) clearTimeout(timer);
    this.receiptRetries.delete(conversationId); this.retryDelays.delete(conversationId);
  }

  /** Lifecycle fences stop new work; normal engine teardown cancels providers. */
  close(): void {
    this.closed = true;
    for (const timer of this.receiptRetries.values()) clearTimeout(timer);
    this.receiptRetries.clear(); this.retryDelays.clear();
  }
}
