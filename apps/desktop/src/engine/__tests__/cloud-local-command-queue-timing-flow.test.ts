import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudCommandClaim, CloudCommandClientRequest, CloudCommandSnapshot, CloudCommandResult } from "@zeros/protocol/cloud-commands";
import { createMessage } from "@zeros/protocol/messages";
import { CloudAgentTurnTimings } from "../cloud-local-command-queue-timings";
import { ZerosEngine } from "../zeros-engine";
import { closeZerosDb, setZerosDbPathForTesting } from "../db";
import { upsertChat } from "../db/chats";
import type { TransportClient } from "../transport/types";

const methods = ZerosEngine.prototype as unknown as {
  handleCloudCommandOperation(this: unknown, op: string, params: Record<string, unknown>, client: TransportClient): Promise<unknown>;
  prepareCloudCommand(this: unknown, claim: CloudCommandClaim): Promise<void>;
  dispatchCloudCommand(this: unknown, claim: CloudCommandClaim): Promise<Pick<CloudCommandResult, "state" | "resultCode" | "result">>;
  validateCloudCommand(this: unknown, conversationId: string): void;
  publishCloudCommandFailure(this: unknown, claim: CloudCommandClaim, code: string): unknown;
  observeCloudCommandSettlement(this: unknown, observed: {commandId: string; claimId: string; conversationId: string;
    executionId: string; turnId: string; provider: string}): void;
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-turn-flow-"));
  setZerosDbPathForTesting(path.join(root, "state.db"));
  await mkdir(path.join(root, "workspace"));
});
afterEach(async () => { closeZerosDb(); setZerosDbPathForTesting(null); await rm(root, { recursive: true, force: true }); });
function fixture() {
  const folder = path.join(root, "workspace"), conversationId = randomUUID();
  upsertChat({ id: conversationId, folder, agentId: "codex", agentName: "Codex", model: "test", effort: "high", permissionMode: "auto",
    lastModeId: null, prePlanModeId: null, fast: false, additionalDirectories: [], title: "test", createdAt: 1, updatedAt: 1,
    sessionId: null, providerBinding: null, providerMetadata: null, pinned: false, archived: false, sourceChatId: null, kind: "chat" });
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2, engineInstanceId: randomUUID() };
  const timings = new CloudAgentTurnTimings({ scope, mode: "legacy", now: () => 100 });
  const claim: CloudCommandClaim = { commandId: randomUUID(), claimId: randomUUID(), conversationId, executionId: randomUUID(),
    payload: { agentId: "codex", model: "test", userMessageId: randomUUID(), modeRevision: 0, prompt: [{ type: "text", text: "synthetic" }] } };
  const request: CloudCommandClientRequest = { kind: "mutate", mutation: { conversationId, operationId: claim.commandId, expectedRevision: 0,
    action: { kind: "enqueue", commandId: claim.commandId, payload: claim.payload } } };
  const snapshot: CloudCommandSnapshot = { version: 1, conversationId, revision: 1, paused: false, pending: [{ commandId: claim.commandId,
    position: 1, state: "queued", payload: claim.payload, executionId: null, generation: 2, resultCode: null,
    createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" }], receipts: [] };
  const client: TransportClient = { id: "client", kind: "cloud", accountUserId: randomUUID(), authorityEpoch: 1,
    cloudActor: { sessionId: randomUUID(), deviceId: randomUUID(), role: "prompter", fingerprint: "a".repeat(64) },
    authorized: () => true, send: vi.fn(), close: vi.fn() };
  const engine = { root: folder, cloudCommands: { handle: vi.fn(async () => snapshot) }, cloudWorker: { version: 4 }, cloudAgentTurnTimings: timings,
    cloudRuntimeConfig: { execution: { organizationId: scope.organizationId, workspaceId: scope.workspaceId, generation: scope.generation },
      engine: { instanceId: scope.engineInstanceId } }, cloudRuntimeAuthorityStopping: false,
    workspace: { workspaceIdForCwd: () => "local-main" }, validateCloudCommand: methods.validateCloudCommand,
    cloudCommandSessions: new Map(), cloudTurnProtocols: new WeakMap(), cloudCommandAdmissions: new WeakMap() };
  const send = (peer = client, value: unknown = request) => methods.handleCloudCommandOperation.call(engine,
    "cloudCommands.request", { request: value, nativeCommandsVersion: 1, cloudTurnProtocolVersion: 1 }, peer);
  return { engine, timings, claim, client, request, snapshot, send, conversationId };
}

describe("current legacy engine timing producers", () => {
  it("records actual pre-prompt provider-start auth failure without inventing native dispatch", () => {
    const f = fixture();
    f.timings.receive({ commandId: f.claim.commandId, conversationId: f.conversationId,
      turnId: f.claim.payload.userMessageId, provider: "codex" });
    f.timings.bindClaim({ commandId: f.claim.commandId, conversationId: f.conversationId, turnId: f.claim.payload.userMessageId,
      executionId: f.claim.executionId, provider: "codex" });
    Object.assign(f.engine, { broadcast: vi.fn() });
    expect(methods.publishCloudCommandFailure.call(f.engine, f.claim, "cloud_provider_start_auth_required"))
      .toMatchObject({ failure: { kind: "auth-required", stage: "newSession" } });
    expect(f.timings.sample(f.conversationId).records.map(row => row.stage))
      .toEqual(["engine_received", "dispatch_committed", "typed_auth_failure"]);
  });
  it("marks confirmed terminal ownership only for the original exact command and turn", () => {
    const f = fixture();
    f.timings.receive({ commandId: f.claim.commandId, conversationId: f.conversationId,
      turnId: f.claim.payload.userMessageId, provider: "codex" });
    f.timings.bindClaim({ commandId: f.claim.commandId, conversationId: f.conversationId, turnId: f.claim.payload.userMessageId,
      executionId: f.claim.executionId, provider: "codex" });
    const owned = { commandId: f.claim.commandId, claimId: f.claim.claimId, conversationId: f.conversationId,
      executionId: f.claim.executionId, turnId: f.claim.payload.userMessageId, provider: "codex" };
    methods.observeCloudCommandSettlement.call(f.engine, { ...owned, turnId: "foreign" });
    methods.observeCloudCommandSettlement.call({ ...f.engine, cloudWorker: null }, owned);
    expect(f.timings.sample(f.conversationId).records).toHaveLength(2);
    methods.observeCloudCommandSettlement.call(f.engine, owned);
    expect(f.timings.sample(f.conversationId).records.at(-1)).toMatchObject({ stage: "terminal_committed", commandId: f.claim.commandId });
  });
  it("records authenticated engine receipt before CP await and accepted only after the exact queue acknowledgement", async () => {
    const f = fixture();
    f.engine.cloudCommands.handle.mockImplementation(async () => {
      expect(f.timings.sample(f.conversationId).records).toMatchObject([{ stage: "engine_received", commandId: f.claim.commandId,
        turnId: f.claim.payload.userMessageId, executionId: null }]);
      return f.snapshot;
    });
    expect(await f.send()).toEqual(f.snapshot);
    expect(f.timings.sample(f.conversationId).records.map(row => row.stage)).toEqual(["engine_received", "accepted"]);
  });
  it("retains receipt without pretending a failed CP enqueue was accepted", async () => {
    const f = fixture(); f.engine.cloudCommands.handle.mockRejectedValue(new Error("synthetic transport failure"));
    await expect(f.send()).rejects.toThrow("synthetic transport failure");
    expect(f.timings.sample(f.conversationId).records.map(row => row.stage)).toEqual(["engine_received"]);
  });
  it.each(["Personal", "organization"])("never installs cloud turn observations from a %s Local client", async placement => {
    const f = fixture(); await f.send({ ...f.client, kind: "local", ...(placement === "Personal" ? { accountUserId: null } : {}) });
    expect(f.timings.sample(f.conversationId).records).toEqual([]);
  });
  it("does not label snapshots or revoked actor traffic as Send", async () => {
    const f = fixture();
    await f.send(f.client, { kind: "snapshot", conversationId: f.conversationId });
    await f.send({ ...f.client, authorized: () => false });
    expect(f.timings.sample(f.conversationId).records).toEqual([]);
  });
  it("does not call an unrelated or contradictory returned command an accepted turn", async () => {
    const f = fixture(); f.engine.cloudCommands.handle.mockResolvedValue({ ...f.snapshot,
      pending: [{ ...f.snapshot.pending[0]!, commandId: randomUUID() }] });
    await f.send();
    expect(f.timings.sample(f.conversationId).records.map(row => row.stage)).toEqual(["engine_received"]);
  });
  it("binds only the actual durable claim identity even when provider admission subsequently refuses it", async () => {
    const f = fixture(); f.timings.receive({ commandId: f.claim.commandId, conversationId: f.conversationId,
      turnId: f.claim.payload.userMessageId, provider: "codex" });
    await expect(methods.prepareCloudCommand.call(f.engine, { ...f.claim, dispatchAllowed: false }))
      .rejects.toMatchObject({ code: "cloud_actor_authority_rejected" });
    expect(f.timings.sample(f.conversationId).records.map(row => row.stage)).toEqual(["engine_received", "dispatch_committed"]);
    expect(f.timings.sample(f.conversationId).records.every(row => row.executionId === f.claim.executionId)).toBe(true);
  });
  it.each(["auth-required", "protocol-error"] as const)("records %s terminal classification without synthesizing native output or acceptance", async kind => {
    const f = fixture();
    f.timings.receive({ commandId: f.claim.commandId, conversationId: f.conversationId, turnId: f.claim.payload.userMessageId, provider: "codex" });
    f.timings.bindClaim({ commandId: f.claim.commandId, conversationId: f.conversationId, turnId: f.claim.payload.userMessageId,
      executionId: f.claim.executionId, provider: "codex" });
    f.engine.cloudCommandSessions.set(f.claim.commandId, { claim: f.claim, controller: new AbortController() });
    const engine = Object.assign(f.engine, {
      agents: { cloudNativeCapabilities: () => undefined }, cloudGoals: { flush: async () => undefined }, broadcast: vi.fn(),
      handleAgentMessage: async (_message: unknown, receiver: TransportClient) => {
        const failed = createMessage({ type: "AGENT_PROMPT_FAILED", source: "engine", requestId: f.claim.commandId,
          agentId: "codex", sessionId: f.claim.executionId, executionId: f.claim.executionId,
          error: "Synthetic native failure", failure: { kind, stage: "prompt", agentId: "codex", message: "Synthetic native failure" } });
        receiver.send({ ...failed, requestId: randomUUID() });
        receiver.send(failed);
      },
    });
    expect((await methods.dispatchCloudCommand.call(engine, f.claim)).state).toBe("failed");
    const rows = f.timings.sample(f.conversationId).records;
    expect(rows.filter(row => row.stage === "typed_auth_failure")).toHaveLength(kind === "auth-required" ? 1 : 0);
    expect(rows.some(row => row.stage === "first_delta" || row.stage === "native_acceptance_ack")).toBe(false);
  });
});
