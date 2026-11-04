import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import type { CloudV2PromptDelivery } from "@zeros/protocol/cloud-v2-prompts";
import { Agents } from "../agents";
import { SessionStore } from "../sessions/session-store";
import { ChatService } from "../workspace/chat-service";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";
import { browserFrame, config, FakeDriver } from "./worker-fixtures";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const task of cleanup.splice(0)) await task(); });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { release, promise }; }
async function setup() {
  const f = await repositoryFixture(), store = await SessionStore.open(f.state, f.scope.key), drivers: FakeDriver[] = [];
  const frames: BridgeMessage[] = [], client = { id: "app", send: async (frame: BridgeMessage) => { frames.push(frame); } };
  const agents = new Agents(store, f.scope, { codex: () => { const driver = new FakeDriver(); drivers.push(driver); return driver; } },
    { ...config, workspace: f.scope.workspace }, client.send, () => {});
  const chats = new ChatService(store, f.scope, id => agents.closeChat(id), agents.turns,
    { historyReplacement: () => true, mutate: agents.mutateChat.bind(agents) });
  cleanup.push(async () => { await agents.dispose(); await store.flush(); });
  await agents.handle(client, browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "chat", cwd: f.root }) as BridgeMessage);
  const opened = frames.find(frame => frame.type === "AGENT_SESSION_CREATED");
  if (opened?.type !== "AGENT_SESSION_CREATED") throw new Error("Missing session");
  await agents.handle(client, browserFrame("AGENT_PROMPT", { agentId: "codex", sessionId: opened.session.sessionId,
    userMessageId: "first", prompt: [{ type: "text", text: "first" }] }) as BridgeMessage);
  await expect.poll(() => drivers[0]?.prompts.length).toBe(1);
  return { ...f, store, agents, chats, drivers, frames, client, executionId: opened.session.sessionId };
}
function delivery(workspaceId: string, id: string, epoch = "1"): CloudV2PromptDelivery {
  return { deliveryId: randomUUID(), payload: { chatId: "chat", userMessageId: id, agentId: "codex", startedAt: Date.now(), prompt: [{ type: "text", text: id }] },
    receipt: { chatId: "chat", userMessageId: id, workspaceId, epoch, sequence: "2", acceptedAt: new Date().toISOString(), workspaceState: "running" } };
}

it("retires native execution before a held HTTP Stop and cuts only after its final receipt", async () => {
  const f = await setup(), hold = gate(), entered = gate();
  f.agents.setOutboxDispatch(async () => true, async () => { entered.release(); await hold.promise; return "1"; });
  const reset = f.chats.handle("messages.truncateFrom", { chatId: "chat", fromMsgId: "first" });
  try {
    await entered.promise;
    expect(f.drivers[0].disposed).toBe(true);
    expect(f.store.history("chat").length).toBeGreaterThan(0);
  } finally { hold.release(); await reset; }
  f.drivers[0].emit({ sessionUpdate: "agent_message_chunk", messageId: "stale", content: { type: "text", text: "late" } });
  await f.agents.flush();
  expect(f.store.history("chat")).toEqual([]);
  expect(f.store.metadata("chat")?.nativeSessionId).toBeUndefined();
});

it("holds a newer HTTP successor outside the cut and dispatches it with fresh native context", async () => {
  const f = await setup(), hold = gate(), entered = gate();
  f.agents.setOutboxDispatch(async () => true, async () => { entered.release(); await hold.promise; return "1"; });
  const reset = f.chats.handle("messages.truncateFrom", { chatId: "chat", fromMsgId: "first" });
  await entered.promise;
  let received = false;
  const successor = f.agents.receiveOutbox(delivery(f.scope.workspace.id, "next")).then(value => { received = true; return value; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(received).toBe(false);
    expect(f.drivers).toHaveLength(1);
  } finally { hold.release(); await reset; }
  const entry = await successor;
  await f.store.acknowledgeOutbox("chat", entry.requestId, "inboxed"); f.agents.resumeOutbox("chat");
  await expect.poll(() => f.drivers[1]?.prompts.length).toBe(1);
  expect(f.drivers[1].opened?.nativeSessionId).toBeUndefined();
  expect(f.store.history("chat").map(row => row.msgId)).toEqual(["next"]);
});

it("fails a cut closed when its HTTP Stop cannot be acknowledged", async () => {
  const f = await setup(), original = f.store.history("chat");
  f.agents.setOutboxDispatch(async () => true, async () => { throw new Error("Unavailable"); });
  await expect(f.chats.handle("messages.truncateFrom", { chatId: "chat", fromMsgId: "first" })).rejects.toThrow("Unavailable");
  expect(f.store.history("chat").map(row => row.msgId)).toEqual(original.map(row => row.msgId));
  expect(f.drivers[0].disposed).toBe(true);
});

it("cancels an old delivery whose inbox acknowledgement arrives after the cut", async () => {
  const f = await setup(), hold = gate(), entered = gate();
  f.agents.setOutboxDispatch(async () => true, async () => "1");
  const old = await f.agents.receiveOutbox(delivery(f.scope.workspace.id, "old-queued", "0"));
  const acknowledge = f.store.acknowledgeOutbox.bind(f.store);
  vi.spyOn(f.store, "acknowledgeOutbox").mockImplementation(async (...args) => { entered.release(); await hold.promise; await acknowledge(...args); });
  const ack = f.store.acknowledgeOutbox("chat", old.requestId, "inboxed").then(() => f.agents.resumeOutbox("chat"));
  await entered.promise;
  try { await f.chats.handle("messages.truncateFrom", { chatId: "chat", fromMsgId: "first" }); }
  finally { hold.release(); await ack; }
  await f.agents.flush();
  expect(f.store.receipt("chat", old.requestId)?.state).toBe("cancelled");
  expect(f.store.history("chat")).toEqual([]);
  expect(f.drivers).toHaveLength(1);
});

it("keeps native continuation usable after a files-only mutation", async () => {
  const f = await setup();
  f.agents.setOutboxDispatch(async () => true, async () => "1");
  const native = f.store.metadata("chat")!.nativeSessionId;
  expect(native).toBeTruthy();
  await f.agents.mutateChat("chat", false, async () => {});
  expect(f.store.metadata("chat")).toMatchObject({ executionId: f.executionId, nativeSessionId: native });
  const entry = await f.agents.receiveOutbox(delivery(f.scope.workspace.id, "next"));
  await f.store.acknowledgeOutbox("chat", entry.requestId, "inboxed"); f.agents.resumeOutbox("chat");
  await expect.poll(() => f.drivers[1]?.prompts.length).toBe(1);
  expect(f.drivers[1].opened?.nativeSessionId).toBe(native);
});

it("serializes consecutive mutations and drains them before shutdown completes", async () => {
  const f = await setup(), first = gate(), entered = gate(), order: string[] = [];
  const a = f.agents.mutateChat("chat", true, async () => { order.push("first"); entered.release(); await first.promise; order.push("saved"); });
  await entered.promise;
  const b = f.agents.mutateChat("chat", true, async () => { order.push("second"); });
  const result = b.then(() => undefined, error => error);
  let stopped = false;
  const stop = f.agents.dispose().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(stopped).toBe(false); expect(order).toEqual(["first"]);
  first.release(); await Promise.all([a, stop]);
  expect(await result).toMatchObject({ code: "WORKSPACE_UNAVAILABLE" });
  expect(order).toEqual(["first", "saved"]);
  expect(stopped).toBe(true);
});

it.each(["bridge", "HTTP"] as const)("does not reopen a queued native session after a newer %s Stop during reset", async mode => {
  const f = await setup(), action = gate(), entered = gate();
  const reset = f.agents.mutateChat("chat", false, async () => { entered.release(); await action.promise; });
  await entered.promise;
  const message = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "chat", cwd: f.root }) as BridgeMessage;
  const waiting = vi.spyOn(f.agents as unknown as { afterMutation(chatId: string): Promise<void> }, "afterMutation");
  const opening = f.agents.handle(f.client, message);
  expect(waiting.mock.calls.some(([chatId]) => chatId === "chat")).toBe(true);
  try {
    if (mode === "HTTP") await f.agents.stopOutbox("chat", "1");
    else await f.agents.handle(f.client, browserFrame("AGENT_CLOSE_SESSION", { agentId: "codex", chatId: "chat", userStop: true }) as BridgeMessage);
  } finally { action.release(); await Promise.all([reset, opening]); }
  expect(f.frames.find(frame => "requestId" in frame && frame.requestId === message.id)?.type).toBe("AGENT_ERROR");
  expect(f.drivers).toHaveLength(1);
  await f.agents.handle(f.client, browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "chat", cwd: f.root }) as BridgeMessage);
  expect(f.drivers).toHaveLength(2);
});

it.each(["inbox", "worker"] as const)("cancels admission behind a held mutation when the %s stops", async boundary => {
  const f = await setup(), held = gate(), entered = gate(), controller = new AbortController();
  const mutation = f.agents.mutateChat("chat", false, async () => { entered.release(); await held.promise; });
  await entered.promise;
  let outcome: unknown, stopped = false;
  const pending = f.agents.receiveOutbox(delivery(f.scope.workspace.id, "waiting"), controller.signal)
    .then(value => { outcome = value; }, error => { outcome = error; });
  const shutdown = boundary === "worker" ? f.agents.dispose().then(() => { stopped = true; }) : undefined;
  if (boundary === "inbox") controller.abort();
  try {
    await expect.poll(() => outcome).toMatchObject({ code: "WORKSPACE_UNAVAILABLE" });
    expect(stopped).toBe(false);
    expect(f.store.receipt("chat", "waiting")).toBeUndefined();
  } finally { held.release(); await Promise.allSettled([mutation, pending, shutdown]); }
  expect(f.store.receipt("chat", "waiting")).toBeUndefined();
  if (boundary === "inbox") {
    const next = await f.agents.receiveOutbox(delivery(f.scope.workspace.id, "fresh"));
    expect(next.userMessageId).toBe("fresh");
  } else expect(stopped).toBe(true);
});
