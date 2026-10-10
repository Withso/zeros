import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isCloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import { CloudBootCommandClaimSchema, CloudCommandFailureError, cloudCommandFailureCode,
  cloudPermissionMode, decodeCloudCommandFailure, type CloudBootCommandClaim, type CloudCommandClaim,
  type CloudCommandResult } from "@zeros/protocol/cloud-commands";
import { legacyProviderBinding, type ProviderBinding } from "@zeros/protocol/identities";
import { createMessage, type EngineMessage } from "./types";
import type { TransportClient } from "./transport/types";
import { CloudCommandRuntimeError } from "./cloud-command-client";
import { cloudBootNativeAuthority, isCloudBootAgentExecutionFactory, isCloudBootAgentSelection,
  type CloudBootAgentExecutionFactory, type CloudBootAgentSelection, type CloudBootSelectionInput,
  type CloudBootTurnReservation, type CloudAgentExecutionLifetime } from "./agents/cloud-provider-execution";
import type { AgentGateway } from "./agents/gateway";

type Conversation = { id: string; folder: string; agentId: string | null; providerBinding?: ProviderBinding | null;
  sessionId?: string | null; permissionMode?: string | null; lastModeId?: string | null };
type Boot = { readonly active: boolean; selectClaim(claim: unknown): CloudBootAgentSelection;
  /** Drop the private claim reference; native retention/retirement belongs to
   * the pump and factory, not this bookkeeping operation. */
  releaseClaim(claim: CloudBootCommandClaim): void | Promise<void> };
export type CloudLocalCommandNativeRecord = { readonly claim: CloudCommandClaim; readonly receiver: TransportClient;
  readonly controller: AbortController; preparation: Promise<void>; ownsExecution: boolean };
type Record = CloudLocalCommandNativeRecord & { snapshot: CloudBootCommandClaim; selection: CloudBootAgentSelection | null;
  lifetime: CloudAgentExecutionLifetime | null; reservation: CloudBootTurnReservation | null;
  prepared: boolean; dispatched: boolean; retirement: Promise<void> | null; stop: Stop | null };
type Host = { provider: CloudBootCommandClaim["payload"]["agentId"]; executionId: string; lifetime: CloudAgentExecutionLifetime };
type Stop = { task: Promise<void>; proved: boolean; executions: Set<string> };
type Options = {
  boot(): Boot | null;
  factory(): CloudBootAgentExecutionFactory;
  gateway: Pick<AgentGateway, "reserveCloudBootTurn" | "cloudBootReservation" | "completeCloudForeground" |
    "endSession" | "cancel" | "setMode" | "updateConfig">;
  conversation(id: string): Conversation | null;
  execution(conversationId: string): string | null;
  busy(executionId: string): boolean;
  workspaceIdForCwd(cwd: string): string | null;
  handleAgentMessage(message: EngineMessage, receiver: TransportClient): Promise<void>;
  broadcast(message: EngineMessage): void;
  bindAdmission(receiver: TransportClient, claim: CloudCommandClaim): void;
  unbindAdmission(receiver: TransportClient): void;
  clearExecution(executionId: string): void;
  invalidateBind(conversationId: string): void;
  onRetirementFailure(error: unknown): void;
};
export type CloudLocalNativeExecutionInput = Omit<CloudBootSelectionInput, "executionId"> & { candidateExecutionId: string };

/** The local queue owns durable claim/terminal state. This pump owns its exact
 * native reservation and conversation scope, independently of client sockets.
 * It is installed only with the real activated boot writer; legacy and Local
 * admission never call it. All authority checks here are synchronous/local. */
export class CloudLocalCommandNativePump {
  private readonly records = new Map<string, Record>();
  private readonly hosts = new Map<string, Host>();
  private readonly stops = new Map<string, Promise<void>>();
  private readonly retirements = new Map<string, Promise<void>>();
  private closed = false;
  constructor(private readonly options: Options) {}

  private factory(): CloudBootAgentExecutionFactory {
    if (this.closed || !this.options.boot()?.active) throw new CloudCommandRuntimeError("cloud_commands_unavailable");
    const factory = this.options.factory();
    if (!isCloudBootAgentExecutionFactory(factory)) throw new CloudCommandRuntimeError("cloud_runtime_upgrade_required");
    return factory;
  }
  /** An actorless route is only a candidate. The queue calls this with its
   * ORIGINAL authorized actor/context before committing the exact native ID. */
  executionFor(input: CloudLocalNativeExecutionInput): string {
    const factory = this.factory();
    if (this.stops.has(input.conversationId)) throw new CloudCommandRuntimeError("command_conflict");
    const current = this.options.execution(input.conversationId);
    if (current && this.hosts.get(input.conversationId)?.executionId === current && !this.options.busy(current) &&
        factory.canRetainBootExecution({ ...input, executionId: current })) return current;
    return randomUUID();
  }
  retainedExecution(conversationId: string): string | null {
    if (this.closed || this.stops.has(conversationId)) return null;
    const host = this.hosts.get(conversationId);
    return host && this.options.execution(conversationId) === host.executionId ? host.executionId : null;
  }
  record(claim: CloudCommandClaim): CloudLocalCommandNativeRecord | null {
    const record = this.records.get(claim.commandId);
    if (!record) return null;
    this.exact(record, claim); return record;
  }
  private exact(record: Record, claim: CloudCommandClaim): void {
    if (record.claim !== claim || !isDeepStrictEqual(record.snapshot, claim)) throw new CloudCommandRuntimeError("command_conflict");
  }
  admissionSelection(claim: CloudCommandClaim): CloudBootAgentSelection {
    const record = this.records.get(claim.commandId);
    if (!record) throw new CloudCommandRuntimeError("cloud_actor_authority_rejected");
    this.exact(record, claim);
    if (record.controller.signal.aborted || !record.selection) throw new CloudCommandRuntimeError("cloud_actor_authority_rejected");
    this.factory().assertBootStart(record.selection); return record.selection;
  }
  claimForExecution(executionId: string): CloudCommandClaim | undefined {
    return [...this.records.values()].find(record => record.ownsExecution && record.claim.executionId === executionId)?.claim;
  }
  prepare(claim: CloudCommandClaim): Promise<void> {
    const parsed = CloudBootCommandClaimSchema.safeParse(claim);
    if (!parsed.success || !parsed.data.actor || parsed.data.dispatchAllowed !== true)
      return Promise.reject(new CloudCommandRuntimeError("cloud_actor_authority_rejected"));
    if (this.records.has(claim.commandId) || this.stops.has(claim.conversationId) ||
        [...this.records.values()].some(record => record.claim.conversationId === claim.conversationId))
      return Promise.reject(new CloudCommandRuntimeError("command_conflict"));
    if (this.records.size >= 32) return Promise.reject(new CloudCommandRuntimeError("command_limit"));
    let admissionError: Error | null = null;
    const receiver: TransportClient = { id: `cloud-command:${claim.commandId}`, kind: "cloud", close: () => {},
      cloudCommandActor: parsed.data.actor, accountUserId: parsed.data.actor.userId,
      send: message => {
        if (message.type === "AGENT_ERROR") {
          const code = isCloudAgentAdmissionCode(message.code) || decodeCloudCommandFailure(message.code)
            ? message.code : cloudCommandFailureCode(message, "provider_start");
          admissionError = Object.assign(new Error("Cloud native admission failed"), { code });
        }
        this.options.broadcast(message);
      } };
    const record: Record = { claim, snapshot: parsed.data, receiver, controller: new AbortController(),
      preparation: Promise.resolve(), ownsExecution: false, selection: null, lifetime: null, reservation: null,
      prepared: false, dispatched: false, retirement: null, stop: null };
    this.records.set(claim.commandId, record); this.options.bindAdmission(receiver, claim);
    record.preparation = Promise.resolve().then(async () => {
      const factory = this.factory(), selected = this.options.boot()!.selectClaim(claim);
      if (!isCloudBootAgentSelection(selected)) throw new CloudCommandFailureError({ stage: "validation", category: "access_denied" });
      factory.validateBootSelection(selected, { actor: selected.actor, provider: parsed.data.payload.agentId,
        model: parsed.data.payload.model, conversationId: claim.conversationId, executionId: claim.executionId,
        cwd: selected.cwd, cacheRevision: selected.cacheRevision });
      if (!isDeepStrictEqual(selected.actor.provenance.actor, parsed.data.actor))
        throw new CloudCommandRuntimeError("cloud_actor_authority_rejected");
      record.selection = selected; record.lifetime = cloudBootNativeAuthority(selected).lifetime;
      this.assertPreparing(record);
      const conversation = this.options.conversation(claim.conversationId);
      if (!conversation || conversation.id !== claim.conversationId || conversation.agentId !== parsed.data.payload.agentId ||
          conversation.folder !== selected.cwd) throw new CloudCommandRuntimeError("command_context_changed");
      const previous = this.options.execution(claim.conversationId);
      if (previous && this.options.busy(previous)) throw new CloudCommandRuntimeError("command_conflict");
      const env = { ...(parsed.data.payload.effort ? { ZEROS_THINKING_EFFORT: parsed.data.payload.effort } : {}),
        ZEROS_FAST_MODE: parsed.data.payload.fast ? "1" : "0", ZEROS_PERMISSION_MODE: cloudPermissionMode(parsed.data.payload.agentId,
          parsed.data.payload.permissionMode ?? conversation.lastModeId ?? conversation.permissionMode ?? "auto") };
      if (previous === claim.executionId && parsed.data.payload.operation?.kind !== "fork") {
        // The exact token exists before setMode/updateConfig can await/rebuild.
        record.reservation = this.options.gateway.reserveCloudBootTurn(parsed.data.payload.agentId, previous, selected);
        record.ownsExecution = true;
        const { ZEROS_PERMISSION_MODE: mode, ...config } = env;
        await this.options.gateway.setMode(parsed.data.payload.agentId, previous, mode);
        this.assertPreparing(record);
        await this.options.gateway.updateConfig(parsed.data.payload.agentId, previous, config);
      } else {
        if (previous) {
          const host = this.hosts.get(claim.conversationId);
          if (!host || host.executionId !== previous) throw new CloudCommandRuntimeError("command_context_changed");
          await this.retireHost(claim.conversationId, host);
        }
        this.assertPreparing(record); record.ownsExecution = true;
        const workspaceId = this.options.workspaceIdForCwd(selected.cwd);
        if (!workspaceId) throw new CloudCommandRuntimeError("command_context_changed");
        const binding = conversation.providerBinding ?? (conversation.sessionId
          ? legacyProviderBinding(parsed.data.payload.agentId, conversation.sessionId) : null);
        const common = { source: "engine" as const, agentId: parsed.data.payload.agentId, chatId: conversation.id, workspaceId, env };
        const invalidate = () => this.options.invalidateBind(claim.conversationId);
        record.controller.signal.addEventListener("abort", invalidate, { once: true });
        try {
          const operation = parsed.data.payload.operation;
          if (operation?.kind === "fork" && binding) throw new CloudCommandRuntimeError("command_context_changed");
          const message = operation?.kind === "fork" && operation.strategy === "native"
            ? createMessage({ ...common, type: "AGENT_FORK_CONVERSATION", sourceChatId: operation.sourceConversationId, destinationChatId: conversation.id })
            : binding ? createMessage({ ...common, type: "AGENT_LOAD_SESSION", providerBinding: binding })
            : createMessage({ ...common, type: "AGENT_NEW_SESSION" });
          await this.options.handleAgentMessage({ ...message, id: claim.commandId }, receiver);
          if (admissionError) throw admissionError;
        } finally { record.controller.signal.removeEventListener("abort", invalidate); }
        if (parsed.data.payload.operation?.kind !== "fork") {
          if (this.options.execution(claim.conversationId) !== claim.executionId) throw new CloudCommandRuntimeError("command_context_changed");
          record.reservation = this.options.gateway.cloudBootReservation(parsed.data.payload.agentId, claim.executionId);
          if (!record.reservation) throw new CloudCommandRuntimeError("cloud_actor_authority_rejected");
        }
      }
      this.assertPreparing(record);
      if (parsed.data.payload.operation?.kind !== "fork") this.hosts.set(claim.conversationId,
        { provider: parsed.data.payload.agentId, executionId: claim.executionId, lifetime: record.lifetime });
      record.prepared = true;
    });
    return record.preparation;
  }
  private assertPreparing(record: Record): void {
    this.exact(record, record.claim);
    if (record.controller.signal.aborted) throw new CloudCommandRuntimeError("command_conflict");
    this.factory().assertBootStart(record.selection!);
  }
  assertDispatch(claim: CloudCommandClaim): void {
    const record = this.records.get(claim.commandId);
    if (!record || !record.prepared || record.dispatched) throw new CloudCommandRuntimeError("command_conflict");
    this.exact(record, claim);
    this.assertPreparing(record);
    if (record.snapshot.payload.operation?.kind !== "fork" && (!record.reservation || this.options.execution(claim.conversationId) !== claim.executionId))
      throw new CloudCommandRuntimeError("command_context_changed");
    record.dispatched = true;
  }
  private failure(error: unknown): void {
    try { void Promise.resolve(this.options.onRetirementFailure(error)).catch(() => {}); } catch { /* Keep the proof failure. */ }
  }
  private retireHost(conversationId: string, host: Host): Promise<void> {
    const current = this.retirements.get(host.executionId); if (current) return current;
    // close invalidates native authority before any asynchronous proof.
    const close = host.lifetime.close(); void close.catch(() => {});
    const task = (async () => {
      await close; await this.options.gateway.endSession(host.provider, host.executionId, { failClosed: true });
      this.options.clearExecution(host.executionId);
      if (this.hosts.get(conversationId)?.executionId === host.executionId) this.hosts.delete(conversationId);
    })().catch(error => { this.failure(error); throw error; });
    this.retirements.set(host.executionId, task);
    void task.finally(() => { if (this.retirements.get(host.executionId) === task) this.retirements.delete(host.executionId); }).catch(() => {});
    return task;
  }
  private async joinStop(record: Record): Promise<boolean> {
    const stop = record.stop; if (!stop) return false;
    await stop.task;
    if (!stop.proved || record.ownsExecution && !stop.executions.has(record.snapshot.executionId))
      throw new CloudCommandFailureError({ stage: "containment", category: "attestation_failed" });
    return true;
  }
  retire(claim: CloudCommandClaim, result: Pick<CloudCommandResult, "state">): Promise<void> {
    const record = this.records.get(claim.commandId);
    if (!record) {
      // Validation can refuse a durably claimed intent before prepare takes
      // native ownership. Only the boot's exact private claim map may release
      // that unused selection; an execution ID never authorizes old cleanup.
      const parsed = CloudBootCommandClaimSchema.safeParse(claim), boot = this.options.boot();
      if (!parsed.success || !boot || result.state === "succeeded" ||
          [...this.records.values()].some(current => current.claim.executionId === claim.executionId))
        return Promise.reject(new CloudCommandRuntimeError("command_conflict"));
      return Promise.resolve().then(() => boot.releaseClaim(parsed.data));
    }
    this.exact(record, claim); if (record.retirement) return record.retirement;
    record.retirement = (async () => {
      await record.preparation.catch(() => {});
      if (record.ownsExecution && result.state === "succeeded" && record.dispatched && !record.controller.signal.aborted &&
          !record.snapshot.payload.operation && record.reservation) {
        try {
          const retained = await this.options.gateway.completeCloudForeground(claim.payload.agentId, claim.executionId, undefined, record.reservation);
          if (!retained) throw new CloudCommandFailureError({ stage: "containment", category: "attestation_failed" });
        } catch (error) {
          // A Stop can positively retire this exact scope while the native
          // background probe is awaiting. That scope is no longer warm; its
          // original positive whole proof replaces foreground retention.
          // A failed Stop proof retains its own cause and cannot be masked.
          if (!await this.joinStop(record)) throw error;
        }
      } else {
        if (record.lifetime) await record.lifetime.close();
        if (record.ownsExecution) await this.retireHost(claim.conversationId, { provider: record.snapshot.payload.agentId,
          executionId: claim.executionId, lifetime: record.lifetime! });
      }
      await this.joinStop(record);
      await this.options.boot()!.releaseClaim(record.snapshot);
      await this.joinStop(record);
      this.options.unbindAdmission(record.receiver); this.records.delete(claim.commandId);
    })().catch(error => { this.failure(error); throw error; });
    return record.retirement;
  }
  cancel(conversationId: string): Promise<void> {
    const existing = this.stops.get(conversationId); if (existing) return existing;
    const records = [...this.records.values()].filter(record => record.claim.conversationId === conversationId);
    const stop: Stop = { task: Promise.resolve(), proved: false, executions: new Set() };
    const closures: Promise<void>[] = [];
    for (const record of records) {
      record.stop = stop;
      record.controller.abort();
      if (record.lifetime) closures.push(record.lifetime.close());
    }
    const host = this.hosts.get(conversationId);
    if (host) {
      closures.push(host.lifetime.close());
      // Provider cancellation is best effort; the whole scope's positive
      // retirement, including descendants, is the authoritative Stop proof.
      void this.options.gateway.cancel(host.provider, host.executionId).catch(() => {});
    }
    for (const closure of closures) void closure.catch(() => {});
    this.options.invalidateBind(conversationId);
    const task = (async () => {
      await Promise.all(records.map(record => record.preparation.catch(() => {})));
      // A start fence can reject selectClaim before its original capture is
      // consumed. Stop owns that exact FULL-stored unused capture too; a
      // later receipt cleanup cannot substitute for this empty-scope proof.
      for (const record of records) if (!record.selection) {
        const boot = this.options.boot();
        if (!boot) throw new CloudCommandRuntimeError("cloud_commands_unavailable");
        await boot.releaseClaim(record.snapshot);
      }
      // A pre-prepare Stop can run before its microtask captures the selected
      // authority. The final proof also owns that late, unused lifetime.
      await Promise.all([...closures, ...records.flatMap(record => record.lifetime ? [record.lifetime.close()] : [])]);
      const owned = new Map<string, Host>(); if (host) owned.set(host.executionId, host);
      for (const record of records) if (record.ownsExecution && record.lifetime) owned.set(record.claim.executionId,
        { provider: record.snapshot.payload.agentId, executionId: record.claim.executionId, lifetime: record.lifetime });
      await Promise.all([...owned.values()].map(value => this.retireHost(conversationId, value)));
      for (const id of owned.keys()) stop.executions.add(id);
      stop.proved = true;
    })().catch(error => { this.failure(error); throw error; });
    stop.task = task;
    this.stops.set(conversationId, task);
    void task.finally(() => { if (this.stops.get(conversationId) === task) this.stops.delete(conversationId); }).catch(() => {});
    return task;
  }
  async dispose(): Promise<void> {
    this.closed = true;
    const conversations = new Set([...this.hosts.keys(), ...[...this.records.values()].map(record => record.claim.conversationId)]);
    const settled = await Promise.allSettled([...conversations].map(id => this.cancel(id)));
    const failed = settled.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
