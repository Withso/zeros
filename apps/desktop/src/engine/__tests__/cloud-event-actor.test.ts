import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureControlPlane, type FixtureControlPlane } from "../../../../../scripts/cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/server";
import type { CloudCommandEngineRequest } from "@zeros/protocol/cloud-commands";
import { ZerosEngine } from "../zeros-engine";
import { CloudCommandRuntime } from "../cloud-command-runtime";
import { requestCloudCommand } from "../cloud-command-client";
import { closeZerosDb, setZerosDbPathForTesting } from "../db";
import { upsertChat } from "../db/chats";
import type { TransportClient } from "../transport/types";

const methods = ZerosEngine.prototype as unknown as {
  handleCloudEventOperation(this: unknown, params: Record<string, unknown>, client: TransportClient): Promise<unknown>;
  validateCloudCommand(this: unknown, conversationId: string): void;
};
let root: string, fixture: FixtureControlPlane | undefined, commands: CloudCommandRuntime | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-event-actor-"));
  setZerosDbPathForTesting(path.join(root, "state.db"));
  await mkdir(path.join(root, "workspace"));
});
afterEach(async () => {
  commands?.close(); commands = undefined;
  await fixture?.close(); fixture = undefined;
  closeZerosDb(); setZerosDbPathForTesting(null);
  await rm(root, { recursive: true, force: true });
});
async function setup() {
  let now = Date.now(), live = true;
  fixture = createFixtureControlPlane({ now: () => now });
  const cp = fixture;
  const attestation = { profile: "zeros-cloud-worker-v4" as const, manifestSha256: "a".repeat(64),
    runtimeId: `r1-${"a".repeat(64)}`, baseCompatibilityId: `bc1-${"b".repeat(64)}`,
    installerReceiptSha256: "c".repeat(64), bootId: randomUUID(), supervisorSessionId: randomUUID() };
  cp.configureRuntime(attestation);
  const { baseUrl } = await cp.start();
  const scope = { workspaceId: cp.identity.workspaceId, organizationId: cp.identity.organizationId,
    generation: cp.identity.generation, engineInstanceId: cp.identity.engineInstanceId };
  const post = (endpoint: string, body: unknown, token: string) => fetch(`${baseUrl}${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const registered = await post("/internal/v1/cloud-workspaces/engine/register", { ...scope,
    setupRunId: cp.identity.setupRunId, executionFence: cp.identity.executionFence, protocolVersion: cp.identity.protocolVersion,
    actorProtocolVersion: 2, agentCustomizationVersion: 3, agentRuntime: attestation }, cp.runtimeTokens.registrationToken);
  expect(registered.status).toBe(200); await registered.body?.cancel();
  const admitted = await post("/internal/v2/cloud-workspaces/engine/client-admission", { ...scope, grantToken: cp.actorGrantToken }, cp.authority().heartbeatToken);
  expect(admitted.status).toBe(200); await admitted.body?.cancel();
  const conversationId = randomUUID(), folder = path.join(root, "workspace");
  upsertChat({ id: conversationId, folder, agentId: "codex", agentName: "Codex", model: "test", effort: "low", permissionMode: "auto",
    lastModeId: null, prePlanModeId: null, fast: false, additionalDirectories: [], title: "test", createdAt: 1, updatedAt: 1,
    sessionId: null, providerBinding: null, providerMetadata: null, pinned: false, archived: false, sourceChatId: null, kind: "chat" });
  const request = vi.fn((input: CloudCommandEngineRequest, actorSessionId?: string) => requestCloudCommand(cp.authority(), input, new AbortController().signal, fetch, actorSessionId));
  commands = new CloudCommandRuntime({ request, validate: () => {}, execution: () => null,
    dispatch: async () => ({ state: "succeeded", resultCode: null }), cancel: async () => {}, changed: () => {} });
  commands.pauseClaims();
  const client: TransportClient = { id: randomUUID(), kind: "cloud", accountUserId: cp.actor.userId, authorityEpoch: 1,
    cloudActor: { sessionId: cp.actor.sessionId, deviceId: cp.actor.deviceId, role: cp.actor.role, fingerprint: cp.actor.fingerprint },
    authorized: () => live, send: vi.fn(), close: vi.fn() };
  const capture = vi.fn((read: () => unknown) => ({ snapshot: read() }));
  const engine = { root: folder, cloudWorker: { version: 4 }, cloudCommands: commands,
    cloudEvents: { snapshot: capture, replay: vi.fn(async () => ({ replayed: true })) },
    validateCloudCommand: methods.validateCloudCommand, workspace: { workspaceIdForCwd: () => "local-main" },
    conversationExecution: new Map(), activePromptContexts: new Map(), sessionLoadResponses: new Map(),
    pendingPermissionRequests: new Map(), pendingQuestionRequests: new Map(), agents: {} };
  return { cp, request, client, engine, capture, conversationId,
    advance: (milliseconds: number) => { now += milliseconds; }, revokeTransport: () => { live = false; } };
}
describe("cloud event snapshot authenticated actor", () => {
  it("forwards the transport actor through the real command runtime and actor-required fixture CP", async () => {
    const f = await setup();
    await expect(methods.handleCloudEventOperation.call(f.engine, { request: { kind: "snapshot", conversationId: f.conversationId } }, f.client))
      .resolves.toMatchObject({ snapshot: { conversationId: f.conversationId, executionId: null, messages: [], activeTurn: null } });
    expect(f.request).toHaveBeenCalledExactlyOnceWith({ kind: "snapshot", conversationId: f.conversationId }, f.cp.actor.sessionId);
    expect(f.cp.inspect().requests.at(-1)).toMatchObject({ path: "/internal/v1/cloud-workspaces/engine/commands", status: 200 });
  });
  it.each(["missing", "foreign", "revoked", "stale", "transport"])("refuses a %s actor without capturing transcript or controls", async cause => {
    const f = await setup();
    let client = f.client;
    if (cause === "missing") client = { ...client, cloudActor: undefined };
    if (cause === "foreign") client = { ...client, cloudActor: { ...client.cloudActor!, sessionId: randomUUID() } };
    if (cause === "revoked") f.cp.revokeActor();
    if (cause === "stale") f.advance(30_001);
    if (cause === "transport") f.revokeTransport();
    await expect(methods.handleCloudEventOperation.call(f.engine, { request: { kind: "snapshot", conversationId: f.conversationId } }, client))
      .rejects.toMatchObject({ code: "cloud_actor_authority_rejected" });
    expect(f.capture).not.toHaveBeenCalled();
    if (cause === "missing" || cause === "transport") expect(f.request).not.toHaveBeenCalled();
  });
  it("rechecks transport authority after the nested CP read before capturing the snapshot", async () => {
    const f = await setup(), request = f.request.getMockImplementation()!;
    f.request.mockImplementationOnce(async (input, actorSessionId) => {
      const snapshot = await request(input, actorSessionId);
      f.revokeTransport(); return snapshot;
    });
    await expect(methods.handleCloudEventOperation.call(f.engine, { request: { kind: "snapshot", conversationId: f.conversationId } }, f.client))
      .rejects.toMatchObject({ code: "cloud_actor_authority_rejected" });
    expect(f.capture).not.toHaveBeenCalled();
  });
  it("retains authenticated replay without a queue read and rejects missing replay authority", async () => {
    const f = await setup(), params = { request: { kind: "replay", cursor: { streamId: f.cp.identity.engineInstanceId, sequence: 0 } } };
    await expect(methods.handleCloudEventOperation.call(f.engine, params, f.client)).resolves.toEqual({ replayed: true });
    await expect(methods.handleCloudEventOperation.call(f.engine, params, { ...f.client, cloudActor: undefined })).rejects.toMatchObject({ code: "cloud_actor_authority_rejected" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("rejects authority lost during replay and never accepts actor identity from request parameters", async () => {
    const f = await setup();
    await expect(methods.handleCloudEventOperation.call(f.engine, { actorSessionId: f.cp.actor.sessionId,
      request: { kind: "snapshot", conversationId: f.conversationId } }, f.client)).rejects.toMatchObject({ code: "invalid_event" });
    f.engine.cloudEvents.replay.mockImplementationOnce(async () => { f.revokeTransport(); return { replayed: true }; });
    await expect(methods.handleCloudEventOperation.call(f.engine, { request: { kind: "replay", cursor: {
      streamId: f.cp.identity.engineInstanceId, sequence: 0 } } }, f.client)).rejects.toMatchObject({ code: "cloud_actor_authority_rejected" });
    expect(f.request).not.toHaveBeenCalled();
  });
});
