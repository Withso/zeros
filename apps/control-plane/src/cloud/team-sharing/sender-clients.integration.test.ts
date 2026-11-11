import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";

// Integration resolves the real desktop sources beside the control plane;
// an isolated checkout can pin the same sources through the existing override.
const root = new URL(process.env.CLOUD_API_TEST_CLIENT_ROOT ?? "../../../../../", import.meta.url);
const source = (path: string) => new URL(`apps/desktop/src/renderer/${path}`, root);
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type Call = { method: string; path: string; teamHeader: string | null; body: any; status?: number; reply?: any };
type Target = { organizationId: string; workspaceId: string };

database("real desktop sender readers against the sharing router and PostgreSQL", () => {
  let pool: pg.Pool, f: TeamSharingFixture, clients: Record<string, any>, actor: AuthedUser;
  let calls: Call[], roles: Map<string, string>;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, statement_timeout: 3000 });
    // Account and native context come from the fixture; serialization, role
    // headers, response decoding and the sender cache remain production code.
    vi.doMock(source("platform/runtime.ts").pathname, () => ({ isElectron: () => true, isLocalDevelopment: () => false,
      nativeInvoke: async () => ({ version: "1.0.0", runtimeMode: "dev" }), nativeListen: async () => () => {} }));
    vi.doMock(source("features/auth/auth-store.ts").pathname, () => ({ getSession: async () => ({ access_token: "synthetic-desktop-session" }) }));
    vi.doMock(source("features/team/team-store.ts").pathname, () => ({ getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({}) }));
    vi.doMock(source("features/team/control-plane.ts").pathname, () => ({ CONTROL_PLANE_URL: "https://api.example.test",
      ControlPlaneError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } } }));
    vi.doMock(source("config/release-channel.ts").pathname, () => ({ isFeatureEnabled: () => true, CHANNEL: "alpha" }));
    clients = Object.assign({}, ...await Promise.all([
      "platform/chat-senders.ts", "platform/chat-senders-lookup.ts", "platform/cloud-v2.ts", "platform/team-sharing-registry.ts",
    ].map(path => import(source(path).href))));
  });
  beforeEach(async () => {
    f = await teamSharingFixture(pool); actor = f.viewer; calls = []; roles = new Map();
    clients.clearChatSenders(); clients.resetChatSenderLookupsForTests();
    clients.registerSharingRoleLookup((id: string) => roles.get(id));
    vi.stubGlobal("fetch", (async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (url.origin !== "https://api.example.test") throw new Error("Unexpected sender fixture origin");
      const call: Call = { method: request.method, path: url.pathname, teamHeader: request.headers.get("X-Zeros-Team-Sharing"),
        body: request.body ? await request.clone().json() : undefined };
      calls.push(call);
      const headers = new Headers(request.headers); headers.set("x-test-actor", actor.id);
      const response = await f.app.fetch(new Request(request, { headers }));
      call.reply = await response.clone().json(); call.status = response.status;
      return response;
    }) satisfies typeof fetch);
  });
  afterEach(() => {
    clients?.resetChatSenderLookupsForTests(); clients?.clearChatSenders();
    clients?.registerSharingRoleLookup(() => undefined);
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  afterAll(() => pool?.end());

  const target = (workspaceId = f.workspace.id): Target => ({ organizationId: f.organizationId, workspaceId });
  async function document(value = target()) {
    const result = clients.cloudV2Document(await clients.getCloudV2Workspace(value));
    roles.set(value.workspaceId, result.sharing.viewerRole);
    return result;
  }
  async function send(workspaceId = f.workspace.id, person = f.creator, userMessageId = randomUUID(), chatId = "chat") {
    const response = await f.call(`/v1/cloud-v2/workspaces/${workspaceId}/prompts`, "POST", {
      chatId, userMessageId, agentId: "codex", startedAt: 123, prompt: [{ type: "text", text: "Sender fixture" }],
    }, person, false);
    expect(response.status).toBe(201);
    await pool.query("UPDATE cloud_v2_prompt_outbox SET state='completed',terminal_at=now(),payload=NULL,payload_bytes=0 WHERE workspace_id=$1", [workspaceId]);
    await f.store.transition(workspaceId, ["starting"], "stopped");
    return userMessageId;
  }
  const row = (msgId: string, role = "user") => ({ msgId, kind: "text", createdAt: 123,
    payload: JSON.stringify({ id: msgId, kind: "text", role, text: "Transcript" }) });
  const lookups = () => calls.filter(call => call.body?.op === "messages.senders");
  const workspaceState = async (id = f.workspace.id) => (await pool.query(
    "SELECT state,active_at,updated_at,worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0];

  it("opts a Creator's new sender lookup in while ordinary history remains headerless", async () => {
    const id = await send(); actor = f.creator; await document(); calls = [];
    const before = await workspaceState();
    clients.lookupChatSender(target(), "chat", id);
    await expect.poll(() => lookups().filter(call => call.status !== undefined).length).toBe(1);
    const request = lookups()[0]!;
    expect(request.status, JSON.stringify(request)).toBe(200);
    expect(request.teamHeader).toBe("1");
    expect(request.body).toEqual({ op: "messages.senders", params: { chatId: "chat", userMessageIds: [id] } });
    await expect.poll(() => clients.chatSender(clients.chatKeyFor(target(), "chat"), id)).toBe(f.creator.id);
    expect(await workspaceState()).toEqual(before);
  });

  it.each(["admin", "viewer"] as const)("looks up and caches bounded pre-mirror sender batches as %s", async person => {
    const id = await send(); actor = f[person];
    await document(); calls = []; f.fetcher.mockClear();
    const before = await workspaceState(), ids = [id, ...Array.from({ length: 249 }, (_, n) => `unknown-${n}`)];
    expect((await pool.query("SELECT 1 FROM cloud_v2_messages WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
    for (const messageId of ids) clients.lookupChatSender(target(), "chat", messageId);
    clients.lookupChatSender(target(), "chat", id);
    clients.lookupChatSender(target(), "chat", "x".repeat(257));
    await expect.poll(() => lookups().filter(call => call.status !== undefined).length).toBe(2);
    expect(lookups().map(call => call.status)).toEqual([200, 200]);
    expect(lookups().map(call => [call.method, call.teamHeader, call.body.params.chatId, call.body.params.userMessageIds.length]))
      .toEqual([["POST", "1", "chat", 200], ["POST", "1", "chat", 50]]);
    const key = clients.chatKeyFor(target(), "chat");
    await expect.poll(() => clients.chatSender(key, ids.at(-1))).toBeNull();
    expect(clients.chatSender(key, id)).toBe(f.creator.id);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      for (const messageId of ids) clients.lookupChatSender(target(), "chat", messageId);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lookups()).toHaveLength(2);
    } finally { vi.useRealTimers(); }
    expect(await workspaceState()).toEqual(before); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["creator", "admin", "viewer"] as const)("keeps ordinary history's role headers and sender maps as %s", async person => {
    const id = await send(); actor = f[person]; await document(); calls = [];
    const messages = [row(id), row("legacy"), row("assistant", "assistant")];
    await f.store.writeHistory(f.workspace.id, { messages: { chatId: "chat", rows: messages } });
    const result = await clients.keepHistorySenders(clients.readCloudV2History)(target(), "messages.window", { chatId: "chat" });
    const request = calls.find(call => call.body?.op === "messages.window")!;
    expect(request.status).toBe(200); expect(result).toEqual(request.reply.result); expect(result.messages).toEqual(messages);
    const key = clients.chatKeyFor(target(), "chat");
    if (person === "creator") {
      expect(request.teamHeader).toBeNull(); expect(result).not.toHaveProperty("senders");
      expect(clients.chatSender(key, id)).toBeUndefined();
    } else {
      expect(request.teamHeader).toBe("1");
      expect(clients.chatSender(key, id)).toBe(f.creator.id); expect(clients.chatSender(key, "legacy")).toBeNull();
    }
    expect(clients.chatSender(clients.chatKeyFor(target(), "another-chat"), id)).toBeUndefined();
  });

  it("keeps attribution for an oversized turn's separate opening", async () => {
    const id = await send(); await document();
    const opening = row(id), messages = [opening, ...Array.from({ length: 1100 }, (_, n) => row(`assistant-${n}`, "assistant"))];
    await f.store.writeHistory(f.workspace.id, { messages: { chatId: "chat", rows: messages } });
    const result = await clients.keepHistorySenders(clients.readCloudV2History)(target(), "messages.window", { chatId: "chat", limit: 1000 });
    expect(result.messages).toHaveLength(1000); expect(result.turnOpening).toEqual(opening);
    expect(clients.chatSender(clients.chatKeyFor(target(), "chat"), id)).toBe(f.creator.id);
  });

  it("keeps the same message id separate across a teammate's and the viewer's own workspace", async () => {
    const id = await send(); await send(f.own.id, f.viewer, id);
    const first = target(), second = target(f.own.id);
    await document(first); await document(second); calls = [];
    clients.lookupChatSender(first, "chat", id); clients.lookupChatSender(second, "chat", id);
    await expect.poll(() => lookups().filter(call => call.status !== undefined).length).toBe(2);
    expect(lookups().map(call => call.status)).toEqual([200, 200]);
    await expect.poll(() => clients.chatSender(clients.chatKeyFor(second, "chat"), id)).toBe(f.viewer.id);
    expect(clients.chatSender(clients.chatKeyFor(first, "chat"), id)).toBe(f.creator.id);
  });

  it("does not cache a sender map refused after membership is revoked during the read", async () => {
    const id = await send(); await document(); calls = [];
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = f.store.messageSenders.bind(f.store);
    vi.spyOn(f.store, "messageSenders").mockImplementationOnce(async (...args) => { const value = await original(...args); entered(); await held; return value; });
    const pending = clients.keepHistorySenders(clients.readCloudV2History)(target(), "messages.senders", { chatId: "chat", userMessageIds: [id] });
    const refused = expect(pending).rejects.toMatchObject({ status: 404 });
    await reached;
    try { await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]); }
    finally { release(); }
    await refused;
    expect(lookups()[0]).toMatchObject({ status: 404, reply: { error: { code: "not_found" } } });
    expect(clients.chatSender(clients.chatKeyFor(target(), "chat"), id)).toBeUndefined();
  });
});
