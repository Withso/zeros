import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudBootCommandSnapshotSchema, type CloudBootCommandClaim } from "@zeros/protocol/cloud-commands";
import { CloudAgentBootCredentialResponseSchema, CloudAgentBootSyncResponseSchema, CloudAgentBootActivateResponseSchema,
  CloudAgentBootRefreshResponseSchema, CloudAgentActorConfirmResponseSchema, CloudAgentWarmActorResponseSchema,
  CloudAgentWarmActorRequestSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudCommandRuntimeError } from "../cloud-command-client";
import type { EngineMessage } from "../types";
import { CloudLocalAgentBootRuntime } from "../cloud-local-command-queue-boot";
import { CloudLocalCommandNativePump } from "../cloud-local-command-native-pump";
import { cloudBootTurnReservation, cloudExecutionLifetime, cloudProviderExecution,
  type CloudBootAgentExecutionFactory, type CloudBootProviderExecution, type CloudBootAgentSelection,
  type CloudBootNativeAuthority, type CloudBootTurnReservation } from "../agents/cloud-provider-execution";
import type { PreparedBoundary } from "../agents/containment/types";
import type { CloudRuntimeRegistration } from "../cloud-runtime-registration";
import { testCloudBootFixture } from "../agents/__tests__/helpers/test-cloud-boot";
import type { TransportClient } from "../transport/types";
import { CloudCommandRuntime } from "../cloud-command-runtime";
import type { CloudAgentBootOperation, CloudAgentBootRequests, CloudAgentBootResponses } from "../cloud-agent-execution-client";
import { CloudAgentCredentialControlExchangeResponseSchema } from "../cloud-local-command-queue-start-fences";

const bootResponses: { [Operation in CloudAgentBootOperation]: { parse(value: unknown): CloudAgentBootResponses[Operation] } } = {
  bootstrap: CloudAgentBootCredentialResponseSchema, sync: CloudAgentBootSyncResponseSchema,
  activate: CloudAgentBootActivateResponseSchema, refresh: CloudAgentBootRefreshResponseSchema,
  "actor-confirm": CloudAgentActorConfirmResponseSchema, "warm-context": CloudAgentWarmActorResponseSchema,
};

const native = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../agents/containment/cloud-native-boundary", () => ({ CloudNativeBoundary: { prepareBoot: native.prepare } }));
vi.mock("../agents/cloud-workload-tools", () => ({ CloudWorkloadTools: class {
  async stopAndProve() {}
} }));
vi.mock("../agents/cloud-mcp", async original => ({ ...await original<typeof import("../agents/cloud-mcp")>(),
  readCloudRepositoryMcp: vi.fn(async () => []) }));
vi.mock("../agents/containment/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../agents/containment/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../agents/__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.clearAllMocks(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-native-pump-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "workspace"); mkdirSync(cwd);
  const f = await testCloudBootFixture(cwd); cleanups.push(f.close);
  const { fundingOwnerUserId: _owner, fundingOwnerEpoch: _epoch, bootId: _boot, writerEpoch: _writer, ...scope } = f.scope;
  const request = vi.fn(async (operation: string, input: unknown) => {
    if (operation === "bootstrap" || operation === "sync") return f.response;
    if (operation === "actor-confirm") return { version: 1, mode: "boot-owner-v1", provenance: f.provenance };
    if (operation === "warm-context") return f.contextRequest(CloudAgentWarmActorRequestSchema.parse(input));
    if (operation === "activate") {
      const { providers: _providers, initialAdoptions: _initial, desiredCacheRevision: _desired, ...identity } = f.response;
      return { ...identity, activated: true };
    }
    throw new Error("Unexpected private operation");
  });
  let factory!: CloudBootAgentExecutionFactory;
  const conversations = new Map([[f.input.conversationId, { id: f.input.conversationId, folder: cwd,
    agentId: "cursor", providerBinding: null, sessionId: null, permissionMode: "auto", lastModeId: null }]]);
  const registration = {
    localCommandsNegotiated: () => true,
    async agentBootRequest<Operation extends CloudAgentBootOperation>(operation: Operation,
      input: CloudAgentBootRequests[Operation]): Promise<CloudAgentBootResponses[Operation]> {
      return bootResponses[operation].parse(await request(operation, input));
    },
    credentialControlsRequest: vi.fn(async () => CloudAgentCredentialControlExchangeResponseSchema.parse({
      version: 1, mode: "boot-owner-v1", controls: [],
    })),
  } satisfies Pick<CloudRuntimeRegistration, "localCommandsNegotiated" | "agentBootRequest" | "credentialControlsRequest">;
  const boot = new CloudLocalAgentBootRuntime({ file: path.join(directory, "queue.sqlite"), scope,
    runtimeBootId: f.scope.bootId, registration,
    legacy: f.legacy, supervisor: { onRetirementFailure: vi.fn() }, engineLive: () => true,
    isAdmittedCwd: root => root === cwd, resolveConversation: conversationId => conversations.has(conversationId)
      ? { provider: "cursor", model: f.input.model, cwd } : null,
    history: () => ({ recordSequence: 1, eventSequence: 1 }), beforeActivate: async () => {},
    install: value => { factory = value; }, changed: vi.fn(),
    executionFor: input => pump.executionFor(input) });
  cleanups.push(() => boot.dispose());
  await boot.initialize();
  const admission = { accountUserId: f.provenance.actor.userId, authorityEpoch: f.provenance.authorityEpoch,
    actor: { sessionId: f.provenance.actorSessionId, deviceId: f.provenance.actor.deviceId,
      role: f.provenance.actor.role, fingerprint: f.provenance.actor.fingerprint } };
  await boot.confirmAdmission(admission); await boot.observeConversation(admission.actor.sessionId, f.input.conversationId);
  const routes = new Map<string, string>(), executions = new Map<string, CloudBootProviderExecution>();
  const stops = new Map<string, ReturnType<typeof vi.fn>>();
  let background = false;
  native.prepare.mockImplementation(async (authority: CloudBootNativeAuthority, workload: PreparedBoundary) => {
    const stop = vi.fn(async () => {}); stops.set(authority.executionId, stop);
    const coordinator = { ...workload, providerHomePath: path.join(directory, "home"), stopAndProve: stop,
      environment: () => ({ HOME: path.join(directory, "home") }), codexExternalAuth: () => null,
      hasBackgroundServers: async () => background };
    authority.lifetime.attach(coordinator); return coordinator;
  });
  const gateway = {
    reserveCloudBootTurn: vi.fn((_agent: string, id: string, selection: CloudBootAgentSelection) => factory.reserveBootTurn(executions.get(id)!, selection)),
    cloudBootReservation: vi.fn((_agent: string, id: string) => cloudBootTurnReservation(executions.get(id)!)),
    completeCloudForeground: vi.fn(async (_agent: string, id: string, _retire?: () => Promise<void>, token?: CloudBootTurnReservation) => {
      await factory.settleBootTurn(executions.get(id)!, token!); return true;
    }),
    endSession: vi.fn(async (_agent: string, id: string) => {
      const execution = executions.get(id); if (execution) await cloudExecutionLifetime(execution).close();
      executions.delete(id);
    }),
    cancel: vi.fn(async (_agent: string, id: string) => {
      const execution = executions.get(id); if (execution) await cloudExecutionLifetime(execution).close();
    }),
    setMode: vi.fn(async () => {}), updateConfig: vi.fn(async () => {}),
  };
  const broadcast = vi.fn(), bindings = new Map<object, CloudBootCommandClaim>(), retirementFailure = vi.fn();
  const handleAgentMessage = vi.fn(async (message: EngineMessage, receiver: TransportClient) => {
    const claim = bindings.get(receiver)!;
    const selection = pump.admissionSelection(claim);
    const workload = { stopAndProve: vi.fn(async () => {}), generation: "synthetic-workload",
      status: { backend: "cloud-worker", parity: { level: "restricted", restrictions: [] } },
      activePorts: () => [], onPortsChanged: () => () => {}, attestation: Promise.resolve() } as unknown as PreparedBoundary;
    await factory.launchBootSelection(selection, async () => workload);
    const prepared = await factory.prepareBoot({ selection, workload, signal: pump.record(claim)!.controller.signal });
    const execution = cloudProviderExecution(prepared.boundary)! as CloudBootProviderExecution;
    factory.reserveBootTurn(execution, selection); executions.set(claim.executionId, execution);
    routes.set(claim.conversationId, claim.executionId);
    expect(message.id).toBe(claim.commandId);
  });
  const releaseClaim = vi.spyOn(boot, "releaseClaim");
  const options = { boot: () => boot, factory: () => factory, gateway, conversation: (id: string) => conversations.get(id) ?? null,
    execution: (id: string) => routes.get(id) ?? null, busy: () => false,
    workspaceIdForCwd: () => "workspace", handleAgentMessage, broadcast,
    bindAdmission: (receiver: TransportClient, claim: CloudBootCommandClaim) => { bindings.set(receiver, claim); },
    unbindAdmission: (receiver: TransportClient) => { bindings.delete(receiver); },
    clearExecution: (id: string) => { for (const [conversationId, current] of routes) if (current === id) routes.delete(conversationId); },
    invalidateBind: vi.fn(), onRetirementFailure: retirementFailure };
  const pump = new CloudLocalCommandNativePump(options);
  const claim = (executionId: string = randomUUID(), conversationId: string = f.input.conversationId): CloudBootCommandClaim => {
    const commandId = randomUUID();
    const snapshot = CloudBootCommandSnapshotSchema.parse(boot.queue.handle({ kind: "snapshot", conversationId },
      { writerEpoch: f.scope.writerEpoch, actorSessionId: admission.actor.sessionId }));
    boot.queue.handle({ kind: "mutate", mutation: { conversationId, operationId: randomUUID(), expectedRevision: snapshot.revision,
      action: { kind: "enqueue", commandId, payload: { agentId: "cursor", model: f.input.model,
        permissionMode: "plan", effort: "high", fast: true, modeRevision: 0, userMessageId: randomUUID(),
        prompt: [{ type: "text", text: "Synthetic turn" }] } } }, admissionError: null },
      { writerEpoch: f.scope.writerEpoch, actorSessionId: admission.actor.sessionId });
    return boot.queue.handle({ kind: "claim", conversationId, claimId: randomUUID(), executionId },
      { writerEpoch: f.scope.writerEpoch }) as CloudBootCommandClaim;
  };
  const finish = async (value: CloudBootCommandClaim) => {
    const execution = executions.get(value.executionId)!;
    pump.assertDispatch(value); factory.markNativeHandoff(execution, cloudBootTurnReservation(execution)!);
    await pump.retire(value, { state: "succeeded" });
    boot.queue.handle({ kind: "settle", result: { commandId: value.commandId, claimId: value.claimId, state: "succeeded", resultCode: null } },
      { writerEpoch: f.scope.writerEpoch });
  };
  request.mockClear(); f.contextRequest.mockClear();
  return { f, boot, factory, pump, options, gateway, claim, finish, handleAgentMessage, request, broadcast,
    routes, executions, stops, retirementFailure, bindings, releaseClaim,
    addConversation: async (conversationId: string) => {
      conversations.set(conversationId, { ...conversations.get(f.input.conversationId)!, id: conversationId });
      await boot.observeConversation(admission.actor.sessionId, conversationId);
    }, background: () => { background = true; } };
}

describe("VM-local native command pump", () => {
  it("selects the exact FULL-stored actor/credential and forwards the ORIGINAL cold selection without CP", async () => {
    const f = await fixture(), claim = f.claim(); await f.pump.prepare(claim);
    expect(f.pump.admissionSelection(claim)).toMatchObject({ executionId: claim.executionId,
      conversationId: claim.conversationId, provider: claim.payload.agentId });
    expect(f.handleAgentMessage).toHaveBeenCalledTimes(1);
    expect(f.handleAgentMessage.mock.calls[0]![0]).toMatchObject({ type: "AGENT_NEW_SESSION", id: claim.commandId,
      env: { ZEROS_PERMISSION_MODE: "plan", ZEROS_FAST_MODE: "1", ZEROS_THINKING_EFFORT: "high" } });
    expect(f.request).not.toHaveBeenCalled(); expect(f.f.contextRequest).not.toHaveBeenCalled();
    expect(f.f.legacy.prepare).not.toHaveBeenCalled();
  });
  it("keeps successful empty foreground warm and reserves a fresh exact token for the same native execution", async () => {
    const f = await fixture(), first = f.claim(); await f.pump.prepare(first);
    const firstToken = f.gateway.cloudBootReservation("cursor", first.executionId);
    await f.finish(first); const second = f.claim(first.executionId); await f.pump.prepare(second);
    expect(second.commandId).not.toBe(first.commandId); expect(second.claimId).not.toBe(first.claimId);
    expect(f.gateway.reserveCloudBootTurn).toHaveBeenCalledTimes(1);
    expect(f.handleAgentMessage).toHaveBeenCalledTimes(1);
    const secondToken = f.gateway.cloudBootReservation("cursor", second.executionId);
    expect(secondToken).not.toBe(firstToken);
    expect(f.gateway.endSession).not.toHaveBeenCalled();
    await f.finish(second);
    expect(f.gateway.completeCloudForeground.mock.calls.map(call => call[3])).toEqual([firstToken, secondToken]);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("rejects an old or copied claim without settling the newer warm reservation", async () => {
    const f = await fixture(), first = f.claim(); await f.pump.prepare(first); await f.finish(first);
    const second = f.claim(first.executionId); await f.pump.prepare(second);
    expect(() => f.pump.assertDispatch({ ...second, claimId: randomUUID() })).toThrow();
    await expect(f.pump.retire(first, { state: "succeeded" })).rejects.toThrow();
    expect(f.gateway.completeCloudForeground).toHaveBeenCalledTimes(1);
    f.pump.assertDispatch(second);
  });
  it("reserves warm authority before mode/configuration awaits and preserves explicit Plan", async () => {
    const f = await fixture(), first = f.claim(); await f.pump.prepare(first); await f.finish(first);
    const wait = deferred(); f.gateway.setMode.mockImplementation(async () => wait.promise);
    const second = f.claim(first.executionId), pending = f.pump.prepare(second);
    await vi.waitFor(() => expect(f.gateway.setMode).toHaveBeenCalled());
    expect(f.gateway.cloudBootReservation("cursor", second.executionId)).not.toBeNull();
    expect(f.pump.record(second)!.controller.signal.aborted).toBe(false);
    wait.resolve(); await pending;
    expect(f.gateway.setMode).toHaveBeenCalledWith("cursor", second.executionId, "plan");
    expect(f.gateway.updateConfig).toHaveBeenCalledWith("cursor", second.executionId,
      expect.objectContaining({ ZEROS_FAST_MODE: "1", ZEROS_THINKING_EFFORT: "high" }));
  });
  it("Stop synchronously fences the entered turn and waits for whole-session proof before clearing the route", async () => {
    const f = await fixture(), claim = f.claim(); await f.pump.prepare(claim); f.pump.assertDispatch(claim);
    const execution = f.executions.get(claim.executionId)!;
    f.factory.markNativeHandoff(execution, cloudBootTurnReservation(execution)!);
    const wait = deferred(); f.stops.get(claim.executionId)!.mockImplementation(async () => wait.promise);
    const stopped = f.pump.cancel(claim.conversationId);
    expect(f.pump.record(claim)!.controller.signal.aborted).toBe(true);
    expect(() => cloudExecutionLifetime(execution).assertLive()).toThrow();
    let settled = false; void stopped.then(() => { settled = true; }); await Promise.resolve();
    expect(settled).toBe(false); expect(f.routes.get(claim.conversationId)).toBe(claim.executionId);
    wait.resolve(); await stopped;
    expect(f.routes.has(claim.conversationId)).toBe(false);
    expect(f.gateway.endSession).toHaveBeenCalledWith("cursor", claim.executionId, { failClosed: true });
  });
  it("Stop also retires an idle warm session after its command record was released", async () => {
    const f = await fixture(), claim = f.claim(); await f.pump.prepare(claim); await f.finish(claim);
    await f.pump.cancel(claim.conversationId);
    expect(f.gateway.endSession).toHaveBeenCalledWith("cursor", claim.executionId, { failClosed: true });
    expect(f.routes.has(claim.conversationId)).toBe(false);
  });
  it("proves the exact selection empty when Stop arrives before the preparation microtask captures its lifetime", async () => {
    const f = await fixture(), claim = f.claim();
    const preparing = f.pump.prepare(claim); void preparing.catch(() => {});
    const stopped = f.pump.cancel(claim.conversationId);
    await expect(preparing).rejects.toThrow(); await stopped;
    expect(f.factory.bootScopeActivity([]).scopes).toHaveLength(0);
    expect(f.routes.has(claim.conversationId)).toBe(false);
  });
  it("proves an unused FULL-stored capture empty when a start fence rejects preparation before consumption", async () => {
    const f = await fixture(), claim = f.claim();
    await f.boot.fences.handle({ ...f.f.scope, version: 1, mutationId: randomUUID(), controlRequestId: randomUUID(), fenceEpoch: 1,
      selectors: [{ provider: "cursor", credentialId: f.f.selection.credentialRun.credentialId }],
      operation: "pause-starts", desiredCacheRevision: null });
    await expect(f.pump.prepare(claim)).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(f.handleAgentMessage).not.toHaveBeenCalled();
    await f.pump.cancel(claim.conversationId);
    expect(f.factory.bootScopeActivity([]).scopes).toHaveLength(0);
    expect(f.releaseClaim).toHaveBeenCalledTimes(1);
  });
  it("joins exact positive Stop proof when foreground settlement is awaiting the real background probe", async () => {
    const f = await fixture(), claim = f.claim(); await f.pump.prepare(claim); f.pump.assertDispatch(claim);
    const execution = f.executions.get(claim.executionId)!;
    f.factory.markNativeHandoff(execution, cloudBootTurnReservation(execution)!);
    let resolve!: (background: boolean) => void;
    const probe = new Promise<boolean>(done => { resolve = done; });
    const background = vi.spyOn(execution.coordinator, "hasBackgroundServers").mockReturnValueOnce(probe);
    const retiring = f.pump.retire(claim, { state: "succeeded" }); void retiring.catch(() => {});
    await vi.waitFor(() => expect(background).toHaveBeenCalled());
    await f.pump.cancel(claim.conversationId); resolve(false);
    await expect(retiring).resolves.toBeUndefined();
    expect(f.pump.record(claim)).toBeNull(); expect(f.routes.has(claim.conversationId)).toBe(false);
    expect(f.retirementFailure).not.toHaveBeenCalled();
  });
  it("preserves an exact failed Stop proof during the same background-settlement race", async () => {
    const f = await fixture(), claim = f.claim(); await f.pump.prepare(claim); f.pump.assertDispatch(claim);
    const execution = f.executions.get(claim.executionId)!;
    f.factory.markNativeHandoff(execution, cloudBootTurnReservation(execution)!);
    let resolve!: (background: boolean) => void;
    const probe = new Promise<boolean>(done => { resolve = done; });
    const background = vi.spyOn(execution.coordinator, "hasBackgroundServers").mockReturnValueOnce(probe);
    const retiring = f.pump.retire(claim, { state: "succeeded" }); void retiring.catch(() => {});
    await vi.waitFor(() => expect(background).toHaveBeenCalled());
    const refusal = Object.assign(new Error("Synthetic exact proof refusal"), { code: "cloud_containment_attestation_failed" });
    f.gateway.endSession.mockRejectedValueOnce(refusal);
    await expect(f.pump.cancel(claim.conversationId)).rejects.toBe(refusal); resolve(false);
    await expect(retiring).rejects.toBe(refusal);
    expect(f.pump.record(claim)).not.toBeNull(); expect(f.releaseClaim).not.toHaveBeenCalled();
    expect(f.routes.get(claim.conversationId)).toBe(claim.executionId);
  });
  it("does not replace an unrelated foreground-settlement failure with an unproved empty-scope claim", async () => {
    const f = await fixture(), claim = f.claim(); await f.pump.prepare(claim); f.pump.assertDispatch(claim);
    const execution = f.executions.get(claim.executionId)!;
    f.factory.markNativeHandoff(execution, cloudBootTurnReservation(execution)!);
    const refusal = Object.assign(new Error("Synthetic foreground proof refusal"), { code: "cloud_containment_canary_failed" });
    f.gateway.completeCloudForeground.mockRejectedValueOnce(refusal);
    await expect(f.pump.retire(claim, { state: "succeeded" })).rejects.toBe(refusal);
    expect(f.pump.record(claim)).not.toBeNull(); expect(f.releaseClaim).not.toHaveBeenCalled();
    expect(f.routes.get(claim.conversationId)).toBe(claim.executionId);
  });
  it("owns and reaps a native allocation returned after Stop during cold preparation", async () => {
    const f = await fixture(), claim = f.claim(), wait = deferred();
    const start = f.handleAgentMessage.getMockImplementation()!;
    f.handleAgentMessage.mockImplementation(async (...args) => { await wait.promise; await start(...args); });
    const preparing = f.pump.prepare(claim); void preparing.catch(() => {});
    await vi.waitFor(() => expect(f.handleAgentMessage).toHaveBeenCalled());
    const stopped = f.pump.cancel(claim.conversationId); wait.resolve();
    await expect(preparing).rejects.toThrow(); await stopped;
    expect(f.routes.has(claim.conversationId)).toBe(false);
    expect(f.factory.bootScopeActivity([]).scopes).toHaveLength(0);
  });
  it("keeps the original selected source while background descendants survive and makes Stop prove them empty", async () => {
    const f = await fixture(), claim = f.claim(); f.background(); await f.pump.prepare(claim); await f.finish(claim);
    expect(f.gateway.endSession).not.toHaveBeenCalled();
    expect(f.factory.bootScopeActivity([]).background).toBe(1);
    await f.pump.cancel(claim.conversationId); expect(f.factory.bootScopeActivity([]).scopes).toHaveLength(0);
  });
  it("refuses denied or unstored claims before creating native ownership", async () => {
    const f = await fixture(), claim = f.claim();
    await expect(f.pump.prepare({ ...claim, dispatchAllowed: false, actor: undefined })).rejects.toThrow();
    await expect(f.pump.prepare({ ...claim, commandId: randomUUID() })).rejects.toThrow();
    expect(f.handleAgentMessage).not.toHaveBeenCalled();
  });
  it("does not select after mode retirement and never falls back to legacy grants", async () => {
    const f = await fixture(), claim = f.claim(); await f.boot.dispose();
    await expect(f.pump.prepare(claim)).rejects.toThrow();
    expect(f.handleAgentMessage).not.toHaveBeenCalled(); expect(f.f.legacy.prepare).not.toHaveBeenCalled();
  });
  it("preserves sibling conversation ownership and boot credentials when one exact warm scope is stopped", async () => {
    const f = await fixture(), first = f.claim(); await f.pump.prepare(first); await f.finish(first);
    await f.addConversation("sibling"); const sibling = f.claim(randomUUID(), "sibling");
    await f.pump.prepare(sibling); await f.finish(sibling);
    await f.pump.cancel(first.conversationId);
    expect(f.routes.get("sibling")).toBe(sibling.executionId);
    expect(f.stops.get(sibling.executionId)).not.toHaveBeenCalled();
    expect(() => cloudExecutionLifetime(f.executions.get(sibling.executionId)!).assertLive()).not.toThrow();
    expect(f.boot.active).toBe(true);
  });
  it("does not publish retirement or clear ownership when the exact native end proof fails", async () => {
    const f = await fixture(), claim = f.claim(); await f.pump.prepare(claim);
    f.gateway.endSession.mockRejectedValueOnce(Object.assign(new Error("Synthetic proof refusal"), { code: "cloud_containment_attestation_failed" }));
    await expect(f.pump.cancel(claim.conversationId)).rejects.toMatchObject({ code: "cloud_containment_attestation_failed" });
    expect(f.routes.get(claim.conversationId)).toBe(claim.executionId);
    expect(f.pump.record(claim)).not.toBeNull(); expect(f.releaseClaim).not.toHaveBeenCalled();
    expect(f.retirementFailure).toHaveBeenCalled();
  });
  it("chooses the exact idle native ID only for the current opaque actor/context before the durable next claim", async () => {
    const f = await fixture(), claim = f.claim(); await f.pump.prepare(claim);
    const selection = f.pump.admissionSelection(claim); await f.finish(claim);
    const input = { actor: selection.actor, context: selection.context, provider: selection.provider, model: selection.model,
      conversationId: selection.conversationId, cwd: selection.cwd, candidateExecutionId: randomUUID() };
    expect(f.pump.executionFor(input)).toBe(claim.executionId);
    expect(f.pump.executionFor({ ...input, actor: f.f.actor })).not.toBe(claim.executionId);
    expect(f.pump.executionFor({ ...input, model: "different-model" })).not.toBe(claim.executionId);
    expect(f.request).not.toHaveBeenCalled();
    await f.pump.cancel(claim.conversationId);
    expect(f.pump.executionFor(input)).not.toBe(claim.executionId);
  });
  it("uses the single installed FULL queue pump for cold and warm receipts without a socket or CP request", async () => {
    const f = await fixture(), dispatched: CloudBootCommandClaim[] = [];
    const runtime = new CloudCommandRuntime({ request: async () => { throw new Error("Unexpected legacy CP request"); },
      validate: () => {}, execution: id => f.routes.get(id) ?? null,
      retainedExecution: id => f.pump.retainedExecution(id), prepare: claim => f.pump.prepare(claim),
      retire: (claim, result) => f.pump.retire(claim, result), cancel: id => f.pump.cancel(id), changed: () => {},
      dispatch: async claim => {
        f.pump.assertDispatch(claim); dispatched.push(claim as CloudBootCommandClaim);
        const execution = f.executions.get(claim.executionId)!;
        f.factory.markNativeHandoff(execution, cloudBootTurnReservation(execution)!);
        return { state: "succeeded", resultCode: null };
      } });
    runtime.installLocalQueue(f.boot.queue); cleanups.push(() => runtime.close());
    const conversationId = f.f.input.conversationId, actorSessionId = f.f.provenance.actorSessionId;
    for (let turn = 0; turn < 2; turn++) {
      const snapshot = CloudBootCommandSnapshotSchema.parse(await runtime.handle({ kind: "snapshot", conversationId }, actorSessionId));
      const commandId = randomUUID();
      await runtime.handle({ kind: "mutate", mutation: { conversationId, expectedRevision: snapshot.revision,
        operationId: randomUUID(), action: { kind: "enqueue", commandId, payload: { agentId: "cursor", model: f.f.input.model,
          permissionMode: "plan", modeRevision: 0, userMessageId: randomUUID(), prompt: [{ type: "text", text: "Synthetic turn" }] } } } }, actorSessionId);
      await vi.waitFor(async () => {
        const current = CloudBootCommandSnapshotSchema.parse(await runtime.handle({ kind: "snapshot", conversationId }, actorSessionId));
        expect(current.receipts.find(row => row.commandId === commandId)?.state).toBe("succeeded");
      });
    }
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]!.executionId).toBe(dispatched[1]!.executionId);
    expect(dispatched[0]!.commandId).not.toBe(dispatched[1]!.commandId);
    expect(f.handleAgentMessage).toHaveBeenCalledTimes(1); expect(f.request).not.toHaveBeenCalled();
    await runtime.handle({ kind: "stop", conversationId, operationId: randomUUID() }, actorSessionId);
    expect(f.routes.has(conversationId)).toBe(false);
  });
  it("settles a known validation failure before native prepare without closing the queue pump or replaying", async () => {
    const f = await fixture(); let claimed = false;
    const handle = f.boot.queue.handle.bind(f.boot.queue);
    vi.spyOn(f.boot.queue, "handle").mockImplementation((request, context) => {
      const value = handle(request, context);
      if (request && typeof request === "object" && "kind" in request && request.kind === "claim" && value !== null) claimed = true;
      return value;
    });
    const runtime = new CloudCommandRuntime({ request: async () => { throw new Error("Unexpected CP"); },
      validate: () => { if (claimed) throw new CloudCommandRuntimeError("command_context_changed"); },
      execution: id => f.routes.get(id) ?? null, prepare: claim => f.pump.prepare(claim),
      retire: (claim, result) => f.pump.retire(claim, result), cancel: id => f.pump.cancel(id), changed: () => {},
      dispatch: async () => { throw new Error("Validation must precede native dispatch"); } });
    runtime.installLocalQueue(f.boot.queue); cleanups.push(() => runtime.close());
    const conversationId = f.f.input.conversationId, commandId = randomUUID();
    await runtime.handle({ kind: "mutate", mutation: { conversationId, expectedRevision: 0, operationId: randomUUID(),
      action: { kind: "enqueue", commandId, payload: { agentId: "cursor", model: f.f.input.model, permissionMode: "plan",
        modeRevision: 0, userMessageId: randomUUID(), prompt: [{ type: "text", text: "Synthetic turn" }] } } } }, f.f.provenance.actorSessionId);
    await vi.waitFor(() => {
      const snapshot = CloudBootCommandSnapshotSchema.parse(handle({ kind: "snapshot", conversationId },
        { writerEpoch: f.f.scope.writerEpoch, actorSessionId: f.f.provenance.actorSessionId }));
      expect(snapshot.receipts.find(row => row.commandId === commandId)?.state).toBe("failed");
    });
    expect(f.handleAgentMessage).not.toHaveBeenCalled(); expect(f.releaseClaim).toHaveBeenCalledTimes(1);
    expect(f.boot.executionFactory.bootScopeActivity([]).scopes).toHaveLength(0);
  });
});
