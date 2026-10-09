import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
import { ZerosEngine } from "../zeros-engine";
import { closeZerosDb, setZerosDbPathForTesting } from "../db";
import { headRev, nextRev } from "../db/sync";
import { createMessage, type EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";
import type { CloudLocalCommandHistoryHead } from "@zeros/protocol/cloud-local-mirror";

const methods = ZerosEngine.prototype as unknown as {
  handleWorkspaceMessage(this: unknown, message: Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>, client: TransportClient, admitted?: boolean): Promise<void>;
  handleConnect(this: unknown, client: TransportClient): Promise<void>;
  publishCloudHistoryChanged(this: unknown, conversationId: string): void;
  restoreCloudLocalHistory(this: unknown): Promise<void>;
};
const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2, engineInstanceId: randomUUID(),
  bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
function historyHead(revision: number): CloudLocalCommandHistoryHead {
  return { originWriterEpoch: scope.writerEpoch, source: { kind: "mutation", mutationId: randomUUID(), operation: "repair" }, deleted: false,
    history: { restoreRevision: revision, recordSequence: revision, eventSequence: revision, manifestSha256: String(revision).repeat(64) } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "zeros-history-read-"));
  setZerosDbPathForTesting(path.join(directory, "normal.sqlite")); headRev(); });
afterEach(async () => { closeZerosDb(); setZerosDbPathForTesting(null); await rm(directory, { recursive: true, force: true }); });

const reads = [
  ["messages.window", { chatId: "chat" }, { messages: [{ msgId: "old", payload: "old" }] }],
  ["messages.windowOlder", { chatId: "chat", beforeMsgId: "later" }, { messages: [{ msgId: "old", payload: "old" }] }],
  ["messages.search", { chatId: "chat", query: "old" }, { hits: [{ chatId: "chat", msgId: "old", payload: "old" }] }],
  ["chats.list", {}, { chats: [{ id: "chat", title: "old" }], chatDeletions: [] }],
] as const;

function fixture(op: string, params: Record<string, unknown>, placement: "cloud" | "Personal" | "organization-local" = "cloud") {
  const rows = deferred<unknown>(), entered = deferred<void>(), sent: EngineMessage[] = [];
  let current = historyHead(1), revision = 1;
  const queue = { scope, mirroredSequence: 10, get historyReadRevision() { return revision; }, currentHistoryHead: () => current };
  const boot = { active: true, queue };
  const state = { cloudWorker: placement === "cloud" ? { version: 3 } : null,
    cloudAgentBoot: placement === "cloud" ? boot : null, cloudLocalHistoryRestoreHeads: new Map(),
    isHostRelayClient: () => false,
    workspace: { isWriteOp: () => false, lifecycleMutationWorkspaceId: () => null,
      handle: async () => { entered.resolve(); return rows.promise; } },
    router: { broadcast: vi.fn(), broadcastExcept: vi.fn() }, slowWorkspaceOperations: { observe: vi.fn() } };
  Object.setPrototypeOf(state, ZerosEngine.prototype);
  const client: TransportClient = { id: "reader", kind: placement === "cloud" ? "cloud" : "local", authorized: () => true,
    ...(placement === "cloud" ? { cloudActor: { sessionId: randomUUID(), deviceId: randomUUID(), role: "developer" as const, fingerprint: "a".repeat(64) } } : {}),
    send: value => { sent.push(value); }, close: () => {} };
  const flight = methods.handleWorkspaceMessage.call(state, createMessage({ type: "WORKSPACE_REQUEST", source: "browser", op, params }), client, true);
  return { rows, entered, sent, flight, state, boot, queue,
    replaceHead: () => { current = historyHead(2); revision++; } };
}

describe("original live rows and their authoritative history head", () => {
  it.each(reads)("refuses old %s rows if the FULL head advances while the original read awaits", async (op, params, raw) => {
    const f = fixture(op, params); await f.entered.promise; f.replaceHead(); f.rows.resolve(raw); await f.flight;
    expect(f.sent).toContainEqual(expect.objectContaining({ type: "WORKSPACE_ERROR", code: "command_conflict" }));
    expect(f.sent.some(value => value.type === "WORKSPACE_RESPONSE")).toBe(false);
  });
  it("also refuses an unmirrored NORMAL change before its current FULL fence is published", async () => {
    const f = fixture("messages.window", { chatId: "chat" }); await f.entered.promise;
    nextRev(); f.rows.resolve({ messages: [{ msgId: "old" }] }); await f.flight;
    expect(f.sent.some(value => value.type === "WORKSPACE_RESPONSE")).toBe(false);
    expect(f.sent).toContainEqual(expect.objectContaining({ type: "WORKSPACE_ERROR", code: "command_conflict" }));
  });
  it("refuses a replacement boot even when its numeric read revision matches", async () => {
    const f = fixture("messages.window", { chatId: "chat" }); await f.entered.promise;
    f.state.cloudAgentBoot = { ...f.boot, queue: { ...f.queue, scope: { ...scope, writerEpoch: randomUUID() } } };
    f.rows.resolve({ messages: [] }); await f.flight;
    expect(f.sent.some(value => value.type === "WORKSPACE_RESPONSE")).toBe(false);
  });
  it("publishes unchanged original head and rows with the separate confirmed mirror cursor", async () => {
    const f = fixture("messages.window", { chatId: "chat" }); await f.entered.promise;
    const raw = { messages: [{ msgId: "current", payload: "unaltered" }] }; f.rows.resolve(raw); await f.flight;
    expect(f.sent).toContainEqual(expect.objectContaining({ type: "WORKSPACE_RESPONSE", result: {
      ...raw, projection: { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", mirroredSequence: 10, sealedSequence: null, complete: false },
      historyHeads: [expect.objectContaining({ conversationId: "chat", restoreRevision: 1 })] } }));
  });
  it.each(["Personal", "organization-local"] as const)("retains exact %s result bytes across unrelated writes", async placement => {
    const f = fixture("messages.window", { chatId: "chat" }, placement); await f.entered.promise;
    nextRev(); f.replaceHead(); const raw = { messages: [{ msgId: "local", payload: "unaltered" }] };
    f.rows.resolve(raw); await f.flight;
    expect(f.sent).toContainEqual(expect.objectContaining({ type: "WORKSPACE_RESPONSE", result: raw }));
    expect(f.sent.some(value => value.type === "WORKSPACE_ERROR")).toBe(false);
  });
  it("publishes the current FULL fence with the live terminal/control invalidation", () => {
    const f = fixture("messages.window", { chatId: "chat" }), broadcast = vi.fn();
    const state = { ...f.state, broadcast }; Object.setPrototypeOf(state, ZerosEngine.prototype);
    methods.publishCloudHistoryChanged.call(state, "chat");
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "DB_CHANGED", chatIds: ["chat"],
      cloudHistoryRestore: { projection: expect.objectContaining({ ...scope, mirroredSequence: 10 }),
        historyHeads: [expect.objectContaining({ conversationId: "chat", restoreRevision: 1 })] } }));
    f.rows.resolve({ messages: [] }); return f.flight;
  });
  it.each(["custody", "writer", "replay"])("refuses NORMAL reads and ready advertisement while %s is not installed", async missing => {
    const sent: EngineMessage[] = [], handle = vi.fn(), close = vi.fn();
    const state = { cloudWorker: { version: 3 }, cloudRecordRuntime: { usesLocalAgentJournal: true },
      cloudLocalHistoryRestored: missing !== "custody", cloudAgentBoot: { active: missing !== "writer" },
      cloudLocalEvents: missing === "replay" ? null : {}, isHostRelayClient: () => false,
      workspace: { isWriteOp: () => false, lifecycleMutationWorkspaceId: () => null, handle },
      framework: null, actualPort: 1234, slowWorkspaceOperations: { observe: vi.fn() } };
    Object.setPrototypeOf(state, ZerosEngine.prototype);
    const client: TransportClient = { id: "reader", kind: "cloud", authorized: () => true,
      send: value => { sent.push(value); }, close };
    await methods.handleWorkspaceMessage.call(state, createMessage({ type: "WORKSPACE_REQUEST", source: "browser", op: "messages.window", params: { chatId: "chat" } }), client, true);
    expect(handle).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({ type: "WORKSPACE_ERROR", code: "command_conflict" }));
    await methods.handleConnect.call(state, client);
    expect(sent.some(value => value.type === "ENGINE_READY")).toBe(false);
    expect(close).toHaveBeenCalledWith(1013, "cloud history initializing");
  });
  it("records fresh enrollment with no local predecessor before the first local cutover", async () => {
    const state = { cloudWorker: {}, cloudRecordRuntime: { usesLocalAgentJournal: false }, cloudLocalHistoryRestored: false,
      cloudRuntimeRegistration: { localCommandsNegotiated: () => true } };
    await methods.restoreCloudLocalHistory.call(state);
    expect(state.cloudLocalHistoryRestored).toBe(true);
  });
  it("does not infer an empty predecessor from unnegotiated enrollment", async () => {
    const state = { cloudWorker: {}, cloudRecordRuntime: { usesLocalAgentJournal: false }, cloudLocalHistoryRestored: false,
      cloudRuntimeRegistration: { localCommandsNegotiated: () => false } };
    await expect(methods.restoreCloudLocalHistory.call(state)).rejects.toThrow("engine_authority_rejected");
    expect(state.cloudLocalHistoryRestored).toBe(false);
  });
});
