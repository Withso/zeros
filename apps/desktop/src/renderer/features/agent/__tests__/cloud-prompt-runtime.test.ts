import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudV2Prompt, CloudV2PromptStatus } from "@zeros/protocol/cloud-v2-prompts";
import { emptyPromptJournal, promptOwnerKey, type CloudPromptJournal, type PromptJournalRecord } from "../cloud-prompt-channel";
const f = vi.hoisted(() => ({ generation: 1, ownerGeneration: 1, apis: new Map<string, any>(), doc: undefined as any, accountId: "account", allowed: true,
  listeners: new Set<() => void>(), workspace: { activeChatId: null as string | null, chats: [] as any[] },
  journal: undefined as unknown as CloudPromptJournal, api: undefined as any }));
vi.mock("../cloud-prompt-journal", () => ({ createCloudPromptJournal: () => f.journal }));
vi.mock("../../../platform/cloud-prompt-api", () => ({ cloudPromptApi: (_target: unknown, chat: string) => f.apis.get(chat) ?? f.api }));
vi.mock("../../team/control-plane", () => ({ CONTROL_PLANE_URL: "https://api.example.test" }));
vi.mock("../../team/team-store", () => ({ getOrganizationStoreGeneration: () => f.generation,
  getTeamStoreState: () => ({ me: { user: { id: f.accountId } } }), subscribeOrganizationSnapshots: (cb: () => void) => { f.listeners.add(cb); return () => f.listeners.delete(cb); } }));
vi.mock("../../team/cloud-workspace-account-access", () => ({ hasCloudWorkspaceAccountAccess: () => f.allowed }));
vi.mock("../../../state/cloud-workspace-catalog", () => ({ cloudCatalogGeneration: () => f.generation, cloudWorkspaceOwnerGeneration: () => f.ownerGeneration,
  cloudWorkspaceDocument: () => f.doc, subscribeCloudWorkspaces: (cb: () => void) => { f.listeners.add(cb); return () => f.listeners.delete(cb); } }));
vi.mock("../../../state/workspace-store", () => ({ useWorkspaceStore: { getState: () => f.workspace, subscribe: () => () => {} } }));
import { eraseCloudPrompts } from "../../../platform/cloud-prompt-erasure";
import { cloudPromptView } from "../cloud-prompt-presentation";
import { CloudPromptRuntime } from "../use-cloud-prompt-outbox";
import { BLANK, useSessionsStore } from "../sessions-store";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const owner = { ...target, backend: "https://api.example.test", accountId: "account", chatId: "chat" };
const chatId = cloudScopedId(target, "chat"), cwd = cloudWorkspaceKey(target);
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("window", new EventTarget());
  f.generation = 1; f.ownerGeneration = 1; f.apis.clear(); f.accountId = "account"; f.allowed = true; f.listeners.clear();
  f.doc = { status: "ready", capabilities: { promptOutbox: 1 }, deletedAt: null };
  f.workspace = { activeChatId: chatId, chats: [{ id: chatId, folder: cwd, agentId: "codex", model: "gpt-6-luna", effort: "low" }] };
  useSessionsStore.setState({ sessions: { [chatId]: { ...BLANK, agentId: "codex", cwd, transcriptState: "resident" } }, executionToChatId: {} });
  const records = new Map<string, PromptJournalRecord>();
  f.journal = { read: async owner => records.get(promptOwnerKey(owner)) ?? emptyPromptJournal(owner),
    change: async (owner, update) => { const record = update(records.get(promptOwnerKey(owner)) ?? emptyPromptJournal(owner)); records.set(promptOwnerKey(owner), record); return record; },
    owners: async () => [...records.values()].map(record => record.owner), erase: async owner => { records.delete(promptOwnerKey(owner)); } };
  const rows: CloudV2PromptStatus[] = [];
  f.api = { enqueue: vi.fn(async (payload: CloudV2Prompt) => {
    const receipt = { workspaceId: target.workspaceId, chatId: "chat", userMessageId: payload.userMessageId, epoch: "0", sequence: String(rows.length + 1), acceptedAt: new Date(1).toISOString(), workspaceState: "running" as const };
    rows.push({ payload, receipt, state: "queued", cancelRequested: false }); return receipt;
  }), list: vi.fn(async () => ({ epoch: "0", items: rows, nextAfter: null })), stop: vi.fn(async () => ({ chatId: "chat", epoch: "1" })) };
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("saves the frozen selection without a live execution, accepts only after the committed HTTPS receipt, and sends exactly once", async () => {
  const runtime = new CloudPromptRuntime(); cleanup = runtime.start(); const accepted = vi.fn();
  await runtime.send(chatId, { text: "ok" }, { id: "one", accepted });
  expect(accepted).toHaveBeenCalledOnce();
  expect(useSessionsStore.getState().sessions[chatId]?.cloudOutbox?.rows[0]).toMatchObject({ text: "ok", id: "one" });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.api.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: "chat", userMessageId: "one", model: "gpt-6-luna", effort: "low" }));
  expect(useSessionsStore.getState().sessions[chatId]?.status).not.toBe("streaming");
});
it("resumes privately saved work when a cold capability catalog arrives under the same account generation", async () => {
  await f.journal.change(owner, record => ({ ...record, nextOrder: 1, entries: [{ order: 0, phase: "pending", updatedAt: 1,
    payload: { chatId: "chat", userMessageId: "one", agentId: "codex", prompt: [{ type: "text", text: "ok" }], startedAt: 1 } }] }));
  f.doc = undefined; const runtime = new CloudPromptRuntime(); cleanup = runtime.start();
  await vi.advanceTimersByTimeAsync(0); expect(f.api.enqueue).not.toHaveBeenCalled();
  f.doc = { status: "ready", capabilities: { promptOutbox: 1 }, deletedAt: null };
  for (const cb of f.listeners) cb(); await vi.advanceTimersByTimeAsync(1);
  expect(f.api.enqueue).toHaveBeenCalledOnce();
});
it("keeps Local Personal, organization-local, capability-absent and foreign-account sends on their own paths", async () => {
  const runtime = new CloudPromptRuntime();
  for (const folder of ["/personal", "/organization-local"]) {
    f.workspace.chats = [{ id: chatId, folder, agentId: "codex" }]; expect(runtime.available(chatId)).toBe(false);
  }
  f.workspace.chats = [{ id: chatId, folder: cwd, agentId: "codex" }]; f.doc.capabilities = {};
  expect(runtime.available(chatId)).toBe(false); f.doc.capabilities = { promptOutbox: 1 }; f.allowed = false;
  expect(runtime.available(chatId)).toBe(false); expect(f.api.enqueue).not.toHaveBeenCalled();
});
it("settles a mid-turn worker restart from its interrupted receipt without replay or a hanging working indicator", async () => {
  const runtime = new CloudPromptRuntime(); cleanup = runtime.start();
  await runtime.send(chatId, { text: "ok" }, { id: "one" }); await vi.advanceTimersByTimeAsync(1);
  const page = await f.api.list(); page.items[0].state = "accepted";
  runtime.refresh(chatId); await vi.advanceTimersByTimeAsync(1);
  expect(useSessionsStore.getState().sessions[chatId]?.status).toBe("streaming");
  page.items[0].state = "interrupted";
  runtime.observe({ type: "ENGINE_READY", instanceId: "replacement-worker" } as any);
  await vi.advanceTimersByTimeAsync(1);
  const slot = useSessionsStore.getState().sessions[chatId]!;
  expect(slot).toMatchObject({ status: "ready", activeTurnStartedAt: null });
  expect(slot.cloudOutbox?.rows[0]?.recoveryFailure?.message).toBe("The worker restarted before this turn finished");
  expect(f.api.enqueue).toHaveBeenCalledTimes(1);
});
it("retains a refusal, sends the next message, and adopts a restarted execution for only the known message", async () => {
  const runtime = new CloudPromptRuntime(); cleanup = runtime.start();
  f.api.enqueue.mockRejectedValueOnce(Object.assign(new Error("sensitive diagnostic"), { status: 409 }));
  await runtime.send(chatId, { text: "one" }, { id: "one" }); await runtime.send(chatId, { text: "two" }, { id: "two" });
  await vi.advanceTimersByTimeAsync(1);
  expect(useSessionsStore.getState().sessions[chatId]?.cloudOutbox?.rows[0]).toMatchObject({ id: "one", recoveryFailure: { message: expect.stringMatching(/retry/i) } });
  expect(f.api.enqueue).toHaveBeenCalledTimes(2);
  const update = { type: "AGENT_SESSION_UPDATE", chatId, agentId: "codex", executionId: "replacement", notification: { sessionId: "replacement",
    update: { sessionUpdate: "turn_state", turnId: "two", state: "running", startedAt: 1 } } } as any;
  runtime.observe(update); useSessionsStore.getState().applyBridgeUpdate({ ...update.notification, chatId });
  expect(useSessionsStore.getState().sessions[chatId]).toMatchObject({ executionId: "replacement", status: "streaming", foregroundTurnId: "two" });
  runtime.observe({ ...update, executionId: "foreign", notification: { ...update.notification, update: { ...update.notification.update, turnId: "unknown" } } });
  expect(useSessionsStore.getState().sessions[chatId]?.executionId).toBe("replacement");
});
it("confirms idle Stop without a bridge or an error banner", async () => {
  const runtime = new CloudPromptRuntime(); cleanup = runtime.start();
  await runtime.stop(chatId); await vi.advanceTimersByTimeAsync(1);
  expect(f.api.stop).toHaveBeenCalledTimes(1);
  expect(useSessionsStore.getState().sessions[chatId]).toMatchObject({ cloudStop: undefined, error: null, activeTurnStartedAt: null });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
it("shows the bubble immediately but finishes Send only after the control plane commits it", async () => {
  const runtime = new CloudPromptRuntime(); cleanup = runtime.start();
  const gate = deferred<void>(), enqueue = f.api.enqueue.getMockImplementation(), accepted = vi.fn();
  f.api.enqueue.mockImplementation(async (payload: CloudV2Prompt) => { await gate.promise; return enqueue(payload); });
  let finished = false;
  const send = runtime.send(chatId, { text: "ok" }, { id: "one", accepted }).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(1);
  expect(useSessionsStore.getState().sessions[chatId]?.cloudOutbox?.rows[0]).toMatchObject({ id: "one", text: "ok" });
  expect(f.api.enqueue).toHaveBeenCalledOnce();
  expect(finished).toBe(false); expect(accepted).not.toHaveBeenCalled();
  gate.resolve(); await send;
  expect(accepted).toHaveBeenCalledOnce();
  expect((await f.journal.read(owner)).entries[0]?.receipt?.userMessageId).toBe("one");
});
it("never acknowledges a lost HTTPS reply as cloud saved, and repairs it with the same message id", async () => {
  const runtime = new CloudPromptRuntime(); cleanup = runtime.start(); const accepted = vi.fn();
  f.api.enqueue.mockRejectedValueOnce(new Error("offline"));
  await runtime.send(chatId, { text: "ok" }, { id: "one", accepted });
  expect(accepted).not.toHaveBeenCalled();
  expect(useSessionsStore.getState().sessions[chatId]?.cloudOutbox?.rows[0]?.recoveryFailure?.message).toContain("Saved on this device");
  await vi.advanceTimersByTimeAsync(2_001);
  expect(f.api.enqueue.mock.calls.map(([payload]: [CloudV2Prompt]) => payload.userMessageId)).toEqual(["one", "one"]);
  expect((await f.journal.read(owner)).entries[0]?.receipt?.userMessageId).toBe("one");
});
it.each(["account", "workspace"])("fences a held receipt across %s A to B to A without accepting it into the new owner", async boundary => {
  const runtime = new CloudPromptRuntime(); cleanup = runtime.start();
  const gate = deferred<void>(), enqueue = f.api.enqueue.getMockImplementation(), accepted = vi.fn();
  f.api.enqueue.mockImplementation(async (payload: CloudV2Prompt) => { await gate.promise; return enqueue(payload); });
  const send = runtime.send(chatId, { text: "ok" }, { id: "one", accepted }).catch(() => {});
  await vi.advanceTimersByTimeAsync(1); expect(f.api.enqueue).toHaveBeenCalledOnce();
  if (boundary === "account") f.generation += 2; else f.ownerGeneration += 2;
  gate.resolve(); await send; await vi.advanceTimersByTimeAsync(1);
  expect(accepted).not.toHaveBeenCalled();
  expect((await f.journal.read(owner)).entries[0]?.receipt).toBeUndefined();
});
it("restores more than 64 saved chats in bounded batches even with no mounted transcript", async () => {
  f.workspace = { activeChatId: null, chats: [] }; useSessionsStore.setState({ sessions: {}, executionToChatId: {} });
  for (let index = 0; index < 70; index++) {
    const native = `saved-${index}`, key = { ...owner, chatId: native };
    const payload: CloudV2Prompt = { chatId: native, userMessageId: native, agentId: "codex", prompt: [{ type: "text", text: "ok" }], startedAt: 1 };
    await f.journal.change(key, record => ({ ...record, nextOrder: 1, entries: [{ order: 0, phase: "pending", updatedAt: 1, payload }] }));
    const receipt = { workspaceId: owner.workspaceId, chatId: native, userMessageId: native, sequence: String(index + 1), epoch: "0", acceptedAt: new Date(1).toISOString(), workspaceState: "running" as const };
    f.apis.set(native, { enqueue: vi.fn(async () => receipt), list: async () => ({ epoch: "0", items: [{ receipt, payload, state: "completed", cancelRequested: false }], nextAfter: null }), stop: vi.fn() });
  }
  const runtime = new CloudPromptRuntime(); cleanup = runtime.start();
  await vi.advanceTimersByTimeAsync(100);
  expect([...f.apis.values()].filter(api => api.enqueue.mock.calls.length === 1)).toHaveLength(70);
});
it("bounds close confirmation even when its Stop HTTP response never arrives", async () => {
  const runtime = new CloudPromptRuntime(); cleanup = runtime.start();
  const gate = deferred<{ chatId: string; epoch: string }>(); f.api.stop.mockImplementationOnce(() => gate.promise);
  let result: boolean | undefined;
  const closing = runtime.confirmStop(chatId).then(value => { result = value; });
  await vi.advanceTimersByTimeAsync(15_001);
  expect(result).toBe(false);
  gate.resolve({ chatId: "chat", epoch: "1" }); await closing;
});

it("erases a confirmed deleted chat and fences a held response without touching another account", async () => {
  const other = { ...owner, accountId: "other-account" };
  await f.journal.change(other, record => ({ ...record, nextOrder: 1, entries: [{ order: 0, phase: "pending", updatedAt: 1,
    payload: { chatId: "chat", userMessageId: "other", agentId: "codex", prompt: [{ type: "text", text: "private" }], startedAt: 1 } }] }));
  const runtime = new CloudPromptRuntime(); cleanup = runtime.start();
  const gate = deferred<void>(), enqueue = f.api.enqueue.getMockImplementation();
  f.api.enqueue.mockImplementation(async (payload: CloudV2Prompt) => { await gate.promise; return enqueue(payload); });
  const pending = runtime.send(chatId, { text: "ok" }, { id: "one" }).catch(() => {});
  await vi.advanceTimersByTimeAsync(1); expect(f.api.enqueue).toHaveBeenCalledOnce();
  eraseCloudPrompts({ ...target, chatId: "chat" }); await vi.advanceTimersByTimeAsync(1);
  gate.resolve(); await pending; await vi.advanceTimersByTimeAsync(1);
  expect((await f.journal.read(owner)).entries).toEqual([]);
  expect((await f.journal.read(other)).entries[0]?.payload.userMessageId).toBe("other");
});

it("retains confirmed same-chat bubbles while reopening the private journal", async () => {
  const record = await f.journal.change(owner, record => ({ ...record, nextOrder: 1, entries: [{ order: 0, phase: "pending", updatedAt: 1,
    payload: { chatId: "chat", userMessageId: "one", agentId: "codex", prompt: [{ type: "text", text: "keep" }], startedAt: 1 } }] }));
  const retained = cloudPromptView(record, "ready"); useSessionsStore.getState().patchSession(chatId, { cloudOutbox: retained });
  const gate = deferred<void>(), read = f.journal.read;
  f.journal.read = async owner => { await gate.promise; return read(owner); };
  const runtime = new CloudPromptRuntime(); cleanup = runtime.start(); await vi.advanceTimersByTimeAsync(1);
  expect(useSessionsStore.getState().sessions[chatId]?.cloudOutbox).toBe(retained);
  gate.resolve(); await vi.advanceTimersByTimeAsync(1);
  expect(useSessionsStore.getState().sessions[chatId]?.cloudOutbox?.rows.map(row => row.text)).toEqual(["keep"]);
});
