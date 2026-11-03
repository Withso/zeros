import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { CloudWorker } from "../worker";
import { SessionStore } from "../sessions/session-store";
import { CLIENT_A, FakeDriver, FakeRelay, WORKSPACE_KEY, browserFrame, config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const serverId = "33333333-3333-4333-8333-333333333333";
async function setup(prepare?: (driver: FakeDriver) => void) {
  const directory = await mkdtemp(join(tmpdir(), "cloud-mcp-failures-")), root = join(directory, "checkout");
  await mkdir(root);
  const authorize = vi.fn(async () => { throw Object.assign(new Error("PRIVATE_SERVER_DIAGNOSTIC"), { code: "mcp_auth_required" }); });
  const relay = Object.assign(new FakeRelay(), { mcpAuthorization: authorize }), drivers: FakeDriver[] = [];
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, drivers: { codex: () => {
    const driver = new FakeDriver(); prepare?.(driver); drivers.push(driver); return driver;
  } } });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  const configuration = { ...config, workspace: { ...config.workspace, checkoutPath: root }, mcpServers: [
    { id: serverId, name: "fixture", transport: "http" as const, url: "https://mcp.example.test", auth: "oauth" as const },
  ] };
  worker.start(); await relay.receive(configuration); await relay.receive({ t: "open", clientId: CLIENT_A });
  const request = async (type: string, fields: Record<string, unknown> = {}) => {
    const frame = browserFrame(type, { agentId: "codex", ...fields });
    await relay.request(CLIENT_A, frame); await worker.flush();
    return relay.response(frame.id)!;
  };
  const open = (chatId: string) => request("AGENT_NEW_SESSION", { chatId, cwd: WORKSPACE_KEY });
  const fail = async (driver: FakeDriver) => {
    const entry = Object.values(driver.opened!.mcpServers!)[0];
    const response = await fetch(entry.url, { method: "POST", headers: { ...entry.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }) });
    await response.arrayBuffer(); await worker.flush();
  };
  const notices = () => relay.bridge("AGENT_SESSION_UPDATE").flatMap(({ frame }) => frame.type === "AGENT_SESSION_UPDATE" &&
    frame.notification.update.sessionUpdate === "error_notice" ? [{ chatId: frame.chatId, executionId: frame.executionId, update: frame.notification.update }] : []);
  const messages = async (chatId: string): Promise<AgentMessage[]> => {
    const response = await request("WORKSPACE_REQUEST", { op: "messages.window", params: { chatId } });
    if (response.type !== "WORKSPACE_RESPONSE") throw new Error("Expected history response");
    return (response.result as { messages: Array<{ payload: string }> }).messages.map(row => JSON.parse(row.payload));
  };
  return { directory, relay, worker, drivers, configuration, request, open, fail, notices, messages, authorize };
}

it("persists a server failure only in the requesting chat and deduplicates its repeated handshake", async () => {
  const f = await setup(); await f.open("a"); await f.open("b");
  await f.fail(f.drivers[0]); await f.fail(f.drivers[0]);
  expect(f.notices()).toMatchObject([{ chatId: "a", update: { severity: "warning", recoverable: true,
    cloud: { source: "mcp", serverId, reason: "sign-in-required" } } }]);
  expect((await f.messages("b")).filter(message => message.kind === "error_notice")).toEqual([]);
  await f.worker.dispose();
  const restored = await SessionStore.open(join(f.directory, "sessions"), WORKSPACE_KEY);
  expect(restored.snapshot("a")!.messages).toMatchObject([{ cloud: { source: "mcp", serverId, reason: "sign-in-required" } }]);
  expect(JSON.stringify(restored.snapshot("a")!.messages)).not.toContain("PRIVATE_SERVER_DIAGNOSTIC");
});

it("drops a late failure after the native driver failed to open", async () => {
  const f = await setup(driver => {
    driver.open = async input => { driver.opened = input; throw new Error("Native start failed"); };
  });
  expect(await f.open("a")).toMatchObject({ type: "AGENT_ERROR" });
  await f.fail(f.drivers[0]);
  expect(f.notices()).toEqual([]);
  expect(await f.messages("a")).toEqual([]);
});

it("fences old driver capabilities after sign-in replacement, even in the same execution", async () => {
  const f = await setup(); await f.open("a");
  await f.relay.receive({ ...f.configuration, loginRevision: "1" });
  await f.open("a");
  expect(f.drivers).toHaveLength(2);
  await f.fail(f.drivers[0]);
  expect(f.notices()).toEqual([]);
  await f.fail(f.drivers[1]);
  expect(f.notices()).toMatchObject([{ chatId: "a", update: { cloud: { source: "mcp", serverId } } }]);
});

it("rechecks the MCP execution inside the history serialization boundary", async () => {
  const f = await setup(); await f.open("a");
  await f.relay.receive({ ...f.configuration, loginRevision: "1" });
  const store = (f.worker as unknown as { store: SessionStore }).store;
  let release!: () => void, held!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { held = resolve; });
  const lock = (store as unknown as { serialize(id: string, action: () => Promise<void>): Promise<void> })
    .serialize("a", async () => { held(); await gate; });
  await acquired;
  const fold = vi.spyOn(store, "fold");
  const failure = f.fail(f.drivers[0]);
  try {
    await expect.poll(() => fold.mock.calls.length).toBe(1);
    const request = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "a", cwd: WORKSPACE_KEY });
    await f.relay.request(CLIENT_A, request);
    expect(f.relay.response(request.id)).toMatchObject({ type: "AGENT_SESSION_CREATED" });
    expect(f.drivers).toHaveLength(2);
  } finally { release(); await lock; }
  await failure;
  expect(f.notices()).toEqual([]);
  expect(await f.messages("a")).toEqual([]);
});

it("drops an in-flight failure after the requesting execution is stopped and replaced", async () => {
  const f = await setup();
  const opened = await f.open("a");
  if (opened.type !== "AGENT_SESSION_CREATED") throw new Error("Expected session");
  let reject!: (error: Error) => void;
  f.authorize.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const failure = f.fail(f.drivers[0]);
  await expect.poll(() => f.authorize.mock.calls.length).toBe(1);
  await f.request("AGENT_CLOSE_SESSION", { sessionId: opened.session.sessionId, userStop: true });
  await f.open("a");
  reject(Object.assign(new Error("late"), { status: 403 }));
  await failure;
  expect(f.notices()).toEqual([]);
});
