import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudLocalAgentBootRuntime } from "../cloud-local-command-queue-boot";
import { testCloudBootFixture } from "../agents/__tests__/helpers/test-cloud-boot";
import { isCloudBootAgentExecutionFactory, isCloudBootAgentSelection, type CloudBootAgentExecutionFactory } from "../agents/cloud-provider-execution";
import type { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import type { CloudRuntimeRegistration } from "../cloud-runtime-registration";
import type { CloudAgentBootResponses } from "../cloud-agent-execution-client";
import { CloudAgentBootSyncResponseSchema, CloudAgentBootRefreshResponseSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import ts from "typescript";
import { ZerosEngine } from "../zeros-engine";
import { CloudTransport } from "../transport/cloud";

type Readiness = ReturnType<CloudRuntimeRegistration["readiness"]>;
const engineMethods = ZerosEngine.prototype as unknown as {
  cloudRuntimeReadiness(this: unknown): Readiness;
  verifyCloudActorClient(this: unknown, token: string, renew?: boolean): Promise<unknown>;
};
/** Exercise the actual transport callback without starting a native engine. */
function internalReadiness(engine: unknown): () => Readiness {
  const source = ts.createSourceFile("zeros-engine.ts", readFileSync(new URL("../zeros-engine.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "internalReadiness" && ts.isObjectLiteralExpression(node.initializer)) {
      const read = node.initializer.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === "read");
      if (read && ts.isPropertyAssignment(read)) expression = read.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error("Missing engine-owned readiness callback");
  const output = ts.transpileModule(`return ${expression.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(output).call(engine) as () => Readiness;
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers(); });
async function fixture(provider: "cursor" | "codex" = "cursor") {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-boot-runtime-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "workspace"); mkdirSync(cwd);
  const f = await testCloudBootFixture(cwd, provider); cleanups.push(f.close);
  const { fundingOwnerUserId: _funder, fundingOwnerEpoch: _epoch, bootId: _boot, writerEpoch: _writer, ...scope } = f.scope;
  let negotiated = true, live = true;
  const request = vi.fn(async (operation: string, input: unknown): Promise<CloudAgentBootResponses[keyof CloudAgentBootResponses]> => {
    if (operation === "bootstrap" || operation === "sync") return f.response;
    if (operation === "actor-confirm") return { version: 1, mode: "boot-owner-v1", provenance: {
      ...f.provenance, confirmedUntilMs: Date.now() + 8_000 } };
    if (operation === "warm-context") return f.contextRequest(input as Parameters<typeof f.contextRequest>[0]);
    if (operation === "activate") {
      const { providers: _providers, initialAdoptions: _baseline, desiredCacheRevision: _desired, ...identity } = f.response;
      return { ...identity, activated: true };
    }
    throw new Error("Unexpected private request");
  });
  const registration = { localCommandsNegotiated: () => negotiated, agentBootRequest: request } as unknown as
    Pick<CloudRuntimeRegistration, "localCommandsNegotiated" | "agentBootRequest" | "credentialControlsRequest">;
  const controls = vi.fn(async (_body: unknown) => ({ version: 1 as const, mode: "boot-owner-v1" as const, controls: [] as unknown[] }));
  registration.credentialControlsRequest = controls as unknown as CloudRuntimeRegistration["credentialControlsRequest"];
  const beforeActivate = vi.fn(async () => {}), install = vi.fn((_factory: CloudBootAgentExecutionFactory, _queue: CloudLocalCommandQueue): void | Promise<void> => {}), changed = vi.fn();
  const options = { file: path.join(directory, "queue.sqlite"), scope, runtimeBootId: f.scope.bootId, registration,
    legacy: f.legacy, supervisor: { onRetirementFailure: vi.fn() }, engineLive: () => live,
    isAdmittedCwd: (cwd: string) => cwd === f.input.cwd, resolveConversation: () => ({ cwd: f.input.cwd, provider: f.input.provider, model: f.input.model }),
    history: () => ({ recordSequence: 1, eventSequence: 1 }), beforeActivate, install, changed };
  const boot = new CloudLocalAgentBootRuntime(options); cleanups.push(() => boot.dispose());
  const admission = { accountUserId: f.provenance.actor.userId, authorityEpoch: f.provenance.authorityEpoch,
    actor: { sessionId: f.provenance.actorSessionId, deviceId: f.provenance.actor.deviceId,
      role: f.provenance.actor.role, fingerprint: f.provenance.actor.fingerprint } };
  return { f, boot, options, admission, request, controls, beforeActivate, install,
    unnegotiate: () => { negotiated = false; }, retire: () => { live = false; } };
}

describe("engine boot-mode orchestration", () => {
  it.each([100, 300])("withholds actual readiness during %ims bootstrap/activation and authenticates after the original flight", async delay => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => {
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      return original(operation, input);
    });
    const ready: NonNullable<Readiness> = { version: 1, instanceId: f.f.scope.engineInstanceId,
      protocolVersion: 4, health: "ready", durableRecordConnected: true };
    const verify = vi.fn(async () => f.admission);
    const engine = { running: true, cloudWorker: { version: 4 }, cloudRuntimeAuthorityStopping: false,
      cloudLocalHistoryRestored: true, cloudLocalEvents: null as object | null,
      cloudRuntimeRegistration: { ...f.options.registration, readiness: () => ready, verifyClientAdmission: verify },
      cloudAgentBoot: f.boot, cloudRuntimeReadiness: engineMethods.cloudRuntimeReadiness };
    f.install.mockImplementation(() => { engine.cloudLocalEvents = {}; });
    const read = internalReadiness(engine), initialization = f.boot.initialize();
    const admission = engineMethods.verifyCloudActorClient.call(engine, "synthetic-connection-token");
    try {
      expect(read()).toBeNull();
      expect(verify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(delay);
      expect(f.request.mock.calls.some(([operation]) => operation === "activate")).toBe(true);
      expect(read()).toBeNull(); expect(verify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(delay * 2);
      await expect(initialization).resolves.toBe(true);
      await expect(admission).resolves.toBe(f.admission);
      expect(read()).toEqual(ready); expect(verify).toHaveBeenCalledOnce();
      expect(f.request.mock.calls.filter(([operation]) => operation === "activate")).toHaveLength(1);
      expect(f.request.mock.calls.filter(([operation]) => operation === "actor-confirm")).toHaveLength(1);
      engine.cloudLocalHistoryRestored = false; expect(read()).toBeNull();
      engine.cloudLocalHistoryRestored = true; engine.cloudLocalEvents = null; expect(read()).toBeNull();
      engine.cloudLocalEvents = {};
      await f.boot.quiesceForSeal();
      expect(f.boot.active).toBe(false); expect(f.boot.authorityActive).toBe(true);
      expect(read()).toEqual(ready);
      await f.boot.dispose(); expect(read()).toBeNull();
    } finally {
      await vi.advanceTimersByTimeAsync(delay * 3);
      await Promise.allSettled([initialization, admission]);
    }
  });
  it("waits for activation before acquiring the bounded actor proof", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => {
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      return original(operation, input);
    });
    const verify = vi.fn(async () => f.admission);
    const engine = { running: true, cloudWorker: { version: 4 }, cloudRuntimeAuthorityStopping: false,
      cloudLocalHistoryRestored: true, cloudLocalEvents: null as object | null, cloudAgentBoot: f.boot,
      cloudRuntimeRegistration: { ...f.options.registration, verifyClientAdmission: verify } };
    f.install.mockImplementation(() => { engine.cloudLocalEvents = {}; });
    const initialization = f.boot.initialize(), admission = engineMethods.verifyCloudActorClient.call(engine, "synthetic-connection-token");
    try {
      expect(verify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      await expect(initialization).resolves.toBe(true);
      await expect(admission).resolves.toBe(f.admission);
      expect(verify).toHaveBeenCalledOnce();
    } finally {
      await vi.advanceTimersByTimeAsync(300);
      await Promise.allSettled([initialization, admission]);
    }
  });
  it("rejects a replaced boot while the original actor confirmation is in flight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(); await f.boot.initialize();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => {
      if (operation === "actor-confirm") await new Promise<void>(resolve => setTimeout(resolve, 100));
      return original(operation, input);
    });
    const verify = vi.fn(async () => f.admission);
    const engine = { cloudRuntimeAuthorityStopping: false, cloudLocalHistoryRestored: true, cloudLocalEvents: {},
      cloudAgentBoot: f.boot as CloudLocalAgentBootRuntime | null,
      cloudRuntimeRegistration: { ...f.options.registration, verifyClientAdmission: verify } };
    const admission = engineMethods.verifyCloudActorClient.call(engine, "synthetic-connection-token");
    await vi.advanceTimersByTimeAsync(0); expect(verify).toHaveBeenCalledOnce();
    engine.cloudAgentBoot = null;
    await vi.advanceTimersByTimeAsync(100); await expect(admission).resolves.toBeNull();
  });
  it("keeps the authenticated quiet endpoint usable after starts are fenced for sealing", async () => {
    const f = await fixture();
    const ready: NonNullable<Readiness> = { version: 1, instanceId: f.f.scope.engineInstanceId,
      protocolVersion: 4, health: "ready", durableRecordConnected: true };
    const engine = { cloudWorker: { version: 4 }, cloudLocalHistoryRestored: true,
      cloudLocalEvents: null as object | null, cloudAgentBoot: f.boot,
      cloudRuntimeRegistration: { ...f.options.registration, readiness: () => ready },
      cloudRuntimeReadiness: engineMethods.cloudRuntimeReadiness };
    f.install.mockImplementation(() => { engine.cloudLocalEvents = {}; });
    const probeToken = `zwr_${"R".repeat(43)}`, challenge = randomUUID();
    const transport = new CloudTransport({ port: 0, token: "synthetic-cloud-token", internalReadiness: {
      token: probeToken, read: internalReadiness(engine), readQuiet: async nonce => ({ version: 1, challenge: nonce,
        workspaceId: f.f.scope.workspaceId, organizationId: f.f.scope.organizationId, generation: f.f.scope.generation,
        engineInstanceId: f.f.scope.engineInstanceId, activityRevision: 1, quietForMs: 60_000, stable: true,
        recordSync: "ready", workloadBusy: false, livePty: false, userProcesses: "idle", presence: "absent" }) } });
    cleanups.push(() => transport.stop()); await transport.start();
    const url = `http://127.0.0.1:${transport.boundPort}`;
    const headers = { "x-zeros-readiness-token": probeToken, "x-zeros-quiet-challenge": challenge };
    expect((await fetch(`${url}/internal/readiness`, { headers })).status).toBe(503);
    await f.boot.initialize();
    expect((await fetch(`${url}/internal/readiness`, { headers })).status).toBe(200);
    await f.boot.quiesceForSeal(); expect(f.boot.active).toBe(false);
    expect((await fetch(`${url}/internal/runtime-quiet`, { headers })).status).toBe(200);
    await f.boot.dispose();
    expect((await fetch(`${url}/internal/runtime-quiet`, { headers })).status).toBe(503);
  });
  it("retains legacy readiness and admission without negotiating a boot runtime", async () => {
    const ready: NonNullable<Readiness> = { version: 1, instanceId: randomUUID(), protocolVersion: 4,
      health: "ready", durableRecordConnected: true };
    const admission = { accountUserId: randomUUID(), authorityEpoch: 1 };
    const verify = vi.fn(async () => admission), initialize = vi.fn(async () => true);
    const engine = { running: true, cloudWorker: { version: 4 }, cloudRuntimeAuthorityStopping: false,
      cloudRuntimeRegistration: { readiness: () => ready, localCommandsNegotiated: () => false, verifyClientAdmission: verify },
      cloudAgentBoot: { active: false, initialize }, cloudRuntimeReadiness: engineMethods.cloudRuntimeReadiness };
    expect(internalReadiness(engine)()).toEqual(ready);
    await expect(engineMethods.verifyCloudActorClient.call(engine, "synthetic-legacy-token")).resolves.toBe(admission);
    expect(initialize).not.toHaveBeenCalled(); expect(verify).toHaveBeenCalledOnce();
  });
  it("keeps exact final authority usable while an admission barrier refuses new starts", async () => {
    const f = await fixture(); let startsAllowed = true;
    Object.assign(f.options, { startsAllowed: () => startsAllowed });
    await f.boot.initialize(); startsAllowed = false;
    expect(f.boot.active).toBe(false); expect(f.boot.authorityActive).toBe(true);
    expect(() => f.boot.metadata).toThrow("cloud_commands_unavailable");
    await expect(f.boot.quiesceForSeal()).resolves.toBeUndefined();
    expect(f.boot.authorityActive).toBe(true);
  });
  it("fences new starts and independently stops all background publications before final sealing", async () => {
    vi.useFakeTimers(); const f = await fixture(); await f.boot.initialize(); const queue = f.boot.queue;
    await f.boot.quiesceForSeal();
    expect(f.boot.active).toBe(false); expect(f.boot.authorityActive).toBe(true); expect(queue.accepting).toBe(false);
    const requests = f.request.mock.calls.length,controls = f.controls.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.request).toHaveBeenCalledTimes(requests); expect(f.controls).toHaveBeenCalledTimes(controls);
    await f.boot.dispose(); expect(f.boot.authorityActive).toBe(false);
  });
  it("waits for durable replay installation before advertising or polling controls", async () => {
    const f = await fixture(); let release!: () => void;
    const attached = new Promise<void>(resolve => { release = resolve; }); f.install.mockReturnValueOnce(attached);
    const pending = f.boot.initialize(); await vi.waitFor(() => expect(f.install).toHaveBeenCalledOnce());
    expect(f.boot.active).toBe(false); expect(f.controls).not.toHaveBeenCalled();
    release(); await pending; expect(f.boot.active).toBe(true);
  });
  it("keeps control polling independent of a successful scheduled Codex refresh", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture("codex");
    const provider = f.f.response.providers.find(value => value.status === "ready");
    if (!provider || provider.status !== "ready") throw new Error("Missing fixture source");
    const now = Math.floor(Date.now() / 1000) * 1000;
    Object.assign(provider, { kind: "codex-chatgpt", expiresAt: new Date(now + 60_000).toISOString(),
      refreshAfter: new Date(Date.now() + 2_000).toISOString(), material: { kind: "codex-chatgpt", accountId: randomUUID(),
        accessToken: "synthetic-before", expiresAt: (now + 60_000) / 1000 } });
    const refreshed = { ...provider, materialVersion: 2, expiresAt: new Date(now + 3_600_000).toISOString(),
      refreshAfter: new Date(now + 3_000_000).toISOString(), material: { ...provider.material,
        accessToken: "synthetic-codex-after", expiresAt: (now + 3_600_000) / 1000 } };
    const ready = CloudAgentBootSyncResponseSchema.parse({ ...f.f.response, cacheRevision: 2, desiredCacheRevision: 2,
      providers: f.f.response.providers.map(value => value.provider === "codex" ? refreshed : value) });
    const { providers: _providers, initialAdoptions: _baseline, ...identity } = ready;
    const refreshedResponse = CloudAgentBootRefreshResponseSchema.parse({ ...identity, provider: refreshed });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => {
      if (operation !== "refresh") return original(operation, input);
      Object.assign(f.f.response, ready);
      return refreshedResponse;
    });
    await f.boot.initialize(); await vi.advanceTimersByTimeAsync(6_000);
    expect(f.request.mock.calls.filter(([operation]) => operation === "refresh")).toHaveLength(1);
    expect(f.boot.metadata.cacheRevision).toBe(2);
    expect(f.controls.mock.calls.length).toBeGreaterThanOrEqual(10);
    await f.boot.dispose(); const calls = f.controls.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000); expect(f.controls).toHaveBeenCalledTimes(calls);
  });
  it("applies background start controls durably and retries the exact ACK after an unknown response", async () => {
    const f = await fixture(); await f.boot.initialize();
    const control = { ...f.f.scope, version: 1, mutationId: randomUUID(), controlRequestId: randomUUID(), fenceEpoch: 1,
      selectors: [{ provider: "cursor", credentialId: f.f.selection.credentialRun.credentialId }],
      operation: "pause-starts", desiredCacheRevision: null };
    f.controls.mockResolvedValueOnce({ version: 1, mode: "boot-owner-v1", controls: [control] });
    await f.boot.pollCredentialControls();
    expect(f.boot.fences.canStart(f.f.selection.credentialRun)).toBe(false);
    const ack = f.boot.fences.pendingAcknowledgement(); expect(ack).toMatchObject({ phase: "fenced" });
    f.controls.mockRejectedValueOnce(Object.assign(new Error("closed transient"), { code: "credential_control_storage_unavailable" }));
    await expect(f.boot.pollCredentialControls()).rejects.toThrow();
    expect(f.boot.fences.pendingAcknowledgement()).toEqual(ack);
    await f.boot.pollCredentialControls();
    expect(f.controls.mock.calls.at(-1)![0]).toMatchObject({ acknowledgements: [ack] });
    expect(f.boot.fences.pendingAcknowledgement()).toBeNull();
  });
  it("validates the whole returned control scope before retiring a durable ACK", async () => {
    const f = await fixture(); await f.boot.initialize();
    const control = { ...f.f.scope, version: 1, mutationId: randomUUID(), controlRequestId: randomUUID(), fenceEpoch: 1,
      selectors: [{ provider: "cursor", credentialId: f.f.selection.credentialRun.credentialId }],
      operation: "pause-starts", desiredCacheRevision: null };
    const fences = f.boot.fences, ack = await fences.handle(control);
    f.controls.mockResolvedValueOnce({ version: 1, mode: "boot-owner-v1", controls: [{ ...control, fundingOwnerEpoch: 2 }] });
    await expect(f.boot.pollCredentialControls()).rejects.toMatchObject({ code: "credential_control_authority_rejected" });
    expect(fences.pendingAcknowledgement()).toEqual(ack);
  });
  it("keeps an unacknowledged/old registration legacy without a private boot fetch", async () => {
    const f = await fixture(); f.unnegotiate();
    expect(await f.boot.initialize()).toBe(false); expect(f.boot.active).toBe(false);
    expect(f.request).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled();
  });
  it("installs the genuine factory and FULL ledger only after exact CP activation", async () => {
    const f = await fixture(), original = f.request.getMockImplementation()!;
    let acknowledge!: (value: Awaited<ReturnType<typeof original>>) => void;
    const activate = new Promise<Awaited<ReturnType<typeof original>>>(resolve => { acknowledge = resolve; });
    f.request.mockImplementation((operation, input) => operation === "activate" ? activate : original(operation, input));
    const pending = f.boot.initialize();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([operation]) => operation === "activate")).toBe(true));
    expect(f.boot.active).toBe(false); expect(f.install).not.toHaveBeenCalled();
    const response = await original("activate", {}); acknowledge(response); await pending;
    expect(f.boot.active).toBe(true); expect(f.beforeActivate).toHaveBeenCalledTimes(1);
    const [factory, queue] = f.install.mock.calls[0]!;
    expect(isCloudBootAgentExecutionFactory(factory)).toBe(true);
    expect(queue.durability()).toEqual({ journalMode: "wal", synchronous: "full" });
    expect(f.boot.metadata).toMatchObject({ bootId: f.f.scope.bootId, writerEpoch: f.f.scope.writerEpoch });
    expect(f.boot.metadata).not.toHaveProperty("providers");
  });
  it("refuses a mismatched source boot before cutover", async () => {
    const f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => operation === "bootstrap"
      ? { ...f.f.response, bootId: randomUUID() } : original(operation, input));
    await expect(f.boot.initialize()).rejects.toMatchObject({ code: "cloud_admission_authority_response_invalid" });
    expect(f.install).not.toHaveBeenCalled(); expect(f.boot.active).toBe(false);
  });
  it("confirms the actual admitted actor and warms the original context off Send; selection performs no CP request", async () => {
    const f = await fixture(); await f.boot.initialize();
    await f.boot.confirmAdmission(f.admission);
    await f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    const payload = { agentId: "cursor" as const, model: f.f.input.model, permissionMode: "auto" as const,
      modeRevision: 0, userMessageId: randomUUID(), prompt: [{ type: "text" as const, text: "Synthetic prompt" }] };
    const commandId = randomUUID();
    f.boot.queue.handle({ kind: "mutate", mutation: { conversationId: f.f.input.conversationId, operationId: commandId,
      expectedRevision: 0, action: { kind: "enqueue", commandId, payload } }, admissionError: null },
      { writerEpoch: f.f.scope.writerEpoch, actorSessionId: f.admission.actor.sessionId });
    const claim = f.boot.queue.handle({ kind: "claim", conversationId: f.f.input.conversationId,
      executionId: randomUUID(), claimId: randomUUID() }, { writerEpoch: f.f.scope.writerEpoch });
    f.request.mockClear();
    const selection = f.boot.selectClaim(claim);
    expect(isCloudBootAgentSelection(selection)).toBe(true);
    expect(selection.actor.provenance.actorSessionId).toBe(f.admission.actor.sessionId);
    expect(f.request).not.toHaveBeenCalled(); expect(f.f.legacy.prepare).not.toHaveBeenCalled();
  });
  it("does not turn repeated conversation reads into per-Send context validation", async () => {
    const f = await fixture(); await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
    await f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    f.request.mockClear();
    await f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("parks a cold context but dispatches a ready context without awaiting its background renewal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), original = f.request.getMockImplementation()!, contextRequest = f.f.contextRequest.getMockImplementation()!;
    let response: Awaited<ReturnType<typeof contextRequest>> | null = null;
    f.f.contextRequest.mockImplementation(async input => {
      response ??= await contextRequest(input);
      return { ...response, actor: { ...response.actor, confirmedUntilMs: Date.now() + 8_000 } };
    });
    f.request.mockImplementation(async (operation, input) => {
      if (operation === "warm-context") await new Promise<void>(resolve => setTimeout(resolve, 100));
      return original(operation, input);
    });
    await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
    const warming = f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    await vi.waitFor(() => expect(f.request.mock.calls.some(([operation]) => operation === "warm-context")).toBe(true));
    const commandId = randomUUID(), payload = { agentId: "cursor" as const, model: f.f.input.model,
      permissionMode: "auto" as const, modeRevision: 0, userMessageId: randomUUID(), prompt: [{ type: "text" as const, text: "Synthetic prompt" }] };
    const queue = f.boot.queue;
    queue.handle({ kind: "mutate", mutation: { conversationId: f.f.input.conversationId, operationId: commandId,
      expectedRevision: 0, action: { kind: "enqueue", commandId, payload } }, admissionError: null },
      { writerEpoch: f.f.scope.writerEpoch, actorSessionId: f.admission.actor.sessionId });
    const claimRequest = () => ({ kind: "claim" as const, conversationId: f.f.input.conversationId,
      executionId: randomUUID(), claimId: randomUUID() });
    expect(queue.handle(claimRequest(), { writerEpoch: f.f.scope.writerEpoch })).toBeNull();
    await vi.advanceTimersByTimeAsync(100); await warming;
    f.request.mockClear(); await vi.advanceTimersByTimeAsync(4_000);
    // Repository MCP reads precede the HTTP boundary even under fake timers.
    await vi.waitFor(() => expect(f.request.mock.calls.filter(([operation]) => operation === "warm-context")).toHaveLength(1),
      { timeout: 100, interval: 5 });
    let renewed = false;
    const renewal = f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId).then(() => { renewed = true; });
    const count = f.request.mock.calls.length;
    const claim = queue.handle(claimRequest(), { writerEpoch: f.f.scope.writerEpoch });
    expect(claim).toMatchObject({ commandId });
    const selection = f.boot.selectClaim(claim);
    expect(isCloudBootAgentSelection(selection)).toBe(true); expect(renewed).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(100); await renewal;
  });
  it("pins the original credential selection in the FULL claim and releases an unused capture exactly", async () => {
    const f = await fixture(); await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
    await f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    const commandId = randomUUID();
    const payload = { agentId: "cursor" as const, model: f.f.input.model, permissionMode: "auto" as const,
      modeRevision: 0, userMessageId: randomUUID(), prompt: [{ type: "text" as const, text: "Synthetic" }] };
    f.boot.queue.handle({ kind: "mutate", mutation: { conversationId: f.f.input.conversationId, operationId: commandId,
      expectedRevision: 0, action: { kind: "enqueue", commandId, payload } }, admissionError: null },
      { writerEpoch: f.f.scope.writerEpoch, actorSessionId: f.admission.actor.sessionId });
    const claim = f.boot.queue.handle({ kind: "claim", conversationId: f.f.input.conversationId,
      executionId: randomUUID(), claimId: randomUUID() }, { writerEpoch: f.f.scope.writerEpoch }) as Parameters<typeof f.boot.releaseClaim>[0];
    const run = f.boot.queue.peekMirrorBatch()!.changes.at(-1)!.credentialRun;
    expect(run).toMatchObject({ bootId: f.f.scope.bootId, provider: "cursor" });
    const selectors = [{ provider: "cursor" as const, credentialId: run!.credentialId }];
    expect(f.boot.executionFactory.bootScopeActivity(selectors)).toMatchObject({ reservedLaunches: 1,
      scopes: [expect.objectContaining({ credentialRun: run, executionId: claim.executionId })] });
    await f.boot.releaseClaim(claim);
    expect(f.boot.executionFactory.bootScopeActivity(selectors).scopes).toEqual([]);
    expect(() => f.boot.selectClaim(claim)).toThrow();
  });
  it("keeps a paused source queued before any durable dispatch marker", async () => {
    const f = await fixture(); await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
    await f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    const provider = f.f.response.providers.find(value => value.status === "ready")!;
    if (provider.status !== "ready") throw new Error("Fixture provider missing");
    await f.boot.fences.handle({ ...f.f.scope, version: 1, mutationId: randomUUID(), controlRequestId: randomUUID(),
      fenceEpoch: 1, operation: "pause-starts", desiredCacheRevision: null, selectors: [{ provider: provider.provider, credentialId: provider.credentialId }] });
    const commandId = randomUUID(), payload = { agentId: "cursor", model: f.f.input.model, modeRevision: 0,
      userMessageId: randomUUID(), prompt: [{ type: "text", text: "Synthetic" }] };
    f.boot.queue.handle({ kind: "mutate", mutation: { conversationId: f.f.input.conversationId, operationId: commandId,
      expectedRevision: 0, action: { kind: "enqueue", commandId, payload } }, admissionError: null },
      { writerEpoch: f.f.scope.writerEpoch, actorSessionId: f.admission.actor.sessionId });
    expect(f.boot.queue.handle({ kind: "claim", conversationId: f.f.input.conversationId,
      executionId: randomUUID(), claimId: randomUUID() }, { writerEpoch: f.f.scope.writerEpoch })).toBeNull();
  });
  it("exposes activated metadata only for a positively confirmed current actor", async () => {
    const f = await fixture(); await f.boot.initialize();
    expect(() => f.boot.metadataFor(f.admission.actor.sessionId)).toThrow("cloud_actor_authority_rejected");
    await f.boot.confirmAdmission(f.admission);
    expect(f.boot.metadataFor(f.admission.actor.sessionId)).toMatchObject({ bootId: f.f.scope.bootId, writerEpoch: f.f.scope.writerEpoch });
    expect(() => f.boot.metadataFor(randomUUID())).toThrow("cloud_actor_authority_rejected");
    f.retire(); expect(() => f.boot.metadataFor(f.admission.actor.sessionId)).toThrow();
  });
  it("renews context proof at its own shorter deadline rather than the actor-only deadline", async () => {
    vi.useFakeTimers(); const f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => {
      const value = await original(operation, input);
      return operation === "warm-context" ? { ...value, actor: { ...f.f.provenance, confirmedUntilMs: Date.now() + 1_000 } } : value;
    });
    await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
    await f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    f.request.mockClear(); await vi.advanceTimersByTimeAsync(600);
    // Repository configuration uses real asynchronous file reads even under
    // fake timers; let the scheduled renewal reach its request boundary.
    await vi.waitFor(() => expect(f.request.mock.calls.some(([operation]) => operation === "warm-context")).toBe(true),
      { interval: 10, timeout: 100 });
  });
  it("does not install a foreign actor proof or advertise after engine authority retirement", async () => {
    const f = await fixture(); await f.boot.initialize();
    await expect(f.boot.confirmAdmission({ ...f.admission, accountUserId: randomUUID() }))
      .rejects.toMatchObject({ code: "cloud_actor_authority_rejected" });
    f.retire(); expect(f.boot.active).toBe(false);
    expect(() => f.boot.metadata).toThrow();
  });
});
