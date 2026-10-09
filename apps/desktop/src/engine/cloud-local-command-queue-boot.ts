import { mkdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CloudAgentBootCredentialRequestSchema, CloudAgentBootCredentialResponseSchema, CloudAgentBootActivateResponseSchema,
  CloudAgentBootScopeSchema, CloudAgentBootConversationSchema, CloudActorProvenanceSchema,
  type CloudAgentBootScope, type CloudAgentBootConversation, type CloudAgentWarmActorRequest,
} from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudBootCommandClaimSchema, type CloudBootCommandClaim } from "@zeros/protocol/cloud-commands";
import { CloudActorAuthorityRegistry, type CloudAuthorizedActor, type CloudAgentLeaseSupervisor } from "./agents/cloud-agent-lease";
import { CloudAgentCredentialCache } from "./agents/cloud-agent-credential-cache";
import { CloudAgentContextCache, createCloudBootAgentExecutionFactory, cloudBootNativeAuthority, type CloudAgentExecutionFactory,
  type CloudBootAgentExecutionFactory, type CloudBootAgentSelection, type CloudBootSelectionInput,
  type CloudAgentExecutionLifetime } from "./agents/cloud-provider-execution";
import { CloudLocalCommandQueue, type CloudLocalCommandHistory } from "./cloud-local-command-queue";
import { CloudCredentialStartFences, CloudAgentCredentialControlExchangeResponseSchema, CloudCredentialControlError } from "./cloud-local-command-queue-start-fences";
import { CloudCommandRuntimeError } from "./cloud-command-client";
import { CloudAgentExecutionError } from "./cloud-agent-execution-client";
import type { CloudRuntimeRegistration, CloudRuntimeClientAdmission } from "./cloud-runtime-registration";

type Reference = Pick<CloudAgentBootScope, "organizationId" | "workspaceId" | "generation" | "engineInstanceId">;
type Conversation = { provider: "claude" | "codex" | "cursor"; model: string; cwd: string };
type Interest = Conversation & { conversationId: string; sessionId: string; timer: ReturnType<typeof setTimeout> | null;
  flight: Promise<void> | null; proof: { contextId: string; confirmedUntilMs: number } | null; confirmedUntilMs: number };
type Actor = { admission: CloudRuntimeClientAdmission; confirmedUntilMs: number; timer: ReturnType<typeof setTimeout> | null };
type Options = {
  file: string; scope: Reference; runtimeBootId: string;
  registration: Pick<CloudRuntimeRegistration, "localCommandsNegotiated" | "agentBootRequest" | "credentialControlsRequest">;
  legacy: CloudAgentExecutionFactory; supervisor: CloudAgentLeaseSupervisor; engineLive(): boolean;
  isAdmittedCwd(cwd: string, actor: CloudAuthorizedActor): boolean;
  resolveConversation(conversationId: string): Conversation | null;
  executionFor?(input: Omit<CloudBootSelectionInput, "executionId"> & { candidateExecutionId: string }): string;
  history(): CloudLocalCommandHistory;
  captureHistory?: ConstructorParameters<typeof CloudLocalCommandQueue>[0]["captureHistory"];
  /** Holds the old pump while proving it has no request/claim/native owner. */
  beforeActivate(): Promise<void>;
  /** Synchronous publication of the original factory and the one queue pump. */
  install(factory: CloudBootAgentExecutionFactory, queue: CloudLocalCommandQueue): void | Promise<void>;
  changed(conversationId?: string): void;
  /** Exact registration authority while only final record/mirror drain is
   * permitted. Never publishes a new actor or extends a cached deadline. */
  confirmedAuthority?(): boolean;
  /** Admission fences stop new actors/claims without pretending the last
   * confirmed authority needed for final replication has been revoked. */
  startsAllowed?(): boolean;
};

/** Registration establishes a candidate; only an exact activation response
 * publishes a local writer. All provider/actor/context requests are explicit
 * background work. Selection, queue acceptance and native guards never fetch. */
export class CloudLocalAgentBootRuntime {
  private readonly controller = new AbortController();
  private initializing: Promise<boolean> | null = null;
  private closed = false;
  private activated = false;
  private sealing = false;
  private scopeValue: CloudAgentBootScope | null = null;
  private registry: CloudActorAuthorityRegistry | null = null;
  private credentials: CloudAgentCredentialCache | null = null;
  private contexts: CloudAgentContextCache | null = null;
  private factory: CloudBootAgentExecutionFactory | null = null;
  private queueValue: CloudLocalCommandQueue | null = null;
  private fencesValue: CloudCredentialStartFences | null = null;
  private readonly actors = new Map<string, Actor>();
  private readonly interests = new Map<string, Interest>();
  private readonly flights = new Set<Promise<unknown>>();
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private controlsTimer: ReturnType<typeof setTimeout> | null = null;
  private controlsFlight: Promise<void> | null = null;
  private readonly selections = new Map<string, { commandId: string; conversationId: string; payload: CloudBootCommandClaim["payload"];
    selection: CloudBootAgentSelection; lifetime: CloudAgentExecutionLifetime; consumed: boolean }>();

  constructor(private readonly options: Options) {}
  private live(): boolean { try { return !this.closed && this.options.engineLive(); } catch { return false; } }
  get authorityActive(): boolean { return this.activated && this.live() && (this.sealing && this.options.confirmedAuthority ?
    this.options.confirmedAuthority() : this.options.registration.localCommandsNegotiated()); }
  get active(): boolean { return !this.sealing && this.authorityActive && (this.options.startsAllowed?.() ?? true); }
  get scope(): CloudAgentBootScope {
    if (!this.scopeValue || !this.live()) throw new CloudCommandRuntimeError("engine_authority_rejected");
    return this.scopeValue;
  }
  get metadata(): CloudAgentBootConversation {
    if (!this.active || !this.credentials) throw new CloudCommandRuntimeError("cloud_commands_unavailable");
    return CloudAgentBootConversationSchema.parse(this.credentials.metadata);
  }
  metadataFor(sessionId: string): CloudAgentBootConversation {
    if (!this.active || !this.registry || !this.actors.has(sessionId)) throw new CloudCommandRuntimeError("cloud_actor_authority_rejected");
    try { this.registry.authorizeCurrent(sessionId, "read"); }
    catch { throw new CloudCommandRuntimeError("cloud_actor_authority_rejected"); }
    return this.metadata;
  }
  authorizeActor(sessionId: string, capability: "read" | "run") {
    if (!this.active || !this.registry || !this.actors.has(sessionId))
      throw new CloudCommandRuntimeError("cloud_actor_authority_rejected");
    try { return this.registry.authorizeCurrent(sessionId, capability); }
    catch { throw new CloudCommandRuntimeError("cloud_actor_authority_rejected"); }
  }
  get executionFactory(): CloudBootAgentExecutionFactory {
    if (!this.live() || !this.factory) throw new CloudCommandRuntimeError("cloud_commands_unavailable");
    return this.factory;
  }
  revokeActor(sessionId: string): void {
    const record = this.actors.get(sessionId); if (record?.timer) clearTimeout(record.timer);
    this.actors.delete(sessionId); this.registry?.revoke(sessionId);
  }
  get queue(): CloudLocalCommandQueue {
    if (!this.active || !this.queueValue) throw new CloudCommandRuntimeError("cloud_commands_unavailable");
    return this.queueValue;
  }
  get fences(): CloudCredentialStartFences {
    if (!this.active || !this.fencesValue) throw new CloudCommandRuntimeError("cloud_commands_unavailable");
    return this.fencesValue;
  }
  private reference() {
    const { fundingOwnerUserId: _owner, fundingOwnerEpoch: _epoch, ...reference } = this.scope;
    return { ...reference, version: 1 as const, mode: "boot-owner-v1" as const };
  }
  initialize(): Promise<boolean> {
    if (!this.live()) return Promise.reject(new CloudCommandRuntimeError("engine_authority_rejected"));
    if (this.activated) return Promise.resolve(true);
    if (this.initializing) return this.initializing;
    if (!this.options.registration.localCommandsNegotiated()) return Promise.resolve(false);
    const task = this.initializeBoot(); this.initializing = task;
    void task.finally(() => { if (this.initializing === task) this.initializing = null; }).catch(() => {});
    return task;
  }
  private async initializeBoot(): Promise<boolean> {
    // Bootstrap is single-flight. An unknown activation ACK never reconstructs
    // or reopens a ledger, since reopen quarantines unverified accepted intent.
    if (!this.credentials) {
      const request = CloudAgentBootCredentialRequestSchema.parse({ ...this.options.scope, version: 1, mode: "boot-owner-v1" });
      const response = CloudAgentBootCredentialResponseSchema.parse(await this.options.registration.agentBootRequest(
        "bootstrap", request, this.controller.signal));
      if (!this.live() || Object.entries(this.options.scope).some(([key, value]) => response[key as keyof typeof response] !== value) ||
          response.bootId !== this.options.runtimeBootId) throw new CloudAgentExecutionError("authority_response_invalid");
      this.scopeValue = Object.freeze(CloudAgentBootScopeSchema.parse(Object.fromEntries(
        Object.keys(CloudAgentBootScopeSchema.shape).map(key => [key, response[key as keyof typeof response]]))));
      this.registry = new CloudActorAuthorityRegistry({ scope: this.scope, engineLive: () => this.live() });
      this.credentials = new CloudAgentCredentialCache({ scope: this.scope, engineLive: () => this.live(), request: {
        bootstrap: async () => response,
        sync: (body, signal) => this.options.registration.agentBootRequest("sync", body, signal),
        refresh: (body, signal) => this.options.registration.agentBootRequest("refresh", body, signal),
      } });
      await this.credentials.initialize(this.controller.signal);
      this.contexts = new CloudAgentContextCache({ scope: this.scope, registry: this.registry, engineLive: () => this.live(),
        isAdmittedCwd: (cwd, actor) => this.options.isAdmittedCwd(cwd, actor),
        request: (body, signal) => this.requestContext(body, signal) });
      mkdirSync(path.dirname(this.options.file), { recursive: true, mode: 0o700 });
      this.fencesValue = new CloudCredentialStartFences({ file: this.options.file, scope: this.scope, engineLive: () => this.live(),
        associationFloor: (provider,credentialId) => this.credentials!.associationFloor(provider,credentialId),
        activity: selectors => this.factory?.bootScopeActivity(selectors) ?? { complete: false, foreground: 0, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [] },
        retire: selectors => this.factory ? this.factory.retireBootCredentials(selectors) : Promise.reject(new CloudCommandRuntimeError("engine_authority_rejected")),
        markDesired: revision => this.credentials!.markDesired(revision), readyRevision: () => this.credentials!.metadata.cacheRevision,
        synchronize: () => this.credentials!.synchronize(this.controller.signal) });
      this.factory = createCloudBootAgentExecutionFactory({ legacy: this.options.legacy, registry: this.registry,
        credentials: this.credentials, contexts: this.contexts, engineLive: () => this.live(), supervisor: this.options.supervisor,
        canStart: run => !this.sealing && (this.options.startsAllowed?.() ?? true) && this.fencesValue!.canStart(run) });
      this.queueValue = new CloudLocalCommandQueue({ file: this.options.file, scope: this.scope, actors: this.registry,
        ...(this.options.captureHistory ? { captureHistory: this.options.captureHistory } : {}),
        engineLive: () => this.live(), history: () => this.options.history(), ready: (payload, provenance, conversationId) => {
          const material = this.credentials!.readiness(payload.agentId, payload.model);
          if (material.state === "pending") return false;
          if (material.state === "unavailable") return true; // Exact typed admission failure, never another credential.
          const conversation = this.options.resolveConversation(conversationId);
          if (!conversation) return false;
          try {
            const actor = this.registry!.reauthorizeRecorded(provenance, "run");
            return this.contexts!.readiness({ actor, provider: payload.agentId, model: payload.model,
              conversationId, cwd: conversation.cwd }).state === "ready";
          } catch { return false; }
        }, selectExecution: input => {
          const conversation = this.options.resolveConversation(input.conversationId);
          if (!conversation || conversation.provider !== input.payload.agentId) return null;
          const ready = this.credentials!.readiness(input.payload.agentId, input.payload.model);
          if (ready.state === "pending") return null;
          if (ready.state === "unavailable") return { executionId: input.candidateExecutionId };
          if (this.selections.has(input.claimId) || this.selections.size >= 32) return null;
          const context = this.contexts!.authorize({ actor: input.actor, provider: input.payload.agentId, model: input.payload.model,
            conversationId: input.conversationId, cwd: conversation.cwd });
          const selectionInput = { actor: input.actor, context, provider: input.payload.agentId, model: input.payload.model,
            conversationId: input.conversationId, cwd: conversation.cwd, candidateExecutionId: input.candidateExecutionId };
          const executionId = this.options.executionFor?.(selectionInput) ?? input.candidateExecutionId;
          const selection = this.factory!.selectBoot({ ...selectionInput, executionId });
          const lifetime = cloudBootNativeAuthority(selection).lifetime;
          try { this.factory!.assertBootStart(selection); }
          catch { this.closeUnused(lifetime); return null; }
          this.selections.set(input.claimId, { commandId: input.commandId, conversationId: input.conversationId,
            payload: structuredClone(input.payload), selection, lifetime, consumed: false });
          return { executionId, credentialRun: selection.credentialRun };
        }, selectionRolledBack: claimId => {
          const record = this.selections.get(claimId);
          if (record) { this.closeUnused(record.lifetime); this.selections.delete(claimId); }
        } });
      this.scheduleCache();
    }
    const credentials = this.credentials, metadata = credentials.metadata;
    if (metadata.desiredCacheRevision > metadata.cacheRevision) {
      await credentials.synchronize(this.controller.signal);
      if (credentials.metadata.desiredCacheRevision > credentials.metadata.cacheRevision)
        throw new CloudCommandRuntimeError("cloud_agent_credential_refresh_required");
    }
    this.queueValue!.durability(); await this.options.beforeActivate();
    const activated = CloudAgentBootActivateResponseSchema.parse(await this.options.registration.agentBootRequest("activate",
      { ...this.reference(), expectedCacheRevision: credentials.metadata.cacheRevision }, this.controller.signal));
    if (!this.live() || Object.entries(this.scope).some(([key, value]) => activated[key as keyof typeof activated] !== value))
      throw new CloudAgentExecutionError("authority_response_invalid");
    // ACK can prove a newer ready floor, but carries no credential material.
    // Keep starts parked until background sync positively installs that floor.
    if (activated.cacheRevision > credentials.metadata.cacheRevision) {
      credentials.markDesired(activated.cacheRevision); await credentials.synchronize(this.controller.signal);
    }
    if (credentials.metadata.cacheRevision < activated.cacheRevision || credentials.metadata.desiredCacheRevision > credentials.metadata.cacheRevision)
      throw new CloudCommandRuntimeError("cloud_agent_credential_refresh_required");
    await this.options.install(this.factory!, this.queueValue!);
    if (!this.live()) throw new CloudCommandRuntimeError("engine_authority_rejected");
    this.activated = true; this.scheduleControls(); this.options.changed(); return true;
  }
  /** Independent of Send and socket lifetime. The FULL ACK is retained until
   * the entire strict current-scope exchange succeeds; unknown HTTP responses
   * resend the same immutable ACK rather than recomputing native inventory. */
  pollCredentialControls(): Promise<void> {
    if (this.controlsFlight) return this.controlsFlight;
    if (!this.active) return Promise.reject(new CloudCommandRuntimeError("engine_authority_rejected"));
    const task = (async () => {
      const scope = this.scope, ack = this.fencesValue!.pendingAcknowledgement();
      const { fundingOwnerUserId: _owner, fundingOwnerEpoch: _epoch, ...reference } = scope;
      const response = CloudAgentCredentialControlExchangeResponseSchema.parse(await this.options.registration.credentialControlsRequest(
        { ...reference, version: 1, mode: "boot-owner-v1", acknowledgements: ack ? [ack] : [] }, this.controller.signal));
      if (!this.active || response.controls.some(control => Object.entries(scope).some(([key, value]) => control[key as keyof typeof control] !== value)))
        throw new CloudCredentialControlError("credential_control_authority_rejected");
      if (ack) this.fencesValue!.confirmAcknowledgement(ack);
      // Each call synchronously installs its FULL start fence before awaiting
      // refresh or native retirement. No later control is hidden behind I/O.
      await Promise.all(response.controls.map(control => this.fencesValue!.handle(control)));
      this.options.changed(); this.scheduleCache();
    })().catch(error => {
      if (error && typeof error === "object" && "code" in error &&
          ["engine_authority_rejected", "credential_control_authority_rejected"].includes(String(error.code))) {
        this.activated = false; this.options.supervisor.onRetirementFailure(error);
      }
      throw error;
    });
    this.controlsFlight = task; this.flights.add(task);
    void task.finally(() => { if (this.controlsFlight === task) this.controlsFlight = null; this.flights.delete(task); this.scheduleControls(); }).catch(() => {});
    return task;
  }
  private scheduleControls(): void {
    if (this.controlsTimer) clearTimeout(this.controlsTimer);
    if (!this.active) return;
    this.controlsTimer = setTimeout(() => { this.controlsTimer = null; void this.pollCredentialControls().catch(() => {}); }, 500);
    this.controlsTimer.unref?.();
  }
  async confirmAdmission(admission: CloudRuntimeClientAdmission): Promise<void> {
    if (!this.active) return;
    const actor = admission.actor;
    if (!actor || !admission.accountUserId) throw new CloudCommandRuntimeError("cloud_actor_authority_rejected");
    const result = await this.options.registration.agentBootRequest("actor-confirm",
      { ...this.reference(), actorSessionId: actor.sessionId }, this.controller.signal);
    const proof = CloudActorProvenanceSchema.parse(result.provenance);
    if (!this.active || !isDeepStrictEqual(proof.scope, this.scope) || proof.actorSessionId !== actor.sessionId ||
        proof.actor.userId !== admission.accountUserId || proof.authorityEpoch !== admission.authorityEpoch ||
        proof.actor.deviceId !== actor.deviceId || proof.actor.role !== actor.role || proof.actor.fingerprint !== actor.fingerprint)
      throw new CloudCommandRuntimeError("cloud_actor_authority_rejected");
    this.registry!.confirm(proof);
    const previous = this.actors.get(actor.sessionId);
    if (previous?.timer) clearTimeout(previous.timer);
    if (!previous && this.actors.size >= 256) throw new CloudCommandRuntimeError("cloud_actor_authority_rejected");
    const record = { admission, confirmedUntilMs: proof.confirmedUntilMs, timer: null }; this.actors.set(actor.sessionId, record);
    this.schedule(record, (proof.confirmedUntilMs - Date.now()) / 2, () => this.confirmAdmission(admission),
      () => this.actors.get(actor.sessionId) === record && Date.now() < record.confirmedUntilMs);
  }
  observeConversation(sessionId: string, conversationId: string): Promise<void> {
    if (!this.active) return Promise.reject(new CloudCommandRuntimeError("cloud_commands_unavailable"));
    const conversation = this.options.resolveConversation(conversationId);
    if (!conversation || !this.actors.has(sessionId)) return Promise.reject(new CloudCommandRuntimeError("cloud_actor_authority_rejected"));
    const key = JSON.stringify([sessionId, conversationId, conversation.provider, conversation.model, conversation.cwd]);
    let interest = this.interests.get(key);
    if (interest) return interest.flight ?? Promise.resolve();
    {
      if (this.interests.size >= 32) return Promise.reject(new CloudCommandRuntimeError("command_limit"));
      interest = { ...conversation, sessionId, conversationId, timer: null, flight: null, proof: null, confirmedUntilMs: 0 }; this.interests.set(key, interest);
    }
    return this.warmInterest(interest);
  }
  private async requestContext(body: CloudAgentWarmActorRequest, signal: AbortSignal) {
    const response = await this.options.registration.agentBootRequest("warm-context", body, signal);
    const interest = this.interests.get(JSON.stringify([body.actorSessionId, body.conversationId, body.provider, body.model, body.cwd]));
    if (interest) interest.proof = { contextId: response.contextId, confirmedUntilMs: response.actor.confirmedUntilMs };
    return response;
  }
  private warmInterest(interest: Interest): Promise<void> {
    if (interest.flight) return interest.flight;
    if (!this.active) return Promise.resolve();
    const task = (async () => {
      const actor = this.registry!.authorizeCurrent(interest.sessionId, "run");
      const context = await this.contexts!.warm({ actor, provider: interest.provider, model: interest.model, conversationId: interest.conversationId,
        cwd: interest.cwd }, this.controller.signal);
      if (!this.active) return;
      // The cache independently validates the response. Its original context
      // identity then binds this deadline; actor-only renewals cannot extend it.
      if (!interest.proof || interest.proof.contextId !== context.contextId) throw new CloudAgentExecutionError("authority_response_invalid");
      interest.confirmedUntilMs = interest.proof.confirmedUntilMs;
      this.options.changed(interest.conversationId);
      this.schedule(interest, (interest.confirmedUntilMs - Date.now()) / 2, () => this.warmInterest(interest),
        () => Date.now() < interest.confirmedUntilMs);
    })();
    interest.flight = task; this.flights.add(task);
    void task.finally(() => { if (interest.flight === task) interest.flight = null; this.flights.delete(task); }).catch(() => {});
    return task;
  }
  selectClaim(value: unknown): CloudBootAgentSelection {
    if (!this.active) throw new CloudCommandRuntimeError("cloud_commands_unavailable");
    const claim = CloudBootCommandClaimSchema.parse(value), actor = this.queue.authorizeClaim(claim);
    const conversation = this.options.resolveConversation(claim.conversationId);
    if (!conversation || conversation.provider !== claim.payload.agentId) throw new CloudCommandRuntimeError("command_context_changed");
    const ready = this.credentials!.readiness(claim.payload.agentId, claim.payload.model);
    if (ready.state === "unavailable") throw Object.assign(new Error("Cloud provider credentials are unavailable"), { code: ready.code });
    const record = this.selections.get(claim.claimId);
    if (!record || record.consumed || record.commandId !== claim.commandId || record.conversationId !== claim.conversationId ||
        record.selection.executionId !== claim.executionId || !isDeepStrictEqual(record.payload, claim.payload) ||
        !isDeepStrictEqual(record.selection.actor.provenance.actor, actor.provenance.actor))
      throw new CloudCommandRuntimeError("command_conflict");
    this.factory!.assertBootStart(record.selection); record.consumed = true; return record.selection;
  }
  async releaseClaim(value: CloudBootCommandClaim): Promise<void> {
    const claim = CloudBootCommandClaimSchema.parse(value), record = this.selections.get(claim.claimId);
    if (!record) return;
    if (record.commandId !== claim.commandId || record.conversationId !== claim.conversationId ||
        record.selection.executionId !== claim.executionId || !isDeepStrictEqual(record.payload, claim.payload))
      throw new CloudCommandRuntimeError("command_conflict");
    // Before prepare there is only an empty captured source. Once consumed,
    // exact native retirement/retention is the pump's responsibility.
    if (!record.consumed) await record.lifetime.close();
    this.selections.delete(claim.claimId);
  }
  private closeUnused(lifetime: CloudAgentExecutionLifetime): void {
    const flight = lifetime.close(); this.flights.add(flight);
    void flight.catch(error => { this.options.supervisor.onRetirementFailure(error); }).finally(() => this.flights.delete(flight));
  }
  private schedule(record: { timer: ReturnType<typeof setTimeout> | null }, delay: number, work: () => Promise<unknown>, current: () => boolean = () => true): void {
    if (record.timer) clearTimeout(record.timer);
    if (!this.live()) return;
    record.timer = setTimeout(() => {
      record.timer = null; if (!this.live() || !current()) return;
      const flight = work(); this.flights.add(flight);
      void flight.catch(() => { if (current()) this.schedule(record, 500, work, current); }).finally(() => this.flights.delete(flight));
    }, Math.max(250, Math.min(5_000, delay))); record.timer.unref?.();
  }
  private scheduleCache(retry = false): void {
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    if (!this.live() || !this.credentials) return;
    const hints = this.credentials.backgroundWork;
    const delays = [hints.synchronizeInMs, hints.codexRefreshInMs].filter((value): value is number => value !== null);
    if (!delays.length && !retry) return;
    const delay = retry ? 500 : Math.max(250, Math.min(5_000, ...delays));
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null; if (!this.live()) return;
      const flight = (async () => {
        const current = this.credentials!.backgroundWork;
        if (current.codexRefreshInMs !== null && current.codexRefreshInMs <= 0) await this.credentials!.refreshCodexAccess(this.controller.signal);
        else if (current.synchronizeInMs !== null && current.synchronizeInMs <= 0) await this.credentials!.synchronize(this.controller.signal);
        this.scheduleCache();
      })();
      this.flights.add(flight);
      void flight.catch(() => this.scheduleCache(true)).finally(() => this.flights.delete(flight));
    }, delay); this.cacheTimer.unref?.();
  }
  async dispose(): Promise<void> {
    this.closed = true; this.activated = false; this.controller.abort();
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    if (this.controlsTimer) clearTimeout(this.controlsTimer);
    for (const record of [...this.actors.values(), ...this.interests.values()]) if (record.timer) clearTimeout(record.timer);
    await Promise.allSettled([...this.flights]);
    await this.factory?.disposeBoot(); // Failed positive retirement must propagate.
    this.contexts?.dispose(); this.credentials?.dispose(); this.registry?.dispose();
    this.fencesValue?.close(); this.queueValue?.close();
  }
  /** Keep the original ledger and confirmed registration usable solely for
   * final replication. New starts and background authority publications stop
   * before a clean seal; exact native retirement is proved by the caller. */
  async quiesceForSeal(): Promise<void> {
    if (!this.authorityActive || !this.queueValue) throw new CloudCommandRuntimeError("engine_authority_rejected");
    this.sealing = true; this.queueValue.fenceAcceptance(); this.controller.abort();
    if (this.cacheTimer) clearTimeout(this.cacheTimer); this.cacheTimer = null;
    if (this.controlsTimer) clearTimeout(this.controlsTimer); this.controlsTimer = null;
    for (const record of [...this.actors.values(), ...this.interests.values()]) if (record.timer) clearTimeout(record.timer);
    await Promise.allSettled([...this.flights]);
  }
}
