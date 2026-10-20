import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
import { ZerosEngine } from "../zeros-engine";
import { closeZerosDb, setZerosDbPathForTesting } from "../db";
import { headRev, nextRev } from "../db/sync";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { WorkspaceService } from "../workspace/service";
import { closeState, setStateRootForTesting } from "../git";
import type { TransportClient } from "../transport/types";
import { createMessage, type EngineMessage } from "../types";
import type { CloudLocalCommandHistoryHead } from "@zeros/protocol/cloud-local-mirror";
import * as contextGraph from "../files/context-graph";
import * as legacyImages from "../files/legacy-attachment-migration";

const methods = ZerosEngine.prototype as unknown as {
  handleWorkspaceMessage(this: unknown, message: Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>, client: TransportClient): Promise<void>;
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let directory: string | undefined;
let fixtureRoot: string | undefined;
const queues: CloudLocalCommandQueue[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const queue of queues.splice(0)) queue.close();
  closeState(); setStateRootForTesting(null); closeZerosDb(); setZerosDbPathForTesting(null);
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  directory = undefined; fixtureRoot = undefined;
});

async function fixture(placement: "cloud" | "Personal" | "organization-local" = "cloud") {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "zeros-history-snapshot-"));
  directory = path.join(fixtureRoot, "repo"); await mkdir(directory);
  setStateRootForTesting(path.join(fixtureRoot, "state"));
  setZerosDbPathForTesting(path.join(fixtureRoot, "normal.sqlite"));
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const engineLive = vi.fn(() => true), actors = new CloudActorAuthorityRegistry({ scope, engineLive });
  const events = { head: 17 };
  const queue = new CloudLocalCommandQueue({ file: path.join(fixtureRoot, "queue.sqlite"), scope, actors, engineLive,
    ready: () => true, history: () => ({ recordSequence: headRev(), eventSequence: events.head }) });
  queues.push(queue);
  const workspace = new WorkspaceService(directory), sent: EngineMessage[] = [];
  const boot = { active: true, authorityActive: true, scope, queue };
  const state = { root: directory, cloudWorker: placement === "cloud" ? { version: 3 } : null,
    cloudAgentBoot: placement === "cloud" ? boot : null, cloudLocalEvents: events,
    cloudLocalHistoryRestoreHeads: new Map<string, CloudLocalCommandHistoryHead>(),
    cloudLocalMirror: { notify: vi.fn() }, cloudWorkspaceMutations: new Set<Promise<void>>(), cloudWorkspaceIdleMaintenance: new Set<Promise<void>>(),
    workspaceProcessStarts: new Map<string, Set<Promise<unknown>>>(), designTerritoryTransitionCallers: new Set<Promise<unknown>>(),
    broadcast: vi.fn(), handleCloudRuntimeAuthorityLoss: vi.fn(), reportEngineError: vi.fn(), isHostRelayClient: () => false,
    workspace, router: { broadcast: vi.fn(), broadcastExcept: vi.fn() }, slowWorkspaceOperations: { observe: vi.fn() } };
  Object.setPrototypeOf(state, ZerosEngine.prototype);
  const authorized = vi.fn(() => true);
  const client: TransportClient = { id: "history-reader", kind: placement === "cloud" ? "cloud" : "local", authorized,
    ...(placement === "cloud" ? { cloudActor: { sessionId: randomUUID(), deviceId: randomUUID(), fingerprint: "b".repeat(64), role: "developer" as const } } : {}),
    send: message => { sent.push(message); }, close: () => {} };
  await workspace.handle("chats.bulkUpsert", { chats: [{ id: "chat", title: "selected", folder: directory }, { id: "sibling", title: "before", folder: directory }] });
  for (const chatId of ["chat", "sibling"]) {
    await workspace.handle("messages.import", { chatId, messages: [
      { msgId: `${chatId}-first`, kind: "text", payload: JSON.stringify({ text: "retained first" }), createdAt: 1 },
      { msgId: `${chatId}-last`, kind: "text", payload: JSON.stringify({ text: "retained last" }), createdAt: 2 },
    ] });
    queue.publishHistoryMutation({ conversationId: chatId, mutationId: randomUUID(), operation: "repair", deleted: false,
      recordSequence: headRev(), eventSequence: events.head });
  }
  const handle = workspace.handle.bind(workspace);
  const request = (op: string, params: Record<string, unknown>) => methods.handleWorkspaceMessage.call(state,
    createMessage({ type: "WORKSPACE_REQUEST", source: "browser", op, params }), client);
  const hold = (op: string, phase: "before" | "after") => {
    const entered = deferred(), release = deferred();
    vi.spyOn(workspace, "handle").mockImplementation(async (...args) => {
      if (args[0] === op && phase === "before") { entered.resolve(); await release.promise; }
      const value = await handle(...args);
      if (args[0] === op && phase === "after") { entered.resolve(); await release.promise; }
      return value;
    });
    return { entered, release };
  };
  const response = () => {
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "WORKSPACE_RESPONSE" });
    return (sent[0] as Extract<EngineMessage, { type: "WORKSPACE_RESPONSE" }>).result as Record<string, unknown>;
  };
  return { state, boot, queue, scope, events, workspace, handle, request, hold, sent, response, authorized };
}

const reads = [
  ["messages.window", { chatId: "chat" }],
  ["messages.windowOlder", { chatId: "chat", beforeMsgId: "chat-last" }],
  ["messages.search", { chatId: "chat", query: "retained" }],
  ["chats.list", {}],
] as const;

async function legacyFixture() {
  const f = await fixture();
  await f.handle("messages.import", { chatId: "chat", messages: [{ msgId: "chat-first", kind: "text", createdAt: 1,
    payload: JSON.stringify({ text: "legacy image", attachments: [{ kind: "image", name: "image.png",
      thumbnailUri: `data:image/png;base64,${Buffer.from("synthetic image").toString("base64")}` }] }) }] });
  f.queue.publishHistoryMutation({ conversationId: "chat", mutationId: randomUUID(), operation: "repair", deleted: false,
    recordSequence: headRev(), eventSequence: f.events.head });
  return f;
}

describe("cloud history takes its snapshot at the SQLite read", () => {
  describe.each(["before", "after"] as const)("unrelated write %s the actual read", phase => {
    it.each(reads)("returns consistent %s rows without a global-counter conflict", async (op, params) => {
      const f = await fixture(), barrier = f.hold(op, phase);
      const original = await f.handle(op, params), selectedHead = f.queue.currentHistoryHead("chat");
      const flight = f.request(op, params);
      await barrier.entered.promise;
      await f.handle("chats.upsert", { chat: { id: "sibling", title: "after", folder: directory } });
      f.queue.publishHistoryMutation({ conversationId: "sibling", mutationId: randomUUID(), operation: "edit", deleted: false,
        recordSequence: headRev(), eventSequence: f.events.head });
      const expectedRows = phase === "before" ? await f.handle(op, params) : original;
      barrier.release.resolve(); await flight;
      const result = f.response();
      expect(result).toMatchObject(expectedRows as object);
      expect(result.projection).toMatchObject(f.scope);
      expect(result.historyHeads).toEqual(expect.arrayContaining([expect.objectContaining({ conversationId: "chat",
        restoreRevision: selectedHead!.history.restoreRevision, source: selectedHead!.source })]));
      expect(f.state.workspaceProcessStarts.size).toBe(0);
    });
  });

  it("pairs a completed read with its original head instead of relabelling it after an outer await", async () => {
    const f = await fixture(), barrier = f.hold("messages.window", "after");
    const original = f.queue.currentHistoryHead("chat")!;
    const flight = f.request("messages.window", { chatId: "chat" }); await barrier.entered.promise;
    await f.handle("messages.clear", { chatId: "chat" });
    f.queue.publishHistoryMutation({ conversationId: "chat", mutationId: randomUUID(), operation: "prune", deleted: false,
      recordSequence: headRev(), eventSequence: f.events.head });
    barrier.release.resolve(); await flight;
    const result = f.response();
    expect(result.messages).toHaveLength(2);
    expect(result.historyHeads).toEqual([expect.objectContaining({ restoreRevision: original.history.restoreRevision, source: original.source })]);
    expect(f.queue.currentHistoryHead("chat")!.history.restoreRevision).toBeGreaterThan(original.history.restoreRevision);
  });

  it.each(["before", "after"] as const)("refuses a replaced boot %s the actual read", async phase => {
    const f = await fixture(), barrier = f.hold("messages.window", phase);
    const flight = f.request("messages.window", { chatId: "chat" }); await barrier.entered.promise;
    f.state.cloudAgentBoot = { ...f.boot };
    barrier.release.resolve(); await flight;
    expect(f.sent).toEqual([expect.objectContaining({ type: "WORKSPACE_ERROR", code: "command_conflict" })]);
  });

  it("refuses actor authority lost after a completed read", async () => {
    const f = await fixture(), barrier = f.hold("messages.window", "after");
    const flight = f.request("messages.window", { chatId: "chat" }); await barrier.entered.promise;
    f.authorized.mockReturnValue(false);
    barrier.release.resolve(); await flight;
    expect(f.sent).toEqual([expect.objectContaining({ type: "WORKSPACE_ERROR", code: "cloud_actor_authority_rejected" })]);
  });

  it.each(["Personal", "organization-local"] as const)("keeps %s rows and wire shape unchanged", async placement => {
    const f = await fixture(placement), barrier = f.hold("messages.window", "after");
    const original = await f.handle("messages.window", { chatId: "chat" });
    const flight = f.request("messages.window", { chatId: "chat" }); await barrier.entered.promise;
    await f.handle("chats.upsert", { chat: { id: "sibling", title: "after", folder: directory } });
    barrier.release.resolve(); await flight;
    expect(f.response()).toEqual(original);
  });

  it.each(["messages.window", "messages.windowOlder"])("re-reads %s after legacy image I/O and an unrelated write", async op => {
    const f = await legacyFixture(), entered = deferred(), release = deferred();
    const stage = vi.spyOn(contextGraph, "stageContextGraphAttachment").mockImplementation(async (_root, input) => {
      entered.resolve(); await release.promise;
      return { ok: true, relativePath: `.context/attachments/${input.attachmentId}/image.png` };
    });
    const migration = vi.spyOn(legacyImages, "externalizeLegacyMessageImages");
    const flight = f.request(op, { chatId: "chat", ...(op === "messages.windowOlder" ? { beforeMsgId: "chat-last" } : {}) });
    await entered.promise;
    await f.handle("chats.upsert", { chat: { id: "sibling", title: "after", folder: directory } });
    release.resolve(); await flight;
    const result = f.response();
    expect(result.messages).toEqual(expect.arrayContaining([expect.objectContaining({ msgId: "chat-first", payload: expect.not.stringContaining("thumbnailUri") })]));
    expect(stage).toHaveBeenCalledTimes(2);
    expect(migration).toHaveBeenCalledTimes(3);
    expect(result.historyHeads).toEqual([expect.objectContaining({ conversationId: "chat", source: f.queue.currentHistoryHead("chat")!.source })]);
  });

  it("never resurrects cleared rows when legacy image I/O finishes", async () => {
    const f = await legacyFixture(), entered = deferred(), release = deferred();
    vi.spyOn(contextGraph, "stageContextGraphAttachment").mockImplementation(async (_root, input) => {
      entered.resolve(); await release.promise;
      return { ok: true, relativePath: `.context/attachments/${input.attachmentId}/image.png` };
    });
    const flight = f.request("messages.window", { chatId: "chat" }); await entered.promise;
    await f.handle("messages.clear", { chatId: "chat" });
    f.queue.publishHistoryMutation({ conversationId: "chat", mutationId: randomUUID(), operation: "prune", deleted: false,
      recordSequence: headRev(), eventSequence: f.events.head });
    release.resolve(); await flight;
    expect(f.response().messages).toEqual([]);
    expect(await f.handle("messages.window", { chatId: "chat" })).toEqual({ messages: [] });
  });

  it("returns the re-read rows after real legacy attachment staging", async () => {
    const f = await legacyFixture();
    const stage = vi.spyOn(contextGraph, "stageContextGraphAttachment");
    await f.request("messages.window", { chatId: "chat" });
    for (const call of stage.mock.results) expect(await call.value).toMatchObject({ ok: true });
    const result = f.response();
    expect(result.messages).toEqual(expect.arrayContaining([expect.objectContaining({ msgId: "chat-first",
      payload: expect.not.stringContaining("thumbnailUri") })]));
    expect(result).toMatchObject(await f.handle("messages.window", { chatId: "chat" }) as object);
  });

  it("caps repeated image conflicts at three reads without committing stale rows", async () => {
    const f = await legacyFixture();
    const stage = vi.spyOn(contextGraph, "stageContextGraphAttachment").mockImplementation(async (_root, input) => {
      nextRev();
      return { ok: true, relativePath: `.context/attachments/${input.attachmentId}/image.png` };
    });
    await f.request("messages.window", { chatId: "chat" });
    expect(stage).toHaveBeenCalledTimes(3);
    expect(f.sent).toEqual([expect.objectContaining({ type: "WORKSPACE_ERROR", code: "command_conflict" })]);
    expect(f.state.workspaceProcessStarts.size).toBe(0);
  });

  it.each(["boot", "actor"])("does not retry or persist a legacy image after %s retirement", async retired => {
    const f = await legacyFixture(), entered = deferred(), release = deferred();
    const stage = vi.spyOn(contextGraph, "stageContextGraphAttachment").mockImplementation(async (_root, input) => {
      entered.resolve(); await release.promise;
      return { ok: true, relativePath: `.context/attachments/${input.attachmentId}/image.png` };
    });
    const originalRevision = headRev();
    const flight = f.request("messages.window", { chatId: "chat" }); await entered.promise;
    if (retired === "boot") f.state.cloudAgentBoot = { ...f.boot };
    else f.authorized.mockReturnValue(false);
    release.resolve(); await flight;
    expect(stage).toHaveBeenCalledOnce();
    expect(headRev()).toBe(originalRevision);
    expect(f.sent).toEqual([expect.objectContaining({ type: "WORKSPACE_ERROR",
      code: retired === "boot" ? "command_conflict" : "cloud_actor_authority_rejected" })]);
  });
});
