import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createCloudWorkspaceInternalRoutes } from "../../apps/control-plane/src/cloud-workspaces/internal-routes.ts";
import { CloudCommandError } from "../../apps/control-plane/src/cloud-workspaces/commands.ts";
import { loadContractSource } from "./source.mjs";

const id = (n) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const workspaceId = id(1),
  organizationId = id(2),
  engineInstanceId = id(3),
  conversationId = id(4);
const commandId = id(5),
  grantId = id(6),
  claimId = id(7),
  streamId = id(8);
const now = Date.parse("2026-10-06T00:00:00Z");
const origin = "https://control.example.invalid";
// Synthetic transport material is constructed at runtime and never printed.
const heartbeatToken = `zwh_${"H".repeat(43)}`;
const authority = {
  workspaceId,
  organizationId,
  engineInstanceId,
  generation: 1,
  heartbeatEndpoint: `${origin}/internal/v1/cloud-workspaces/engine/heartbeat`,
  heartbeatToken,
};
const abort = new AbortController();
const stamp = new Date(now).toISOString();
const prompt = [{ type: "text", text: "synthetic compatibility prompt" }];
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function until(condition, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("runtime_skew_contract_timeout");
}

async function bounded(promise, code, timeoutMs = 5_000) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function controlPlane() {
  let revision = 0,
    paused = false,
    entry = null,
    claimed = false;
  const requests = [],
    frames = [],
    actionReceipts = new Map();
  const snapshot = () => ({
    version: 1,
    conversationId,
    revision,
    paused,
    pending:
      entry && ["queued", "dispatching"].includes(entry.state)
        ? [clone(entry)]
        : [],
    receipts:
      entry && !["queued", "dispatching"].includes(entry.state)
        ? [clone(entry)]
        : [],
  });
  const service = {
    redeem: async () => {
      throw new Error("setup is outside this contract slice");
    },
    commands: {
      snapshot: async () => snapshot(),
      read: async (_scope, requested) => {
        assert.equal(requested, entry.commandId);
        return { ...clone(entry), conversationId };
      },
      mutate: async (_scope, mutation, admissionError) => {
        assert.equal(admissionError, null);
        assert.equal(mutation.expectedRevision, revision);
        if (mutation.action.kind === "enqueue") {
          assert.equal(entry, null);
          entry = {
            commandId: mutation.action.commandId,
            position: 1,
            state: "queued",
            payload: mutation.action.payload,
            executionId: null,
            generation: 1,
            resultCode: null,
            createdAt: stamp,
            updatedAt: stamp,
          };
        } else if (mutation.action.kind === "resume") paused = false;
        else throw new Error("unexpected queue mutation");
        revision++;
        return snapshot();
      },
      claim: async (_scope, conversation, execution, requestedClaim) => {
        assert.equal(conversation, conversationId);
        if (!entry || claimed || paused) return null;
        claimed = true;
        entry.state = "dispatching";
        entry.executionId = execution;
        return {
          commandId: entry.commandId,
          claimId: requestedClaim,
          conversationId,
          executionId: execution,
          payload: entry.payload,
        };
      },
      settle: async (_scope, result) => {
        assert.equal(result.commandId, entry.commandId);
        Object.assign(entry, {
          state: result.state,
          resultCode: result.resultCode,
          payload: null,
          ...(result.result ? { result: clone(result.result) } : {}),
        });
        revision++;
        return snapshot();
      },
      stop: async () => {
        paused = true;
        revision++;
        return snapshot();
      },
    },
    actions: {
      request: async (_scope, request) => {
        if (request.kind === "begin") {
          assert.equal(request.admissible, true);
          const action = request.action;
          const receipt = {
            operationId: action.operationId,
            conversationId: action.conversationId,
            executionId: action.executionId,
            kind: action.kind,
            requestId: action.requestId,
            state: "dispatching",
            claimId,
            outcome: null,
            turnId: null,
            replayed: false,
          };
          actionReceipts.set(action.operationId, receipt);
          return clone(receipt);
        }
        const receipt = actionReceipts.get(request.operationId);
        if (!receipt && request.kind === "read") throw new CloudCommandError("command_not_found");
        assert.ok(receipt);
        if (request.kind === "settle")
          Object.assign(receipt, {
            state: "settled",
            outcome: request.outcome,
            turnId: request.turnId,
          });
        return clone(receipt);
      },
    },
    events: {
      request: async (_scope, request) => {
        if (request.kind === "append") {
          frames.push(...clone(request.events));
          return { streamId, head: frames.at(-1).sequence, replayed: false };
        }
        assert.equal(request.streamId, streamId);
        return {
          streamId,
          head: frames.at(-1).sequence,
          firstRetained: 1,
          cursor: frames.at(-1).sequence,
          events: frames.filter((frame) => frame.sequence > request.after),
        };
      },
    },
    registerEngine: async (input) => {
      assert.equal(input.protocolVersion, 20);
      return {
        version: 1,
        audience: "zeros-cloud-workspace-engine-registration-v1",
        engineInstanceId,
        durableRecordConnected: true,
        leaseExpiresAtMs: now + 90_000,
        heartbeat: {
          endpoint: authority.heartbeatEndpoint,
          token: heartbeatToken,
          intervalMs: 5_000,
        },
      };
    },
    heartbeat: async () => ({
      version: 1,
      audience: "zeros-cloud-workspace-engine-heartbeat-v1",
      engineInstanceId,
      accepted: true,
      leaseExpiresAtMs: now + 90_000,
    }),
    admitRuntimeAccess: async () => ({
      version: 1,
      audience: "zeros-cloud-runtime-access-admission-v1",
      admitted: true,
      grantId,
      accountUserId: id(9),
      authorityEpoch: 1,
      kind: "ssh",
      remotePort: null,
      expiresAtMs: now + 5_000,
      leaseDurationMs: 5_000,
    }),
    admitActorClient: async () => ({
      version: 2,
      audience: "zeros-cloud-workspace-engine-client-admission-v2",
      admitted: true,
      accountUserId: id(9),
      authorityEpoch: 1,
      actorSessionId: id(6),
      deviceId: id(7),
      role: "developer",
      fingerprint: "a".repeat(64),
    }),
    appendRecord: async (input) => ({
      version: 1,
      revision: input.expectedRevision + 1,
      replayed: false,
    }),
  };
  const routes = createCloudWorkspaceInternalRoutes(service);
  return {
    requests,
    snapshot,
    service,
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, origin);
      requests.push({ path: parsed.pathname, body: JSON.parse(init.body) });
      // In-process Hono dispatch: no sockets, provider APIs, database or credentials.
      return routes.request(new globalThis.Request(parsed, init));
    },
  };
}

async function commandRoundtrip(client, engine, negativeFixture, stop = true, settled) {
  const cp = controlPlane(),
    completion = deferred();
  const journal = new engine.CloudEventRuntime(streamId, {
    request: (request) => engine.eventTransport.requestCloudEvent(authority, request, abort.signal, cp.fetch),
    onFailure: () => {},
  });
  journal.start();
  let dispatched = 0,
    cancelled = 0;
  const runtime = new engine.CloudCommandRuntime({
    request: (request) =>
      engine.commandTransport.requestCloudCommand(
        authority,
        request,
        abort.signal,
        cp.fetch,
      ),
    validate: () => {},
    execution: () => "execution-contract-fixture",
    dispatch: async (claim) => {
      assert.deepEqual(claim.payload.prompt, prompt);
      if (settled?.result?.terminal) settled = { ...settled, result: { ...settled.result,
        terminal: { ...settled.result.terminal, commandId: claim.commandId, conversationId: claim.conversationId,
          executionId: claim.executionId, turnId: claim.payload.userMessageId } } };
      dispatched++;
      return completion.promise;
    },
    cancel: async () => {
      cancelled++;
      completion.resolve({
        state: "cancelled",
        resultCode: "stopped_before_dispatch",
      });
    },
    changed: () => {},
  });
  const peer = { cloudActor: { sessionId: id(6) } };
  const commandHost = { cloudCommands: runtime, cloudTurnProtocols: new WeakMap() };
  const commandHandler = engine.engineReplies.EngineReplyContract.prototype.handleCloudCommandOperation;
  const responses = [], commandRequests = [];
  const bridge = {
    status: "connected",
    request: async (message) => {
      const { op, params } = message;
      let result;
      if (op === "cloudCommands.createConversation") {
        engine.commands.CloudConversationCreateSchema.parse(params);
        result = {
          conversationId,
          modeRevision: 0,
          permissionModeVersion: 1,
          nativeCommandsVersion: 1,
          ...(engine.engineReplies.cloudTurnProtocolVersion === 1 ? { cloudTurnProtocolVersion: 1 } : {}),
        };
      } else if (op === "cloudCommands.conversation") {
        engine.commands.CloudConversationReadSchema.parse(params);
        result = {
          conversationId,
          modeRevision: 0,
          permissionModeVersion: 1,
          nativeCommandsVersion: 1,
          ...(engine.engineReplies.cloudTurnProtocolVersion === 1 ? { cloudTurnProtocolVersion: 1 } : {}),
        };
      } else if (op === "cloudEvents.request") {
        // The receiving cohort supplies both the strict client parser and the
        // actual native journal snapshot implementation. Do not let a new
        // renderer operation pass against an older runtime via an echo fake.
        const request = engine.events.CloudEventClientRequestSchema.parse(params.request);
        if (request.kind === "snapshot") {
          assert.equal(request.conversationId, conversationId);
          result = await journal.snapshot(() => ({ conversationId,
            executionId: "execution-contract-fixture", activeTurn: null, messages: [] }));
        } else result = await journal.replay(request.cursor);
      } else {
        assert.equal(op, "cloudCommands.request");
        const request = clone(params.request);
        if (
          negativeFixture &&
          request.kind === "mutate" &&
          request.mutation.action.kind === "enqueue"
        )
          Object.assign(request.mutation.action.payload, negativeFixture);
        // Run the strict receiving cohort parser before the real engine pump.
        if (
          !engine.commands.CloudCommandClientRequestSchema.safeParse(request)
            .success
        )
          throw new Error(
            "runtime_skew_incompatible: queued prompt rejected before durable dispatch",
          );
        commandRequests.push(clone(params));
        result = await commandHandler.call(commandHost, op, { ...params, request }, peer);
      }
      responses.push(clone(result));
      return { type: "WORKSPACE_RESPONSE", op, result };
    },
  };
  const connection = new client.CloudAgentConnection(
    bridge,
    "local-main",
    async () => grantId,
  );
  let sending;
  try {
    await connection.request({
      type: "AGENT_NEW_SESSION",
      chatId: conversationId,
      agentId: "codex",
      env: { OPENAI_MODEL: "contract-model" },
    });
    sending = connection.request({
      type: "AGENT_PROMPT",
      sessionId: `conversation:${conversationId}`,
      agentId: "codex",
      userMessageId: "synthetic-message",
      prompt,
    });
    // Register observation immediately, so an incompatible request never causes
    // an unhandled rejection while the pump is being inspected.
    const observed = sending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    if (negativeFixture) {
      const result = await observed;
      assert.ok(result.error);
      assert.equal(
        cp.requests.filter((request) => request.body.request?.kind === "mutate")
          .length,
        0,
      );
      throw result.error;
    }
    await until(() => dispatched === 1);
    const payload = cp.snapshot().pending[0].payload;
    client.commands.CloudQueuedPromptSchema.parse(payload);
    assert.equal(payload.model, "contract-model");
    assert.equal(payload.permissionMode, "auto-edit");
    if (stop)
      await bridge.request(
        connection.outgoing({
          type: "AGENT_CANCEL",
          sessionId: `conversation:${conversationId}`,
          agentId: "codex",
        }),
      );
    else completion.resolve(settled ?? { state: "succeeded", resultCode: null });
    const result = await bounded(observed, "runtime_skew_receipt_completion_incompatible");
    assert.ifError(result.error);
    const failed = settled?.state === "failed";
    assert.equal(result.value.type, failed ? "AGENT_PROMPT_FAILED" : "AGENT_PROMPT_COMPLETE");
    if (failed) {
      const typed = client.commands.cloudCommandFailureFromCode(settled.resultCode, "codex");
      assert.equal(result.value.error, typed ? settled.resultCode : "command_dispatch_rejected");
      if (typed) assert.deepEqual(result.value.failure, typed);
      else assert.equal(client.failureDisplay.classifyCloudAdmissionFailure({
        folder: `cloud://${organizationId}/${workspaceId}`, error: result.value.error,
      }).message, "The cloud agent request could not be completed. Review the conversation before trying again");
    }
    if (settled?.result?.terminal && client.engineReplies.cloudTurnProtocolVersion === 1) {
      assert.equal(result.value.stopReason, settled.result.terminal.stopReason);
      assert.deepEqual(result.value.response, settled.result.terminal.response);
    }
    assert.equal(cancelled, stop ? 1 : 0);
    await until(() =>
      cp.requests.some((request) => request.body.request?.kind === "settle"),
    );
    engine.commands.CloudCommandSnapshotSchema.parse(cp.snapshot());
    assert.equal(
      cp.snapshot().receipts[0].state,
      stop ? "cancelled" : settled?.state ?? "succeeded",
    );
    for (const kind of ["mutate", "claim", "settle", ...(stop ? ["stop"] : [])])
      assert.ok(
        cp.requests.some((request) => request.body.request?.kind === kind),
      );
    const negotiated = client.engineReplies.cloudTurnProtocolVersion === 1 && engine.engineReplies.cloudTurnProtocolVersion === 1;
    for (const request of commandRequests)
      assert.equal(request.cloudTurnProtocolVersion, negotiated ? 1 : undefined, "runtime_skew_turn_negotiation_incompatible");
    if (!negotiated) for (const response of responses) {
      if (response?.version === 1 && Array.isArray(response.receipts))
        client.commands.CloudCommandSnapshotSchema.parse(response);
      if (response?.commandId) client.commands.CloudCommandEntrySchema.extend({
        conversationId: client.commands.CloudCommandSnapshotSchema.shape.conversationId,
      }).parse(response);
    }
    return result.value;
  } finally {
    completion.resolve({
      state: "cancelled",
      resultCode: "stopped_before_dispatch",
    });
    runtime.close();
    journal.close();
    connection.dispose();
    await sending?.catch(() => {});
  }
}

async function approvalAndReplay(client, engine) {
  const cp = controlPlane();
  let delivered = 0;
  const actions = new engine.CloudActionRuntime({
    request: (request) =>
      engine.commandTransport.requestCloudAction(
        authority,
        request,
        abort.signal,
        cp.fetch,
      ),
    validate: () => true,
    authorize: async () => {},
    changed: () => {},
    dispatch: async () => {
      delivered++;
      return { outcome: "delivered", turnId: null };
    },
  });
  try {
    const request = {
      kind: "submit",
      action: {
        operationId: commandId,
        conversationId,
        executionId: "execution-contract-fixture",
        kind: "permission",
        requestId: "permission-fixture",
        payload: {
          response: { outcome: { outcome: "selected", optionId: "allow" } },
        },
      },
    };
    client.actions.CloudActionClientRequestSchema.parse(request);
    const receipt = await actions.handle(request);
    client.actions.CloudActionReceiptSchema.parse(receipt);
    assert.equal(receipt.state, "settled");
    assert.equal(delivered, 1);
    const frame = {
      id: "frame-fixture",
      type: "AGENT_PERMISSION_SETTLED",
      source: "engine",
      timestamp: now,
      cloudStream: { streamId, sequence: 1 },
      conversationId,
      permissionId: "permission-fixture",
    };
    const appended = await engine.eventTransport.requestCloudEvent(
      authority,
      { kind: "append", batchId: commandId, events: [{ sequence: 1, frame }] },
      abort.signal,
      cp.fetch,
    );
    client.events.CloudEventAppendResultSchema.parse(appended);
    const replay = await engine.eventTransport.requestCloudEvent(
      authority,
      { kind: "replay", streamId, after: 0 },
      abort.signal,
      cp.fetch,
    );
    const parsed = client.events.CloudEventReplayResultSchema.parse(replay);
    assert.deepEqual(
      parsed.events.map((event) => event.sequence),
      [1],
    );
    assert.equal(parsed.events[0].frame.type, "AGENT_PERMISSION_SETTLED");
  } finally {
    actions.close();
  }
}

const executionId = "execution-contract-fixture";
const terminalResult = () => ({ version: 1, model: "contract-model", goal: null,
  terminal: { commandId, conversationId, executionId, turnId: "native-turn-fixture", agentId: "codex",
    status: "completed", stopReason: "max_tokens",
    response: { stopReason: "max_tokens", effectiveModel: "contract-model", userMessageId: "synthetic-message",
      usage: { inputTokens: 12, outputTokens: 34 } } } });

function receipt(result, pending = false) {
  return { commandId, position: 1, state: pending ? "dispatching" : "succeeded", payload: null,
    executionId, generation: 1, resultCode: null, createdAt: stamp, updatedAt: stamp, result };
}

export async function controlPlaneTerminalNegotiation(current, previous) {
  const result = terminalResult(), original = clone(result);
  const settle = { kind: "settle", result: { commandId, claimId, state: "succeeded", resultCode: null, result } };
  assert.equal(previous.controlCommands.CloudCommandRequestSchema.safeParse(settle).success, false,
    "runtime_skew_old_control_plane_terminal_incompatible");
  current.controlCommands.CloudCommandRequestSchema.parse(settle);
  // Terminal negotiation cannot make the old CP accept this PR's newly
  // closed failure vocabulary. CP-first rollout remains required.
  for (const category of current.commands.CLOUD_COMMAND_FAILURE_CATEGORIES.filter(category =>
    !previous.commands.CLOUD_COMMAND_FAILURE_CATEGORIES.includes(category))) {
    const failed = clone(settle);
    delete failed.result.result.terminal;
    failed.result.state = "failed";
    failed.result.resultCode = current.commands.encodeCloudCommandFailure({ stage: "provider_prompt", category });
    assert.equal(previous.controlCommands.CloudCommandRequestSchema.safeParse(failed).success, false,
      "runtime_skew_control_plane_first_incompatible");
    current.controlCommands.CloudCommandRequestSchema.parse(failed);
  }
  const cp = controlPlane(), sent = [];
  cp.service.commands.read = async () => ({ ...receipt(result), conversationId });
  cp.service.commands.settle = async (_scope, settled) => ({ version: 1, conversationId,
    revision: 1, paused: false, pending: [], receipts: [receipt(settled.result)] });
  let cohort = "previous", acknowledged = true;
  const requestFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(clone(body));
    assert.equal(new Headers(init.headers).get("x-zeros-cloud-turn-protocol"), "1");
    if (cohort === "previous") {
      previous.controlCommands.CloudCommandRequestSchema.parse(body.request);
      return Response.json({ result: { ...receipt(body.request.result?.result ?? { version: 1 }), conversationId } });
    }
    const response = await cp.fetch(url, init);
    if (!acknowledged) response.headers.delete("x-zeros-cloud-turn-protocol");
    return response;
  };
  const send = (request, binding = authority) => current.commandTransport.requestCloudCommand(binding, request, abort.signal, requestFetch);
  await send(settle);
  await send(settle);
  assert.ok(sent.every(body => body.request.result.result.terminal === undefined));
  cohort = "current";
  await send({ kind: "read", commandId }); // Real current route acknowledges the capability.
  await send(settle);
  assert.deepEqual(sent.at(-1).request.result.result.terminal, result.terminal);
  // A capability belongs only to this CP + organization + workspace +
  // generation + engine identity, even when the same fetcher is reused.
  for (const changed of [{ heartbeatEndpoint: "https://other.example.invalid/heartbeat" },
    { organizationId: id(8) }, { workspaceId: id(9) }, { generation: 2 }, { engineInstanceId: id(7) }]) {
    cohort = "previous";
    await send(settle, { ...authority, ...changed });
    assert.equal(sent.at(-1).request.result.result.terminal, undefined);
  }
  cohort = "current";
  acknowledged = false;
  await send({ kind: "read", commandId }); // Missing acknowledgement forgets learned support.
  cohort = "previous";
  await send(settle);
  assert.equal(sent.at(-1).request.result.result.terminal, undefined);
  // The Alpha producer's known native-v1 fields remain readable by the new CP.
  const legacy = clone(settle);
  delete legacy.result.result.terminal;
  await previous.commandTransport.requestCloudCommand(authority, legacy, abort.signal, cp.fetch);
  assert.deepEqual(result, original);
  return { oldBody: true, acknowledgedBody: true, forgottenAcknowledgement: true, exactBinding: true };
}

async function failureCategoryFallback(client, engine, current, previous) {
  const added = current.commands.CLOUD_COMMAND_FAILURE_CATEGORIES.filter(category =>
    !previous.commands.CLOUD_COMMAND_FAILURE_CATEGORIES.includes(category));
  assert.ok(added.length >= 17, "runtime_skew_failure_taxonomy_incompatible");
  let checked = 0;
  for (const stage of current.commands.CLOUD_COMMAND_FAILURE_STAGES) for (const category of added) {
    const code = current.commands.encodeCloudCommandFailure({ stage, category });
    const row = { ...receipt(undefined), state: "failed", resultCode: code };
    client.commands.CloudCommandEntrySchema.parse(row);
    const known = client === current;
    assert.equal(!!client.commands.cloudCommandFailureFromCode(code), known, "runtime_skew_failure_fallback_incompatible");
    const displayed = client.failureDisplay.classifyCloudAdmissionFailure({
      folder: `cloud://${organizationId}/${workspaceId}`, error: known ? code : "command_dispatch_rejected",
    });
    if (!known) assert.match(displayed.message, /could not be completed/);
    checked++;
  }
  // Exercise the renderer/HTTP/pump/receipt path for every added category.
  // All stages above share the same receiving parser and decoder.
  for (const category of added) await commandRoundtrip(client, engine, null, false, {
    state: "failed", resultCode: current.commands.encodeCloudCommandFailure({ stage: "provider_prompt", category }),
  });
  const unknown = "cloud_provider_prompt_future_contract";
  assert.equal(client.commands.cloudCommandFailureFromCode(unknown), null);
  client.commands.CloudCommandEntrySchema.parse({ ...receipt(undefined), state: "failed", resultCode: unknown });
  assert.match(client.failureDisplay.classifyCloudAdmissionFailure({
    folder: `cloud://${organizationId}/${workspaceId}`, error: "command_dispatch_rejected",
  }).message, /could not be completed/);
  // Unknown future codes are readable, but the current CP producer correctly
  // rejects them. Only today's closed taxonomy enters the durable pump above.
  return { categories: added.length, codes: checked, receiptFailures: added.length, unknownFallback: true };
}

async function terminalReceiptNegotiation(client, engine) {
  const supported = engine.engineReplies.cloudTurnProtocolVersion === 1;
  const result = terminalResult();
  if (!supported) delete result.terminal;
  const row = { ...receipt(result), conversationId };
  const snapshot = { version: 1, conversationId, revision: 1, paused: false,
    pending: [receipt(result, true)], receipts: [receipt(result)],
    nativeGoal: { version: 1, conversationId, revision: 1, goal: null } };
  const durable = clone({ row, snapshot });
  const peer = {}, host = { cloudCommands: { handle: async request => request.kind === "read" ? row : snapshot },
    cloudTurnProtocols: new WeakMap() };
  const handler = engine.engineReplies.EngineReplyContract.prototype.handleCloudCommandOperation;
  const nativeParams = { nativeCommandsVersion: 1 };
  for (const request of [{ kind: "read", commandId }, { kind: "snapshot", conversationId }]) {
    const projected = await handler.call(host, "cloudCommands.request", { ...nativeParams, request }, peer);
    if (request.kind === "read") {
      assert.equal(projected.result?.terminal, undefined);
      assert.equal(projected.result?.model, "contract-model");
      client.commands.CloudCommandEntrySchema.extend({ conversationId: client.commands.CloudCommandSnapshotSchema.shape.conversationId }).parse(projected);
    } else {
      assert.equal(projected.pending[0].result?.terminal, undefined);
      assert.equal(projected.receipts[0].result?.terminal, undefined);
      assert.equal(projected.nativeGoal?.goal, null);
      client.commands.CloudCommandSnapshotSchema.parse(projected);
    }
  }
  if (supported) {
    assert.equal(client.commands.CloudNativeResultSchema.safeParse(result).success, client.engineReplies.cloudTurnProtocolVersion === 1,
      "runtime_skew_old_reader_terminal_leak");
    for (const request of [{ kind: "read", commandId }, { kind: "snapshot", conversationId }]) {
      const negotiated = await handler.call(host, "cloudCommands.request", { ...nativeParams, cloudTurnProtocolVersion: 1, request }, peer);
      assert.deepEqual(request.kind === "read" ? negotiated.result.terminal : negotiated.receipts[0].result.terminal, result.terminal);
      assert.equal(host.cloudTurnProtocols.get(peer), 1);
    }
    for (const version of [0, 2, "1"]) await assert.rejects(handler.call(host, "cloudCommands.request", {
      ...nativeParams, cloudTurnProtocolVersion: version, request: { kind: "read", commandId },
    }, peer), error => error.code === "invalid_command");
  }
  const returned = await commandRoundtrip(client, engine, null, false, { state: "succeeded", resultCode: null, result });
  if (client.engineReplies.cloudTurnProtocolVersion !== 1 || !supported) assert.equal(returned.stopReason, "end_turn");
  assert.deepEqual({ row, snapshot }, durable); // Projection never mutates durable storage.
  return { directRead: true, snapshot: true, terminal: supported };
}

async function permissionQuestionReplies(client, engine) {
  const cp = controlPlane(), peer = { cloudActor: { sessionId: id(6) } }, submitted = [];
  const connection = new client.CloudAgentConnection({ request: async () => ({ type: "WORKSPACE_RESPONSE", result: {
    conversationId, modeRevision: 0, nativeCommandsVersion: 1,
    ...(engine.engineReplies.cloudTurnProtocolVersion === 1 ? { cloudTurnProtocolVersion: 1 } : {}),
  } }) }, "local-main", async () => grantId);
  const actions = new engine.CloudActionRuntime({
    request: request => engine.commandTransport.requestCloudAction(authority, request, abort.signal, cp.fetch),
    validate: action => action.executionId === executionId && action.conversationId === conversationId,
    authorize: async () => {}, changed: () => {},
    dispatch: async action => { submitted.push(clone(action)); return { outcome: "delivered", turnId: null }; },
  });
  const host = { cloudActions: actions, cloudTurnProtocols: new WeakMap(),
    pendingPermissionRequests: new Map([["permission-fixture", { request: { sessionId: executionId } }]]),
    pendingQuestionRequests: new Map([["question-fixture", { request: { sessionId: executionId, nativeRequestId: "native-question" } }]]),
    sessionChat: new Map([[executionId, conversationId]]) };
  const handler = engine.engineReplies.EngineReplyContract.prototype.handleLegacyCloudAction;
  try {
    await connection.request({ type: "AGENT_NEW_SESSION", chatId: conversationId, agentId: "codex", env: { OPENAI_MODEL: "contract-model" } });
    connection.incoming({ type: "AGENT_SESSION_CREATED", chatId: conversationId, agentId: "codex", executionId,
      session: { sessionId: executionId } });
    for (const kind of ["permission", "question"]) {
      const message = { id: kind === "permission" ? id(1) : id(2), source: "browser", timestamp: now,
        type: kind === "permission" ? "AGENT_PERMISSION_RESPONSE" : "AGENT_QUESTION_RESPONSE",
        chatId: conversationId, executionId,
        ...(kind === "permission" ? { permissionId: "permission-fixture", response: { outcome: { outcome: "selected", optionId: "allow" } } }
          : { questionId: "question-fixture", nativeRequestId: "native-question", response: { outcome: { outcome: "answered", answers: [{ questionId: "q1", selectedOptionIds: ["option"], freeText: "answer" }] } } }),
      };
      // Released renderers did not send these additive ownership fields.
      if (client.engineReplies.cloudTurnProtocolVersion !== 1) { delete message.chatId; delete message.executionId; }
      const outgoing = connection.outgoing(message);
      assert.ok(engine.schemas.safeParseClientBridgeMessage(outgoing));
      if (client.engineReplies.cloudTurnProtocolVersion === 1 && engine.engineReplies.cloudTurnProtocolVersion !== 1) {
        assert.equal(outgoing.chatId, undefined); assert.equal(outgoing.executionId, undefined);
      }
      if (client.engineReplies.cloudTurnProtocolVersion === 1 && engine.engineReplies.cloudTurnProtocolVersion === 1) {
        assert.equal(outgoing.chatId, conversationId); assert.equal(outgoing.executionId, executionId);
        host.cloudTurnProtocols.set(peer, 1);
      }
      await handler.call(host, outgoing, peer);
      assert.equal(submitted.at(-1).kind, kind); assert.equal(submitted.at(-1).executionId, executionId);
      const before = submitted.length;
      await assert.rejects(handler.call(host, { ...outgoing, id: id(3),
        permissionId: "missing-resolver", questionId: "missing-resolver" }, peer), error => error.code === "command_context_changed");
      if (engine.engineReplies.cloudTurnProtocolVersion === 1) {
        host.cloudTurnProtocols.set(peer, 1);
        for (const identity of [{}, { chatId: conversationId }, { executionId },
          { chatId: id(8), executionId }, { chatId: conversationId, executionId: "retired-execution" }]) {
          const { chatId: _chat, executionId: _execution, ...legacy } = outgoing;
          const wrong = { ...legacy, id: id(4), ...identity };
          await assert.rejects(handler.call(host, wrong, peer), error => error.code === "command_context_changed");
        }
        host.cloudTurnProtocols.delete(peer);
        for (const identity of [{ chatId: conversationId }, { executionId }]) {
          const { chatId: _chat, executionId: _execution, ...legacy } = outgoing;
          await assert.rejects(handler.call(host, { ...legacy, id: id(4), ...identity }, peer), error => error.code === "command_context_changed");
        }
      }
      assert.equal(submitted.length, before);
    }
    return { permission: true, question: true };
  } finally { connection.dispose(); actions.close(); }
}

function createRegistration(engine, requestFetch, onAuthorityLost) {
  return new engine.registration.CloudRuntimeRegistration(
    {
      version: 1,
      audience: "zeros-cloud-engine-runtime-v1",
      execution: {
        workspaceId,
        organizationId,
        generation: 1,
        setupRunId: id(9),
        executionFence: 1,
      },
      engine: {
        instanceId: engineInstanceId,
        protocolVersion: engine.version.PROTOCOL_VERSION,
        readinessProbeToken: `zwr_${"R".repeat(43)}`,
      },
      registration: {
        endpoint: `${origin}/internal/v1/cloud-workspaces/engine/register`,
        token: `zws_${"S".repeat(43)}`,
        expiresAtMs: now + 60_000,
      },
    },
    {
      agentRuntime: {
        profile: "zeros-cloud-worker-v4",
        runtimeId: `r1-${"a".repeat(64)}`,
        manifestSha256: "a".repeat(64),
        baseCompatibilityId: `bc1-${"b".repeat(64)}`,
        installerReceiptSha256: "c".repeat(64),
        bootId: id(8),
        supervisorSessionId: id(9),
      },
      fetch: requestFetch,
      now: () => now,
      onAuthorityLost,
      onDurableRecordSync: async () => {},
    },
  );
}

async function registrationRoundtrip(engine) {
  const cp = controlPlane();
  let lost = false;
  const registration = createRegistration(engine, cp.fetch, () => { lost = true; });
  try {
    await registration.start();
    assert.equal(registration.readiness().health, "ready");
    // Let the real public registration lifecycle emit its next heartbeat.
    // Historical private methods and timer fields are not client contracts.
    await until(
      () => cp.requests.some((request) => request.path.endsWith("/heartbeat")),
      15_000,
    );
    assert.ok(
      cp.requests.some((request) => request.path.endsWith("/heartbeat")),
    );
    const admission = await registration.verifyServiceAccess(
      `zsh_${"T".repeat(43)}`,
    );
    assert.equal(admission?.kind, "ssh");
    assert.equal(lost, false);
    const body = {
      workspaceId,
      organizationId,
      generation: 1,
      engineInstanceId,
      expectedRevision: 0,
      idempotencyKey: "record-contract-fixture",
      mutations: [
        {
          entityKind: "terminal",
          entityId: "terminal-fixture",
          operation: "upsert",
          schemaVersion: 1,
          document: { sessionId: "terminal-fixture" },
          occurredAt: stamp,
        },
      ],
    };
    const response = await cp.fetch(
      `${origin}/internal/v1/cloud-workspaces/engine/record/append`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${heartbeatToken}`,
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).revision, 1);
  } finally {
    await registration.stop();
  }
}

async function renewalTransientContract(engine, current) {
  const cp = controlPlane();
  let fault = null, lost = false, renewals = 0;
  const requestFetch = async (url, init) => {
    if (new URL(String(url)).pathname.endsWith("/client-admission") && fault) {
      if (JSON.parse(init.body).renew) renewals++;
      if (fault === "network") throw new Error("private upstream fixture detail");
      return new Response("private upstream fixture detail", { status: fault });
    }
    return cp.fetch(url, init);
  };
  const registration = createRegistration(engine, requestFetch, () => { lost = true; });
  const grant = `zwa_${"A".repeat(43)}`;
  let transport, socket;
  try {
    await registration.start();
    const confirmed = await registration.verifyClientAdmission(grant);
    assert.equal(confirmed.accountUserId, id(9));
    assert.equal(confirmed.authorityEpoch, 1);
    assert.equal(confirmed.actor.sessionId, id(6));
    let cases = 0;
    for (const failure of ["network", 408, 429, 503, 401, 403]) {
      fault = failure;
      assert.equal(await registration.verifyClientAdmission(grant), null);
      const renewal = registration.verifyClientAdmission(grant, true);
      if (engine === current && ![401, 403].includes(failure)) await assert.rejects(renewal, error => {
        assert.equal(error.code, "cloud_client_authority_transient", "runtime_skew_renewal_transient_incompatible");
        assert.equal(error.message, "Cloud client authority is temporarily unavailable");
        return true;
      });
      else assert.equal(await renewal, null);
      cases++;
    }
    assert.equal(lost, false); // A socket-local denial never surrenders engine authority.
    fault = null;
    assert.deepEqual(await registration.verifyClientAdmission(grant, true), confirmed);
    // Exercise the actual frozen/current transport on an ephemeral local socket.
    // Only the typed transient can retain the remaining confirmed lease; it
    // never changes that lease's deadline or resurrects an expired connection.
    const leaseMs = 300;
    transport = new engine.CloudTransport({ port: 0, token: "runtime-skew-synthetic-transport",
      verifyToken: token => registration.verifyClientAdmission(token),
      renewToken: token => registration.verifyClientAdmission(token, true),
      clientAuthorityLeaseMs: leaseMs });
    const received = [];
    transport.onMessage((_peer, message) => { received.push(message.type); });
    await transport.start();
    socket = new WebSocket(`ws://127.0.0.1:${transport.boundPort}/ws`, {
      headers: { "x-zeros-cloud-token": grant },
    });
    const closed = once(socket, "close");
    void closed.catch(() => {}); // Observe upgrade errors before waiting for expiry.
    await bounded(once(socket, "open"), "runtime_skew_renewal_socket_incompatible");
    socket.send(JSON.stringify({ id: "renewal-handshake", source: "browser", timestamp: now,
      type: "CONNECTED", capabilities: [], protocolVersion: engine.version.PROTOCOL_VERSION }));
    await until(() => received.includes("CONNECTED"));
    fault = 503;
    renewals = 0;
    let timer;
    const [code, reason] = await Promise.race([closed, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("runtime_skew_renewal_expiry_incompatible")), 2_000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(renewals, 1, "runtime_skew_renewal_expiry_incompatible");
    assert.equal(code, 1008);
    assert.equal(reason.toString(), engine === current ? "client authority expired" : "client authority revoked");
    assert.equal(lost, false);
    return { cases, transient: engine === current, expiredWithoutExtension: true };
  } finally {
    socket?.terminate();
    await transport?.stop();
    await registration.stop();
  }
}

async function terminalContract(client, engine) {
  const sent = [];
  const peer = {
    request: async (request) => {
      assert.ok(
        engine.schemas.safeParseClientBridgeMessage({
          ...request,
          id: "terminal-request",
          source: "browser",
          timestamp: now,
        }),
      );
      return {
        type: "PTY_CREATED",
        sessionId: request.sessionId,
        pid: 123,
        cwd: request.cwd,
        cols: request.cols,
        rows: request.rows,
        reattached: true,
        replay: "synthetic snapshot\r\n",
        replayBytes: 20,
        replayTruncated: false,
      };
    },
    send: (request) => {
      assert.ok(
        engine.schemas.safeParseClientBridgeMessage({
          ...request,
          id: "terminal-input",
          source: "browser",
          timestamp: now,
        }),
      );
      sent.push(request);
    },
  };
  const terminal = await client.pty.bridgePtyCreate(peer, {
    sessionId: "terminal-fixture",
    cwd: "/srv/zeros/workspace",
    cols: 80,
    rows: 24,
  });
  assert.equal(terminal?.reattached, true);
  assert.equal(terminal?.replay, "synthetic snapshot\r\n");
  client.pty.bridgePtyWrite(peer, {
    sessionId: "terminal-fixture",
    data: "synthetic input\n",
  });
  assert.equal(sent[0].type, "PTY_WRITE");
  assert.equal(sent[0].data, "synthetic input\n");
}

export function validatePins(pins) {
  assert.equal(pins?.schemaVersion, 1, "runtime_skew_pin_invalid");
  assert.equal(pins.mode, "source-contracts", "runtime_skew_pin_invalid");
  assert.ok(Array.isArray(pins.retainedRuntimes), "runtime_skew_pin_invalid");
  const sources = [
    pins.previousRuntime,
    pins.previousDesktop,
    ...pins.retainedRuntimes,
  ];
  for (const pin of sources) {
    assert.ok(
      pin &&
        /^[a-f0-9]{40}$/.test(pin.sourceCommit) &&
        /^[a-f0-9]{40}$/.test(pin.sourceTree),
      "runtime_skew_pin_invalid",
    );
  }
}

async function capabilityRefusal(current) {
  for (const version of [undefined, 0, 2]) {
    let mutations = 0;
    const connection = new current.CloudAgentConnection(
      {
        request: async (message) => {
          if (message.op === "cloudCommands.request") {
            if (message.params.request.kind === "mutate") mutations++;
            return {
              type: "WORKSPACE_RESPONSE",
              result: {
                version: 1,
                conversationId,
                revision: 0,
                paused: false,
                pending: [],
                receipts: [],
              },
            };
          }
          return {
            type: "WORKSPACE_RESPONSE",
            result: {
              conversationId,
              modeRevision: 0,
              nativeCommandsVersion: version,
            },
          };
        },
      },
      "local-main",
      async () => grantId,
    );
    try {
      await connection.request({
        type: "AGENT_NEW_SESSION",
        chatId: conversationId,
        agentId: "codex",
        env: { OPENAI_MODEL: "contract-model" },
      });
      await assert.rejects(
        connection.request({
          type: "AGENT_GOAL_CLEAR",
          sessionId: `conversation:${conversationId}`,
          agentId: "codex",
        }),
        (error) =>
          error.code === "cloud_runtime_feature_unavailable" &&
          error.action ===
            (version === 2 ? "update-desktop" : "update-runtime") &&
          error.feature === "native-commands-v1",
      );
      assert.equal(mutations, 0);
    } finally {
      connection.dispose();
    }
  }
}

export async function runRuntimeSkewGate({ negativeFixture = false } = {}) {
  const pins = JSON.parse(
    await readFile(new URL("./pins.json", import.meta.url), "utf8"),
  );
  validatePins(pins);
  const [current, previousRuntime, previousDesktop] = await Promise.all([
    loadContractSource(),
    loadContractSource(pins.previousRuntime),
    loadContractSource(pins.previousDesktop),
  ]);
  const incompatible = negativeFixture
    ? JSON.parse(
        await readFile(
          new URL("./fixtures/incompatible-command.json", import.meta.url),
          "utf8",
        ),
      )
    : null;
  assert.equal(current.engineReplies.cloudTurnProtocolVersion, 1, "runtime_skew_turn_version_incompatible");
  const directions = [], contracts = [];
  const retained = await Promise.all(
    pins.retainedRuntimes.map((pin) => loadContractSource(pin)),
  );
  for (const [direction, client, engine] of [
    ["current-client/previous-runtime", current, previousRuntime],
    ["previous-client/current-runtime", previousDesktop, current],
    ...retained.map((engine, index) => [
      `current-client/retained-runtime-${index + 1}`,
      current,
      engine,
    ]),
  ]) {
    assert.ok(client.version.isCompatible(engine.version.PROTOCOL_VERSION));
    assert.ok(engine.version.isCompatible(client.version.PROTOCOL_VERSION));
    await commandRoundtrip(client, engine, incompatible);
    await commandRoundtrip(client, engine, null, false);
    await approvalAndReplay(client, engine);
    await registrationRoundtrip(engine);
    await terminalContract(client, engine);
    contracts.push({ direction,
      failures: await failureCategoryFallback(client, engine, current, previousDesktop),
      receipts: await terminalReceiptNegotiation(client, engine),
      replies: await permissionQuestionReplies(client, engine),
      renewal: await renewalTransientContract(engine, current),
    });
    directions.push(direction);
  }
  // A same-version positive control ensures negotiated terminal/reply support
  // cannot disappear while all legacy downgrade checks still pass.
  const negotiated = { receipts: await terminalReceiptNegotiation(current, current),
    replies: await permissionQuestionReplies(current, current),
    controlPlane: await controlPlaneTerminalNegotiation(current, previousRuntime) };
  await capabilityRefusal(current);
  // All local path identities retain the existing local dispatch selection,
  // independently of owner metadata. Switching to cloud selects its exact key.
  for (const folder of ["/local-owner/repo", "/organization-owner/repo"])
    assert.equal(
      current.wire.cloudRequestTarget({
        type: "WORKSPACE_REQUEST",
        op: "files.write",
        params: { cwd: folder },
      }),
      null,
    );
  const key = `cloud://${organizationId}/${workspaceId}`;
  assert.deepEqual(
    current.wire.cloudRequestTarget({
      type: "WORKSPACE_REQUEST",
      op: "files.write",
      params: { cwd: key },
    }),
    { organizationId, workspaceId, relativePath: "" },
  );
  return {
    mode: "source-contracts",
    directions,
    contracts,
    negotiated,
    checks: [
      "handshake-range",
      "queued-prompt/claim/settle/stop/approval",
      "event-replay",
      "registration/renewal/service-admission",
      "record-append-shape",
      "terminal-renderer-contract",
      "capability-refusal",
      "local-dispatch-selection",
      "failure-category-fallback",
      "terminal-receipt-negotiation",
      "permission-question-reply-ownership",
      "renewal-transient-refusal",
    ],
  };
}
