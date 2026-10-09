// Actual renderer classes over an honestly named controlled bridge. These
// cases prove harness evidence refusal, not native/provider qualification.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BridgeMessage } from "../cloud-workspace-validation/lib/bridge-client";
import { driveRendererTurn, captureRendererEnqueue } from "../cloud-workspace-validation/cloud-agent-e2e/renderer-turn";
import { diagnoseHarnessFailure } from "../cloud-workspace-validation/cloud-agent-e2e/assertions";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";

const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
const conversationId = randomUUID(), userMessageId = randomUUID(), executionId = "controlled-execution";
const provider = "codex" as const, model = "test-model", grantId = randomUUID();
const promptText = "private-prompt-sentinel", nativeText = "private-native-sentinel";
const expected = { conversationId, userMessageId, provider, model, prompt: promptText };
type Row = Record<string, unknown>;
const bootBinding = CloudAgentBootConversationSchema.parse({ ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
  bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1,
  authorityEpoch: 1, cacheRevision: 1, desiredCacheRevision: 1,
  initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) });

function controlledBridge() {
  const listeners = new Set<(frame: BridgeMessage) => void>();
  const statusListeners = new Set<(status: "connected" | "disconnected") => void>();
  const order: string[] = [];
  const streamId = randomUUID();
  let mutation: Row | undefined, journal: Row[] = [], reads = 0, snapshots = 0, observedAtMs = 0;
  const settings = { emitLive: true, emitText: true, state: "failed", resultCode: "cloud_provider_prompt_auth_required",
    replay: "exact", missingTiming: false, unknownCoverage: false, wrongScope: false, wrongReceipt: false,
    lostAck: false, hang: false, stopFails: false, pendingReads: 0, paused: false, strictOuterParams: false,
    boot: undefined as unknown };
  const emit = (frame: Row) => { for (const listener of listeners) listener(frame as BridgeMessage); };
  const packet = () => {
    const commandId = (mutation?.action as Row).commandId;
    const sampledAtMs = performance.now() - 100;
    return { version: 1, ...scope, ...(settings.wrongScope ? { generation: 2 } : {}),
      conversationId, mode: settings.boot ? "boot-owner-v1" : "legacy", bootId: settings.boot ? bootBinding.bootId : null,
      writerEpoch: settings.boot ? bootBinding.writerEpoch : null, clockId: randomUUID(), sampledAtMs,
      coverage: { truncated: false, retired: false, unknown: settings.unknownCoverage },
      records: ["engine_received", "dispatch_committed", "typed_auth_failure", "terminal_committed"].map((stage, i) => ({
        sequence: i + 1, commandId, conversationId, turnId: userMessageId, executionId, provider, stage, atMs: observedAtMs,
      })) };
  };
  const result = async (op: string, params: Row = {}): Promise<unknown> => {
    // Exact outer-key guards from the actual engine's command/event handlers.
    // The authenticated transport binds this engine; only create carries cwd identity.
    if (settings.strictOuterParams) {
      const allowed: Record<string, readonly string[]> = {
        'cloudCommands.createConversation': ['conversationId', 'workspaceId', 'agentId', 'model'],
        'cloudCommands.conversation': ['conversationId', 'agentTurnTimingsVersion'],
        'cloudCommands.request': ['request', 'nativeCommandsVersion', 'cloudTurnProtocolVersion',
          ...(settings.boot ? ['cloudLocalCommandsVersion', 'bootId', 'writerEpoch'] : [])],
        'cloudEvents.request': ['request'],
      };
      if (Object.keys(params).some(key => !allowed[op]?.includes(key))) throw new Error('invalid_event');
      if (settings.boot && op === 'cloudCommands.request' && (params.cloudLocalCommandsVersion !== 1 ||
          params.bootId !== bootBinding.bootId || params.writerEpoch !== bootBinding.writerEpoch)) throw new Error('cloud_workspace_client_update_required');
    }
    const request = params.request as Row | undefined;
    order.push(op + (request ? ":" + request.kind : ""));
    if (op === "cloudCommands.createConversation" || op === "cloudCommands.conversation") return {
      conversationId, modeRevision: 0, permissionModeVersion: 1, nativeCommandsVersion: 1, cloudTurnProtocolVersion: 1,
      ...(settings.boot ? { cloudLocalCommands: settings.boot } : {}),
      ...(params.agentTurnTimingsVersion === 1 && !settings.missingTiming ? { agentTurnTimings: packet() } : {}),
    };
    if (op === "cloudEvents.request") {
      if (request?.kind === "snapshot") return { cursor: { streamId, sequence: snapshots++ ? journal.length : 0 } };
      const cursor = (request?.cursor as Row).sequence as number;
      const frames = settings.replay === "empty" ? [] : journal.slice(cursor).map(frame => {
        if (settings.replay !== "changed" || frame.type !== "AGENT_SESSION_UPDATE") return frame;
        return { ...frame, notification: { sessionId: executionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "changed-native-sentinel" } } } };
      });
      return { streamId, head: journal.length, firstRetained: 1, cursor: frames.length ? journal.length : cursor,
        events: frames.map((frame, i) => ({ sequence: cursor + i + 1, frame })) };
    }
    if (request?.kind === "snapshot") return { version: 1, conversationId, revision: 0, paused: settings.paused, pending: [], receipts: [] };
    if (request?.kind === "mutate") {
      if (((request.mutation as Row).action as Row).kind === "resume") {
        settings.paused = false;
        return { version: 1, conversationId, revision: 1, paused: false, pending: [], receipts: [] };
      }
      observedAtMs = performance.now() - 100;
      mutation = request.mutation as Row;
      if (settings.lostAck) throw new Error("controlled-unknown-ack");
      if (settings.hang) return {};
      const action = mutation.action as Row;
      journal = [];
      if (settings.emitText) journal.push({ type: "AGENT_SESSION_UPDATE", source: "engine", agentId: provider, chatId: conversationId,
        executionId, notification: { sessionId: executionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: nativeText } } },
        cloudStream: { streamId, sequence: 1 } });
      journal.push({ type: settings.state === "succeeded" ? "AGENT_PROMPT_COMPLETE" : "AGENT_PROMPT_FAILED", source: "engine",
        agentId: provider, chatId: conversationId, executionId, sessionId: executionId, requestId: action.commandId,
        ...(settings.state === "succeeded" ? { stopReason: "end_turn" } : { error: settings.resultCode }),
        cloudStream: { streamId, sequence: journal.length + 1 } });
      if (settings.emitLive) for (const frame of journal) emit(frame);
      return {};
    }
    if (request?.kind === "read") {
      reads++;
      return { conversationId, commandId: settings.wrongReceipt ? randomUUID() : request.commandId,
        position: 0, state: settings.hang || reads <= settings.pendingReads ? "dispatching" : settings.state,
        payload: null, executionId, generation: 1, resultCode: settings.state === "succeeded" ? null : settings.resultCode,
        createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" };
    }
    if (request?.kind === "stop") { if (settings.stopFails) throw new Error("private-stop-sentinel"); return {}; }
    return {};
  };
  const requestEnvelope = vi.fn(async (op: string, params: Row = {}) => ({ type: "WORKSPACE_RESPONSE", source: "engine", op,
    result: await result(op, params) }) as BridgeMessage);
  const bridge = { status: "connected" as const, engineCapabilities: ["cloud.turnTimings.v1"], requestEnvelope,
    request: vi.fn(result),
    onMessage(listener: (frame: BridgeMessage) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    onStatusChange(listener: (status: "connected" | "disconnected") => void) {
      statusListeners.add(listener); return () => statusListeners.delete(listener);
    } };
  const checkTerminal = vi.fn((_commandId: string) => { order.push("fixture-check"); });
  const input = { engineWorkspaceId: "local-main", scope, ...expected, expected: "auth-failure" as const,
    grant: vi.fn(async () => { order.push("prepare"); return grantId; }),
    verifyTerminal: checkTerminal, fixtureEvents: () => journal.map((frame, i) => ({ sequence: i + 1, frame })),
    onSend: () => { order.push("send-window"); }, onRendererSettled: () => { order.push("close-window"); }, timeoutMs: 1000 };
  return { bridge, input, settings, order, checkTerminal, listeners, statusListeners, mutation: () => mutation, reads: () => reads };
}

describe("actual renderer turn evidence integration", () => {
  it("uses the actual negotiated grant-free renderer and exact boot read/Stop wire", async () => {
    const f = controlledBridge(); f.settings.boot = bootBinding; f.settings.strictOuterParams = true;
    f.bridge.engineCapabilities.push("cloud.localCommands.v1");
    f.input.grant.mockImplementation(async () => { throw new Error("grant_on_boot_send"); });
    const result = await driveRendererTurn(f.bridge, { ...f.input, mode: "boot-owner-v1", bootBinding, fixtureEvents: undefined });
    expect(result).toMatchObject({ outcome: "pre_auth_only" });
    expect(f.input.grant).not.toHaveBeenCalled();
    expect((f.mutation()?.action as Row).payload).not.toHaveProperty("agentCredentialGrantId");
    expect(f.bridge.request.mock.calls.filter(([op]) => op === "cloudCommands.request")
      .every(([, params]) => params?.cloudLocalCommandsVersion === 1 && params.bootId === bootBinding.bootId && params.writerEpoch === bootBinding.writerEpoch)).toBe(true);
    expect(f.checkTerminal).toHaveBeenCalledWith(result.commandId, expect.objectContaining({ state: "failed" }), expect.any(AbortSignal));
    expect(result.timing.sendToTypedAuthFailureMs).not.toBeNull();
  });
  it.each(["missing-capability", "missing-binding", "foreign-owner", "foreign-writer", "legacy-fallback"])("refuses boot %s before any Send", async kind => {
    const f = controlledBridge(); f.settings.boot = bootBinding; f.bridge.engineCapabilities.push("cloud.localCommands.v1");
    let selected: unknown = bootBinding;
    if (kind === "missing-capability") f.bridge.engineCapabilities.pop();
    if (kind === "missing-binding") selected = undefined;
    if (kind === "foreign-owner") f.settings.boot = { ...bootBinding, fundingOwnerUserId: randomUUID() };
    if (kind === "foreign-writer") f.settings.boot = { ...bootBinding, writerEpoch: randomUUID() };
    if (kind === "legacy-fallback") f.settings.boot = undefined;
    await expect(driveRendererTurn(f.bridge, { ...f.input, mode: "boot-owner-v1", bootBinding: selected, fixtureEvents: undefined }))
      .rejects.toThrow("fixture_contract_invalid");
    expect(f.input.grant).not.toHaveBeenCalled(); expect(f.mutation()).toBeUndefined();
  });
  it("retains exact current-turn replay guards when the CP compact journal omits deltas", async () => {
    const f = controlledBridge(); f.settings.boot = bootBinding; f.bridge.engineCapabilities.push("cloud.localCommands.v1");
    f.settings.replay = "changed";
    await expect(driveRendererTurn(f.bridge, { ...f.input, mode: "boot-owner-v1", bootBinding, fixtureEvents: undefined }))
      .rejects.toThrow("replay_content_mismatch");
    expect(f.input.grant).not.toHaveBeenCalled();
  });
  it("keeps unknown-ACK cleanup bound to the same boot/writer without redispatch", async () => {
    const f = controlledBridge(); f.settings.boot = bootBinding; f.settings.strictOuterParams = true;
    f.bridge.engineCapabilities.push("cloud.localCommands.v1"); f.settings.lostAck = true;
    await expect(driveRendererTurn(f.bridge, { ...f.input, mode: "boot-owner-v1", bootBinding, fixtureEvents: undefined })).rejects.toThrow();
    const stop = f.bridge.request.mock.calls.find(([op, params]) => op === 'cloudCommands.request' &&
      (params?.request as Row | undefined)?.kind === 'stop');
    expect(stop?.[1]).toMatchObject({ cloudLocalCommandsVersion: 1, bootId: bootBinding.bootId, writerEpoch: bootBinding.writerEpoch });
    expect(f.order.filter(value => value === "cloudCommands.request:mutate")).toHaveLength(1);
    expect(f.input.grant).not.toHaveBeenCalled();
  });
  it('passes the actual strict cloud outer wire shapes through Send, receipt, replay and timing read', async () => {
    const f = controlledBridge(); f.settings.strictOuterParams = true;
    await expect(driveRendererTurn(f.bridge, f.input)).resolves.toMatchObject({ outcome: 'pre_auth_only' });
    expect(f.checkTerminal).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0); expect(f.statusListeners.size).toBe(0);
  });
  it('retains the strict Stop shape after an unknown renderer enqueue acknowledgement', async () => {
    const f = controlledBridge(); f.settings.strictOuterParams = true; f.settings.lostAck = true;
    await expect(driveRendererTurn(f.bridge, f.input)).rejects.toThrow();
    const stop = f.bridge.request.mock.calls.find(([op, params]) => op === 'cloudCommands.request' &&
      (params?.request as Row | undefined)?.kind === 'stop');
    expect(stop).toBeDefined();
    expect(Object.keys(stop![1]!).sort()).toEqual(['cloudTurnProtocolVersion', 'nativeCommandsVersion', 'request']);
    expect(f.input.grant).toHaveBeenCalledOnce();
  });
  it("captures the actual renderer command UUID and separates it from optimistic turn identity", async () => {
    const f = controlledBridge();
    const result = await driveRendererTurn(f.bridge, f.input);
    expect(result.commandId).toBe((f.mutation()?.action as Row).commandId);
    expect(result.commandId).not.toBe(userMessageId);
    expect(result.turnId).toBe(userMessageId);
    expect(result).toMatchObject({ outcome: "pre_auth_only", resultCode: "cloud_provider_prompt_auth_required",
      liveDeltaBytes: Buffer.byteLength(nativeText), replayDeltaBytes: Buffer.byteLength(nativeText) });
    expect(result.timing.sendToNativeAcceptanceMs).toBeNull();
    expect(result.timing.sendToTypedAuthFailureMs).not.toBeNull();
    expect(f.checkTerminal).toHaveBeenCalledExactlyOnceWith(result.commandId);
    expect(JSON.stringify(result)).not.toMatch(/private-prompt-sentinel|private-native-sentinel/);
    expect(f.listeners.size).toBe(0); expect(f.statusListeners.size).toBe(0);
  });
  it("begins Send before public grant and pre-reads, closing it before verification reads", async () => {
    const f = controlledBridge(); await driveRendererTurn(f.bridge, f.input);
    const start = f.order.indexOf("send-window"), prepare = f.order.indexOf("prepare"), end = f.order.indexOf("close-window");
    expect(start).toBeLessThan(prepare);
    expect(start).toBeLessThan(f.order.indexOf("cloudCommands.request:snapshot"));
    expect(end).toBeGreaterThan(f.order.indexOf("cloudCommands.request:mutate"));
    expect(end).toBeLessThan(f.order.indexOf("fixture-check"));
    expect(end).toBeLessThan(f.order.lastIndexOf("cloudEvents.request:replay"));
  });
  it("retains the calibrated client clock and absolute Send/result samples for ingress alignment", async () => {
    const f = controlledBridge(); const result = await driveRendererTurn(f.bridge, f.input);
    expect(result.clientTiming).toMatchObject({ clockId: result.timing.clocks.clientClockId });
    expect(result.clientTiming.sentAtMs).toBeGreaterThanOrEqual(0);
    expect(result.clientTiming.settledAtMs).toBeGreaterThanOrEqual(result.clientTiming.sentAtMs);
    expect(result.clientTiming.settledAtMs - result.clientTiming.sentAtMs).toBe(result.rendererSendToResultMs);
  });
  it("refuses missing producer capability before any grant or wire request", async () => {
    const f = controlledBridge(); f.bridge.engineCapabilities = [];
    await expect(driveRendererTurn(f.bridge, f.input)).rejects.toThrow("timing_capability_missing");
    expect(f.bridge.requestEnvelope).not.toHaveBeenCalled(); expect(f.input.grant).not.toHaveBeenCalled();
  });
  it.each(["missingTiming", "unknownCoverage", "wrongScope"] as const)("refuses %s evidence without a fallback", async field => {
    const f = controlledBridge(); f.settings[field] = true;
    await expect(driveRendererTurn(f.bridge, f.input)).rejects.toThrow(field === "missingTiming" ? "timing_packet_invalid" :
      field === "unknownCoverage" ? "timing_coverage_incomplete" : "timing_scope_mismatch");
  });
  it("cannot substitute populated fixture inspection for empty authenticated replay", async () => {
    const f = controlledBridge(); f.settings.replay = "empty";
    await expect(driveRendererTurn(f.bridge, f.input)).rejects.toThrow("missing_replay");
  });
  it("refuses changed authenticated replay content", async () => {
    const f = controlledBridge(); f.settings.replay = "changed";
    await expect(driveRendererTurn(f.bridge, { ...f.input, fixtureEvents: undefined })).rejects.toThrow("replay_content_mismatch");
  });
  it("cannot count renderer receipt synthesis as a live engine terminal", async () => {
    const f = controlledBridge(); f.settings.emitLive = false;
    await expect(driveRendererTurn(f.bridge, f.input)).rejects.toThrow("missing_terminal");
  });
  it("refuses empty provider success even with a matching renderer result and receipt", async () => {
    const f = controlledBridge(); f.settings.state = "succeeded"; f.settings.emitText = false;
    await expect(driveRendererTurn(f.bridge, { ...f.input, expected: "success" })).rejects.toThrow("empty_success");
  });
  it("refuses a foreign independent command receipt", async () => {
    const f = controlledBridge(); f.settings.wrongReceipt = true;
    await expect(driveRendererTurn(f.bridge, f.input)).rejects.toThrow("receipt_mismatch");
  });
  it("keeps actual unexpected typed containment failure closed and failed", async () => {
    const f = controlledBridge(); f.settings.resultCode = "cloud_containment_environment_setup_failed";
    let failure: unknown;
    try { await driveRendererTurn(f.bridge, f.input); } catch (error) { failure = error; }
    expect(diagnoseHarnessFailure(failure)).toMatchObject({ code: "cloud_containment_environment_setup_failed",
      assertionCode: "expected_auth_failure" });
  });
  it("waits for independent receipt settlement after an early live terminal", async () => {
    const f = controlledBridge(); f.settings.pendingReads = 2;
    await expect(driveRendererTurn(f.bridge, f.input)).resolves.toMatchObject({ outcome: "pre_auth_only" });
    expect(f.reads()).toBeGreaterThan(2);
  });
  it("refuses a failed CP settlement cross-check before timing can report success", async () => {
    const f = controlledBridge(); f.checkTerminal.mockImplementation(() => { throw new Error("fixture_settlement_conflict"); });
    await expect(driveRendererTurn(f.bridge, f.input)).rejects.toThrow("fixture_settlement_conflict");
  });
  it("times out, stops the submitted conversation once and detaches all observers", async () => {
    const f = controlledBridge(); f.settings.hang = true;
    await expect(driveRendererTurn(f.bridge, { ...f.input, timeoutMs: 25 })).rejects.toThrow("turn_timeout");
    expect(f.bridge.request.mock.calls.filter(([, params]) => (params?.request as Row)?.kind === "stop")).toHaveLength(1);
    expect(f.bridge.requestEnvelope.mock.calls.filter(([, params]) => (params?.request as Row)?.kind === "mutate")).toHaveLength(1);
    expect(f.listeners.size).toBe(0); expect(f.statusListeners.size).toBe(0);
  });
  it("never resubmits an unknown enqueue acknowledgement and stops the exact scope", async () => {
    const f = controlledBridge(); f.settings.lostAck = true;
    await expect(driveRendererTurn(f.bridge, f.input)).rejects.toThrow("controlled-unknown-ack");
    expect(f.bridge.requestEnvelope.mock.calls.filter(([, params]) => (params?.request as Row)?.kind === "mutate")).toHaveLength(1);
    const stops = f.bridge.request.mock.calls.filter(([, params]) => (params?.request as Row)?.kind === "stop");
    expect(stops).toHaveLength(1); expect(stops[0][1]?.request).toMatchObject({ conversationId });
  });
  it("refuses failed cleanup without retaining its raw error", async () => {
    const f = controlledBridge(); f.settings.lostAck = true; f.settings.stopFails = true;
    let failure: unknown;
    try { await driveRendererTurn(f.bridge, f.input); } catch (error) { failure = error; }
    expect(String(failure)).toContain("cleanup_unconfirmed");
    expect(String(failure) + JSON.stringify(failure)).not.toContain("private-stop-sentinel");
  });
  it("includes the actual renderer resume mutation without treating it as another prompt", async () => {
    const f = controlledBridge(); f.settings.paused = true;
    const result = await driveRendererTurn(f.bridge, f.input);
    const mutations = f.bridge.requestEnvelope.mock.calls.filter(([, params]) => (params?.request as Row)?.kind === "mutate");
    expect(mutations).toHaveLength(2);
    expect((((mutations[0][1]?.request as Row).mutation as Row).action as Row).kind).toBe("resume");
    expect(result.commandId).toBe((f.mutation()?.action as Row).commandId);
  });
  it("awaits an asynchronous independent terminal verification before replay or timing", async () => {
    const f = controlledBridge(); let release!: () => void, began = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const flight = driveRendererTurn(f.bridge, { ...f.input, verifyTerminal: async () => { began = true; await pending; } });
    try {
      await expect.poll(() => began).toBe(true);
      expect(f.order).not.toContain("cloudEvents.request:replay");
      expect(f.bridge.request.mock.calls.some(([op, params]) => op === "cloudCommands.conversation" && params?.agentTurnTimingsVersion === 1)).toBe(false);
    } finally { release(); }
    await expect(flight).resolves.toMatchObject({ outcome: "pre_auth_only" });
  });
});

describe("outgoing renderer enqueue ownership", () => {
  function wire() { const commandId = randomUUID(); return { request: { kind: "mutate", mutation: {
    conversationId, operationId: commandId, expectedRevision: 0, action: { kind: "enqueue", commandId,
      payload: { agentId: provider, userMessageId, model, modeRevision: 0, agentCredentialGrantId: grantId,
        prompt: [{ type: "text", text: promptText }] } } } } }; }
  it("retains only actual command/turn identity from the exact wire", () => {
    const params = wire(); expect(captureRendererEnqueue(params, expected)).toEqual({ commandId: params.request.mutation.action.commandId,
      turnId: userMessageId });
  });
  it.each(["agentId", "model", "userMessageId"])("refuses foreign %s before transport", field => {
    const params = wire(); Object.assign(params.request.mutation.action.payload, { [field]: field === "agentId" ? "claude" : "foreign" });
    expect(() => captureRendererEnqueue(params, expected)).toThrow("renderer_command_invalid");
  });
  it("refuses a foreign conversation or distinct mutation identity", () => {
    for (const field of ["conversationId", "operationId"] as const) {
      const params = wire(); params.request.mutation[field] = randomUUID();
      expect(() => captureRendererEnqueue(params, expected)).toThrow("renderer_command_invalid");
    }
  });
  it("refuses a changed prompt without leaking either value", () => {
    const params = wire(); params.request.mutation.action.payload.prompt[0].text = "changed-private-sentinel";
    let failure: unknown;
    try { captureRendererEnqueue(params, expected); } catch (error) { failure = error; }
    expect(String(failure)).toContain("renderer_command_invalid");
    expect(JSON.stringify(failure)).not.toContain("private-sentinel");
  });
});
