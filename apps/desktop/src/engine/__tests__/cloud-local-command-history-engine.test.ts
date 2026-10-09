import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
import { ZerosEngine } from "../zeros-engine";
import * as checkpoint from "../cloud-local-command-queue-checkpoint";
import * as rebuild from "../cloud-local-command-queue-history-rebuild";
import { openSqlite } from "../db/sqlite";
import { closeZerosDb, setZerosDbPathForTesting } from "../db";
import { headRev } from "../db/sync";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { WorkspaceService } from "../workspace/service";
import { closeState, setStateRootForTesting } from "../git";
import type { TransportClient } from "../transport/types";
import { createMessage, type EngineMessage } from "../types";
import type { CloudLocalCommandHistoryHead } from "@zeros/protocol/cloud-local-mirror";

const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2, engineInstanceId: randomUUID(),
  bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
const head: CloudLocalCommandHistoryHead = { originWriterEpoch: scope.writerEpoch,
  source: { kind: "mutation", mutationId: randomUUID(), operation: "prune" }, deleted: false,
  history: { restoreRevision: 9, recordSequence: 10, eventSequence: 11, incompleteReason: "capture_unavailable" } };
const methods = ZerosEngine.prototype as unknown as {
  restoreCloudLocalHistory(this: unknown): Promise<void>;
  cloudHistoryRestoreMetadata(this: unknown, conversations: readonly string[]): Record<string, unknown> | undefined;
  cloudHistoryReadResult(this: unknown, op: string, params: Record<string, unknown>, result: unknown): unknown;
  publishCloudHistoryMutation(this: unknown, queue: CloudLocalCommandQueue, operationId: string, op: string,
    params: Record<string, unknown>, result: unknown): void;
  handleWorkspaceMessage(this: unknown, message: Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>, client: TransportClient, admitted?: boolean): Promise<void>;
};
let directory: string | undefined;
const mutationQueues: CloudLocalCommandQueue[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const queue of mutationQueues.splice(0)) queue.close();
  closeState(); setStateRootForTesting(null); closeZerosDb(); setZerosDbPathForTesting(null);
  if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

describe("current local-writer history exposure", () => {
  it("requires authenticated source selection before any checkpoint install or NORMAL rebuild", async () => {
    const restore = vi.spyOn(checkpoint, "restoreCloudLocalCommandCheckpointLedger"), project = vi.spyOn(rebuild, "rebuildCloudLocalCommandHistory");
    const state = { cloudRecordRuntime: { usesLocalAgentJournal: true }, cloudWorker: {},
      cloudRuntimeConfig: { execution: scope }, cloudRuntimeRegistration: { agentSourceWriterEpoch: null } };
    await expect(methods.restoreCloudLocalHistory.call(state)).rejects.toThrow("engine_authority_rejected");
    expect(restore).not.toHaveBeenCalled(); expect(project).not.toHaveBeenCalled();
  });
  it("retains every exact restored fence before boot exposure and does not publish a partial rebuild", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "zeros-history-exposure-"));
    setZerosDbPathForTesting(path.join(directory, "normal.sqlite"));
    const file = path.join(directory, "source.sqlite"), ledger = openSqlite(file);
    ledger.exec("CREATE TABLE local_command_history_heads(conversation_id TEXT); INSERT INTO local_command_history_heads VALUES('chat'),('sibling')"); ledger.close();
    const cleanup = vi.fn(async () => {}), source = { manifest: { seal: { scope } }, ledgerFile: file, normalFile: "unused", cleanup };
    const restore = vi.spyOn(checkpoint, "restoreCloudLocalCommandCheckpointLedger").mockResolvedValue(source as unknown as Awaited<ReturnType<typeof checkpoint.restoreCloudLocalCommandCheckpointLedger>>);
    const project = vi.spyOn(rebuild, "rebuildCloudLocalCommandHistory").mockImplementation(input => ({ conversationId: input.conversationId, historyHead: head, restored: false }));
    const state = { root: directory, cloudLocalHistoryRestored: false, cloudLocalHistoryRestoreHeads: new Map(),
      cloudRecordRuntime: { usesLocalAgentJournal: true }, cloudWorker: {}, cloudRuntimeConfig: { execution: scope },
      cloudRuntimeRegistration: { agentSourceWriterEpoch: scope.writerEpoch } };
    project.mockImplementationOnce(input => ({ conversationId: input.conversationId, historyHead: head, restored: false }))
      .mockImplementationOnce(() => { throw new Error("invalid lineage"); });
    await expect(methods.restoreCloudLocalHistory.call(state)).rejects.toThrow("invalid lineage");
    expect(state.cloudLocalHistoryRestoreHeads.size).toBe(0); expect(state.cloudLocalHistoryRestored).toBe(false);
    await methods.restoreCloudLocalHistory.call(state);
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ expectedWriterEpoch: scope.writerEpoch }));
    expect(state.cloudLocalHistoryRestoreHeads).toEqual(new Map([["chat", head], ["sibling", head]]));
    expect(state.cloudLocalHistoryRestored).toBe(true); expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it("publishes current FULL heads with exact boot scope and separate confirmed mirror cursor", () => {
    const latest = { ...head, history: { ...head.history, restoreRevision: 10 } };
    const state = { cloudWorker: {}, cloudAgentBoot: { active: true, queue: { scope, mirroredSequence: 23,
      currentHistoryHead: (id: string) => id === "chat" ? latest : null } }, cloudLocalHistoryRestoreHeads: new Map([["chat", head]]) };
    const result = methods.cloudHistoryRestoreMetadata.call(state, ["chat", "chat", "missing"]);
    expect(result).toEqual({ projection: { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
      mirroredSequence: 23, sealedSequence: null, complete: false }, historyHeads: [{ conversationId: "chat", originWriterEpoch: latest.originWriterEpoch,
        source: latest.source, restoreRevision: 10, deleted: false, recordSequence: 10, eventSequence: 11,
        manifestSha256: null, incompleteReason: "capture_unavailable" }] });
  });
  it("keeps Local and legacy reads exact and includes deletion heads in the live catalog", () => {
    const raw = { chats: [], chatDeletions: ["chat"] }, metadata = { projection: "verified", historyHeads: ["exact"] };
    const state = { cloudHistoryRestoreMetadata: vi.fn(() => metadata) };
    expect(methods.cloudHistoryReadResult.call(state, "chats.list", {}, raw)).toEqual({ ...raw, ...metadata });
    expect(state.cloudHistoryRestoreMetadata).toHaveBeenCalledWith(["chat"]);
    state.cloudHistoryRestoreMetadata.mockReturnValue(undefined as unknown as typeof metadata);
    expect(methods.cloudHistoryReadResult.call(state, "messages.window", { chatId: "chat" }, raw)).toBe(raw);
    expect(methods.cloudHistoryReadResult.call(state, "git.diff", {}, raw)).toBe(raw);
  });
  it.each([
    ["messages.clear", { chatId: "chat" }, {}, "prune", false],
    ["messages.truncateFrom", { chatId: "chat" }, {}, "prune", false],
    ["turns.reset", { chatId: "chat" }, {}, "prune", false],
    ["turns.undoReset", {}, { chatId: "chat", transcriptRestored: true }, "repair", false],
    ["messages.import", { chatId: "chat" }, {}, "repair", false],
    ["chats.upsert", { chat: { id: "chat" } }, {}, "edit", false],
    ["chats.delete", { id: "chat" }, {}, "delete", true],
  ] as const)("publishes the accepted %s mutation with exact current watermarks before acknowledgment", async (op, params, result, operation, deleted) => {
    directory = await mkdtemp(path.join(os.tmpdir(), "zeros-history-mutation-")); setZerosDbPathForTesting(path.join(directory, "normal.sqlite"));
    const publishHistoryMutation = vi.fn(() => head), queue = { publishHistoryMutation, scope } as unknown as CloudLocalCommandQueue;
    const state = { cloudWorker: {}, cloudAgentBoot: { active: true, authorityActive: true, scope, queue }, cloudLocalEvents: { head: 17 },
      cloudLocalHistoryRestoreHeads: new Map(), cloudLocalMirror: { notify: vi.fn() },
      cloudHistoryRestoreMetadata: vi.fn(() => undefined), broadcast: vi.fn(), handleCloudRuntimeAuthorityLoss: vi.fn() };
    const operationId = randomUUID();
    methods.publishCloudHistoryMutation.call(state, queue, operationId, op, params, result);
    expect(publishHistoryMutation).toHaveBeenCalledWith({ conversationId: "chat", mutationId: operationId, operation, deleted,
      recordSequence: headRev(), eventSequence: 17 });
    expect(state.cloudLocalHistoryRestoreHeads.get("chat")).toEqual(head); expect(state.cloudLocalMirror.notify).toHaveBeenCalledOnce();
  });
  it("does not fabricate mutation intent for failed repairs or unrelated operations", () => {
    const queue = { publishHistoryMutation: vi.fn() } as unknown as CloudLocalCommandQueue;
    const state = { cloudWorker: {}, cloudAgentBoot: { active: true, queue } };
    methods.publishCloudHistoryMutation.call(state, queue, randomUUID(), "turns.undoReset", {}, { chatId: "chat", transcriptRestored: false });
    methods.publishCloudHistoryMutation.call(state, queue, randomUUID(), "git.diff", {}, {});
    expect(queue.publishHistoryMutation).not.toHaveBeenCalled();
  });
  it("commits the FULL head after the actual workspace mutation and before its response", async () => {
    const order: string[] = [], queue = {};
    const state = { cloudWorker: { version: 3 }, cloudAgentBoot: { active: true, queue }, isHostRelayClient: () => false,
      workspace: { isWriteOp: () => false, lifecycleMutationWorkspaceId: () => null,
        handle: async () => { order.push("normal"); return { ok: true }; } },
      publishCloudHistoryMutation: vi.fn(() => { order.push("full"); }),
      router: { broadcast: vi.fn(), broadcastExcept: vi.fn() }, slowWorkspaceOperations: { observe: vi.fn() } };
    Object.setPrototypeOf(state, ZerosEngine.prototype);
    const client: TransportClient = { id: "actor", kind: "cloud", authorized: () => true,
      cloudActor: { sessionId: randomUUID(), deviceId: randomUUID(), fingerprint: "a".repeat(64), role: "developer" },
      send: value => { order.push(value.type); }, close: () => {} };
    const message = createMessage({ type: "WORKSPACE_REQUEST", source: "browser", op: "messages.clear", params: { chatId: "chat" } });
    await methods.handleWorkspaceMessage.call(state, message, client, true);
    expect(order).toEqual(["normal", "full", "WORKSPACE_RESPONSE"]);
    expect(state.publishCloudHistoryMutation).toHaveBeenCalledWith(queue, message.id, message.op, message.params, { ok: true });
  });
});

async function mutationFixture() {
  directory = await mkdtemp(path.join(os.tmpdir(), "zeros-history-consumer-"));
  setStateRootForTesting(path.join(directory, "state"));
  setZerosDbPathForTesting(path.join(directory, "normal.sqlite"));
  const events = { head: 17 }, engineLive = vi.fn(() => true);
  const actors = new CloudActorAuthorityRegistry({ scope, engineLive });
  const queueFile = path.join(directory, "queue.sqlite");
  const queue = new CloudLocalCommandQueue({ file: queueFile, scope, actors, engineLive,
    ready: () => true, history: () => ({ recordSequence: headRev(), eventSequence: events.head }) });
  mutationQueues.push(queue);
  const workspace = new WorkspaceService(directory), deliveries: EngineMessage[] = [];
  const state = { root: directory, cloudWorker: { version: 3 }, cloudAgentBoot: { active: true, authorityActive: true, scope, queue },
    cloudLocalEvents: events, cloudLocalHistoryRestoreHeads: new Map<string, CloudLocalCommandHistoryHead>(),
    cloudLocalMirror: { notify: vi.fn() }, cloudWorkspaceMutations: new Set<Promise<void>>(), cloudWorkspaceIdleMaintenance: new Set<Promise<void>>(),
    cloudHistoryRestoreMetadata: vi.fn(() => undefined), broadcast: vi.fn(), handleCloudRuntimeAuthorityLoss: vi.fn(),
    reportEngineError: vi.fn(), isHostRelayClient: () => false, workspace,
    router: { broadcast: vi.fn(), broadcastExcept: vi.fn() }, slowWorkspaceOperations: { observe: vi.fn() } };
  Object.setPrototypeOf(state, ZerosEngine.prototype);
  const client: TransportClient = { id: "mutation-actor", kind: "cloud", authorized: () => true,
    cloudActor: { sessionId: randomUUID(), deviceId: randomUUID(), fingerprint: "b".repeat(64), role: "developer" },
    send: message => { deliveries.push(message); }, close: () => {} };
  const request = async (op: string, params: Record<string, unknown>, id: string = randomUUID()) => {
    const message = createMessage({ type: "WORKSPACE_REQUEST", source: "browser", op, params }); message.id = id;
    await methods.handleWorkspaceMessage.call(state, message, client);
    return message;
  };
  const seed = async () => {
    await workspace.handle("chats.bulkUpsert", { chats: [{ id: "chat", folder: directory }, { id: "sibling", folder: directory }] });
    for (const chatId of ["chat", "sibling"]) await workspace.handle("messages.import", { chatId,
      messages: [{ msgId: `${chatId}-message`, kind: "text", payload: JSON.stringify({ text: `${chatId} retained` }), createdAt: 1 }] });
  };
  return { state, workspace, queue, queueFile, events, client, deliveries, request, seed };
}

describe("accepted NORMAL mutations enter the original FULL history ledger", () => {
  it("commits a real clear and its exact incomplete head before success without touching the sibling", async () => {
    const f = await mutationFixture(); await f.seed();
    const publish = vi.spyOn(f.queue, "publishHistoryMutation"), originalSend = f.client.send;
    f.client.send = message => {
      if (message.type === "WORKSPACE_RESPONSE") expect(f.queue.currentHistoryHead("chat")).toMatchObject({
        history: { recordSequence: headRev(), eventSequence: 17, incompleteReason: "capture_unavailable" } });
      originalSend(message);
    };
    const message = await f.request("messages.clear", { chatId: "chat" });
    expect(f.deliveries).toEqual([expect.objectContaining({ type: "WORKSPACE_RESPONSE", requestId: message.id, result: { cleared: 1 } })]);
    expect(publish).toHaveBeenCalledWith({ conversationId: "chat", mutationId: message.id, operation: "prune", deleted: false,
      recordSequence: headRev(), eventSequence: 17 });
    expect(await f.workspace.handle("messages.window", { chatId: "chat" })).toEqual({ messages: [] });
    expect(await f.workspace.handle("messages.window", { chatId: "sibling" })).toMatchObject({ messages: [expect.objectContaining({ msgId: "sibling-message" })] });
    expect(f.queue.currentHistoryHead("sibling")).toBeNull();
    expect(f.queue.peekMirrorBatch()!.changes).toEqual([expect.objectContaining({ conversationId: "chat", historyHead: f.queue.currentHistoryHead("chat") })]);
    expect(f.state.cloudWorkspaceMutations.size).toBe(0);
  });
  it("returns only WORKSPACE_ERROR after NORMAL commits but FULL publication rolls back", async () => {
    const f = await mutationFixture(); await f.seed();
    const db = openSqlite(f.queueFile);
    try { db.exec("CREATE TRIGGER reject_engine_mutation BEFORE INSERT ON local_command_outbox_jobs BEGIN SELECT RAISE(ABORT,'synthetic storage refusal'); END"); }
    finally { db.close(); }
    const message = await f.request("messages.clear", { chatId: "chat" });
    expect(await f.workspace.handle("messages.window", { chatId: "chat" })).toEqual({ messages: [] });
    expect(f.deliveries).toEqual([expect.objectContaining({ type: "WORKSPACE_ERROR", requestId: message.id, code: "command_storage_unavailable" })]);
    expect(f.queue.currentHistoryHead("chat")).toBeNull(); expect(f.queue.mirrorDrained()).toBe(true);
    expect(f.state.broadcast).not.toHaveBeenCalled(); expect(f.state.router.broadcastExcept).not.toHaveBeenCalled();
    expect(f.state.handleCloudRuntimeAuthorityLoss).toHaveBeenCalledOnce(); expect(f.state.cloudLocalMirror.notify).not.toHaveBeenCalled();
    expect(f.state.cloudWorkspaceMutations.size).toBe(0);
  });
  it("does not publish or retire authority when the NORMAL producer rejects the request", async () => {
    const f = await mutationFixture(); await f.seed(); const publish = vi.spyOn(f.queue, "publishHistoryMutation");
    await f.request("chats.setComposerMode", { chatId: "chat", folder: "foreign-checkout", mode: "code" });
    expect(f.deliveries).toEqual([expect.objectContaining({ type: "WORKSPACE_ERROR" })]);
    expect(publish).not.toHaveBeenCalled(); expect(f.queue.currentHistoryHead("chat")).toBeNull();
    expect(f.state.handleCloudRuntimeAuthorityLoss).not.toHaveBeenCalled();
  });
  it.each(["Personal Local", "organization-local", "legacy cloud"])("preserves the existing %s path without FULL publication", async placement => {
    const f = await mutationFixture(); await f.seed();
    if (placement !== "legacy cloud") Reflect.set(f.state, "cloudWorker", undefined);
    Reflect.set(f.state, "cloudAgentBoot", undefined); if (placement !== "legacy cloud") Reflect.set(f.client, "cloudActor", undefined);
    const publish = vi.spyOn(f.queue, "publishHistoryMutation");
    await f.request("messages.clear", { chatId: "chat" });
    expect(f.deliveries).toEqual([expect.objectContaining({ type: "WORKSPACE_RESPONSE", result: { cleared: 1 } })]);
    expect(publish).not.toHaveBeenCalled(); expect(f.queue.currentHistoryHead("chat")).toBeNull();
  });
  it("does not select a cloud ledger on Local even when a stale cloud boot reference remains", async () => {
    const f = await mutationFixture(); await f.seed();
    Reflect.set(f.state, "cloudWorker", undefined); Reflect.set(f.client, "cloudActor", undefined);
    const publish = vi.spyOn(f.queue, "publishHistoryMutation");
    await f.request("messages.clear", { chatId: "chat" });
    expect(f.deliveries).toEqual([expect.objectContaining({ type: "WORKSPACE_RESPONSE", result: { cleared: 1 } })]);
    expect(publish).not.toHaveBeenCalled(); expect(f.state.handleCloudRuntimeAuthorityLoss).not.toHaveBeenCalled();
  });
  it.each(["replaced", "inactive"] as const)("rejects an original %s boot after the NORMAL await instead of publishing through stale ownership", async state => {
    const f = await mutationFixture(); await f.seed();
    const handle = f.workspace.handle.bind(f.workspace);
    vi.spyOn(f.workspace, "handle").mockImplementation(async (...args) => {
      const result = await handle(...args);
      if (state === "inactive") f.state.cloudAgentBoot.active = false;
      else {
        const engineLive = () => true, actors = new CloudActorAuthorityRegistry({ scope, engineLive });
        const replacement = new CloudLocalCommandQueue({ file: path.join(directory!, "replacement.sqlite"), scope, actors, engineLive,
          ready: () => true, history: () => ({ recordSequence: headRev(), eventSequence: f.events.head }) });
        mutationQueues.push(replacement); f.state.cloudAgentBoot = { ...f.state.cloudAgentBoot, queue: replacement };
      }
      return result;
    });
    const publish = vi.spyOn(f.queue, "publishHistoryMutation"); await f.request("messages.clear", { chatId: "chat" });
    expect(f.deliveries).toEqual([expect.objectContaining({ type: "WORKSPACE_ERROR", code: "engine_authority_rejected" })]);
    expect(publish).not.toHaveBeenCalled(); expect(f.queue.currentHistoryHead("chat")).toBeNull();
    expect(f.state.handleCloudRuntimeAuthorityLoss).toHaveBeenCalledOnce();
  });
  it("keeps bulk per-chat identities immutable under reordering/duplicates and ignores rejected empty chat rows", async () => {
    const f = await mutationFixture(), operationId = randomUUID();
    const chats = [{ id: "chat", folder: directory }, { id: "sibling", folder: directory }, { id: "chat", folder: directory }, { id: "", folder: directory }, null];
    const publish = vi.spyOn(f.queue, "publishHistoryMutation");
    await f.request("chats.bulkUpsert", { chats }, operationId);
    expect(f.deliveries).toEqual([expect.objectContaining({ type: "WORKSPACE_RESPONSE", result: { ok: true } })]);
    expect(publish).toHaveBeenCalledTimes(2);
    const saved = [f.queue.currentHistoryHead("chat"), f.queue.currentHistoryHead("sibling")];
    expect(saved[0]!.source).toMatchObject({ kind: "mutation", operation: "edit" });
    expect(saved[0]!.source).not.toEqual(saved[1]!.source);
    expect(publish.mock.calls[0]![0].mutationId).not.toBe(operationId);
    methods.publishCloudHistoryMutation.call(f.state, f.queue, operationId, "chats.bulkUpsert", { chats: [...chats].reverse() }, { ok: true });
    expect([f.queue.currentHistoryHead("chat"), f.queue.currentHistoryHead("sibling")]).toEqual(saved);
    expect(publish.mock.calls.slice(2).map(([input]) => input.mutationId).sort()).toEqual(publish.mock.calls.slice(0, 2).map(([input]) => input.mutationId).sort());
  });
  it("withholds bulk success and notifications until every accepted target has its FULL fence", async () => {
    const f = await mutationFixture(), db = openSqlite(f.queueFile);
    try { db.exec("CREATE TRIGGER reject_second_engine_mutation BEFORE INSERT ON local_command_outbox_jobs WHEN NEW.conversation_id='sibling' BEGIN SELECT RAISE(ABORT,'synthetic storage refusal'); END"); }
    finally { db.close(); }
    await f.request("chats.bulkUpsert", { chats: [{ id: "chat", folder: directory }, { id: "sibling", folder: directory }] });
    expect(f.deliveries).toEqual([expect.objectContaining({ type: "WORKSPACE_ERROR", code: "command_storage_unavailable" })]);
    expect(f.state.broadcast).not.toHaveBeenCalled(); expect(f.state.cloudLocalMirror.notify).not.toHaveBeenCalled();
    expect(f.state.cloudLocalHistoryRestoreHeads.size).toBe(0);
    expect(f.queue.currentHistoryHead("chat")).not.toBeNull(); expect(f.queue.currentHistoryHead("sibling")).toBeNull();
    expect(f.state.handleCloudRuntimeAuthorityLoss).toHaveBeenCalledOnce();
  });
});
