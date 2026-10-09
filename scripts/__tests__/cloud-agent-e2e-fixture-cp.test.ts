import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CloudActorAdmissionResponseSchema } from "@zeros/protocol/cloud-actors";
import { CloudCommandClaimSchema, CloudCommandEntrySchema, CloudCommandSnapshotSchema, cloudCommandFailureFromCode } from "@zeros/protocol/cloud-commands";
import { requestCloudCommand, CloudCommandRuntimeError } from "../../apps/desktop/src/engine/cloud-command-client";
import { CloudAgentAccessMaterialSchema, CloudAgentExecutionAuthoritySchema, CloudAgentExecutionLeaseSchema, CloudBackgroundStateSchema } from "@zeros/protocol/cloud-agent-execution";
import { requestCloudAgentExecution } from "../../apps/desktop/src/engine/cloud-agent-execution-client";
import { cloudMcpDigest } from "../../apps/desktop/src/engine/agents/cloud-mcp";
import { CloudEventAppendResultSchema, CloudEventReplayResultSchema, CloudTurnOutcomeSchema } from "@zeros/protocol/cloud-events";
import { requestCloudEvent } from "../../apps/desktop/src/engine/cloud-event-client";
import { createFixtureControlPlane, type FixtureControlPlane } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/server";

const fixtures: FixtureControlPlane[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())); });

async function setup(options: Parameters<typeof createFixtureControlPlane>[0] = {}) {
  const fixture = createFixtureControlPlane(options);
  fixtures.push(fixture);
  const attestation = { profile: "zeros-cloud-worker-v4" as const, manifestSha256: "a".repeat(64),
    runtimeId: `r1-${"a".repeat(64)}`, baseCompatibilityId: `bc1-${"b".repeat(64)}`,
    installerReceiptSha256: "c".repeat(64), bootId: randomUUID(), supervisorSessionId: randomUUID() };
  fixture.configureRuntime(attestation);
  const { baseUrl } = await fixture.start();
  const scope = { workspaceId: fixture.identity.workspaceId, organizationId: fixture.identity.organizationId,
    generation: fixture.identity.generation, engineInstanceId: fixture.identity.engineInstanceId };
  const post = (path: string, body: unknown, token = fixture.authority().heartbeatToken) => fetch(`${baseUrl}${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const registration = { ...scope, setupRunId: fixture.identity.setupRunId, executionFence: fixture.identity.executionFence,
    protocolVersion: fixture.identity.protocolVersion, actorProtocolVersion: 2, agentCustomizationVersion: 3, agentRuntime: attestation };
  const register = () => post("/internal/v1/cloud-workspaces/engine/register", registration, fixture.runtimeTokens.registrationToken);
  return { fixture, baseUrl, scope, post, register, registration };
}

describe("cloud agent E2E fixture registration and actor authority", () => {
  it("requires exact runtime registration before heartbeat authority exists", async () => {
    const { fixture, scope, post, register } = await setup();
    expect((await post("/internal/v1/cloud-workspaces/engine/heartbeat", scope)).status).toBe(401);
    const response = await register();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 1, audience: "zeros-cloud-workspace-engine-registration-v1",
      engineInstanceId: scope.engineInstanceId, durableRecordConnected: true,
      heartbeat: { token: fixture.authority().heartbeatToken, intervalMs: 10_000 } });
    expect((await post("/internal/v1/cloud-workspaces/engine/heartbeat", scope)).status).toBe(200);
  });

  it.each(["workspaceId", "organizationId", "engineInstanceId", "setupRunId"] as const)("rejects a foreign %s at registration", async field => {
    const { fixture, registration, post } = await setup();
    const response = await post("/internal/v1/cloud-workspaces/engine/register", { ...registration, [field]: randomUUID() }, fixture.runtimeTokens.registrationToken);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "engine_registration_rejected", retryable: false } });
  });

  it("rejects wrong attestation, unknown fields and bearer tokens without echoing input", async () => {
    const { fixture, registration, post } = await setup();
    const path = "/internal/v1/cloud-workspaces/engine/register";
    expect((await post(path, { ...registration, agentRuntime: { ...registration.agentRuntime, bootId: randomUUID() } }, fixture.runtimeTokens.registrationToken)).status).toBe(403);
    expect((await post(path, { ...registration, extra: "private-sentinel" }, fixture.runtimeTokens.registrationToken)).status).toBe(422);
    const response = await post(path, registration, `zws_${randomBytes(32).toString("base64url")}`);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("private-sentinel");
  });

  it("expires engine authority and cannot resurrect it with a late heartbeat", async () => {
    let now = Date.now();
    const { scope, post, register } = await setup({ now: () => now, engineLeaseMs: 30_000 });
    await register();
    now += 30_001;
    const response = await post("/internal/v1/cloud-workspaces/engine/heartbeat", scope);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "engine_authority_rejected" } });
  });

  it("redeems one actor/device-bound grant, then only permits explicit renewal", async () => {
    const { fixture, scope, post, register } = await setup();
    await register();
    const path = "/internal/v2/cloud-workspaces/engine/client-admission";
    const request = { ...scope, grantToken: fixture.actorGrantToken };
    expect((await post(path, { ...request, renew: true })).status).toBe(401);
    const response = await post(path, request);
    expect(response.status).toBe(200);
    const result = CloudActorAdmissionResponseSchema.parse(await response.json());
    expect(result).toMatchObject({ accountUserId: fixture.actor.userId, actorSessionId: fixture.actor.sessionId,
      deviceId: fixture.actor.deviceId, role: fixture.actor.role, fingerprint: fixture.actor.fingerprint });
    expect((await post(path, request)).status).toBe(401);
    expect((await post(path, { ...request, renew: true })).status).toBe(200);
    fixture.revokeActor();
    expect((await post(path, { ...request, renew: true })).status).toBe(401);
  });

  it("inspection has only bounded metadata and close is idempotent", async () => {
    const { fixture, scope, post, register } = await setup();
    await register();
    await post("/missing-private-sentinel", { ...scope, prompt: "private-sentinel" });
    const serialized = JSON.stringify(fixture.inspect());
    expect(serialized).not.toContain(fixture.runtimeTokens.registrationToken);
    expect(serialized).not.toContain(fixture.authority().heartbeatToken);
    expect(serialized).not.toContain(fixture.actorGrantToken);
    expect(serialized).not.toContain("private-sentinel");
    await fixture.close(); await fixture.close();
  });

  it("checks the owning bearer before parsing private request bodies", async () => {
    const { fixture, post, register } = await setup(); await register();
    for (const path of ["/internal/v1/cloud-workspaces/engine/commands", "/internal/v1/cloud-workspaces/engine/events", "/internal/v2/cloud-workspaces/engine/agent-execution"]) {
      const response = await post(path, { private: "do-not-echo" }, fixture.actorGrantToken);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "engine_authority_rejected" });
    }
  });

  it.each([
    ["/internal/v1/cloud-workspaces/engine/commands", "invalid_command", 422],
    ["/internal/v1/cloud-workspaces/engine/events", "invalid_event", 422],
    ["/internal/v2/cloud-workspaces/engine/agent-execution", "invalid_agent_execution", 415],
  ] as const)("uses the real content-type refusal at %s", async (path, code, status) => {
    const { fixture, baseUrl, register } = await setup(); await register();
    const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "text/plain", authorization: `Bearer ${fixture.authority().heartbeatToken}` }, body: "private-text" });
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code });
    expect(fixture.inspect().requests.at(-1)).toMatchObject({ path, status, errorCode: code });
  });

  it("keeps durable head GET-only", async () => {
    const { scope, post, register } = await setup(); await register();
    const response = await post("/internal/v1/cloud-workspaces/engine/record/head", scope);
    expect(response.status).toBe(404);
  });

  it.each([
    ["/internal/v1/cloud-workspaces/engine/commands", 256 * 1024, "invalid_command"],
    ["/internal/v1/cloud-workspaces/engine/events", 1_100_000, "invalid_event"],
    ["/internal/v2/cloud-workspaces/engine/agent-execution", 256 * 1024, "invalid_agent_execution"],
  ] as const)("bounds raw body bytes at %s", async (path, limit, code) => {
    const { fixture, baseUrl, register } = await setup(); await register();
    const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixture.authority().heartbeatToken}` },
      body: JSON.stringify({ private: "x".repeat(limit) }) });
    expect(response.status).toBe(413); expect(await response.json()).toEqual({ error: code });
  });

  it("expires live actor admission after 30 seconds without revoking accepted command ownership", async () => {
    let now = Date.now();
    const { fixture, scope, post, enqueue, call, conversationId, executionId, claimId } = await queueSetup({ now: () => now });
    await enqueue(); now += 30_001;
    await post("/internal/v1/cloud-workspaces/engine/heartbeat", scope);
    expect((await post("/internal/v2/cloud-workspaces/engine/client-admission", { ...scope, grantToken: fixture.actorGrantToken, renew: true })).status).toBe(401);
    await expect(call({ kind: "snapshot", conversationId })).rejects.toMatchObject({ code: "cloud_actor_authority_rejected" });
    const claim = CloudCommandClaimSchema.parse(await call({ kind: "claim", conversationId, executionId, claimId }));
    expect(claim.dispatchAllowed).toBe(true);
  });
});

describe("cloud agent E2E fixture ordered event journal", () => {
  it("appends the real terminal frame, replays a lost ACK once and rejects conflicting/out-of-order batches", async () => {
    const { fixture, commandId, executionId, scope, post } = await queueSetup();
    const call = (request: Parameters<typeof requestCloudEvent>[1]) => requestCloudEvent(fixture.authority(), request, new AbortController().signal);
    const event = { sequence: 1, frame: { id: randomUUID(), timestamp: Date.now(), source: "engine" as const, type: "AGENT_PROMPT_COMPLETE" as const,
      requestId: commandId, sessionId: executionId, agentId: "claude", stopReason: "end_turn" as const, response: { stopReason: "end_turn" as const }, cloudStream: { streamId: scope.engineInstanceId, sequence: 1 } } };
    const append = { kind: "append" as const, batchId: randomUUID(), events: [event] };
    expect(CloudEventAppendResultSchema.parse(await call(append))).toMatchObject({ head: 1, replayed: false });
    expect(CloudEventAppendResultSchema.parse(await call(append))).toMatchObject({ head: 1, replayed: true });
    const replay = CloudEventReplayResultSchema.parse(await call({ kind: "replay", streamId: scope.engineInstanceId, after: 0 }));
    expect(replay.events).toEqual([event]);
    expect(fixture.readEvents(0)).toEqual([event]);
    await expect(call({ ...append, events: [{ ...event, frame: { ...event.frame, timestamp: event.frame.timestamp + 1 } }] })).rejects.toMatchObject({ code: "event_conflict" });
    await expect(call({ ...append, batchId: randomUUID() })).rejects.toMatchObject({ code: "event_conflict" });
    await expect(call({ kind: "replay", streamId: randomUUID(), after: 0 })).rejects.toMatchObject({ code: "event_stream_changed" });
    expect((await post("/internal/v1/cloud-workspaces/engine/events", { ...scope, request: { ...append, batchId: randomUUID(), events: [{ ...event, sequence: 2 }] } })).status).toBe(422);
  });

  it("prunes by bounded retention and returns a typed expired cursor", async () => {
    const { fixture, scope } = await queueSetup({ eventRetentionCount: 2 });
    const call = (request: Parameters<typeof requestCloudEvent>[1]) => requestCloudEvent(fixture.authority(), request, new AbortController().signal);
    for (let sequence = 1; sequence <= 3; sequence++) await call({ kind: "append", batchId: randomUUID(), events: [{ sequence, frame: {
      id: randomUUID(), source: "engine", timestamp: Date.now(), type: "DB_CHANGED", kinds: ["messages"], cloudStream: { streamId: scope.engineInstanceId, sequence } } }] });
    await expect(call({ kind: "replay", streamId: scope.engineInstanceId, after: 0 })).rejects.toMatchObject({ code: "event_cursor_expired" });
    expect(CloudEventReplayResultSchema.parse(await call({ kind: "replay", streamId: scope.engineInstanceId, after: 1 }))).toMatchObject({ firstRetained: 2, cursor: 3, head: 3 });
  });

  it("does not certify success from a receipt without its exact native terminal", async () => {
    const { fixture, scope, commandId, conversationId, executionId, claimId, call, enqueue, post } = await queueSetup();
    await enqueue(); await call({ kind: "claim", conversationId, executionId, claimId });
    await call({ kind: "settle", result: { commandId, claimId, state: "succeeded", resultCode: null } });
    expect(() => fixture.assertTerminalConsistency(commandId)).toThrow("fixture_terminal_missing");
    const append = (requestId: string, sequence: number) => post("/internal/v1/cloud-workspaces/engine/events", { ...scope,
      request: { kind: "append", batchId: randomUUID(), events: [{ sequence, frame: { id: randomUUID(), source: "engine", timestamp: Date.now(),
        type: "AGENT_PROMPT_COMPLETE", requestId, sessionId: executionId, agentId: "claude", stopReason: "end_turn", response: { stopReason: "end_turn" }, cloudStream: { streamId: scope.engineInstanceId, sequence } } }] } });
    await append(randomUUID(), 1);
    expect(() => fixture.assertTerminalConsistency(commandId)).toThrow("fixture_terminal_missing");
    await append(commandId, 2);
    expect(() => fixture.assertTerminalConsistency(commandId)).not.toThrow();
    expect(JSON.stringify(fixture.inspect())).not.toContain("response");
  });

  it("matches cancellation using the actual terminal envelope's top-level stopReason", async () => {
    const { fixture, scope, commandId, conversationId, executionId, claimId, call, enqueue, post } = await queueSetup();
    await enqueue(); await call({ kind: "claim", conversationId, executionId, claimId });
    await post("/internal/v1/cloud-workspaces/engine/events", { ...scope, request: { kind: "append", batchId: randomUUID(), events: [{ sequence: 1,
      frame: { id: randomUUID(), source: "engine", timestamp: Date.now(), type: "AGENT_PROMPT_COMPLETE", requestId: commandId, sessionId: executionId,
        agentId: "claude", stopReason: "cancelled", response: { stopReason: "cancelled" }, cloudStream: { streamId: scope.engineInstanceId, sequence: 1 } } }] } });
    await call({ kind: "settle", result: { commandId, claimId, state: "cancelled", resultCode: null } });
    expect(() => fixture.assertTerminalConsistency(commandId)).not.toThrow();
  });

  it.each(["provider", "execution", "cancellation"])("rejects a terminal with mismatched %s", async mismatch => {
    const { fixture, scope, commandId, conversationId, executionId, claimId, call, enqueue, post } = await queueSetup();
    await enqueue(); await call({ kind: "claim", conversationId, executionId, claimId });
    await call({ kind: "settle", result: { commandId, claimId, state: "succeeded", resultCode: null } });
    await post("/internal/v1/cloud-workspaces/engine/events", { ...scope, request: { kind: "append", batchId: randomUUID(), events: [{ sequence: 1,
      frame: { id: randomUUID(), source: "engine", timestamp: Date.now(), type: "AGENT_PROMPT_COMPLETE", requestId: commandId,
        sessionId: mismatch === "execution" ? randomUUID() : executionId, agentId: mismatch === "provider" ? "cursor" : "claude",
        stopReason: mismatch === "cancellation" ? "cancelled" : "end_turn", response: { stopReason: "end_turn" },
        cloudStream: { streamId: scope.engineInstanceId, sequence: 1 } } }] } });
    expect(() => fixture.assertTerminalConsistency(commandId)).toThrow("fixture_terminal_conflict");
  });

  it("rejects duplicate command terminals even when another execution produced one", async () => {
    const { fixture, scope, commandId, conversationId, executionId, claimId, call, enqueue, post } = await queueSetup();
    await enqueue(); await call({ kind: "claim", conversationId, executionId, claimId });
    await call({ kind: "settle", result: { commandId, claimId, state: "succeeded", resultCode: null } });
    await post("/internal/v1/cloud-workspaces/engine/events", { ...scope, request: { kind: "append", batchId: randomUUID(),
      events: [executionId, randomUUID()].map((sessionId, index) => ({ sequence: index + 1, frame: { id: randomUUID(), source: "engine", timestamp: Date.now(),
        type: "AGENT_PROMPT_COMPLETE", requestId: commandId, sessionId, agentId: "claude", stopReason: "end_turn", response: { stopReason: "end_turn" },
        cloudStream: { streamId: scope.engineInstanceId, sequence: index + 1 } } })) } });
    expect(() => fixture.assertTerminalConsistency(commandId)).toThrow("fixture_terminal_conflict");
  });

  it("cannot conceal a generic VM settlement behind the CP's retained typed admission denial", async () => {
    const { fixture, scope, commandId, conversationId, executionId, claimId, call, enqueue, post, payload } = await queueSetup({ credentials: { mode: "environment", env: {} } });
    await enqueue(); await call({ kind: "claim", conversationId, executionId, claimId });
    await expect(requestCloudAgentExecution(fixture.authority(), { kind: "admit", admission: { executionId, delegationId: fixture.delegationId("claude"),
      provider: "claude", model: payload.model, source: { kind: "command", commandId, claimId } }, environmentVersion: 1 }, new AbortController().signal))
      .rejects.toMatchObject({ code: "cloud_agent_credential_required" });
    await call({ kind: "settle", result: { commandId, claimId, state: "failed", resultCode: "vm_command_executor_error" } });
    expect(fixture.readCommand(commandId)).toMatchObject({ state: "failed", resultCode: "cloud_agent_credential_required" });
    await post("/internal/v1/cloud-workspaces/engine/events", { ...scope, request: { kind: "append", batchId: randomUUID(), events: [{ sequence: 1,
      frame: { id: randomUUID(), source: "engine", timestamp: Date.now(), type: "AGENT_PROMPT_FAILED", requestId: commandId, sessionId: executionId,
        agentId: "claude", error: "cloud_agent_credential_required", cloudStream: { streamId: scope.engineInstanceId, sequence: 1 } } }] } });
    expect(() => fixture.assertTerminalConsistency(commandId)).toThrow("fixture_settlement_conflict");
    expect(fixture.inspect().commands[0]).toMatchObject({ settlementMatchesReceipt: false });
  });

  it.each(["command", "conversation", "response", "matching"])("cross-checks the receipt's native terminal %s", async mismatch => {
    const { fixture, scope, commandId, conversationId, executionId, claimId, call, enqueue, post } = await queueSetup();
    await enqueue(); await call({ kind: "claim", conversationId, executionId, claimId });
    await call({ kind: "settle", result: { commandId, claimId, state: "succeeded", resultCode: null, result: { version: 1, terminal: {
      commandId: mismatch === "command" ? randomUUID() : commandId, conversationId: mismatch === "conversation" ? randomUUID() : conversationId,
      executionId, turnId: randomUUID(), agentId: "claude", status: "completed", stopReason: "end_turn", response: {
        stopReason: "end_turn", usage: { inputTokens: mismatch === "response" ? 999 : 1 } } } } } });
    await post("/internal/v1/cloud-workspaces/engine/events", { ...scope, request: { kind: "append", batchId: randomUUID(), events: [{ sequence: 1,
      frame: { id: randomUUID(), source: "engine", timestamp: Date.now(), type: "AGENT_PROMPT_COMPLETE", requestId: commandId, sessionId: executionId,
        agentId: "claude", stopReason: "end_turn", response: { stopReason: "end_turn", usage: { inputTokens: 1 } },
        cloudStream: { streamId: scope.engineInstanceId, sequence: 1 } } }] } });
    if (mismatch === "matching") expect(() => fixture.assertTerminalConsistency(commandId)).not.toThrow();
    else expect(() => fixture.assertTerminalConsistency(commandId)).toThrow("fixture_terminal_conflict");
  });

  it.each(["matching-admission", "matching-provider", "matching-native-dispatch", "code", "kind", "stage", "message", "terminal-message", "missing-failure", "advice", "extra-native-advice"])(
    "checks the real engine failure text/code contract: %s", async mismatch => {
      const { fixture, scope, commandId, conversationId, executionId, claimId, call, enqueue, post, payload } = await queueSetup();
      await enqueue(); await call({ kind: "claim", conversationId, executionId, claimId });
      const code = mismatch === "matching-native-dispatch" ? "cloud_provider_prompt_auth_required" :
        mismatch === "matching-provider" ? "cloud_provider_start_auth_required" : "cloud_agent_credential_required";
      // publishCloudCommandFailure retains human text but emits the typed code,
      // using the same native failure object for the receipt and event. The
      // dispatched receiver instead retains the frame's exact typed code.
      const failure = { ...(cloudCommandFailureFromCode(code, "claude") ?? { kind: "protocol-error" as const, stage: "initialize" as const,
        agentId: "claude", message: "The cloud agent request could not be completed. Review the conversation before trying again." }),
        ...(mismatch === "advice" ? { advice: "fixture recovery advice" } : {}) };
      const terminal = CloudTurnOutcomeSchema.parse({ commandId, conversationId, executionId, turnId: payload.userMessageId,
        agentId: "claude", status: "failed", stopReason: null,
        error: mismatch === "terminal-message" ? "different retained message" : mismatch === "matching-native-dispatch" ? code : failure.message, failure });
      await call({ kind: "settle", result: { commandId, claimId, state: "failed", resultCode: code,
        result: { version: 1, terminal } } });
      const frameFailure = mismatch === "missing-failure" ? undefined : { ...failure,
        ...(mismatch === "kind" ? { kind: "subprocess-exited" } : {}),
        ...(mismatch === "stage" ? { stage: "prompt" } : {}),
        ...(mismatch === "message" ? { message: "different native message" } : {}),
        ...(mismatch === "advice" ? { advice: "different native advice" } : {}),
        ...(mismatch === "extra-native-advice" ? { advice: "unretained native advice" } : {}) };
      const response = await post("/internal/v1/cloud-workspaces/engine/events", { ...scope, request: { kind: "append", batchId: randomUUID(),
        events: [{ sequence: 1, frame: { id: randomUUID(), source: "engine", timestamp: Date.now(), type: "AGENT_PROMPT_FAILED",
          requestId: commandId, executionId, sessionId: executionId, agentId: "claude",
          error: mismatch === "code" ? "cloud_provider_prompt_protocol_error" : code,
          ...(frameFailure ? { failure: frameFailure } : {}), cloudStream: { streamId: scope.engineInstanceId, sequence: 1 } } }] } });
      expect(response.status).toBe(200);
      if (mismatch.startsWith("matching-")) expect(() => fixture.assertTerminalConsistency(commandId)).not.toThrow();
      else expect(() => fixture.assertTerminalConsistency(commandId)).toThrow("fixture_terminal_conflict");
    });
});

describe("cloud agent E2E fixture durable record sync", () => {
  it("returns the actual empty head before readiness and advances one revision per mutation", async () => {
    const { fixture, baseUrl, scope, post, register } = await setup(); await register();
    const head = () => fetch(`${baseUrl}/internal/v1/cloud-workspaces/engine/record/head?${new URLSearchParams({ ...scope, generation: String(scope.generation), limit: "10" })}`,
      { headers: { authorization: `Bearer ${fixture.authority().heartbeatToken}` } });
    expect(await (await head()).json()).toEqual({ currentRevision: 0, entries: [], next: null });
    const mutations = [{ entityKind: "chat", entityId: "chat-a", operation: "upsert", schemaVersion: 1, document: { version: 1, chat: { title: "private-record-text" } }, occurredAt: new Date().toISOString() },
      { entityKind: "turn", entityId: "turn-a", operation: "upsert", schemaVersion: 1, document: { version: 1 }, occurredAt: new Date().toISOString() }];
    const body = { ...scope, expectedRevision: 0, idempotencyKey: randomUUID(), mutations };
    const response = await post("/internal/v1/cloud-workspaces/engine/record/append", body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ firstRevision: 1, lastRevision: 2, currentRevision: 2, replayed: false });
    expect(await (await post("/internal/v1/cloud-workspaces/engine/record/append", body)).json()).toEqual({ firstRevision: 1, lastRevision: 2, currentRevision: 2, replayed: true });
    const document = await (await head()).json();
    expect(document).toMatchObject({ currentRevision: 2, next: null, entries: [{ entityKind: "chat", entityId: "chat-a", revision: 1, tombstonedAt: null }, { entityKind: "turn", entityId: "turn-a", revision: 2, tombstonedAt: null }] });
    expect(JSON.stringify(fixture.inspect())).not.toContain("private-record-text");
    expect(fixture.inspect()).toMatchObject({ recordRevision: 2, recordHeadReads: 2 });
  });

  it("handles cursor pagination, tombstones and exact revision/idempotency conflicts", async () => {
    const { fixture, baseUrl, scope, post, register } = await setup(); await register();
    const stamp = new Date().toISOString();
    const mutations = Array.from({ length: 12 }, (_, index) => ({ entityKind: "chat", entityId: `chat-${String(index).padStart(2, "0")}`, operation: "upsert", schemaVersion: 1, document: { version: 1 }, occurredAt: stamp }));
    const body = { ...scope, expectedRevision: 0, idempotencyKey: randomUUID(), mutations };
    await post("/internal/v1/cloud-workspaces/engine/record/append", body);
    const url = new URL(`${baseUrl}/internal/v1/cloud-workspaces/engine/record/head`);
    for (const [key, value] of Object.entries(scope)) url.searchParams.set(key, String(value));
    url.searchParams.set("limit", "10");
    const get = () => fetch(url, { headers: { authorization: `Bearer ${fixture.authority().heartbeatToken}` } }).then(response => response.json());
    const first = await get(); expect(first.entries).toHaveLength(10); expect(first.next).toEqual({ entityKind: "chat", entityId: "chat-09" });
    url.searchParams.set("afterEntityKind", first.next.entityKind); url.searchParams.set("afterEntityId", first.next.entityId);
    expect(await get()).toMatchObject({ currentRevision: 12, next: null, entries: [{ entityId: "chat-10" }, { entityId: "chat-11" }] });
    const conflict = await post("/internal/v1/cloud-workspaces/engine/record/append", { ...body, idempotencyKey: randomUUID() });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual({ error: { code: "revision_conflict" } });
    const changed = await post("/internal/v1/cloud-workspaces/engine/record/append", { ...body, mutations: [mutations[0]] });
    expect(changed.status).toBe(409); expect(await changed.json()).toEqual({ error: { code: "idempotency_conflict" } });
    const tombstone = await post("/internal/v1/cloud-workspaces/engine/record/append", { ...scope, expectedRevision: 12, idempotencyKey: randomUUID(),
      mutations: [{ entityKind: "chat", entityId: "chat-00", operation: "tombstone", schemaVersion: 1, occurredAt: stamp }] });
    expect(tombstone.status).toBe(200);
    url.searchParams.delete("afterEntityKind"); url.searchParams.delete("afterEntityId");
    expect((await get()).entries[0]).toMatchObject({ entityId: "chat-00", document: null, tombstonedAt: stamp, revision: 13 });
  });

  it("rejects malformed record documents and foreign owner scope with bare CP error envelopes", async () => {
    const { fixture, baseUrl, scope, post, register } = await setup(); await register();
    const response = await post("/internal/v1/cloud-workspaces/engine/record/append", { ...scope, expectedRevision: 0, idempotencyKey: randomUUID(),
      mutations: [{ entityKind: "chat", entityId: "bad", operation: "upsert", schemaVersion: 1, occurredAt: new Date().toISOString() }] });
    expect(response.status).toBe(422);
    const url = new URL(`${baseUrl}/internal/v1/cloud-workspaces/engine/record/head`);
    for (const [key, value] of Object.entries({ ...scope, workspaceId: randomUUID() })) url.searchParams.set(key, String(value));
    const foreign = await fetch(url, { headers: { authorization: `Bearer ${fixture.authority().heartbeatToken}` } });
    expect(foreign.status).toBe(401); expect(await foreign.json()).toEqual({ error: { code: "engine_authority_rejected" } });
  });

  it.each(["entity-control", "expired-timestamp", "reserved-key", "deep-document"])("matches durable record service refusal for %s", async problem => {
    let document: Record<string, unknown> = { version: 1 };
    if (problem === "reserved-key") document = JSON.parse('{"constructor":"private-value"}');
    if (problem === "deep-document") for (let index = 0; index < 34; index++) document = { nested: document };
    const now = Date.now();
    const { fixture, scope, post, register } = await setup({ now: () => now }); await register();
    const response = await post("/internal/v1/cloud-workspaces/engine/record/append", { ...scope, expectedRevision: 0, idempotencyKey: randomUUID(), mutations: [{
      entityKind: "chat", entityId: problem === "entity-control" ? "chat\u0000other" : "chat", operation: "upsert", schemaVersion: 1, document,
      occurredAt: new Date(now - (problem === "expired-timestamp" ? 24 * 60 * 60_000 + 1 : 0)).toISOString() }] });
    expect(response.status).toBe(422); expect(await response.json()).toEqual({ error: { code: "invalid_input" } });
    expect(fixture.inspect().recordRevision).toBe(0);
  });

  it("normalizes offset record timestamps before hashing idempotency and projecting tombstones", async () => {
    const now = Date.now(), stamp = new Date(now).toISOString();
    const { fixture, baseUrl, scope, post, register } = await setup({ now: () => now }); await register();
    const mutation = { entityKind: "chat", entityId: "chat", operation: "tombstone", schemaVersion: 1, occurredAt: stamp.replace("Z", "+00:00") };
    const body = { ...scope, expectedRevision: 0, idempotencyKey: randomUUID(), mutations: [mutation] };
    expect((await post("/internal/v1/cloud-workspaces/engine/record/append", body)).status).toBe(200);
    const replay = await post("/internal/v1/cloud-workspaces/engine/record/append", { ...body, mutations: [{ ...mutation, occurredAt: stamp }] });
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ replayed: true, currentRevision: 1 });
    const head = await fetch(`${baseUrl}/internal/v1/cloud-workspaces/engine/record/head?${new URLSearchParams({ ...scope, generation: String(scope.generation) })}`,
      { headers: { authorization: `Bearer ${fixture.authority().heartbeatToken}` } });
    expect(await head.json()).toMatchObject({ entries: [{ tombstonedAt: stamp }] });
  });
});

describe("cloud agent E2E fixture execution admission", () => {
  async function executionSetup(options: Parameters<typeof createFixtureControlPlane>[0] = {}) {
    const state = await queueSetup(options);
    await state.enqueue();
    await state.call({ kind: "claim", conversationId: state.conversationId, executionId: state.executionId, claimId: state.claimId });
    const admission = { executionId: state.executionId, delegationId: state.fixture.delegationId("claude"), provider: "claude" as const, model: state.payload.model,
      source: { kind: "command" as const, commandId: state.commandId, claimId: state.claimId },
      customization: { version: 3 as const, repositoryServers: [{ name: "valid-server", transport: "http" as const, url: "http://localhost:24193/mcp" }] } };
    const execute = (request: Parameters<typeof requestCloudAgentExecution>[1]) => requestCloudAgentExecution(state.fixture.authority(), request, new AbortController().signal);
    const admit = () => execute({ kind: "admit", admission, includeGitAuthor: true, nativeCapabilitiesVersion: 1, backgroundTasksVersion: 1, environmentVersion: 1 });
    return { ...state, admission, execute, admit };
  }

  it("echoes repository MCP with the actual engine digest and returns only provider access material", async () => {
    const { fixture, admission, admit } = await executionSetup();
    const authority = CloudAgentExecutionAuthoritySchema.parse(await admit());
    CloudAgentAccessMaterialSchema.parse(authority.material);
    const { digest, ...snapshot } = authority.customization!;
    expect(digest).toBe(cloudMcpDigest(snapshot));
    expect(snapshot.servers.filter(entry => entry.scope === "repository").map(entry => entry.server)).toEqual(admission.customization.repositoryServers);
    expect(snapshot.history).toBeDefined();
    expect(authority.environment?.values).toEqual({});
    expect(authority.nativeCapabilities?.connectedApps).toBe(false);
    expect(JSON.stringify(fixture.inspect())).not.toContain(JSON.stringify(authority.material));
    expect(CloudAgentExecutionAuthoritySchema.parse(await admit())).toEqual(authority);
  });

  it("echoes the exact live 0canvas declaration and fences changed customization on admission replay", async () => {
    const { admission, execute } = await executionSetup();
    const exact = { ...admission, customization: { version: 3 as const,
      repositoryServers: [{ name: "0canvas", transport: "http" as const, url: "http://localhost:24193/mcp" }] } };
    const result = CloudAgentExecutionAuthoritySchema.parse(await execute({ kind: "admit", admission: exact, environmentVersion: 1 }));
    expect(result.customization!.servers[0]!.server).toEqual(exact.customization.repositoryServers[0]);
    await expect(execute({ kind: "admit", admission: { ...exact, customization: { ...exact.customization, repositoryServers: [] } }, environmentVersion: 1 })).rejects.toBeDefined();
  });

  it("binds admission to the claimed command, provider, model and recorded actor", async () => {
    const { fixture, scope, post, admission, execute } = await executionSetup();
    for (const changed of [ { ...admission, executionId: randomUUID() }, { ...admission, model: "other-model" },
      { ...admission, provider: "cursor" as const }, { ...admission, source: { ...admission.source, claimId: randomUUID() } } ]) {
      await expect(execute({ kind: "admit", admission: changed, environmentVersion: 1 })).rejects.toMatchObject({ code: "cloud_admission_authority_http_4xx" });
      const response = await post("/internal/v2/cloud-workspaces/engine/agent-execution", { ...scope, request: { kind: "admit", admission: changed, environmentVersion: 1 } });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "cloud_agent_authority_rejected" });
    }
    fixture.revokeActor();
    await expect(execute({ kind: "admit", admission, environmentVersion: 1 })).rejects.toMatchObject({ code: "cloud_admission_authority_http_4xx" });
    const response = await post("/internal/v2/cloud-workspaces/engine/agent-execution", { ...scope, request: { kind: "admit", admission, environmentVersion: 1 } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cloud_agent_authority_rejected" });
  });

  it("records the invalid-delegation typed denial from a correctly claimed command", async () => {
    const state = await queueSetup();
    await state.call({ kind: "mutate", admissionError: null, mutation: { ...state.mutation,
      action: { ...state.mutation.action, payload: { ...state.payload, agentCredentialGrantId: state.fixture.invalidDelegationId } } } });
    await state.call({ kind: "claim", conversationId: state.conversationId, executionId: state.executionId, claimId: state.claimId });
    const admission = { executionId: state.executionId, delegationId: state.fixture.invalidDelegationId, provider: "claude" as const, model: state.payload.model,
      source: { kind: "command" as const, commandId: state.commandId, claimId: state.claimId } };
    await expect(requestCloudAgentExecution(state.fixture.authority(), { kind: "admit", admission, environmentVersion: 1 }, new AbortController().signal))
      .rejects.toMatchObject({ code: "cloud_agent_credential_required" });
    const settled = CloudCommandSnapshotSchema.parse(await state.call({ kind: "settle", result: { commandId: state.commandId, claimId: state.claimId, state: "succeeded", resultCode: null } }));
    expect(settled.receipts[0]).toMatchObject({ state: "failed", resultCode: "cloud_agent_credential_required" });
  });

  it("enforces allowed models with a typed denial retained in the durable receipt", async () => {
    const { commandId, claimId, call, admit } = await executionSetup({ allowedModels: { claude: ["another-model"] } });
    await expect(admit()).rejects.toMatchObject({ code: "cloud_agent_model_not_authorized" });
    const settled = CloudCommandSnapshotSchema.parse(await call({ kind: "settle", result: { commandId, claimId, state: "failed", resultCode: "cloud_admission_rejected" } }));
    expect(settled.receipts[0]).toMatchObject({ state: "failed", resultCode: "cloud_agent_model_not_authorized" });
  });

  it("renews only a live lease, expires independently of heartbeat, and releases idempotently", async () => {
    let now = Date.now();
    const { scope, post, execute, admit } = await executionSetup({ now: () => now, executionLeaseMs: 15_000 });
    const authority = CloudAgentExecutionAuthoritySchema.parse(await admit());
    now += 10_000;
    const renewed = CloudAgentExecutionLeaseSchema.parse(await execute({ kind: "validate", leaseId: authority.leaseId, renew: true, credentialVersion: 1 }));
    expect(Date.parse(renewed.expiresAt)).toBe(now + 15_000);
    now += 15_001;
    await post("/internal/v1/cloud-workspaces/engine/heartbeat", scope);
    await expect(execute({ kind: "validate", leaseId: authority.leaseId, renew: true })).rejects.toMatchObject({ code: "cloud_validation_authority_http_4xx" });
    expect(await execute({ kind: "release", leaseId: authority.leaseId })).toEqual({ released: true });
    expect(await execute({ kind: "release", leaseId: authority.leaseId })).toEqual({ released: true });
  });

  it("returns a bounded empty foreground background snapshot and rejects foreign conversation and unsupported retention", async () => {
    const { conversationId, execute, admit } = await executionSetup();
    const { leaseId } = CloudAgentExecutionAuthoritySchema.parse(await admit());
    expect(CloudBackgroundStateSchema.parse(await execute({ kind: "background", leaseId, operation: { kind: "read", conversationId } })))
      .toMatchObject({ leaseId, conversationId, phase: "foreground", snapshot: { tasks: [], waiting: false, processWork: false } });
    await expect(execute({ kind: "background", leaseId, operation: { kind: "read", conversationId: randomUUID() } })).rejects.toBeDefined();
    await expect(execute({ kind: "background", leaseId, operation: { kind: "retain", conversationId, revision: 1, snapshot: { tasks: [], waiting: false, processWork: false } } })).rejects.toBeDefined();
  });

  it("refuses missing environment credentials, makes no process.env changes and never stores material in inspection", async () => {
    const { fixture, admit } = await executionSetup({ credentials: { mode: "environment", env: {} } });
    await expect(admit()).rejects.toMatchObject({ code: "cloud_agent_credential_required" });
    expect(JSON.stringify(fixture.inspect())).not.toContain("material");
    const privateValue = `fixture-access-${randomBytes(24).toString("hex")}`;
    const before = process.env.ANTHROPIC_API_KEY;
    const next = await executionSetup({ credentials: { mode: "environment", env: { ANTHROPIC_API_KEY: privateValue } } });
    const authority = CloudAgentExecutionAuthoritySchema.parse(await next.admit());
    expect(authority.material).toEqual({ kind: "claude-api-key", apiKey: privateValue });
    expect(process.env.ANTHROPIC_API_KEY).toBe(before);
    expect(JSON.stringify(next.fixture.inspect())).not.toContain(privateValue);
    expect(JSON.stringify(next.fixture.inspect())).not.toContain(authority.authorityId);
  });
});

async function queueSetup(options: Parameters<typeof createFixtureControlPlane>[0] = {}) {
  const state = await setup(options);
  await state.register();
  await state.post("/internal/v2/cloud-workspaces/engine/client-admission", { ...state.scope, grantToken: state.fixture.actorGrantToken });
  const conversationId = randomUUID(), commandId = randomUUID(), executionId = randomUUID(), claimId = randomUUID();
  const payload = { agentId: "claude", userMessageId: randomUUID(), prompt: [{ type: "text" as const, text: "fixture prompt" }],
    modeRevision: 0, model: "claude-test", agentCredentialGrantId: state.fixture.delegationId("claude"), permissionMode: "bypass" };
  const call = (request: Parameters<typeof requestCloudCommand>[1], actorSessionId: string | undefined = state.fixture.actor.sessionId) =>
    requestCloudCommand(state.fixture.authority(), request, new AbortController().signal, fetch, actorSessionId);
  const mutation = { conversationId, operationId: randomUUID(), expectedRevision: 0, action: { kind: "enqueue" as const, commandId, payload } };
  return { ...state, conversationId, commandId, executionId, claimId, payload, mutation, call,
    enqueue: () => call({ kind: "mutate", mutation, admissionError: null }) };
}

describe("cloud agent E2E fixture durable command queue", () => {
  it.each(["read", "snapshot"] as const)("advertises terminal support and projects %s only after explicit native opt-in", async kind => {
    const { fixture, baseUrl, scope, conversationId, commandId, executionId, claimId, payload, call, enqueue } = await queueSetup();
    await enqueue(); await call({ kind: "claim", conversationId, executionId, claimId });
    const terminal = { commandId, conversationId, executionId, turnId: payload.userMessageId, agentId: "claude",
      status: "completed", stopReason: "end_turn", response: { stopReason: "end_turn", userMessageId: payload.userMessageId } };
    await call({ kind: "settle", result: { commandId, claimId, state: "succeeded", resultCode: null,
      result: { version: 1, model: payload.model, terminal: { ...terminal, status: "completed", stopReason: "end_turn",
        response: { ...terminal.response, stopReason: "end_turn" } } } } });
    expect(fixture.readCommand(commandId).result?.terminal).toEqual(terminal);
    for (const [native, turnProtocol] of [[false, false], [false, true], [true, false], [true, true]]) {
      const response = await fetch(`${baseUrl}/internal/v1/cloud-workspaces/engine/commands`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixture.authority().heartbeatToken}`,
          ...(native ? { "x-zeros-native-commands": "1" } : {}), ...(turnProtocol ? { "x-zeros-cloud-turn-protocol": "1" } : {}) },
        body: JSON.stringify({ ...scope, actorSessionId: fixture.actor.sessionId,
          request: kind === "read" ? { kind, commandId } : { kind, conversationId } }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-zeros-cloud-turn-protocol")).toBe("1");
      const document = await response.json();
      const entry = kind === "read" ? document.result : document.result.receipts[0];
      if (!native) expect(entry).not.toHaveProperty("result");
      else expect(entry.result).toEqual({ version: 1, model: payload.model, ...(turnProtocol ? { terminal } : {}) });
    }
    // Legacy wire projection cannot remove evidence from the stored ledger.
    expect(fixture.readCommand(commandId).result?.terminal).toEqual(terminal);
  });

  it("returns real schemas and idempotent mutation, claim and settlement through the engine HTTP client", async () => {
    const { conversationId, commandId, executionId, claimId, mutation, call, enqueue } = await queueSetup();
    expect(CloudCommandSnapshotSchema.parse(await enqueue()).revision).toBe(1);
    expect(CloudCommandSnapshotSchema.parse(await call({ kind: "mutate", mutation, admissionError: "command_context_changed" })).replayed).toBe(true);
    const request = { kind: "claim" as const, conversationId, executionId, claimId };
    const [left, right] = await Promise.all([call(request), call(request)]);
    expect(CloudCommandClaimSchema.parse(left)).toEqual(right);
    expect(CloudCommandClaimSchema.parse(left).dispatchAllowed).toBe(true);
    expect(CloudCommandSnapshotSchema.parse(await call({ kind: "snapshot", conversationId })).revision).toBe(2);
    const result = { commandId, claimId, state: "succeeded" as const, resultCode: null };
    expect(CloudCommandSnapshotSchema.parse(await call({ kind: "settle", result })).replayed).toBe(false);
    expect(CloudCommandSnapshotSchema.parse(await call({ kind: "settle", result })).replayed).toBe(true);
    expect(CloudCommandEntrySchema.extend({ conversationId: CloudCommandSnapshotSchema.shape.conversationId }).parse(await call({ kind: "read", commandId })))
      .toMatchObject({ state: "succeeded", payload: null, executionId });
    expect(await call(request)).toBeNull();
  });

  it("rejects changed operation content, stale revision, wrong claim and conflicting settlement", async () => {
    const { conversationId, commandId, executionId, claimId, mutation, call, enqueue } = await queueSetup();
    await enqueue();
    const conflict = (request: Parameters<typeof requestCloudCommand>[1]) => expect(call(request)).rejects.toMatchObject({ code: "command_conflict" });
    await conflict({ kind: "mutate", mutation: { ...mutation, action: { ...mutation.action, payload: { ...mutation.action.payload, fast: true } } }, admissionError: null });
    await conflict({ kind: "mutate", mutation: { ...mutation, operationId: randomUUID(), action: { kind: "resume" } }, admissionError: null });
    await call({ kind: "claim", conversationId, executionId, claimId });
    await conflict({ kind: "claim", conversationId, executionId: randomUUID(), claimId });
    await conflict({ kind: "settle", result: { commandId, claimId: randomUUID(), state: "failed", resultCode: "cloud_provider_start_auth_required" } });
    await call({ kind: "settle", result: { commandId, claimId, state: "failed", resultCode: "cloud_provider_start_auth_required" } });
    await conflict({ kind: "settle", result: { commandId, claimId, state: "succeeded", resultCode: null } });
  });

  it("keeps Stop monotonic across replay and returns the accepted claim after Stop", async () => {
    const { conversationId, executionId, claimId, call, enqueue } = await queueSetup();
    await enqueue();
    const claim = await call({ kind: "claim", conversationId, executionId, claimId });
    const stop = { kind: "stop" as const, conversationId, operationId: randomUUID() };
    const paused = CloudCommandSnapshotSchema.parse(await call(stop));
    expect(paused.paused).toBe(true);
    expect(await call({ kind: "claim", conversationId, executionId, claimId })).toEqual(claim);
    const resumed = CloudCommandSnapshotSchema.parse(await call({ kind: "mutate", mutation: { conversationId, operationId: randomUUID(), expectedRevision: paused.revision, action: { kind: "resume" } }, admissionError: null }));
    const replay = CloudCommandSnapshotSchema.parse(await call(stop));
    expect(replay).toMatchObject({ paused: false, replayed: true, revision: resumed.revision });
  });

  it("never requeues a dispatched command on elapsed time and claims revoked actors without dispatch authority", async () => {
    let now = Date.now();
    const { fixture, scope, post, conversationId, executionId, claimId, call, enqueue } = await queueSetup({ now: () => now });
    await enqueue();
    await call({ kind: "claim", conversationId, executionId, claimId });
    now += 25_000;
    await post("/internal/v1/cloud-workspaces/engine/heartbeat", scope);
    fixture.revokeActor();
    const claim = CloudCommandClaimSchema.parse(await call({ kind: "claim", conversationId, executionId, claimId }));
    expect(claim.dispatchAllowed).toBe(false);
    expect(claim.actor).toBeUndefined();
    expect(await call({ kind: "claim", conversationId, executionId, claimId: randomUUID() })).toBeNull();
  });

  it("rejects missing/foreign actor and engine scope and unreserved failure categories", async () => {
    const { fixture, scope, post, conversationId, commandId, call, enqueue } = await queueSetup();
    const response = await post("/internal/v1/cloud-workspaces/engine/commands", { ...scope, request: { kind: "snapshot", conversationId } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cloud_actor_authority_rejected" });
    await expect(call({ kind: "snapshot", conversationId }, randomUUID())).rejects.toBeInstanceOf(CloudCommandRuntimeError);
    await enqueue();
    const request = { kind: "read", commandId };
    expect((await post("/internal/v1/cloud-workspaces/engine/commands", { ...scope, organizationId: randomUUID(), actorSessionId: fixture.actor.sessionId, request })).status).toBe(401);
    expect((await post("/internal/v1/cloud-workspaces/engine/commands", { ...scope, request: { kind: "settle", result: { commandId, claimId: randomUUID(), state: "failed", resultCode: "cloud_provider_prompt_private_unknown" } } })).status).toBe(422);
  });

  it("enforces the real workspace-wide pending limit and leaves snapshots detached", async () => {
    const { conversationId, payload, call, enqueue } = await queueSetup();
    const first = CloudCommandSnapshotSchema.parse(await enqueue());
    first.pending[0]!.payload!.model = "mutated";
    for (let index = 1; index < 32; index++) await call({ kind: "mutate", mutation: { conversationId, operationId: randomUUID(), expectedRevision: index,
      action: { kind: "enqueue", commandId: randomUUID(), payload: { ...payload, userMessageId: randomUUID() } } }, admissionError: null });
    expect(CloudCommandSnapshotSchema.parse(await call({ kind: "snapshot", conversationId })).pending[0]!.payload!.model).toBe("claude-test");
    await expect(call({ kind: "mutate", mutation: { conversationId: randomUUID(), operationId: randomUUID(), expectedRevision: 0,
      action: { kind: "enqueue", commandId: randomUUID(), payload } }, admissionError: null })).rejects.toMatchObject({ code: "command_limit" });
  });
});
