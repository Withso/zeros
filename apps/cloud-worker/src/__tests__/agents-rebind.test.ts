import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudV2ControlFrameSchema, type CloudV2Agent } from "@zeros/protocol/cloud-v2-relay";
import { providerBindingForResume } from "@zeros/protocol/identities";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { CloudWorker } from "../worker";
import { SessionStore } from "../sessions/session-store";
import type { ChatRow } from "../sessions/chat-history";
import { CLIENT_A, CLIENT_B, FakeDriver, FakeRelay, WORKSPACE_KEY, browserFrame, config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

async function setup(prepare?: (driver: FakeDriver, agent: CloudV2Agent) => void) {
  const directory = await mkdtemp(join(tmpdir(), "worker-agent-rebind-"));
  const drivers: Array<{ driver: FakeDriver; agent: CloudV2Agent }> = [];
  let worker: CloudWorker, relay: FakeRelay;
  const start = async () => {
    relay = new FakeRelay();
    worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, drivers: Object.fromEntries(
      (["codex", "claude", "cursor"] as const).map(agent => [agent, () => {
        const driver = new FakeDriver(); prepare?.(driver, agent); drivers.push({ driver, agent }); return driver;
      }])) });
    worker.start();
    await relay.receive(CloudV2ControlFrameSchema.parse({ ...config, agents: { ...config.agents, claude: { apiKey: "fixture-claude-api-key" }, cursor: { apiKey: "fixture-cursor" } } }));
    await relay.receive({ t: "open", clientId: CLIENT_A });
    await relay.receive({ t: "open", clientId: CLIENT_B });
  };
  await start();
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  const request = async (type: string, fields: Record<string, unknown>) => {
    const frame = browserFrame(type, fields); await relay.request(CLIENT_A, frame); return relay.response(frame.id)!;
  };
  const op = async (op: string, params: Record<string, unknown> = {}) => {
    const result = await request("WORKSPACE_REQUEST", { op, params });
    expect(result.type).toBe("WORKSPACE_RESPONSE");
    return (result as Extract<BridgeMessage, { type: "WORKSPACE_RESPONSE" }>).result;
  };
  const open = (agentId: CloudV2Agent, chatId = "chat", env?: Record<string, string>) => request("AGENT_NEW_SESSION", { agentId, chatId, cwd: WORKSPACE_KEY, ...(env ? { env } : {}) });
  const chat = async (chatId = "chat") => ((await op("chats.list")) as { chats: ChatRow[] }).chats.find(row => row.id === chatId)!;
  return { directory, drivers, open, op, chat, request, get relay() { return relay; }, get worker() { return worker; },
    restart: async () => { await worker.dispose(); await start(); } };
}
function session(frame: BridgeMessage) {
  expect(frame.type).toBe("AGENT_SESSION_CREATED");
  if (frame.type !== "AGENT_SESSION_CREATED") throw new Error("Missing session");
  return frame.session;
}

it("treats a first conversation probe before chats.upsert as a typed miss, then opens the same chat", async () => {
  const f = await setup();
  const probe = await f.request("AGENT_LOAD_SESSION", { agentId: "claude", chatId: "chat", cwd: WORKSPACE_KEY });
  expect(probe).toMatchObject({ type: "AGENT_ERROR", code: "session-expired", requestId: expect.any(String),
    failure: { kind: "session-expired", stage: "loadSession", agentId: "claude" } });
  expect(f.drivers).toHaveLength(0);
  expect(await f.chat()).toBeUndefined();
  const created = session(await f.open("claude"));
  // The renderer's independent metadata save can finish after admission.
  await f.op("chats.upsert", { chat: { id: "chat", folder: WORKSPACE_KEY, agentId: "claude", title: "Untitled" } });
  expect((await f.op("chats.list") as { chats: ChatRow[] }).chats).toHaveLength(1);
  expect(f.drivers).toHaveLength(1);
  expect(await f.request("AGENT_LOAD_SESSION", { agentId: "claude", chatId: "chat", cwd: WORKSPACE_KEY }))
    .toMatchObject({ type: "AGENT_SESSION_LOADED", sessionId: created.sessionId });
});

it("opens the first default chat in either order relative to chats.upsert", async () => {
  const f = await setup();
  for (const before of [true, false]) {
    const chatId = `first-${before}`;
    const save = () => f.op("chats.upsert", { chat: { id: chatId, folder: WORKSPACE_KEY, agentId: "claude", title: "Untitled" } });
    if (before) await save();
    session(await f.open("claude", chatId));
    if (!before) await save();
    expect(await f.chat(chatId)).toMatchObject({ id: chatId, agentId: "claude" });
  }
  expect(f.drivers).toHaveLength(2);
});

it.each(["providerBinding", "sessionId", "executionId", "deleted", "foreign"])(
  "does not turn a %s refusal into a fresh-chat probe miss", async reason => {
    const f = await setup();
    if (reason === "deleted") {
      session(await f.open("claude"));
      await f.op("chats.delete", { id: "chat" });
    }
    const reply = await f.request("AGENT_LOAD_SESSION", { agentId: "claude", chatId: "chat", cwd: WORKSPACE_KEY,
      ...(reason === "providerBinding" ? { providerBinding: providerBindingForResume("claude", "missing-native") } : {}),
      ...(["sessionId", "executionId"].includes(reason) ? { [reason]: "missing-execution" } : {}),
      ...(reason === "foreign" ? { workspaceId: "another-workspace" } : {}) });
    expect(reply).toMatchObject({ type: "AGENT_ERROR" });
    expect(reply).not.toHaveProperty("failure.kind", "session-expired");
    expect(f.drivers).toHaveLength(reason === "deleted" ? 1 : 0);
  },
);

it("adopts a first open whose metadata write is still preparing", async () => {
  const f = await setup(), held = gate(), select = SessionStore.prototype.selectAgent;
  let entered = false;
  vi.spyOn(SessionStore.prototype, "selectAgent").mockImplementation(async function (this: SessionStore, ...args) {
    entered = true; await held.promise; return select.apply(this, args);
  });
  const opening = f.open("claude");
  await expect.poll(() => entered).toBe(true);
  const loading = f.request("AGENT_LOAD_SESSION", { agentId: "claude", chatId: "chat", cwd: WORKSPACE_KEY });
  held.release();
  const created = session(await opening);
  expect(await loading).toMatchObject({ type: "AGENT_SESSION_LOADED", sessionId: created.sessionId });
  expect(f.drivers).toHaveLength(1);
});

it("rebinds Cursor → Claude → Cursor in one untouched chat, resetting settings and retiring only its driver", async () => {
  const f = await setup();
  await f.op("chats.upsert", { chat: { id: "chat", folder: WORKSPACE_KEY, agentId: "cursor", model: "old-model", effort: "high", title: "Untitled", createdAt: 100 } });
  const first = session(await f.open("cursor"));
  const other = session(await f.open("codex", "other")), neighbor = f.drivers[1].driver;
  const next = session(await f.open("claude", "chat", { ANTHROPIC_MODEL: "claude-haiku-5-5", ZEROS_THINKING_EFFORT: "low" }));
  expect(next.sessionId).not.toBe(first.sessionId);
  expect(next.providerBinding).toBeUndefined();
  expect(f.drivers[0].driver.disposed).toBe(true);
  expect(neighbor.disposed).toBe(false);
  expect(f.drivers.at(-1)!.driver.opened).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
  expect(await f.chat()).toMatchObject({ id: "chat", agentId: "claude", model: "claude-haiku-5-5", effort: "low", createdAt: 100, title: "Untitled" });
  session(await f.open("cursor"));
  expect(f.drivers.at(-1)!.driver.opened?.model).toBeUndefined();
  expect(f.drivers.at(-1)!.driver.opened?.effort).toBeUndefined();
  expect(await f.chat()).toMatchObject({ agentId: "cursor", model: null, effort: "", providerBinding: null });
  expect((await f.op("chats.list") as { chats: ChatRow[] }).chats).toHaveLength(2);
  expect((await f.request("AGENT_LOAD_SESSION", { agentId: "codex", chatId: "other", sessionId: other.sessionId, adoptOnly: true })).type).toBe("AGENT_SESSION_LOADED");
  await f.worker.flush();
  const mirrored = f.relay.frames.flatMap(frame => frame.t === "history" ? frame.chats ?? [] : []).filter(row => row.id === "chat");
  expect(mirrored.at(-1)).toMatchObject({ agentId: "cursor", model: null, effort: "", providerBinding: null });
});

it("keeps new provider ids provisional before a turn and persists the rebound selection across restart", async () => {
  const f = await setup();
  expect(session(await f.open("codex")).providerBinding).toBeUndefined();
  session(await f.open("claude", "chat", { ANTHROPIC_MODEL: "claude-haiku-5-5", ZEROS_THINKING_EFFORT: "low" }));
  await f.restart();
  const stored = await SessionStore.open(join(f.directory, "sessions"), WORKSPACE_KEY);
  expect(stored.metadata("chat")).toMatchObject({ chat: { agentId: "claude", model: "claude-haiku-5-5", effort: "low", providerBinding: null } });
  expect(stored.metadata("chat")?.nativeSessionId).toBeUndefined();
  session(await f.open("claude"));
  expect(f.drivers.at(-1)!.driver.opened).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
  session(await f.open("cursor"));
  expect(await f.chat()).toMatchObject({ agentId: "cursor", model: null, effort: "" });
});

it.each(["turn", "history", "binding"])("refuses a different agent once the chat has %s evidence", async evidence => {
  const f = await setup();
  if (evidence === "binding") await f.op("chats.upsert", { chat: { id: "chat", folder: WORKSPACE_KEY, agentId: "cursor",
    sessionId: "existing-native", providerBinding: providerBindingForResume("cursor", "existing-native") } });
  const current = session(await f.open("cursor"));
  if (evidence === "turn") {
    await f.request("AGENT_PROMPT", { agentId: "cursor", sessionId: current.sessionId, chatId: "chat", prompt: [{ type: "text", text: "fixture" }] });
    await expect.poll(() => f.drivers[0].driver.prompts.length).toBe(1);
    expect((await f.chat()).providerBinding).toMatchObject({ providerId: "cursor", resumeId: `native-${current.sessionId}` });
    f.drivers[0].driver.complete(); await f.worker.flush();
  } else if (evidence === "history") {
    await f.op("messages.import", { chatId: "chat", messages: [{ msgId: "old", kind: "text", payload: JSON.stringify({ id: "old", kind: "text", role: "user", text: "fixture", createdAt: 1 }), createdAt: 1 }] });
  }
  expect(await f.open("claude")).toMatchObject({ type: "AGENT_ERROR", code: "session-expired" });
  expect(await f.chat()).toMatchObject({ agentId: "cursor" });
  expect(f.drivers).toHaveLength(1);
  expect(f.drivers[0].driver.disposed).toBe(false);
  await f.restart();
  expect(await f.open("claude")).toMatchObject({ type: "AGENT_ERROR", code: "session-expired" });
});

it("lets the latest concurrent open win without a late driver restoring the previous selection", async () => {
  const held = gate();
  let first = true;
  const f = await setup(driver => { if (first) { first = false; driver.opening = held.promise; } });
  const opening = f.open("cursor");
  let switching: Promise<BridgeMessage> | undefined, latest: Promise<BridgeMessage> | undefined;
  try {
    await expect.poll(() => f.drivers[0]?.driver.opened).toBeDefined();
    switching = f.open("claude"); latest = f.open("codex");
    held.release(); await Promise.all([opening, switching, latest]);
    const final = session(await latest);
    expect(await f.chat()).toMatchObject({ agentId: "codex", providerBinding: null });
    const live = f.drivers.filter(row => !row.driver.disposed);
    expect(live).toHaveLength(1); expect(live[0].agent).toBe("codex");
    expect(live[0].driver.opened?.sessionId).toBe(final.sessionId);
    f.drivers[0].driver.emit({ sessionUpdate: "provider_binding_update", providerBinding: providerBindingForResume("cursor", "late-native") });
    await f.worker.flush();
    expect(await f.chat()).toMatchObject({ agentId: "codex", providerBinding: null });
  } finally { held.release(); await Promise.all([opening, switching, latest]); }
});

it.each([false, true])("handles a view close during rebind (userStop=%s) without resurrecting a retired route", async userStop => {
  const f = await setup();
  session(await f.open("cursor"));
  const retiring = gate(), old = f.drivers[0].driver, dispose = old.dispose.bind(old);
  vi.spyOn(old, "dispose").mockImplementation(async () => { await dispose(); await retiring.promise; });
  const switching = f.open("claude");
  let closing: Promise<BridgeMessage> | undefined;
  try {
    await expect.poll(() => old.disposed).toBe(true);
    closing = f.request("AGENT_CLOSE_SESSION", { agentId: "claude", chatId: "chat", ...(userStop ? { userStop: true } : {}) });
    retiring.release();
    const [opened, closed] = await Promise.all([switching, closing]);
    expect(closed.type).toBe("AGENT_SESSION_CLOSED");
    expect(opened.type).toBe(userStop ? "AGENT_ERROR" : "AGENT_SESSION_CREATED");
    expect(f.drivers.filter(row => !row.driver.disposed)).toHaveLength(userStop ? 0 : 1);
    if (userStop) expect(f.drivers).toHaveLength(1);
  } finally { retiring.release(); await Promise.all([switching, closing]); }
});

it("refuses an old execution's Stop and prompt after rebinding", async () => {
  const f = await setup(), old = session(await f.open("cursor"));
  const current = session(await f.open("claude"));
  for (const type of ["AGENT_CANCEL", "AGENT_PROMPT"]) {
    const reply = await f.request(type, { agentId: "cursor", chatId: "chat", sessionId: old.sessionId,
      ...(type === "AGENT_PROMPT" ? { prompt: [{ type: "text", text: "stale" }] } : {}) });
    expect(reply).toMatchObject({ type: "AGENT_ERROR", code: "session-expired" });
  }
  const cancel = await f.request("AGENT_CANCEL", { agentId: "claude", chatId: "chat", sessionId: current.sessionId });
  expect(cancel).toMatchObject({ type: "WORKSPACE_RESPONSE", result: { conversationId: "chat", state: "cancelled" } });
  expect(f.drivers.at(-1)!.driver.prompts).toHaveLength(0);
});

it("does not let an adoption of a retired route undo an agent selection", async () => {
  const f = await setup(), old = session(await f.open("cursor"));
  const current = session(await f.open("claude"));
  expect(await f.request("AGENT_LOAD_SESSION", { agentId: "cursor", sessionId: old.sessionId, chatId: "chat", adoptOnly: true }))
    .toMatchObject({ type: "AGENT_ERROR", code: "session-expired" });
  expect(await f.chat()).toMatchObject({ agentId: "claude" });
  expect(session(await f.open("claude")).sessionId).toBe(current.sessionId);
});

it("shares concurrent opens of the same agent and fences an old execution across A → B → A", async () => {
  const f = await setup();
  const opens = await Promise.all([f.open("cursor"), f.open("cursor")]);
  const original = session(opens[0]);
  expect(session(opens[1]).sessionId).toBe(original.sessionId);
  expect(f.drivers).toHaveLength(1);
  session(await f.open("claude"));
  const current = session(await f.open("cursor"));
  const close = await f.request("AGENT_CLOSE_SESSION", { agentId: "cursor", sessionId: original.sessionId, chatId: "chat", userStop: true });
  expect(close.type).toBe("AGENT_SESSION_CLOSED");
  expect(f.drivers.at(-1)!.driver.disposed).toBe(false);
  expect((await f.request("AGENT_PROMPT", { agentId: "cursor", sessionId: original.sessionId, chatId: "chat", prompt: [{ type: "text", text: "late" }] })).type).toBe("AGENT_ERROR");
  await f.request("AGENT_PROMPT", { agentId: "cursor", sessionId: current.sessionId, chatId: "chat", prompt: [{ type: "text", text: "current" }] });
  await expect.poll(() => f.drivers.at(-1)!.driver.prompts.length).toBe(1);
});

it("refuses rebinding once a first Send is admitted, including while its durable enqueue is held", async () => {
  const f = await setup(), current = session(await f.open("cursor"));
  const held = gate(), enqueue = SessionStore.prototype.enqueue;
  let entered = false;
  vi.spyOn(SessionStore.prototype, "enqueue").mockImplementation(async function (this: SessionStore, ...args) {
    entered = true; await held.promise; return enqueue.apply(this, args);
  });
  const sending = f.request("AGENT_PROMPT", { agentId: "cursor", sessionId: current.sessionId, chatId: "chat", prompt: [{ type: "text", text: "first" }] });
  try {
    await expect.poll(() => entered).toBe(true);
    expect(await f.open("claude")).toMatchObject({ type: "AGENT_ERROR", code: "session-expired" });
    expect(f.drivers[0].driver.disposed).toBe(false);
  } finally { held.release(); await sending; }
  await expect.poll(() => f.drivers[0].driver.prompts.length).toBe(1);
});

it("refuses a late Send when the renderer has saved the new agent but has not opened it yet", async () => {
  const f = await setup(), old = session(await f.open("cursor"));
  await f.op("chats.upsert", { chat: { ...(await f.chat()), agentId: "claude", model: "claude-haiku-5-5", effort: "low" } });
  expect(await f.request("AGENT_PROMPT", { agentId: "cursor", sessionId: old.sessionId, chatId: "chat", prompt: [{ type: "text", text: "late" }] }))
    .toMatchObject({ type: "AGENT_ERROR", code: "session-expired" });
  expect(await f.op("messages.window", { chatId: "chat" })).toEqual({ messages: [] });
  session(await f.open("claude"));
  expect(f.drivers[0].driver.prompts).toHaveLength(0);
  expect(f.drivers[1].driver.opened).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
});

it("keeps provider-binding notifications from an empty open provisional", async () => {
  const f = await setup(driver => {
    const open = driver.open.bind(driver);
    vi.spyOn(driver, "open").mockImplementation(async input => {
      const result = await open(input);
      driver.emit({ sessionUpdate: "provider_binding_update", providerBinding: providerBindingForResume("cursor", result.nativeSessionId) });
      return result;
    });
  });
  expect(session(await f.open("cursor")).providerBinding).toBeUndefined();
  await f.worker.flush();
  expect((await f.chat()).providerBinding).toBeNull();
  expect(f.relay.bridge("AGENT_SESSION_UPDATE").some(({ frame }) => frame.type === "AGENT_SESSION_UPDATE" && frame.notification.update.sessionUpdate === "provider_binding_update")).toBe(false);
});

it("saves already received stream events when Stop closes the current execution", async () => {
  const f = await setup(), current = session(await f.open("cursor")), held = gate();
  await f.request("AGENT_PROMPT", { agentId: "cursor", sessionId: current.sessionId, chatId: "chat", prompt: [{ type: "text", text: "first" }] });
  await expect.poll(() => f.drivers[0].driver.prompts.length).toBe(1);
  const fold = SessionStore.prototype.fold;
  let entered = false;
  vi.spyOn(SessionStore.prototype, "fold").mockImplementation(async function (this: SessionStore, ...args) {
    entered = true; await held.promise; return fold.apply(this, args);
  });
  f.drivers[0].driver.emit({ sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "one " } });
  await expect.poll(() => entered).toBe(true);
  f.drivers[0].driver.emit({ sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "two" } });
  const closing = f.request("AGENT_CLOSE_SESSION", { agentId: "cursor", sessionId: current.sessionId, chatId: "chat", userStop: true });
  try { await expect.poll(() => f.drivers[0].driver.disposed).toBe(true); }
  finally { held.release(); await closing; }
  const page = await f.op("messages.window", { chatId: "chat" }) as { messages: Array<{ msgId: string; payload: string }> };
  expect(page.messages.map(row => JSON.parse(row.payload)).find(row => row.messageId === "answer")?.text).toBe("one two");
});

// Waking a stopped VM restarts its worker. The renderer still holds each open
// chat's execution, so a Send, Stop or model change for it must not fail as
// "This execution has ended" and strand the chat.
describe("a worker restart", () => {
  const prompt = (sessionId: string, text: string) => browserFrame("AGENT_PROMPT", { agentId: "claude", sessionId, executionId: sessionId, prompt: [{ type: "text", text }] });
  async function finish(f: Awaited<ReturnType<typeof setup>>, frame: ReturnType<typeof browserFrame>, driverIndex: number) {
    await f.relay.request(CLIENT_A, frame);
    await expect.poll(() => f.drivers[driverIndex]?.driver.prompts.length).toBe(1);
    f.drivers[driverIndex].driver.complete(); await f.worker.flush();
    await expect.poll(() => f.relay.response(frame.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
  }

  it("keeps the chat's execution, so the next Send resumes the same native conversation", async () => {
    const f = await setup(), current = session(await f.open("claude"));
    await finish(f, prompt(current.sessionId, "before"), 0);
    await f.restart();
    // Reconnect probes stay misses; only real work starts a native process.
    expect(await f.request("AGENT_LOAD_SESSION", { agentId: "claude", sessionId: current.sessionId, chatId: "chat", cwd: WORKSPACE_KEY, adoptOnly: true }))
      .toMatchObject({ type: "AGENT_ERROR", code: "session-expired" });
    expect(f.drivers).toHaveLength(1);
    await finish(f, prompt(current.sessionId, "after"), 1);
    expect(f.drivers).toHaveLength(2);
    expect(f.drivers[1].driver.opened).toMatchObject({ sessionId: current.sessionId, nativeSessionId: `native-${current.sessionId}` });
    expect(session(await f.open("claude")).sessionId).toBe(current.sessionId);
  });

  it("confirms Stop and applies a model change for that execution", async () => {
    const f = await setup(), current = session(await f.open("claude"));
    await f.restart();
    expect(await f.request("AGENT_CANCEL", { agentId: "claude", chatId: "chat", sessionId: current.sessionId, executionId: current.sessionId }))
      .toMatchObject({ type: "WORKSPACE_RESPONSE", result: { conversationId: "chat", state: "cancelled" } });
    await f.relay.request(CLIENT_A, browserFrame("AGENT_SET_MODEL", { agentId: "claude", sessionId: current.sessionId, executionId: current.sessionId, model: "claude-haiku-5-5" }));
    await expect.poll(() => f.drivers.at(-1)?.driver.model).toBe("claude-haiku-5-5");
    expect(f.relay.bridge("AGENT_ERROR")).toHaveLength(0);
  });

  it("still refuses executions the chat replaced or closed before the restart", async () => {
    const f = await setup(), replaced = session(await f.open("cursor"));
    const current = session(await f.open("claude"));
    const closed = session(await f.open("claude", "closed"));
    expect((await f.request("AGENT_CLOSE_SESSION", { agentId: "claude", chatId: "closed", sessionId: closed.sessionId, userStop: true })).type).toBe("AGENT_SESSION_CLOSED");
    await f.restart();
    for (const [agentId, sessionId] of [["cursor", replaced.sessionId], ["claude", closed.sessionId]] as const)
      expect(await f.request("AGENT_PROMPT", { agentId, sessionId, prompt: [{ type: "text", text: "stale" }] }))
        .toMatchObject({ type: "AGENT_ERROR", code: "session-expired" });
    expect(await f.request("AGENT_PROMPT", { agentId: "claude", sessionId: current.sessionId, chatId: "closed", prompt: [{ type: "text", text: "foreign" }] }))
      .toMatchObject({ type: "AGENT_ERROR", code: "session-expired" });
    expect(f.drivers.every(row => row.driver.prompts.length === 0)).toBe(true);
    await finish(f, prompt(current.sessionId, "current"), 3);
  });
});
