import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCloudWorkspaceInternalRoutes } from "../../apps/control-plane/src/cloud-workspaces/internal-routes.ts";
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

async function commandRoundtrip(client, engine, negativeFixture, stop = true) {
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
        };
      } else if (op === "cloudCommands.conversation") {
        engine.commands.CloudConversationReadSchema.parse(params);
        result = {
          conversationId,
          modeRevision: 0,
          permissionModeVersion: 1,
          nativeCommandsVersion: 1,
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
        result = await runtime.handle(request);
        if (params.nativeCommandsVersion !== 1)
          result = engine.commands.legacyCloudCommandResponse(result);
      }
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
    else completion.resolve({ state: "succeeded", resultCode: null });
    const result = await observed;
    assert.ifError(result.error);
    assert.equal(result.value.type, "AGENT_PROMPT_COMPLETE");
    assert.equal(cancelled, stop ? 1 : 0);
    await until(() =>
      cp.requests.some((request) => request.body.request?.kind === "settle"),
    );
    client.commands.CloudCommandSnapshotSchema.parse(cp.snapshot());
    assert.equal(
      cp.snapshot().receipts[0].state,
      stop ? "cancelled" : "succeeded",
    );
    for (const kind of ["mutate", "claim", "settle", ...(stop ? ["stop"] : [])])
      assert.ok(
        cp.requests.some((request) => request.body.request?.kind === kind),
      );
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

async function registrationRoundtrip(engine) {
  const cp = controlPlane();
  let lost = false;
  const registration = new engine.registration.CloudRuntimeRegistration(
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
      fetch: cp.fetch,
      now: () => now,
      onAuthorityLost: () => {
        lost = true;
      },
      onDurableRecordSync: async () => {},
    },
  );
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
  const directions = [];
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
    directions.push(direction);
  }
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
    checks: [
      "handshake-range",
      "queued-prompt/claim/settle/stop/approval",
      "event-replay",
      "registration/renewal/service-admission",
      "record-append-shape",
      "terminal-renderer-contract",
      "capability-refusal",
      "local-dispatch-selection",
    ],
  };
}
