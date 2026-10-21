import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_V2_MAX_HISTORY_ROWS, CloudV2WorkerFrameSchema } from "@zeros/protocol/cloud-v2-relay";
import { MIN_SUPPORTED_PROTOCOL, PROTOCOL_VERSION } from "@zeros/protocol/version";
import type { BridgeMessage, SteerOutcome } from "@zeros/protocol/messages";
import { CloudWorker } from "../worker";
import { SessionStore } from "../sessions/session-store";
import { UNSUPPORTED_CHAT_OPS } from "../workspace/chat-service";
import { CLIENT_A, CLIENT_B, WORKSPACE_ID, WORKSPACE_KEY, FakeDriver, FakeRelay, browserFrame, config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(driverSetup?: (driver: FakeDriver) => void) {
  const directory = await mkdtemp(join(tmpdir(), "zeros-worker-routing-"));
  const relay = new FakeRelay();
  const drivers: FakeDriver[] = [];
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, drivers: { codex: () => {
    const driver = new FakeDriver(); driverSetup?.(driver); drivers.push(driver); return driver;
  } } });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  worker.start();
  await relay.receive(config);
  await relay.receive({ t: "open", clientId: CLIENT_A });
  await relay.receive({ t: "open", clientId: CLIENT_B });
  async function op(op: string, params: Record<string, unknown> = {}, clientId = CLIENT_A) {
    const request = browserFrame("WORKSPACE_REQUEST", { op, params });
    await relay.request(clientId, request);
    await expect.poll(() => relay.response(request.id)).toBeDefined();
    return relay.response(request.id)! as Extract<BridgeMessage, { type: "WORKSPACE_RESPONSE" | "WORKSPACE_ERROR" }>;
  }
  async function chat(id = "chat") {
    await op("chats.upsert", { chat: { id, folder: WORKSPACE_KEY, agentId: "codex", title: "Fixture", createdAt: 100 } });
    const request = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: id, cwd: WORKSPACE_KEY, workspaceId: WORKSPACE_ID });
    await relay.request(CLIENT_A, request);
    const response = relay.response(request.id) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
    expect(response.type).toBe("AGENT_SESSION_CREATED");
    return response.session.sessionId;
  }
  const prompt = (sessionId: string, id: string = randomUUID()) => browserFrame("AGENT_PROMPT", {
    agentId: "codex", sessionId, userMessageId: `user-${id}`, prompt: [{ type: "text", text: id }], id,
  });
  return { directory, relay, drivers, worker, op, chat, prompt };
}

describe("worker bridge routing through a fake relay", () => {
  it("sends hello and the normal ENGINE_READY handshake without a VM path", async () => {
    const { relay } = await setup();
    expect(relay.frames[0]).toMatchObject({ t: "hello", capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex", "claude", "cursor"] } });
    expect(relay.bridge("ENGINE_READY").map((item) => item.clientId)).toEqual([CLIENT_A, CLIENT_B]);
    expect(relay.bridge("ENGINE_READY")[0].frame).toMatchObject({ source: "engine", root: "", protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_SUPPORTED_PROTOCOL });
    await relay.request(CLIENT_A, browserFrame("CONNECTED", { protocolVersion: PROTOCOL_VERSION + 1, capabilities: [] }));
    expect(relay.bridge("CONNECTION_REJECTED")[0].clientId).toBe(CLIENT_A);
  });

  it("routes replies to their client and shared updates to all clients using authoritative chat identity", async () => {
    const { relay, drivers, chat, prompt, op } = await setup();
    const sessionId = await chat();
    const request = prompt(sessionId);
    await relay.request(CLIENT_A, request);
    await expect.poll(() => drivers[0].prompts.length).toBe(1);
    drivers[0].emit({ sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "Done" } });
    drivers[0].complete();
    await expect.poll(() => relay.response(request.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
    expect(relay.bridge("AGENT_PROMPT_COMPLETE")[0].clientId).toBe(CLIENT_A);
    expect(relay.bridge("AGENT_SESSION_UPDATE").some(({ clientId, frame }) => clientId === "*" && "chatId" in frame && frame.chatId === "chat")).toBe(true);
    const page = await op("messages.window", { chatId: "chat" }, CLIENT_B);
    expect(page).toMatchObject({ type: "WORKSPACE_RESPONSE", result: { messages: [{ msgId: request.userMessageId }, { kind: "text" }] } });
    expect(relay.frames.some((frame) => frame.t === "history" && frame.messages?.chatId === "chat")).toBe(true);
    expect(relay.frames.filter((frame) => !CloudV2WorkerFrameSchema.safeParse(frame).success)).toEqual([]);
  });

  it("adopts one live chat on another client and deduplicates prompts before and after completion", async () => {
    const { relay, drivers, chat, prompt } = await setup();
    const sessionId = await chat();
    const load = browserFrame("AGENT_LOAD_SESSION", { agentId: "codex", chatId: "chat", sessionId, adoptOnly: true });
    await relay.request(CLIENT_B, load);
    expect(relay.response(load.id)).toMatchObject({ type: "AGENT_SESSION_LOADED", sessionId, promptActive: false });
    expect(drivers).toHaveLength(1);
    const first = prompt(sessionId);
    await relay.request(CLIENT_A, first);
    await relay.request(CLIENT_B, { ...first, id: "duplicate-envelope" });
    await expect.poll(() => drivers[0].prompts.length).toBe(1);
    drivers[0].complete();
    await expect.poll(() => relay.response("duplicate-envelope")?.type).toBe("AGENT_PROMPT_COMPLETE");
    await relay.request(CLIENT_B, { ...first, id: "completed-retry" });
    expect(relay.response("completed-retry")?.type).toBe("AGENT_PROMPT_COMPLETE");
    expect(drivers[0].prompts).toHaveLength(1);
  });

  it("keeps working after disconnect, then backfills history on reconnect without replaying a prompt", async () => {
    const { relay, drivers, worker, chat, prompt, op } = await setup();
    const sessionId = await chat();
    await relay.request(CLIENT_A, prompt(sessionId));
    await expect.poll(() => drivers[0].prompts.length).toBe(1);
    relay.disconnect();
    drivers[0].emit({ sessionUpdate: "agent_message_chunk", messageId: "offline", content: { type: "text", text: "Finished while closed" } });
    drivers[0].complete();
    await worker.flush();
    const before = relay.frames.length;
    await relay.reconnect();
    await relay.receive(config);
    await relay.receive({ t: "open", clientId: CLIENT_B });
    await worker.flush();
    expect(relay.frames[before].t).toBe("hello");
    expect(relay.frames.slice(before).some((frame) => frame.t === "history" && frame.messages?.rows.some((row) => row.payload.includes("Finished while closed")))).toBe(true);
    const page = await op("messages.window", { chatId: "chat" }, CLIENT_B);
    expect(page.type).toBe("WORKSPACE_RESPONSE");
    expect(drivers[0].prompts).toHaveLength(1);
    expect(drivers[0].disposed).toBe(false);
  });

  it("Stop preserves queued prompts until a new explicit send resumes them", async () => {
    const { relay, drivers, chat, prompt } = await setup();
    const sessionId = await chat();
    const first = prompt(sessionId, "first");
    await relay.request(CLIENT_A, first);
    await expect.poll(() => drivers[0].prompts.length).toBe(1);
    await relay.request(CLIENT_A, prompt(sessionId, "queued"));
    await relay.request(CLIENT_A, browserFrame("AGENT_CANCEL", { agentId: "codex", sessionId }));
    await expect.poll(() => relay.response(first.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
    expect(relay.response(first.id)).toMatchObject({ stopReason: "cancelled" });
    expect(drivers[0].prompts).toHaveLength(1);
    await relay.request(CLIENT_B, prompt(sessionId, "explicit"));
    await expect.poll(() => drivers[0].prompts.length).toBe(2);
    expect(drivers[0].prompts[1]).toEqual([{ type: "text", text: "explicit" }]);
    drivers[0].complete();
    await expect.poll(() => drivers[0].prompts.length).toBe(3);
    expect(drivers[0].prompts[2]).toEqual([{ type: "text", text: "queued" }]);
    drivers[0].complete();
  });

  it("applies full replacement logins to idle/new children while active turns retain their spawn config", async () => {
    const { relay, drivers, chat, prompt } = await setup();
    const sessionId = await chat();
    const first = prompt(sessionId);
    await relay.request(CLIENT_A, first);
    await expect.poll(() => drivers[0].prompts.length).toBe(1);
    const refreshed = { ...config, agents: { codex: { ...config.agents.codex!, token: "fixture-fresh-token" } } };
    await relay.receive(refreshed);
    expect(drivers[0].disposed).toBe(false);
    drivers[0].complete();
    await expect.poll(() => relay.response(first.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
    await relay.request(CLIENT_A, prompt(sessionId));
    await expect.poll(() => drivers.length).toBe(2);
    await expect.poll(() => drivers[1].prompts.length).toBe(1);
    expect(drivers[1].opened?.nativeSessionId === `native-${sessionId}`).toBe(true);
    expect(drivers[1].opened?.proxy?.token === refreshed.agents.codex.token).toBe(true);
    expect(drivers[0].disposed).toBe(true);
    drivers[1].complete();
    await relay.receive({ ...config, agents: {} });
    const denied = prompt(sessionId);
    await relay.request(CLIENT_A, denied);
    await expect.poll(() => relay.response(denied.id)?.type).toBe("AGENT_PROMPT_FAILED");
    expect(drivers).toHaveLength(2);
  });

  it("retains exact steering receipts so retries never inject twice", async () => {
    let resolve!: (value: SteerOutcome) => void;
    const result = new Promise<SteerOutcome>((yes) => { resolve = yes; });
    const { relay, drivers, chat, prompt, op } = await setup((driver) => { driver.steerResult = result; });
    const sessionId = await chat();
    const running = prompt(sessionId, "opening");
    await relay.request(CLIENT_A, running);
    await expect.poll(() => drivers[0].prompts.length).toBe(1);
    const steer = browserFrame("AGENT_STEER", { agentId: "codex", sessionId, attemptId: "attempt", userMessageId: "user-steer", prompt: [{ type: "text", text: "Change course" }] });
    const first = relay.request(CLIENT_A, steer);
    await expect.poll(() => drivers[0].steers.length).toBe(1);
    const second = relay.request(CLIENT_B, { ...steer, id: "retry" });
    resolve("delivered");
    await Promise.all([first, second]);
    expect(drivers[0].steers).toHaveLength(1);
    expect(relay.response("retry")).toMatchObject({ type: "AGENT_STEERED", outcome: "delivered", turnId: "user-opening" });
    drivers[0].complete();
    await expect.poll(() => relay.response(running.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
    await relay.request(CLIENT_A, { ...steer, id: "late-retry" });
    expect(drivers[0].steers).toHaveLength(1);
    expect(relay.response("late-retry")).toMatchObject({ outcome: "delivered" });
    const page = await op("messages.window", { chatId: "chat" });
    expect(page).toMatchObject({ result: { messages: [{ msgId: "user-opening" }, { msgId: "user-steer" }] } });
  });

  it("keeps the active child during config refresh and live adoption, including background activity", async () => {
    const { relay, drivers, chat, prompt } = await setup();
    const sessionId = await chat();
    const running = prompt(sessionId);
    await relay.request(CLIENT_A, running);
    await expect.poll(() => drivers[0].prompts.length).toBe(1);
    await relay.receive({ ...config, agents: { codex: { ...config.agents.codex!, token: "fixture-refreshed-login" } } });
    const adopt = browserFrame("AGENT_LOAD_SESSION", { agentId: "codex", chatId: "chat", sessionId, adoptOnly: true });
    await relay.request(CLIENT_B, adopt);
    expect(drivers).toHaveLength(1);
    expect(drivers[0].disposed).toBe(false);
    drivers[0].emit({ sessionUpdate: "background_tasks_update", tasks: [], waiting: false, activity: { state: "running", startedAt: 1 } });
    drivers[0].complete();
    await expect.poll(() => relay.response(running.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
    await relay.request(CLIENT_B, prompt(sessionId));
    expect(drivers).toHaveLength(1);
    expect(relay.frames.filter((frame) => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: false });
    drivers[0].emit({ sessionUpdate: "background_tasks_update", tasks: [], waiting: false, activity: null });
    await expect.poll(() => drivers.length).toBe(2);
    await expect.poll(() => drivers[1].prompts.length).toBe(1);
    drivers[1].complete();
  });

  it("keeps Stop effective while a refreshed driver is still opening", async () => {
    let hold = false, release!: () => void;
    const { relay, drivers, chat, prompt } = await setup((driver) => {
      if (hold) driver.opening = new Promise<void>((resolve) => { release = resolve; });
    });
    const sessionId = await chat();
    hold = true;
    await relay.receive({ ...config, agents: { codex: { ...config.agents.codex!, token: "fixture-refreshed-login" } } });
    const request = prompt(sessionId);
    await relay.request(CLIENT_A, request);
    await expect.poll(() => drivers.length).toBe(2);
    await relay.request(CLIENT_B, browserFrame("AGENT_CANCEL", { agentId: "codex", sessionId }));
    release();
    await expect.poll(() => relay.response(request.id)).toMatchObject({ type: "AGENT_PROMPT_COMPLETE", stopReason: "cancelled" });
    expect(drivers[1].prompts).toHaveLength(0);
  });

  it("does not deliver an old caller's late reply to a replacement socket with the same id", async () => {
    const { relay, drivers, worker, chat, prompt } = await setup();
    const sessionId = await chat();
    const request = prompt(sessionId);
    await relay.request(CLIENT_A, request);
    await expect.poll(() => drivers[0].prompts.length).toBe(1);
    await relay.receive({ t: "close", clientId: CLIENT_A });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    drivers[0].complete();
    await worker.flush();
    expect(relay.response(request.id)).toBeUndefined();
    await relay.request(CLIENT_A, { ...request, id: "recover-receipt" });
    expect(relay.response("recover-receipt")?.type).toBe("AGENT_PROMPT_COMPLETE");
    expect(drivers[0].prompts).toHaveLength(1);
  });

  it("view close leaves shared work running; explicit user Stop closes the execution", async () => {
    const { relay, drivers, chat, prompt } = await setup();
    const sessionId = await chat();
    const request = prompt(sessionId);
    await relay.request(CLIENT_A, request);
    await expect.poll(() => drivers[0].prompts.length).toBe(1);
    const close = browserFrame("AGENT_CLOSE_SESSION", { agentId: "codex", sessionId, chatId: "chat" });
    await relay.request(CLIENT_A, close);
    expect(relay.response(close.id)?.type).toBe("AGENT_SESSION_CLOSED");
    expect(drivers[0].disposed).toBe(false);
    await relay.request(CLIENT_B, { ...close, id: "stop", userStop: true });
    expect(drivers[0].disposed).toBe(true);
    expect(relay.response(request.id)).toMatchObject({ type: "AGENT_PROMPT_COMPLETE", stopReason: "cancelled" });
  });

  it("honors Stop while the initial chat metadata write is still pending", async () => {
    const { relay, drivers } = await setup();
    const create = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "new-chat", cwd: WORKSPACE_KEY });
    const opening = relay.request(CLIENT_A, create);
    const stopped = relay.request(CLIENT_B, browserFrame("AGENT_CLOSE_SESSION", { agentId: "codex", chatId: "new-chat", userStop: true }));
    await Promise.all([opening, stopped]);
    expect(drivers).toHaveLength(0);
    expect(relay.response(create.id)?.type).toBe("AGENT_ERROR");
  });

  it("does not resurrect an app socket closed during first-config preparation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zeros-worker-opening-"));
    const relay = new FakeRelay();
    let release!: () => void;
    const preparing = new Promise<void>((resolve) => { release = resolve; });
    const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: () => preparing });
    cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
    worker.start();
    const configuring = relay.receive(config);
    const opening = relay.receive({ t: "open", clientId: CLIENT_A });
    await relay.receive({ t: "close", clientId: CLIENT_A });
    release();
    await Promise.all([configuring, opening]);
    expect(relay.bridge("ENGINE_READY")).toHaveLength(0);
  });

  it("fails the waiting prompt cleanly when its final durable write fails", async () => {
    const { relay, drivers, chat, prompt } = await setup();
    const sessionId = await chat();
    const request = prompt(sessionId);
    await relay.request(CLIENT_A, request);
    await expect.poll(() => drivers[0].prompts.length).toBe(1);
    vi.spyOn(SessionStore.prototype, "finish").mockRejectedValueOnce(new Error("Fixture disk failure."));
    drivers[0].complete();
    await expect.poll(() => relay.response(request.id)?.type).toBe("AGENT_PROMPT_FAILED");
    expect(drivers[0].disposed).toBe(true);
    expect(relay.bridge("AGENT_SESSION_UPDATE").some(({ frame }) => "notification" in frame && frame.notification.update.sessionUpdate === "turn_state" && frame.notification.update.state === "failed")).toBe(true);
  });

  it("refuses foreign roots, engine-originated client frames and unknown execution routes", async () => {
    const { relay, drivers, op } = await setup();
    expect(await op("chats.upsert", { chat: { id: "foreign", folder: "cloud://other/owner" } })).toMatchObject({ type: "WORKSPACE_ERROR", code: "WORKSPACE_NOT_FOUND" });
    const forged = browserFrame("AGENT_NEW_SESSION", { source: "engine", agentId: "codex", chatId: "chat" });
    await relay.request(CLIENT_A, forged);
    expect(relay.response(forged.id)).toBeUndefined();
    expect(drivers).toHaveLength(0);
    const steer = browserFrame("AGENT_STEER", { agentId: "codex", sessionId: "retired", attemptId: "unknown", prompt: [{ type: "text", text: "uncertain retry" }] });
    await relay.request(CLIENT_A, steer);
    expect(relay.response(steer.id)).toMatchObject({ type: "AGENT_STEERED", outcome: "interrupted" });
  });

  it("mirrors all chat writes, bounded history batches, and permanent deletion tombstones", async () => {
    const { relay, op, worker } = await setup();
    await op("chats.bulkUpsert", { chats: [{ id: "chat", folder: WORKSPACE_KEY, agentId: "codex" }, { id: "other", folder: WORKSPACE_KEY }] });
    const messages = Array.from({ length: 1001 }, (_, i) => ({ msgId: `m${i}`, kind: "text", createdAt: 1, payload: JSON.stringify({ id: `m${i}`, kind: "text", role: "agent", text: `message ${i}`, createdAt: 1 }) }));
    expect(await op("messages.import", { chatId: "chat", messages })).toMatchObject({ result: { ok: true, imported: 1001 } });
    await worker.flush();
    const batches = relay.frames.flatMap((frame) => frame.t === "history" && frame.messages?.chatId === "chat" ? [frame.messages.rows] : []);
    expect(batches.every((batch) => batch.length <= CLOUD_V2_MAX_HISTORY_ROWS)).toBe(true);
    expect(new Set(batches.flat().map((row) => row.msgId)).size).toBe(1001);
    await op("chats.delete", { id: "chat" });
    expect(await op("chats.list")).toMatchObject({ result: { chats: [{ id: "other" }], chatDeletions: ["chat"] } });
    expect(await op("chats.upsert", { chat: { id: "chat", folder: WORKSPACE_KEY } })).toMatchObject({ type: "WORKSPACE_ERROR" });
    expect(relay.frames.some((frame) => frame.t === "history" && frame.chatDeletions?.includes("chat"))).toBe(true);
  });

  it("answers the renderer's native chat paths with native rows on the bridge and history mirror", async () => {
    const { relay, op, worker } = await setup();
    await op("chats.upsert", { chat: { id: "native-chat", folder: config.workspace.checkoutPath, agentId: "codex" } });
    expect(await op("chats.list")).toMatchObject({ result: { chats: [{ id: "native-chat", folder: config.workspace.checkoutPath }] } });
    await worker.flush();
    expect(relay.frames.some((frame) => frame.t === "history" && frame.chats?.some((chat) => chat.id === "native-chat" && chat.folder === config.workspace.checkoutPath))).toBe(true);
  });

  it("exposes the deferred chat operations as explicit unsupported errors", async () => {
    const { op } = await setup();
    expect(UNSUPPORTED_CHAT_OPS).toEqual([
      "messages.clear", "messages.truncateFrom", "chats.summariesForFolder", "turns.list", "turns.get", "turns.diff", "turns.reset", "turns.undoReset", "messages.search", "chats.titleSeeds",
    ]);
    for (const name of UNSUPPORTED_CHAT_OPS) expect(await op(name)).toMatchObject({ type: "WORKSPACE_ERROR", code: "CLOUD_V2_UNSUPPORTED", op: name });
  });
});
