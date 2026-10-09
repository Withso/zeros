import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import pg from "pg";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BridgeMessage } from "../../../../packages/protocol/src/messages";
import type { AgentTextMessage } from "../../../../packages/protocol/src/agent-messages";
import { CloudBootCommandClaimSchema } from "../../../../packages/protocol/src/cloud-commands";
import { CloudActorAuthorityRegistry } from "../../../desktop/src/engine/agents/cloud-actor-authority";
import { CloudLocalCommandQueue } from "../../../desktop/src/engine/cloud-local-command-queue";
import { CloudLocalCommandEventStore } from "../../../desktop/src/engine/cloud-local-command-queue-events";
import { captureCloudLocalCommandHistory } from "../../../desktop/src/engine/cloud-local-command-queue-history";
import { CloudLocalCommandMirrorDriver, requestCloudLocalCommandMirror } from "../../../desktop/src/engine/cloud-local-command-mirror";
import { CloudEventRuntime } from "../../../desktop/src/engine/cloud-event-runtime";
import { runMigrations } from "../../../desktop/src/engine/db/migrations";
import { openSqlite } from "../../../desktop/src/engine/db/sqlite";
import { createPostgresCostSampler, preparePostgresCostMonitor } from "../../../../scripts/cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/postgres-cost";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { CloudAgentActorConfirmResponseSchema, CloudAgentBootActivateResponseSchema,
  CloudAgentBootCredentialResponseSchema, CloudAgentWarmActorResponseSchema } from "./agent-boot-contract.js";
import { DatabaseCloudAgentExecutionService } from "./agent-executions.js";
import { CLOUD_AGENT_EXECUTION_PATH, createCloudAgentExecutionRoutes } from "./agent-credential-routes.js";
import { CLOUD_COMMAND_PATH, createCloudCommandRoutes } from "./command-routes.js";
import { DatabaseCloudWorkspaceCommandService, type CloudCommandEngineScope } from "./commands.js";
import { CLOUD_RUNTIME_BRIDGE_PATH } from "./engine-client-admission.js";
import { CLOUD_EVENT_PATH, createCloudEventRoutes } from "./event-routes.js";
import { DatabaseCloudWorkspaceEventService } from "./event-streams.js";
import { seedRecordedCloudWorkspaceActor } from "./recorded-actor-test-fixture.js";
import { CloudRuntimeBridgeRelay } from "./runtime-bridge.js";
import { seedReadyCloudWorkspace, withCloudFixtureOwnerTx } from "./test-fixtures.js";

// TEST_DATABASE_URL selects the disposable serial test database. A separate
// monitor is supplied explicitly or bootstrapped on the same test server.
// This never uses the native e2e fixture as an SQL/relay substitute.
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const integration = enabled ? describe : describe.skip;
const DELTAS = 100;
const EVENT_COUNT = DELTAS + 3; // permission request, settled receipt, terminal
const provider = "cursor" as const;
const model = "grok-4.6";
const responseId = z.string().uuid();

type Workload = ReturnType<typeof workload>;
type EngineEvent = Extract<BridgeMessage, { type: "AGENT_SESSION_UPDATE" | "AGENT_PERMISSION_REQUEST" |
  "AGENT_PERMISSION_SETTLED" | "AGENT_PROMPT_COMPLETE" }>;
type ClientInput = Extract<BridgeMessage, { type: "WORKSPACE_REQUEST" | "AGENT_PERMISSION_RESPONSE" }>;
function workload(scope: CloudCommandEngineScope, delegationId: string) {
  const conversationId = "synthetic-cost-turn";
  const commandId = randomUUID(), executionId = randomUUID(), permissionId = randomUUID();
  const payload = { agentId: provider, model, userMessageId: commandId, modeRevision: 0,
    prompt: [{ type: "text" as const, text: "Synthetic cost measurement" }], agentCredentialGrantId: delegationId };
  const user: ClientInput = { id: randomUUID(), source: "browser", timestamp: 1,
    type: "WORKSPACE_REQUEST", op: "cloudCommands.request",
    params: { request: { kind: "mutate", mutation: { conversationId, operationId: commandId, expectedRevision: 0,
      action: { kind: "enqueue", commandId, payload } } } } };
  const frame = (sequence: number) => ({ id: randomUUID(), source: "engine" as const, timestamp: sequence,
    cloudStream: { streamId: scope.engineInstanceId, sequence } });
  const events: EngineEvent[] = Array.from({ length: DELTAS }, (_, index) => ({ ...frame(index + 1),
    type: "AGENT_SESSION_UPDATE", agentId: provider, chatId: conversationId, executionId,
    notification: { sessionId: executionId, update: { sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "delta" } } } }));
  const permission: EngineEvent = { ...frame(DELTAS + 1), type: "AGENT_PERMISSION_REQUEST",
    agentId: provider, chatId: conversationId, permissionId,
    request: { sessionId: executionId, toolCall: { toolCallId: "synthetic-tool", title: "Read fixture" },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } };
  const reply: ClientInput = { id: randomUUID(), source: "browser", timestamp: DELTAS + 2,
    type: "AGENT_PERMISSION_RESPONSE", permissionId, chatId: conversationId, executionId,
    response: { outcome: { outcome: "selected", optionId: "allow" } } };
  const settled: EngineEvent = { ...frame(DELTAS + 2), type: "AGENT_PERMISSION_SETTLED",
    agentId: provider, chatId: conversationId, executionId, sessionId: executionId, permissionId };
  const terminal: EngineEvent = { ...frame(EVENT_COUNT), type: "AGENT_PROMPT_COMPLETE",
    requestId: commandId, agentId: provider, sessionId: executionId, executionId,
    stopReason: "end_turn", response: { stopReason: "end_turn", userMessageId: commandId } };
  events.push(permission, settled, terminal);
  const result = { version: 1 as const, terminal: { commandId, conversationId, executionId,
    turnId: commandId, agentId: provider, status: "completed" as const, stopReason: "end_turn" as const,
    response: { stopReason: "end_turn" as const, userMessageId: commandId } } };
  return { conversationId, commandId, executionId, payload, user, reply, events, result };
}

async function privateRequest<T>(app: Hono, path: string, scope: CloudCommandEngineScope, request: unknown,
  schema: z.ZodType<T>, actor = false): Promise<T> {
  const response = await app.request(path, { method: "POST", headers: {
    authorization: `Bearer ${scope.heartbeatToken}`, "content-type": "application/json",
    "x-zeros-native-commands": "1", "x-zeros-cloud-turn-protocol": "1",
  }, body: JSON.stringify({ workspaceId: scope.workspaceId, organizationId: scope.organizationId,
    generation: scope.generation, engineInstanceId: scope.engineInstanceId,
    ...(actor ? { actorSessionId: scope.actorSessionId } : {}), request }) });
  return checkedPrivateResult(response, schema);
}

async function checkedPrivateResult<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  // Do not put credential-bearing service responses in assertion failures.
  const body: unknown = await response.json();
  if (response.status !== 200) {
    const refusal = z.object({ error: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/) }).safeParse(body);
    throw new Error(`cost_http_${response.status}_${refusal.success ? refusal.data.error : "response_invalid"}`);
  }
  const envelope = z.object({ result: z.unknown() }).strict().safeParse(body);
  if (!envelope.success || !Object.hasOwn(envelope.data, "result")) throw new Error("cost_http_response_invalid");
  const parsed = schema.safeParse(envelope.data.result);
  if (!parsed.success) throw new Error("cost_http_response_invalid");
  return parsed.data;
}

async function bootRequest<T>(app: Hono, operation: "bootstrap" | "activate" | "actor-confirm" | "warm-context",
  scope: CloudCommandEngineScope, request: unknown, schema: z.ZodType<T>): Promise<T> {
  const response = await app.request(`/internal/v2/cloud-workspaces/engine/agent-boot/${operation}`, {
    method: "POST", headers: { authorization: `Bearer ${scope.heartbeatToken}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return checkedPrivateResult(response, schema);
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("cost_relay_address_invalid");
  return address.port;
}

/** Real complete-message forwarding. The grant/preview resolver is a local
 * transport fixture; this does not certify production CP or provider auth. */
async function relayFixture(scope: CloudCommandEngineScope) {
  const upstreamServer = createServer(), upstream = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  upstreamServer.on("upgrade", (request, socket, head) => {
    upstream.handleUpgrade(request, socket, head, ws => upstream.emit("connection", ws, request));
  });
  upstream.on("connection", ws => sockets.add(ws));
  const upstreamPort = await listen(upstreamServer);
  const token = `zws_${"A".repeat(43)}`;
  const relay = new CloudRuntimeBridgeRelay({
    resolve: async () => ({ workspaceId: scope.workspaceId, organizationId: scope.organizationId,
      generation: scope.generation, authorityEpoch: 1, engineInstanceId: scope.engineInstanceId,
      resourceId: "synthetic-cost-resource", readOnly: false,
      endpoint: { url: "https://approved-provider.example.test/", headerName: "x-provider-preview",
        headerValue: "synthetic-cost-preview" } }),
    revalidate: async () => true,
    openUpstream: (_url, options) => {
      const ws = new WebSocket(`ws://127.0.0.1:${upstreamPort}/ws`, options);
      sockets.add(ws); return ws;
    },
    // Consume only scalars; the observer itself receives no payload content.
    observeMessage: observation => {
      if (!Number.isSafeInteger(observation.payloadBytes)) throw new Error("cost_relay_bytes_invalid");
    }, log: () => undefined,
  });
  const downstreamServer = createServer();
  downstreamServer.on("upgrade", (request, socket, head) => {
    if (!relay.handleUpgrade(request, socket, head)) socket.destroy();
  });
  const downstreamPort = await listen(downstreamServer);
  const connect = async (direct = false) => {
    const engineConnected = once(upstream, "connection", { signal: AbortSignal.timeout(3000) });
    const client = direct ? new WebSocket(`ws://127.0.0.1:${upstreamPort}/ws`) :
      new WebSocket(`ws://127.0.0.1:${downstreamPort}${CLOUD_RUNTIME_BRIDGE_PATH}`,
        ["zeros-v1", `zeros-cloud-token.${Buffer.from(token).toString("base64url")}`]);
    sockets.add(client);
    const [[engine]] = await Promise.all([engineConnected, once(client, "open", { signal: AbortSignal.timeout(3000) })]);
    return { client, engine: engine as WebSocket };
  };
  return { relay, connect, async close() {
    relay.close();
    for (const ws of sockets) ws.terminate();
    await Promise.all([new Promise<void>(resolve => upstream.close(() => resolve())),
      new Promise<void>(resolve => upstreamServer.close(() => resolve())),
      new Promise<void>(resolve => downstreamServer.close(() => resolve()))]);
  } };
}

async function deliver(sender: WebSocket, receiver: WebSocket, value: BridgeMessage) {
  const payload = JSON.stringify(value);
  const [received] = await Promise.all([
    once(receiver, "message", { signal: AbortSignal.timeout(3000) }),
    new Promise<void>((resolve, reject) => sender.send(payload, error => error ? reject(error) : resolve())),
  ]);
  const raw: unknown = received[0];
  if (!Buffer.isBuffer(raw) || !raw.equals(Buffer.from(payload))) throw new Error("cost_relay_delivery_mismatch");
  return Buffer.byteLength(payload);
}

async function deliverTurn(pair: { client: WebSocket; engine: WebSocket }, turn: Workload) {
  let clientBytes = await deliver(pair.client, pair.engine, turn.user), engineBytes = 0;
  for (let index = 0; index < turn.events.length; index++) {
    engineBytes += await deliver(pair.engine, pair.client, turn.events[index]!);
    if (index === DELTAS) clientBytes += await deliver(pair.client, pair.engine, turn.reply);
  }
  return { clientMessages: 2, engineMessages: EVENT_COUNT, clientBytes, engineBytes };
}

integration("actual control-plane synthetic turn cost", () => {
  let monitor: pg.Pool, scope: CloudCommandEngineScope, delegationId: string, fundingOwnerUserId: string;
  let targetDatabase: string, monitorDatabase: string;
  const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
  const producer = () => new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4,
    application_name: "zeros-w6-turn-cost-producer" });
  beforeAll(async () => {
    const setup = producer();
    try {
      const database = await preparePostgresCostMonitor({ producerPool: setup,
        producerConnectionString: process.env.TEST_DATABASE_URL!,
        ...(process.env.TEST_OBSERVER_DATABASE_URL ? { monitorConnectionString: process.env.TEST_OBSERVER_DATABASE_URL } : {}) });
      ({ targetDatabase, monitorDatabase } = database);
      monitor = new pg.Pool({ connectionString: database.monitorConnectionString, max: 1,
        application_name: "zeros-w6-turn-cost-monitor" });
    } finally { await setup.end(); }
  });
  afterAll(async () => { await monitor?.end(); });
  beforeEach(async () => {
    const setup = producer();
    try {
      await resetMigratedTestDatabase(setup);
      await setup.query("UPDATE managed_compute_provider_requirements SET require_credit=false WHERE provider='boat'");
      const ready = await seedReadyCloudWorkspace(setup);
      fundingOwnerUserId = ready.userId;
      scope = await seedRecordedCloudWorkspaceActor(setup, ready);
      const credentials = new DatabaseCloudAgentCredentialService(setup, keys), credentialId = randomUUID();
      await credentials.put({ ownerUserId: ready.userId, credentialId, operationId: randomUUID(), expectedRevision: 0,
        displayName: "Synthetic cost fixture", material: { kind: "cursor-api-key", apiKey: "fixture-invalid-key" } });
      delegationId = randomUUID();
      await credentials.delegate(ready.userId, { id: delegationId, credentialId, expectedRevision: 1,
        workspaceId: ready.workspaceId, granteeUserId: ready.userId, models: [model],
        expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    } finally { await setup.end(); }
  });

  async function configureBootSource() {
    const setup = producer();
    try {
      // This disposable relational qualification seed is outside the cost
      // window. It does not certify an engine/native/provider capability.
      await setup.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1", [scope.engineInstanceId]);
      await withCloudFixtureOwnerTx(setup, async tx => {
        await tx.query("SET LOCAL session_replication_role=replica");
        await tx.query("UPDATE cloud_runtime_qualifications SET native_capabilities=$1::jsonb WHERE credential_kind='cursor-api-key'",
          [JSON.stringify({ version: 1, goals: false, nativeFork: false, transcriptFork: false,
            nativeReview: false, connectedApps: false, multiAgent: false })]);
      });
      const credentials = new DatabaseCloudAgentCredentialService(setup, keys), credentialId = randomUUID();
      await credentials.put({ ownerUserId: fundingOwnerUserId, organizationId: scope.organizationId,
        credentialId, operationId: randomUUID(), expectedRevision: 0, displayName: "Synthetic boot cost fixture",
        material: { kind: "cursor-api-key", apiKey: "fixture-invalid-key" } });
      await credentials.setOrganizationConnection(fundingOwnerUserId, scope.organizationId, provider,
        { expectedRevision: 0, credentialId, credentialRevision: 1, models: [model], consent: "zeros-managed" });
    } finally { await setup.end(); }
  }

  async function establishBootContext(writes: pg.Pool) {
    const app = new Hono().route("/", createCloudAgentExecutionRoutes(new DatabaseCloudAgentExecutionService(writes, keys, false)));
    const request = { version: 1, mode: "boot-owner-v1", organizationId: scope.organizationId,
      workspaceId: scope.workspaceId, generation: scope.generation, engineInstanceId: scope.engineInstanceId };
    const boot = await bootRequest(app, "bootstrap", scope, request, CloudAgentBootCredentialResponseSchema);
    expect(boot.providers.some(slot => slot.provider === provider && slot.status === "ready")).toBe(true);
    const reference = { ...request, bootId: boot.bootId, writerEpoch: boot.writerEpoch };
    const activated = await bootRequest(app, "activate", scope, { ...reference, expectedCacheRevision: boot.cacheRevision },
      CloudAgentBootActivateResponseSchema);
    expect(activated.activated).toBe(true);
    const actor = await bootRequest(app, "actor-confirm", scope, { ...reference, actorSessionId: scope.actorSessionId },
      CloudAgentActorConfirmResponseSchema);
    expect(actor.provenance.actorSessionId).toBe(scope.actorSessionId);
    const context = await bootRequest(app, "warm-context", scope, { ...reference, actorSessionId: scope.actorSessionId,
      provider, conversationId: "synthetic-cost-turn", model, cwd: "/workspace", repositoryServers: [] },
      CloudAgentWarmActorResponseSchema);
    expect(context.actor.actorSessionId).toBe(scope.actorSessionId);
    expect(context.bootId === boot.bootId && context.writerEpoch === boot.writerEpoch).toBe(true);
    return { boot, actor: actor.provenance, context };
  }

  it("measures a real legacy enqueue/claim/admit/validate/journal/settle turn after setup and positive PG drain", async () => {
    const turn = workload(scope, delegationId), relay = await relayFixture(scope);
    const pair = await relay.connect(), sampler = createPostgresCostSampler({ monitorPool: monitor, targetDatabase, monitorDatabase });
    try {
      const start = await sampler.checkpoint(), writes = producer();
      const app = new Hono().route("/", createCloudCommandRoutes(new DatabaseCloudWorkspaceCommandService({ pool: writes })))
        .route("/", createCloudAgentExecutionRoutes(new DatabaseCloudAgentExecutionService(writes, keys, false)))
        .route("/", createCloudEventRoutes(new DatabaseCloudWorkspaceEventService({ pool: writes })));
      let expectedClientBytes = 0, expectedEngineBytes = 0;
      try {
        expectedClientBytes += await deliver(pair.client, pair.engine, turn.user);
        await privateRequest(app, CLOUD_COMMAND_PATH, scope, turn.user.params?.request, z.unknown(), true);
        const claimed = await privateRequest(app, CLOUD_COMMAND_PATH, scope, { kind: "claim",
          conversationId: turn.conversationId, executionId: turn.executionId, claimId: randomUUID() },
        z.object({ commandId: responseId, claimId: responseId }));
        expect(claimed.commandId).toBe(turn.commandId);
        const lease = await privateRequest(app, CLOUD_AGENT_EXECUTION_PATH, scope, { kind: "admit", environmentVersion: 1,
          admission: { executionId: turn.executionId, delegationId, provider, model,
            source: { kind: "command", commandId: turn.commandId, claimId: claimed.claimId } } },
        z.object({ leaseId: responseId, credentialVersion: z.number().int().positive() }));
        for (let index = 0; index < turn.events.length; index++) {
          expectedEngineBytes += await deliver(pair.engine, pair.client, turn.events[index]!);
          if (index === DELTAS) {
            await privateRequest(app, CLOUD_AGENT_EXECUTION_PATH, scope, { kind: "validate", leaseId: lease.leaseId },
              z.object({ leaseId: responseId }));
            expectedClientBytes += await deliver(pair.client, pair.engine, turn.reply);
          }
        }
        // Actual production service batches writes while retaining one row
        // for every event; do not inflate legacy cost into 103 HTTP requests.
        await privateRequest(app, CLOUD_EVENT_PATH, scope, { kind: "append", batchId: randomUUID(),
          events: turn.events.map((frame, index) => ({ sequence: index + 1, frame })) },
        z.object({ head: z.literal(EVENT_COUNT) }));
        await privateRequest(app, CLOUD_COMMAND_PATH, scope, { kind: "settle", result: { commandId: turn.commandId,
          claimId: claimed.claimId, state: "succeeded", resultCode: null, result: turn.result } }, z.unknown());
        await privateRequest(app, CLOUD_AGENT_EXECUTION_PATH, scope, { kind: "release", leaseId: lease.leaseId }, z.unknown());
      } finally { await writes.end(); }
      const end = await sampler.checkpoint(), cost = sampler.window(start, end);
      const coverage = relay.relay.messageObservationCoverage();
      expect(cost.databaseComplete).toBe(true);
      expect(BigInt(cost.database.xactCommit)).toBeGreaterThan(0n);
      expect(BigInt(cost.database.tuplesInserted)).toBeGreaterThanOrEqual(BigInt(EVENT_COUNT));
      expect(BigInt(cost.database.tuplesUpdated)).toBeGreaterThan(0n);
      expect(cost.successfulStatementCalls).toBeNull();
      expect(cost.sqlWriteStatements).toBeNull();
      expect(cost.encodedPersistedBytes).toBeNull();
      expect(coverage).toMatchObject({ complete: true, pendingForwards: 0, pendingObservations: 0,
        directions: { client_to_engine: { forwardedMessages: 2, forwardedBytes: expectedClientBytes, failedMessages: 0 },
          engine_to_client: { forwardedMessages: EVENT_COUNT, forwardedBytes: expectedEngineBytes, failedMessages: 0 } } });
      const verify = producer();
      try {
        const counts = await verify.query<{ event_count: string; lease_count: string; released_count: string; command_count: string }>(`
          SELECT (SELECT count(*)::text FROM cloud_workspace_stream_events WHERE workspace_id=$1) AS event_count,
            (SELECT count(*)::text FROM cloud_agent_execution_leases WHERE workspace_id=$1) AS lease_count,
            (SELECT count(*)::text FROM cloud_agent_execution_leases WHERE workspace_id=$1 AND released_at IS NOT NULL) AS released_count,
            (SELECT count(*)::text FROM cloud_workspace_commands WHERE workspace_id=$1 AND state='succeeded') AS command_count`, [scope.workspaceId]);
        expect(counts.rows).toEqual([{ event_count: String(EVENT_COUNT), lease_count: "1", released_count: "1", command_count: "1" }]);
      } finally { await verify.end(); }
      console.info("synthetic-cloud-turn-cost", JSON.stringify({ mode: "legacy", workload: { userMessages: 1,
        deltas: DELTAS, permissions: 1, terminals: 1 }, authority: cost.authority, database: cost.database,
        statements: null, encodedPersistedBytes: null, includesBackground: true, includesTeardown: true,
        cpRelay: { clientToEngineBytes: expectedClientBytes, engineToClientBytes: expectedEngineBytes } }));
    } finally { await relay.close(); }
  }, 30_000);

  it("measures genuine boot binding and warm actor setup separately from per-turn persistence", async () => {
    await configureBootSource();
    const sampler = createPostgresCostSampler({ monitorPool: monitor, targetDatabase, monitorDatabase });
    const start = await sampler.checkpoint(), writes = producer();
    let bootId: string, writerEpoch: string;
    try {
      const { boot } = await establishBootContext(writes);
      bootId = boot.bootId; writerEpoch = boot.writerEpoch;
    } finally { await writes.end(); }
    const end = await sampler.checkpoint(), cost = sampler.window(start, end);
    expect(cost.databaseComplete).toBe(true);
    expect(BigInt(cost.database.xactCommit)).toBeGreaterThan(0n);
    expect(BigInt(cost.database.tuplesInserted)).toBeGreaterThan(0n);
    expect(cost.successfulStatementCalls).toBeNull();
    const verify = producer();
    try {
      const state = await verify.query<{ mode: string; boot_id: string; writer_epoch: string; state: string; leases: string }>(`
        SELECT workspace.agent_command_mode AS mode,binding.boot_id,writer.writer_epoch,writer.state,
          (SELECT count(*)::text FROM cloud_agent_execution_leases WHERE workspace_id=workspace.id) AS leases
        FROM cloud_workspaces workspace JOIN cloud_agent_boot_bindings binding ON binding.id=workspace.agent_boot_id
        JOIN cloud_workspace_local_command_writers writer ON writer.writer_epoch=binding.writer_epoch
        WHERE workspace.id=$1`, [scope.workspaceId]);
      expect(state.rows).toEqual([{ mode: "boot-owner-v1", boot_id: bootId, writer_epoch: writerEpoch, state: "active", leases: "0" }]);
    } finally { await verify.end(); }
    console.info("synthetic-cloud-boot-cost", JSON.stringify({ mode: "boot-owner-v1", phase: "boot-and-context-setup",
      authority: cost.authority, database: cost.database, statements: null, encodedPersistedBytes: null,
      includesBackground: true, includesTeardown: true, perTurn: false }));
  }, 30_000);

  it("measures the warm FULL outbox and actual compact canonical turn with direct delivery", async () => {
    await configureBootSource();
    const bootWrites = producer();
    let bound: Awaited<ReturnType<typeof establishBootContext>>;
    try { bound = await establishBootContext(bootWrites); } finally { await bootWrites.end(); }
    const turn = workload(scope, delegationId), writer = bound.context.actor.scope;
    const { agentCredentialGrantId: _legacyGrant, ...payload } = turn.payload;
    const mutation = { conversationId: turn.conversationId, operationId: turn.commandId,
      expectedRevision: 0, action: { kind: "enqueue" as const, commandId: turn.commandId, payload } };
    const input: ClientInput = { ...turn.user, params: { nativeCommandsVersion: 1, cloudTurnProtocolVersion: 1,
      cloudLocalCommandsVersion: 1, bootId: writer.bootId, writerEpoch: writer.writerEpoch,
      request: { kind: "mutate", mutation } } };
    const directory = mkdtempSync(join(tmpdir(), "zeros-w6-turn-cost-")), normal = openSqlite(":memory:");
    const actors = new CloudActorAuthorityRegistry({ scope: writer, engineLive: () => true });
    const relay = await relayFixture(scope), pair = await relay.connect(true);
    let queue: CloudLocalCommandQueue | undefined, driver: CloudLocalCommandMirrorDriver | undefined;
    let eventStore: CloudLocalCommandEventStore | undefined, eventRuntime: CloudEventRuntime | undefined;
    try {
      runMigrations(normal); normal.pragma("synchronous = NORMAL");
      normal.prepare("INSERT INTO chats(id,folder,agent_id,title,created_at,updated_at,rev) VALUES(?,?,?,?,?,?,?)")
        .run(turn.conversationId, bound.context.cwd, provider, "Synthetic cost turn", 1, 2, 1);
      const insert = normal.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES(?,?,?,?,?,?,?)");
      const user: AgentTextMessage = { id: turn.commandId, kind: "text", role: "user", text: "Synthetic cost measurement", createdAt: 1 };
      insert.run(turn.conversationId, user.id, 0, user.kind, JSON.stringify(user), user.createdAt, 2);
      normal.prepare("UPDATE sync_meta SET next_rev=3 WHERE id=0").run();
      actors.confirm(bound.context.actor);
      let eventSequence = 0;
      const file = join(directory, "commands.sqlite");
      queue = new CloudLocalCommandQueue({ file, scope: writer, actors, engineLive: () => true,
        history: () => ({ recordSequence: Number((normal.prepare("SELECT next_rev - 1 AS rev FROM sync_meta WHERE id=0").get() as { rev: number }).rev), eventSequence }),
        ready: (pending, actor, conversationId) => conversationId === bound.context.conversationId &&
          actor.actorSessionId === bound.context.actor.actorSessionId && pending.agentId === bound.context.provider &&
          pending.model === bound.context.model && bound.boot.providers.some(slot => slot.provider === provider && slot.status === "ready"),
        captureHistory: captured => {
          if (!eventStore) throw new Error("cost_event_store_unavailable");
          return captureCloudLocalCommandHistory({ ...captured, db: normal, repositoryRoot: bound.context.cwd,
            controls: eventStore.controls(captured.conversationId), redactDocument: value => value });
        },
      });
      expect(queue.durability()).toEqual({ journalMode: "wal", synchronous: "full" });
      eventStore = new CloudLocalCommandEventStore({ file, queue, engineLive: () => true });
      let localEventCpRequests = 0;
      eventRuntime = new CloudEventRuntime(scope.engineInstanceId, { request: async () => {
        localEventCpRequests++;
        throw new Error("cost_local_events_requested_cp");
      }, onFailure: () => undefined });
      eventRuntime.start(); await eventRuntime.installLocalStore(eventStore);
      const sampler = createPostgresCostSampler({ monitorPool: monitor, targetDatabase, monitorDatabase });
      const start = await sampler.checkpoint(), writes = producer();
      let mirrorRequests = 0, clientBytes = 0, engineBytes = 0;
      try {
        const commands = new DatabaseCloudWorkspaceCommandService({ pool: writes });
        const app = new Hono().route("/", createCloudCommandRoutes(commands));
        const context = { writerEpoch: writer.writerEpoch, actorSessionId: bound.context.actor.actorSessionId };
        clientBytes += await deliver(pair.client, pair.engine, input);
        // The trusted engine adds its local validation result; this field is
        // absent from the renderer's strict wire request above.
        queue.handle({ kind: "mutate", mutation, admissionError: null }, context);
        const claim = CloudBootCommandClaimSchema.parse(queue.handle({ kind: "claim", conversationId: turn.conversationId,
          executionId: turn.executionId, claimId: randomUUID() }, context));
        expect(claim.commandId).toBe(turn.commandId);
        eventStore.bindControlOwner(turn.reply.permissionId, "permission", claim);
        for (let index = 0; index < turn.events.length; index++) {
          const frame = eventRuntime.capture(turn.events[index]!);
          engineBytes += await deliver(pair.engine, pair.client, frame);
          eventSequence = eventRuntime.cursor.sequence;
          if (index === DELTAS) clientBytes += await deliver(pair.client, pair.engine, turn.reply);
        }
        expect(eventStore.controls(turn.conversationId)).toHaveLength(2);
        const replay = await eventRuntime.replay({ streamId: scope.engineInstanceId, sequence: 0 });
        expect(replay.events).toHaveLength(EVENT_COUNT);
        expect(localEventCpRequests).toBe(0);
        // The synthetic native side commits its coalesced exact final NORMAL
        // state. No PostgreSQL stream row is used as a substitute for it.
        const assistant: AgentTextMessage = { id: "synthetic-response", kind: "text", role: "agent",
          text: "delta".repeat(DELTAS), createdAt: 2 };
        insert.run(turn.conversationId, assistant.id, 1, assistant.kind, JSON.stringify(assistant), assistant.createdAt, 3);
        normal.prepare("INSERT INTO turns(chat_id,turn_id,folder,agent_id,ord,started_at,ended_at,status,files,usage,rev) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .run(turn.conversationId, turn.commandId, bound.context.cwd, provider, 0, 1, 2, "completed", "[]", "{}", 4);
        normal.prepare("UPDATE sync_meta SET next_rev=5 WHERE id=0").run();
        queue.handle({ kind: "settle", result: { commandId: turn.commandId, claimId: claim.claimId,
          state: "succeeded", resultCode: null, result: turn.result } }, context);
        const localHead = queue.currentHistoryHead(turn.conversationId);
        expect(localHead !== null && "manifestSha256" in localHead.history).toBe(true);
        const parent = { organizationId: scope.organizationId, workspaceId: scope.workspaceId,
          generation: scope.generation, engineInstanceId: scope.engineInstanceId };
        driver = new CloudLocalCommandMirrorDriver({ scope: writer, queue, assertCurrent: () => {
          // Background replication checks the already-confirmed engine/boot
          // binding, independent of the sending actor's ten-second deadline.
          if (queue?.scope.bootId !== bound.boot.bootId || queue.scope.writerEpoch !== bound.boot.writerEpoch)
            throw new Error("cost_mirror_scope_changed");
        },
          request: async (batch, signal) => {
            mirrorRequests++;
            return requestCloudLocalCommandMirror({ ...parent, heartbeatToken: scope.heartbeatToken,
              heartbeatEndpoint: "https://control-plane.cost.test/internal/v1/cloud-workspaces/engine/heartbeat" }, batch, signal,
            async (input, init) => app.request(input instanceof Request ? input : input.toString(), init));
          } });
        await driver.flush();
        expect(queue.mirrorDrained()).toBe(true);
      } finally { await writes.end(); }
      const end = await sampler.checkpoint(), cost = sampler.window(start, end), coverage = relay.relay.messageObservationCoverage();
      expect(cost.databaseComplete).toBe(true);
      expect(BigInt(cost.database.xactCommit)).toBeGreaterThan(0n);
      expect(BigInt(cost.database.tuplesInserted)).toBeGreaterThan(0n);
      expect(coverage.complete).toBe(true);
      expect(coverage.directions.client_to_engine.forwardedBytes + coverage.directions.engine_to_client.forwardedBytes).toBe(0);
      expect(normal.pragma("synchronous", { simple: true })).toBe(1);
      const verify = producer();
      try {
        const counts = await verify.query<{ events: string; leases: string; commands: string; heads: string; blobs: string; controls: string }>(`
          SELECT (SELECT count(*)::text FROM cloud_workspace_stream_events WHERE workspace_id=$1) AS events,
            (SELECT count(*)::text FROM cloud_agent_execution_leases WHERE workspace_id=$1) AS leases,
            (SELECT count(*)::text FROM cloud_workspace_local_commands WHERE workspace_id=$1 AND state='succeeded') AS commands,
            (SELECT count(*)::text FROM cloud_workspace_local_command_history_heads WHERE workspace_id=$1 AND complete) AS heads,
            (SELECT count(*)::text FROM cloud_workspace_local_command_history_blobs WHERE workspace_id=$1) AS blobs,
            (SELECT count(*)::text FROM cloud_workspace_local_agent_controls WHERE workspace_id=$1) AS controls`, [scope.workspaceId]);
        expect(counts.rows).toEqual([{ events: "0", leases: "0", commands: "1", heads: "1", blobs: "7", controls: "2" }]);
      } finally { await verify.end(); }
      console.info("synthetic-cloud-turn-cost", JSON.stringify({ mode: "boot-owner-v1", phase: "warm-turn", workload: {
        userMessages: 1, deltas: DELTAS, permissions: 1, terminals: 1 }, authority: cost.authority, database: cost.database,
        statements: null, encodedPersistedBytes: null, includesBackground: true, includesTeardown: true,
        mirrorRequests, cpRelayBytes: 0, directDeliveredBytes: clientBytes + engineBytes,
        nativeProviderQualified: false, permissionDurableActionIncluded: false }));
    } finally {
      driver?.close(); eventRuntime?.close(); eventStore?.close(); queue?.close(); actors.dispose(); normal.close(); await relay.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("delivers the identical complete workload directly with no additional CP-relayed bytes", async () => {
    const turn = workload(scope, delegationId), relay = await relayFixture(scope);
    try {
      const relayed = await relay.connect(), legacy = await deliverTurn(relayed, turn);
      await expect.poll(() => relay.relay.messageObservationCoverage().complete).toBe(true);
      const before = relay.relay.messageObservationCoverage();
      expect(before.directions.engine_to_client.forwardedMessages).toBe(EVENT_COUNT);
      const direct = await relay.connect(true), delivered = await deliverTurn(direct, turn);
      expect(delivered).toEqual(legacy);
      const after = relay.relay.messageObservationCoverage();
      expect(after.complete).toBe(true);
      expect(after.directions).toEqual(before.directions);
      expect(after.observedMessages).toBe(before.observedMessages);
      const directCpRelayBytes = after.directions.client_to_engine.forwardedBytes + after.directions.engine_to_client.forwardedBytes -
        before.directions.client_to_engine.forwardedBytes - before.directions.engine_to_client.forwardedBytes;
      expect(directCpRelayBytes).toBe(0);
      console.info("synthetic-cloud-turn-relay", JSON.stringify({ workload: { userMessages: 1, deltas: DELTAS,
        permissions: 1, terminals: 1 }, legacyCpRelayBytes: legacy.clientBytes + legacy.engineBytes,
        directCpRelayBytes, directDeliveredBytes: delivered.clientBytes + delivered.engineBytes,
        productionProviderWssQualified: false }));
    } finally { await relay.close(); }
  }, 30_000);
});
