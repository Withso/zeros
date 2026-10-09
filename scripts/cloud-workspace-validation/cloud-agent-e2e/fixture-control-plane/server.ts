import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { CloudActorAdmissionResponseSchema, CloudActorContextSchema, CloudCommandActorSchema } from "@zeros/protocol/cloud-actors";
import { PROTOCOL_VERSION } from "@zeros/protocol/version";
import { z } from "zod";
import { ActorAdmissionSchema, canonical, clone, FixtureRefusal, HeartbeatSchema, parse, RegistrationSchema, ScopeSchema, type RuntimeAttestation } from "./contracts";
import { CloudAgentRuntimeSchema } from "../../../../apps/control-plane/src/cloud-workspaces/runtime-contract";
import { CloudAgentCredentialControlExchangeRequestSchema } from "../../../../apps/desktop/src/engine/cloud-local-command-queue-start-fences";
import { CommandBodySchema, FixtureCommands } from "./commands";
import { ExecutionBodySchema, FixtureExecutions } from "./executions";
import { EventBodySchema, FixtureEvents } from "./events";
import { RecordAppendSchema, RecordHeadSchema, FixtureRecords } from "./records";
import { FixtureBootAuthority, FIXTURE_BOOT_REQUEST_SCHEMAS, type FixtureBootConfiguration, type FixtureBootOperation } from "./boot";
import { FixtureMirrorBodySchema, FixtureMirrorProjection, FixtureSealBodySchema } from "./mirror";
import { FixtureRequestObservations, type FixtureOperation, type FixtureRequestDelay, type FixtureRoute, type MeasurementCheckpoint } from "./request-observations";
export type { FixtureOperation, FixtureRequestDelay, FixtureRoute, MeasurementCheckpoint, MeasurementWindow } from "./request-observations";

export type FixtureIdentity = {
  workspaceId: string; organizationId: string; generation: number; engineInstanceId: string;
  setupRunId: string; executionFence: number; protocolVersion: number;
};
export type FixtureOptions = Partial<FixtureIdentity> & {
  tls?: { key: string | Buffer; cert: string | Buffer };
  now?: () => number; engineLeaseMs?: number; executionLeaseMs?: number;
  eventRetentionCount?: number;
  requestObservationRetentionCount?: number;
  requestDelay?: readonly FixtureRequestDelay[];
  credentials?: { mode: "synthetic" | "environment"; env?: Record<string, string | undefined> };
  allowedModels?: Partial<Record<"claude" | "codex" | "cursor", readonly string[]>>;
};
const paths = {
  registration: "/internal/v1/cloud-workspaces/engine/register",
  heartbeat: "/internal/v1/cloud-workspaces/engine/heartbeat",
  actor: "/internal/v2/cloud-workspaces/engine/client-admission",
  commands: "/internal/v1/cloud-workspaces/engine/commands",
  execution: "/internal/v2/cloud-workspaces/engine/agent-execution",
  events: "/internal/v1/cloud-workspaces/engine/events",
  recordHead: "/internal/v1/cloud-workspaces/engine/record/head",
  recordAppend: "/internal/v1/cloud-workspaces/engine/record/append",
  bootBootstrap: "/internal/v2/cloud-workspaces/engine/agent-boot/bootstrap",
  bootSync: "/internal/v2/cloud-workspaces/engine/agent-boot/sync",
  bootActivate: "/internal/v2/cloud-workspaces/engine/agent-boot/activate",
  bootRefresh: "/internal/v2/cloud-workspaces/engine/agent-boot/refresh",
  actorConfirm: "/internal/v2/cloud-workspaces/engine/agent-boot/actor-confirm",
  warmContext: "/internal/v2/cloud-workspaces/engine/agent-boot/warm-context",
  mirror: "/internal/v2/cloud-workspaces/engine/commands/mirror",
  seal: "/internal/v2/cloud-workspaces/engine/commands/seal",
  credentialControls: "/internal/v2/cloud-workspaces/engine/agent-credential-controls",
} as const;
const bootOperation = (path: string): FixtureBootOperation | undefined => {
  for (const operation of Object.keys(FIXTURE_BOOT_REQUEST_SCHEMAS) as FixtureBootOperation[])
    if (path === `/internal/v2/cloud-workspaces/engine/agent-boot/${operation}`) return operation;
  return undefined;
};
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const rendererPreparePath = "/v1/cloud-workspaces/:workspace/agent-credentials/prepare";
const rendererPrepareBody = z.object({}).strict();

/** Disposable, loopback-only control plane for the real Linux harness. It has
 * no persistence, provisioning, external identity, or production import path. */
export class FixtureControlPlane {
  readonly identity: Readonly<FixtureIdentity>;
  readonly runtimeTokens = Object.freeze({ registrationToken: token("zws"), readinessToken: token("zwr") });
  readonly actor = Object.freeze({ userId: randomUUID(), deviceId: randomUUID(), deviceKeyVersion: 1,
    sessionId: randomUUID(), role: "developer" as const, fingerprint: randomBytes(32).toString("hex") });
  readonly actorGrantToken = token("zwa");
  readonly invalidDelegationId = randomUUID();
  private readonly heartbeatToken = token("zwh");
  private readonly rendererToken = token("zfu");
  private readonly computeFingerprint = randomBytes(32).toString("hex");
  private readonly delegations = { claude: randomUUID(), codex: randomUUID(), cursor: randomUUID() };
  private readonly now: () => number;
  private readonly engineLeaseMs: number;
  private attestation: RuntimeAttestation | null = null;
  private engineExpiresAt = 0;
  private registrationExpiresAt: number;
  private registered = false;
  private runtimeQualified = false;
  private mcpQualified = false;
  private actorAdmitted = false;
  private actorRevoked = false;
  private actorLastRenewedAt = 0;
  private readonly actorSessionExpiresAt: number;
  private readonly rendererDelegationExpiresAt: number;
  private actorGrantExpiresAt: number;
  private baseUrl: string | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private closed = false;
  private readonly requests: Array<{ path: string; status: number; errorCode: string | null }> = [];
  private readonly commands: FixtureCommands;
  private readonly executions: FixtureExecutions;
  private readonly events: FixtureEvents;
  private readonly records: FixtureRecords;
  private boot: FixtureBootAuthority | null = null;
  private mirror: FixtureMirrorProjection | null = null;
  private readonly measurements: FixtureRequestObservations;
  private readonly handlers = new Set<Promise<void>>();
  private readonly handlerControllers = new Set<AbortController>();

  constructor(private readonly options: FixtureOptions = {}) {
    this.now = options.now ?? Date.now;
    this.measurements = new FixtureRequestObservations(options.requestObservationRetentionCount, options.requestDelay);
    this.records = new FixtureRecords(this.now);
    this.engineLeaseMs = options.engineLeaseMs ?? 60_000;
    if (this.engineLeaseMs < 5_000 || this.engineLeaseMs > 600_000) throw new Error("fixture_engine_lease_invalid");
    this.identity = Object.freeze({ workspaceId: options.workspaceId ?? randomUUID(), organizationId: options.organizationId ?? randomUUID(),
      generation: options.generation ?? 1, engineInstanceId: options.engineInstanceId ?? randomUUID(), setupRunId: options.setupRunId ?? randomUUID(),
      executionFence: options.executionFence ?? 1, protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION });
    parse(RegistrationSchema, this.identity, "fixture_identity_invalid");
    CloudActorContextSchema.parse({ sessionId: this.actor.sessionId, deviceId: this.actor.deviceId, role: this.actor.role, fingerprint: this.actor.fingerprint });
    CloudCommandActorSchema.parse(this.commandActor());
    this.registrationExpiresAt = this.now() + 60 * 60_000;
    this.actorGrantExpiresAt = this.now() + 2 * 60_000;
    this.actorSessionExpiresAt = this.now() + 24 * 60 * 60_000;
    this.rendererDelegationExpiresAt = this.now() + 15 * 60_000;
    this.commands = new FixtureCommands({ now: this.now, generation: this.identity.generation, sourceSessionId: this.actor.sessionId,
      requireActor: sessionId => this.requireActor(sessionId), recordedActorLive: () => this.recordedActorLive() });
    this.executions = new FixtureExecutions({ now: this.now, workspaceId: this.identity.workspaceId, organizationId: this.identity.organizationId,
      commands: this.commands, requireActor: sessionId => { this.requireActor(sessionId); }, requireRecordedActor: sessionId => { this.requireRecordedActor(sessionId); }, actorUserId: this.actor.userId,
      delegationId: provider => this.delegationId(provider), delegationExpiresAtMs: this.rendererDelegationExpiresAt,
      credentials: options.credentials, allowedModels: options.allowedModels, leaseMs: options.executionLeaseMs });
    this.events = new FixtureEvents(this.identity.engineInstanceId, options.eventRetentionCount);
  }

  configureRuntime(value: RuntimeAttestation): void {
    if (this.registered || this.closed) throw new Error("fixture_runtime_already_configured");
    const runtime = CloudAgentRuntimeSchema.safeParse(value);
    if (!runtime.success || runtime.data.profile !== "zeros-cloud-worker-v4") throw new Error("fixture_runtime_invalid");
    this.attestation = clone(value);
  }

  /** Operator-owned synthetic funding configuration, never inferred from
   * the fixture actor's role or accepted from a renderer/HTTP selector. */
  activeBootScope() {
    if (!this.boot) throw new FixtureRefusal("command_context_changed");
    return this.boot.activeScope();
  }
  configureBootOwner(configuration: FixtureBootConfiguration): void {
    if (this.registered || this.closed || this.boot) throw new Error("fixture_boot_already_configured");
    const { workspaceId, organizationId, generation, engineInstanceId } = this.identity;
    this.boot = new FixtureBootAuthority({ scope: { workspaceId, organizationId, generation, engineInstanceId }, now: this.now,
      engineLive: () => this.registered && !this.closed && this.now() < this.engineExpiresAt,
      engineDeadline: () => this.engineExpiresAt, actorSessionExpiresAt: () => this.actorSessionExpiresAt,
      configuration, actorSessionId: this.actor.sessionId, recordedActor: session => { this.requireRecordedActor(session); return this.commandActor(); },
      credentials: this.options.credentials, allowedModels: this.options.allowedModels });
    this.mirror = new FixtureMirrorProjection({ activeScope: () => this.boot!.activeScope() });
  }

  async start(): Promise<{ baseUrl: string }> {
    if (this.closed) throw new Error("fixture_closed");
    if (this.baseUrl) return { baseUrl: this.baseUrl };
    const listener = (request: IncomingMessage, response: ServerResponse) => { this.receive(request, response); };
    const server = this.options.tls ? createHttpsServer(this.options.tls, listener) : createServer(listener);
    this.server = server;
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_listener_invalid");
    this.baseUrl = `${this.options.tls ? "https" : "http"}://127.0.0.1:${address.port}`;
    return { baseUrl: this.baseUrl };
  }

  runtimeConfig() {
    if (!this.baseUrl?.startsWith("https:") || !this.attestation) throw new Error("fixture_https_runtime_required");
    const { workspaceId, organizationId, generation, setupRunId, executionFence, engineInstanceId, protocolVersion } = this.identity;
    return { version: 1 as const, audience: "zeros-cloud-engine-runtime-v1" as const,
      execution: { workspaceId, organizationId, generation, setupRunId, executionFence },
      engine: { instanceId: engineInstanceId, protocolVersion, readinessProbeToken: this.runtimeTokens.readinessToken },
      registration: { endpoint: `${this.baseUrl}${paths.registration}`, token: this.runtimeTokens.registrationToken, expiresAtMs: this.registrationExpiresAt } };
  }

  authority() {
    if (!this.baseUrl) throw new Error("fixture_not_started");
    const { workspaceId, organizationId, generation, engineInstanceId } = this.identity;
    return { workspaceId, organizationId, generation, engineInstanceId,
      heartbeatEndpoint: `${this.baseUrl}${paths.heartbeat}`, heartbeatToken: this.heartbeatToken };
  }
  delegationId(provider: keyof typeof this.delegations): string { return this.delegations[provider]; }
  rendererAuthority() { return Object.freeze({ userId: this.actor.userId, bearerToken: this.rendererToken }); }
  revokeActor(): void { this.actorRevoked = true; }
  commandActor() { const { sessionId: _session, ...actor } = this.actor; return actor; }
  private requireActor(sessionId: string | undefined) {
    this.requireRecordedActor(sessionId);
    if (this.now() - this.actorLastRenewedAt >= 30_000) throw new FixtureRefusal("cloud_actor_authority_rejected", 403);
    return this.commandActor();
  }
  private recordedActorLive() { return this.actorAdmitted && !this.actorRevoked && this.now() < this.actorSessionExpiresAt; }
  private requireRecordedActor(sessionId: string | undefined): void {
    if (!this.recordedActorLive() || sessionId !== this.actor.sessionId) throw new FixtureRefusal("cloud_actor_authority_rejected", 403);
  }
  readCommand(commandId: string) { return this.commands.read(commandId); }
  readEvents(after = 0) { return this.events.read(after); }
  assertTerminalConsistency(commandId: string): void { this.events.assertTerminal(this.commands.terminalReceipt(commandId)); }
  readMirrorCommand(commandId: string) { return this.mirror?.readCommand(commandId) ?? null; }
  readMirrorHistory(conversationId: string) { return this.mirror?.readHistory(conversationId) ?? null; }
  assertMirrorTerminalConsistency(commandId: string, observed: { conversationId: string; entry: unknown }): void {
    if (!this.mirror) throw new FixtureRefusal("fixture_terminal_mismatch");
    this.mirror.assertTerminalConsistency(commandId, observed);
  }
  private currentEngine(scope: ReturnType<typeof ScopeSchema.parse>, bearer: string): void {
    if (!this.registered || this.closed || this.now() >= this.engineExpiresAt || bearer !== this.heartbeatToken ||
        ["workspaceId", "organizationId", "generation", "engineInstanceId"].some(key => scope[key as keyof typeof scope] !== this.identity[key as keyof FixtureIdentity]))
      throw new FixtureRefusal("engine_authority_rejected", 401);
  }

  private dispatch(path: string, body: unknown, bearer: string, native = false, turnProtocol = false, localCommands = false): unknown {
    if (path === paths.registration) {
      if (bearer !== this.runtimeTokens.registrationToken || this.now() >= this.registrationExpiresAt) throw new FixtureRefusal("invalid_capability", 401);
      const input = parse(RegistrationSchema, body, "invalid_request");
      if (!this.attestation || Object.entries(this.identity).some(([key, value]) => input[key as keyof typeof input] !== value) ||
          canonical(input.agentRuntime) !== canonical(this.attestation)) throw new FixtureRefusal("engine_registration_rejected", 403);
      // An idempotent registration retry never revives an expired engine.
      if (this.registered && this.now() >= this.engineExpiresAt) throw new FixtureRefusal("engine_registration_rejected", 403);
      if (!this.registered) {
        this.registered = true; this.engineExpiresAt = this.now() + this.engineLeaseMs;
        this.runtimeQualified = input.protocolVersion === PROTOCOL_VERSION && input.actorProtocolVersion === 2;
        this.mcpQualified = input.agentCustomizationVersion === 3;
      }
      this.boot?.negotiateRegistration(this.attestation.bootId, localCommands, this.runtimeQualified && this.mcpQualified);
      return { version: 1, audience: "zeros-cloud-workspace-engine-registration-v1", engineInstanceId: this.identity.engineInstanceId,
        durableRecordConnected: true, leaseExpiresAtMs: this.engineExpiresAt,
        heartbeat: { endpoint: `${this.baseUrl}${paths.heartbeat}`, token: this.heartbeatToken, intervalMs: 10_000 } };
    }
    if (path === paths.heartbeat) {
      const input = parse(HeartbeatSchema, body, "invalid_request");
      this.currentEngine(input, bearer);
      this.engineExpiresAt = this.now() + this.engineLeaseMs;
      return { version: 1, audience: "zeros-cloud-workspace-engine-heartbeat-v1", accepted: true,
        engineInstanceId: this.identity.engineInstanceId, leaseExpiresAtMs: this.engineExpiresAt,
        ...(input.repositoryCredentialRefresh ? { repositoryCredential: { outcome: "unavailable", requestGeneration: input.repositoryCredentialRefresh.generation } } : {}) };
    }
    if (path === paths.actor) {
      const input = parse(ActorAdmissionSchema, body, "invalid_request");
      this.currentEngine(input, bearer);
      if (input.grantToken !== this.actorGrantToken || this.actorRevoked || this.now() >= this.actorSessionExpiresAt ||
          (input.renew ? !this.actorAdmitted || this.now() - this.actorLastRenewedAt >= 30_000 : this.actorAdmitted || this.now() >= this.actorGrantExpiresAt))
        throw new FixtureRefusal("cloud_actor_admission_rejected", 401);
      this.actorAdmitted = true; this.actorLastRenewedAt = this.now();
      return CloudActorAdmissionResponseSchema.parse({ version: 2, audience: "zeros-cloud-workspace-engine-client-admission-v2", admitted: true,
        authorityEpoch: 1, accountUserId: this.actor.userId, actorSessionId: this.actor.sessionId,
        deviceId: this.actor.deviceId, role: this.actor.role, fingerprint: this.actor.fingerprint });
    }
    if (path === paths.commands) {
      const input = parse(CommandBodySchema, body, "invalid_command");
      this.currentEngine(input, bearer);
      if (this.boot?.inspect().activated && !["snapshot", "read"].includes(input.request.kind)) throw new FixtureRefusal("command_conflict");
      return { result: this.commands.handle(input.request, input.actorSessionId, native, turnProtocol) };
    }
    if (path === paths.execution) {
      const input = parse(ExecutionBodySchema, body, "invalid_agent_execution");
      this.currentEngine(input, bearer);
      try { return { result: this.executions.handle(input.request) }; }
      catch (error) {
        if (error instanceof FixtureRefusal && error.code === "cloud_actor_authority_rejected") throw new FixtureRefusal("cloud_agent_authority_rejected", 403);
        throw error;
      }
    }
    if (path === paths.events) {
      const input = parse(EventBodySchema, body, "invalid_event"); this.currentEngine(input, bearer);
      return { result: this.events.handle(input.request) };
    }
    if (path === paths.recordHead) {
      const input = parse(RecordHeadSchema, body, "invalid_request"); this.currentEngine(input, bearer);
      return this.records.head(input);
    }
    if (path === paths.recordAppend) {
      const input = parse(RecordAppendSchema, body, "invalid_request"); this.currentEngine(input, bearer);
      return this.records.append(input);
    }
    const operation = bootOperation(path);
    if (operation) {
      const input = FIXTURE_BOOT_REQUEST_SCHEMAS[operation].safeParse(body);
      if (!input.success) throw new FixtureRefusal("invalid_request", 422);
      const { organizationId, workspaceId, generation, engineInstanceId } = input.data;
      this.currentEngine({ organizationId, workspaceId, generation, engineInstanceId }, bearer);
      if (!this.boot) throw new FixtureRefusal("cloud_runtime_upgrade_required");
      if (operation === "activate" && (this.commands.inspect().some(row => ["queued", "dispatching"].includes(row.state)) ||
          this.executions.inspect().some(row => !row.released))) throw new FixtureRefusal("command_conflict");
      return { result: this.boot.handle(operation, input.data) };
    }
    if (path === paths.mirror) {
      const input = parse(FixtureMirrorBodySchema, body, "invalid_command"); this.currentEngine(input, bearer);
      if (!this.mirror) throw new FixtureRefusal("cloud_runtime_upgrade_required");
      return { result: this.mirror.handle(input.batch) };
    }
    if (path === paths.seal) {
      const input = parse(FixtureSealBodySchema, body, "invalid_command"); this.currentEngine(input, bearer);
      if (!this.mirror) throw new FixtureRefusal("cloud_runtime_upgrade_required");
      return { result: this.mirror.seal(input.seal) };
    }
    throw new FixtureRefusal("fixture_route_not_found", 404);
  }

  measurementCheckpoint() { return this.measurements.checkpoint(this.handlers.size); }
  measurementWindow(start: MeasurementCheckpoint, end = this.measurementCheckpoint()) { return this.measurements.window(start, end); }

  private operation(path: string, body: unknown): FixtureOperation {
    if (path === paths.mirror && FixtureMirrorBodySchema.safeParse(body).success) return "commands.mirror";
    if (path === paths.seal && FixtureSealBodySchema.safeParse(body).success) return "commands.seal";
    if (path === paths.credentialControls && CloudAgentCredentialControlExchangeRequestSchema.safeParse(body).success) return "credentials.controls";
    const boot = bootOperation(path);
    if (boot && FIXTURE_BOOT_REQUEST_SCHEMAS[boot].safeParse(body).success) {
      const operations = { bootstrap: "boot.bootstrap", sync: "boot.sync", activate: "boot.activate", refresh: "boot.refresh",
        "actor-confirm": "actor.confirm", "warm-context": "context.warm" } as const;
      return operations[boot];
    }
    if (path === paths.registration && RegistrationSchema.safeParse(body).success) return "engine.register";
    if (path === paths.heartbeat && HeartbeatSchema.safeParse(body).success) return "engine.heartbeat";
    if (path === paths.actor) {
      const input = ActorAdmissionSchema.safeParse(body);
      if (input.success) return input.data.renew ? "client.renew" : "client.admit";
    }
    if (path === paths.commands) {
      const input = CommandBodySchema.safeParse(body);
      if (input.success) return `commands.${input.data.request.kind}`;
    }
    if (path === paths.execution) {
      const input = ExecutionBodySchema.safeParse(body);
      if (input.success) {
        const kind = input.data.request.kind;
        if (kind === "validate") return input.data.request.renew ? "credentials.renew" : "credentials.validate";
        return kind === "refresh-codex" ? "credentials.refresh" : `credentials.${kind}`;
      }
    }
    if (path === paths.events) {
      const input = EventBodySchema.safeParse(body);
      if (input.success) return `events.${input.data.request.kind}`;
    }
    if (path === paths.recordHead && RecordHeadSchema.safeParse(body).success) return "records.head";
    if (path === paths.recordAppend && RecordAppendSchema.safeParse(body).success) return "records.sync";
    if (path === rendererPreparePath && rendererPrepareBody.safeParse(body).success) return "renderer.prepare";
    return "unknown";
  }

  private receive(request: IncomingMessage, response: ServerResponse): void {
    const arrivedAtUs = this.measurements.nowUs();
    let url: URL | undefined;
    try { url = new URL(request.url ?? "/", "http://127.0.0.1"); } catch { /* Count unknown malformed paths too. */ }
    const rendererWorkspace = url && /^\/v1\/cloud-workspaces\/([^/]+)\/agent-credentials\/prepare$/.exec(url.pathname)?.[1];
    const route: FixtureRoute = rendererWorkspace ? "rendererPrepare" :
      (Object.keys(paths) as Array<keyof typeof paths>).find(key => paths[key] === url?.pathname) ?? "unknown";
    const path = route === "rendererPrepare" ? rendererPreparePath : route === "unknown" ? "unknown" : paths[route];
    const record = this.measurements.arrive(route, request.method, arrivedAtUs);
    const controller = new AbortController();
    const aborted = () => controller.abort();
    request.once("aborted", aborted);
    response.once("finish", () => this.measurements.complete(record, response.statusCode));
    response.once("close", () => {
      if (!response.writableFinished) { this.measurements.complete(record, null); aborted(); }
    });
    if (this.closed || this.handlers.size >= 128) {
      this.respond(response, path, 503, { error: "fixture_service_unavailable" });
      return;
    }
    this.handlerControllers.add(controller);
    const task = this.handle(request, response, path, url, rendererWorkspace, route, record, controller.signal).finally(() => {
      this.handlers.delete(task); this.handlerControllers.delete(controller); request.off("aborted", aborted);
      if (!response.writableEnded) this.measurements.complete(record, null);
    });
    this.handlers.add(task);
    // handle projects every rejection into closed fixture metadata. Retain no
    // request/response or private body outside this bounded handler lifetime.
    void task.catch(() => { this.measurements.complete(record, null); response.destroy(); });
  }

  private async handle(request: IncomingMessage, response: ServerResponse, path: string, url: URL | undefined,
    rendererWorkspace: string | undefined, route: FixtureRoute, record: ReturnType<FixtureRequestObservations["arrive"]>, signal: AbortSignal): Promise<void> {
    try {
      if (!await this.measurements.delay(route, undefined, signal)) throw new FixtureRefusal("fixture_service_unavailable", 503);
      if (path === "unknown" || (path === paths.recordHead ? request.method !== "GET" : request.method !== "POST")) throw new FixtureRefusal("fixture_route_not_found", 404);
      const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
      if (path === rendererPreparePath) {
        if (bearer !== this.rendererToken || this.closed || this.actorRevoked || this.now() >= this.actorSessionExpiresAt)
          throw new FixtureRefusal("unauthorized", 401);
        if (rendererWorkspace !== this.identity.workspaceId) throw new FixtureRefusal("cloud_agent_authority_rejected", 403);
      } else if (path === paths.registration ? bearer !== this.runtimeTokens.registrationToken : bearer !== this.heartbeatToken) {
        const code = bootOperation(path) || [paths.commands, paths.events, paths.execution, paths.mirror, paths.seal].includes(path as never) ? "engine_authority_rejected" : "invalid_capability";
        throw new FixtureRefusal(code, 401);
      }
      if (path === paths.recordHead && request.method === "GET") {
        const body = Object.fromEntries(url!.searchParams), operation = this.operation(path, body);
        this.measurements.classify(record, operation);
        if (!await this.measurements.delay(route, operation, signal)) throw new FixtureRefusal("fixture_service_unavailable", 503);
        this.respond(response, path, 200, this.dispatch(path, body, bearer)); return;
      }
      const invalidCode = path === rendererPreparePath ? "invalid_agent_credential_request" : [paths.commands, paths.mirror, paths.seal].includes(path as never) ? "invalid_command" : path === paths.events ? "invalid_event" : path === paths.execution ? "invalid_agent_execution" : "invalid_request";
      const boot = bootOperation(path);
      const maximum = boot ? boot === "warm-context" ? 1024 * 1024 : 16 * 1024 : path === paths.mirror ? 1024 * 1024 : path === paths.seal || path === rendererPreparePath ? 16 * 1024 : path === paths.commands || path === paths.execution ? 256 * 1024 : path === paths.events ? 1_100_000 : path === paths.recordAppend ? 2_250_000 : 64 * 1024;
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new FixtureRefusal(invalidCode, path === paths.execution ? 415 : 422);
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maximum) { request.resume(); throw new FixtureRefusal(invalidCode, 413); }
        chunks.push(chunk);
      }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new FixtureRefusal(invalidCode, 422); }
      const operation = this.operation(path, body);
      this.measurements.classify(record, operation);
      if (!await this.measurements.delay(route, operation, signal)) throw new FixtureRefusal("fixture_service_unavailable", 503);
      if (path === rendererPreparePath) {
        parse(rendererPrepareBody, body, invalidCode);
        // Authority is checked again after body/delay work; injected time must
        // never revive a revoked or expired renderer session.
        if (this.closed || this.actorRevoked || this.now() >= this.actorSessionExpiresAt) throw new FixtureRefusal("unauthorized", 401);
        // This is a synthetic user session and a read-only metadata projection,
        // not a production OAuth or credential-qualification implementation.
        const live = this.registered && this.now() < this.engineExpiresAt;
        this.respond(response, path, 200, { compute: { fingerprint: this.computeFingerprint, trust: "zeros-managed" },
          delegations: this.executions.rendererDelegations(live && this.runtimeQualified, live && this.runtimeQualified && this.mcpQualified) });
        return;
      }
      this.respond(response, path, 200, this.dispatch(path, body, bearer, request.headers["x-zeros-native-commands"] === "1",
        request.headers["x-zeros-cloud-turn-protocol"] === "1", request.headers["x-zeros-cloud-local-commands"] === "1"));
    } catch (error) {
      const refusal = error instanceof FixtureRefusal ? error : new FixtureRefusal("fixture_service_unavailable", 503);
      const nested = path === rendererPreparePath || [paths.registration, paths.heartbeat, paths.actor, paths.recordHead, paths.recordAppend].includes(path as never);
      const detail = { code: refusal.code, ...(path === rendererPreparePath ? { message: refusal.code } : {}),
        ...(path === paths.registration && refusal.status === 403 ? { retryable: false } : {}) };
      this.respond(response, path, refusal.status, { error: nested ? detail : refusal.code });
    }
  }

  private respond(response: ServerResponse, path: string, status: number, value: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    // Errors originate only from our closed refusal vocabulary. Bodies and
    // provider material are never retained in this metadata journal.
    const error = (value as { error?: string | { code: string } }).error;
    this.requests.push({ path, status, errorCode: typeof error === "string" ? error : error?.code ?? null });
    if (this.requests.length > 2048) this.requests.shift();
    const bootAuthority = status === 200 && path === paths.registration ? this.boot : undefined;
    const boot = bootAuthority?.inspect();
    const sourceWriter = boot?.negotiated && boot.activated ? bootAuthority?.activeScope().writerEpoch : undefined;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store",
      ...(path === paths.commands ? { "x-zeros-cloud-turn-protocol": "1" } : {}),
      ...(boot?.negotiated ? { "x-zeros-cloud-local-commands": "1",
        "x-zeros-cloud-agent-journal": boot.activated ? "local" : "legacy",
        ...(sourceWriter ? { "x-zeros-cloud-agent-source-writer": sourceWriter } : {}) } : {}) });
    response.end(JSON.stringify(value));
  }
  inspect() { return clone({ registered: this.registered, engineExpiresAt: this.engineExpiresAt, requests: this.requests,
    commands: this.commands.inspect(), executions: this.executions.inspect(), ...(this.boot ? { boot: this.boot.inspect() } : {}),
    ...(this.mirror ? { mirror: this.mirror.inspect() } : {}),
    ...this.events.inspect(), ...this.records.inspect() }); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.handlerControllers) controller.abort();
    this.executions.close();
    this.boot?.close();
    this.mirror?.close();
    const server = this.server;
    if (server) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    });
    await Promise.allSettled([...this.handlers]);
    this.measurements.drainClosed();
  }
}
export function createFixtureControlPlane(options: FixtureOptions = {}): FixtureControlPlane { return new FixtureControlPlane(options); }
