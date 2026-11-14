import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "../db.js";
import type { AuthedUser } from "../auth.js";
import { teamSharingFixture, type TeamSharingFixture } from "./team-sharing/test-fixture.js";

// A separately frozen desktop half can be exercised before integration;
// the integrated checkout resolves these same production sources in place.
const root = new URL(process.env.CLOUD_CHAT_CACHE_TEST_ROOT ?? "../../../../", import.meta.url);
const source = (name: string) => new URL(`apps/desktop/electron/cloud-chat-cache/${name}.ts`, root);
const present = existsSync(source("source"));
if (process.env.CLOUD_CHAT_CACHE_TEST_ROOT && !present) throw new Error("Cloud cache test consumer is missing");
const suite = process.env.TEST_DATABASE_URL && present ? describe : describe.skip;
const load = async () => Object.assign({}, ...await Promise.all(["source", "service", "store", "commands"].map(name => import(source(name).href))));

suite("production desktop cache against HTTP, PostgreSQL and SQLite", () => {
  let pool: pg.Pool, f: TeamSharingFixture, clients: Awaited<ReturnType<typeof load>>;
  let server: ReturnType<typeof serve>, base: string, directory: string, offline: boolean, legacy: boolean;
  let calls: { path: string; operation: string | null; after: string | null; status: number }[];
  let afterReceipt: (() => Promise<void>) | undefined;
  const opened: { close(): void }[] = [];
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 });
    clients = await load();
  });
  beforeEach(async () => {
    f = await teamSharingFixture(pool);
    directory = await mkdtemp(join(tmpdir(), "zeros-chat-cache-client-"));
    calls = []; offline = false; legacy = false; afterReceipt = undefined;
    server = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      if (offline) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      const url = new URL(request.url), headers = new Headers(request.headers);
      const actor = headers.get("authorization")?.replace("Bearer fixture-", "");
      if (!actor || !f.actors.has(actor)) return new Response(null, { status: 401 });
      headers.set("x-test-actor", actor);
      const body = request.method === "POST" ? await request.clone().json() : undefined;
      const response = legacy && ["messages.range", "messages.since"].includes(body?.op)
        ? Response.json({ error: { code: "invalid_request" } }, { status: 400 })
        : await f.app.fetch(new Request(request, { headers }));
      calls.push({ path: url.pathname, operation: body?.op ?? null, after: url.searchParams.get("after"), status: response.status });
      if (url.pathname.endsWith("/prompts") && afterReceipt) {
        const mutate = afterReceipt; afterReceipt = undefined; await mutate();
      }
      return response;
    } });
    await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Cache fixture listener unavailable");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    for (const value of opened.splice(0).reverse()) value.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => pool?.end());
  const row = (id: string, text = id) => ({ msgId: id, kind: "text", createdAt: 1,
    payload: JSON.stringify({ id, kind: "text", role: "assistant", text, createdAt: 1 }) });
  const target = () => ({ organizationId: f.organizationId, workspaceId: f.workspace.id, chatId: "chat" });
  const mirror = (rows: ReturnType<typeof row>[], replace?: true) => f.store.writeHistory(f.workspace.id,
    { chats: [{ id: "chat" }], messages: { chatId: "chat", rows, ...(replace ? { replace } : {}) } });
  async function known() {
    const response = await fetch(`${base}/v1/cloud-v2/workspaces/${f.workspace.id}/history`, {
      method: "POST", headers: { authorization: `Bearer fixture-${f.viewer.id}`, "X-Zeros-Team-Sharing": "1", "content-type": "application/json" },
      body: JSON.stringify({ op: "chats.list", params: {} }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).result.chats.find((chat: { id: string }) => chat.id === "chat").historyCache;
  }
  function desktop(actor = f.viewer) {
    const owner = JSON.stringify([base, actor.id]), session = actor.authentication.sessionId;
    const native = new clients.CloudChatCacheStore(join(directory, actor.id));
    const source = new clients.ControlPlaneCloudChatCacheSource({ baseUrl: base,
      session: async () => ({ accountId: actor.id, sessionId: session, accessToken: `fixture-${actor.id}` }), fetch, wait: async () => {} });
    const service = new clients.CloudChatCacheService({ store: native, source, identity: () => ({ owner, session }) });
    opened.push(native, service);
    const lease = service.bind(1, owner, "fixture-window");
    return { native, service, source, lease, owner, session, key: { owner, ...target() } };
  }
  async function seedReceipts(owners: AuthedUser[]) {
    await withSystemTx(pool, async tx => {
      await tx.query("INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id,next_sequence) VALUES($1,'chat',$2)", [f.workspace.id, owners.length]);
      for (const [i, actor] of owners.entries()) {
        const userMessageId = `message-${i + 1}`, sequence = String(i + 1);
        const payload = { chatId: "chat", userMessageId, agentId: "claude", startedAt: 1, prompt: [{ type: "text", text: "Fixture" }] };
        const receipt = { workspaceId: f.workspace.id, chatId: "chat", userMessageId, sequence, epoch: "0",
          acceptedAt: "2026-01-01T00:00:00.000Z", workspaceState: "stopped" };
        await tx.query(`INSERT INTO cloud_v2_prompt_outbox(workspace_id,chat_id,user_message_id,creator_user_id,sequence,epoch,access_epoch,
          payload_hash,payload,payload_bytes,receipt,state) VALUES($1,'chat',$2,$3,$4,0,0,$5,$6,$7,$8,'completed')`,
        [f.workspace.id, userMessageId, actor.id, sequence, "0".repeat(64), payload, Buffer.byteLength(JSON.stringify(payload)), receipt]);
      }
    });
  }

  it("persists native rows across restart, applies exact deltas and replaces after a cut", async () => {
    await mirror([row("m0"), row("m1")]);
    const first = desktop();
    const initial = await first.service.refresh(1, first.lease, target(), 200);
    expect(initial.range.rows.map((value: { msgId: string }) => value.msgId)).toEqual(["m0", "m1"]);
    await mirror([row("m0", "edited"), row("m2")]);
    const current = await first.service.refresh(1, first.lease, target(), 200);
    expect(current.range.rows).toEqual([{ index: 0, ...row("m0", "edited") }, { index: 1, ...row("m1") }, { index: 2, ...row("m2") }]);
    first.service.close(); first.native.close();
    const restarted = desktop();
    expect(restarted.service.read(1, restarted.lease, target(), 200)).toEqual(current.range);
    offline = true;
    await expect(restarted.service.refresh(1, restarted.lease, target(), 200)).rejects.toThrow();
    expect(restarted.service.read(1, restarted.lease, target(), 200)).toEqual(current.range);
    offline = false;
    await mirror([row("m2")], true);
    const cut = await restarted.service.refresh(1, restarted.lease, target(), 200);
    expect(cut).toMatchObject({ replaced: true, range: { messageCount: 1, rows: [{ index: 0, ...row("m2") }] } });
    expect(calls.some(call => call.operation === "messages.since")).toBe(true);
    expect(calls.every(call => /\/history$|\/workspaces\/[^/]+$/.test(call.path))).toBe(true);
    expect((await f.store.get(f.workspace.id, f.creator.id)).state).toBe("stopped");
  });

  it("serves a matching shared transcript and its senders without requests, then continues only the changed chat", async () => {
    await mirror([]); await seedReceipts([f.creator, f.viewer]);
    const user = (id: string) => ({ ...row(id), payload: JSON.stringify({ id, kind: "text", role: "user", text: id, createdAt: 1 }) });
    await mirror([user("message-1"), row("assistant")]);
    const first = desktop(), metadata = await known();
    const initial = await first.service.refresh(1, first.lease, target(), 200, metadata);
    expect(initial.range.senders).toEqual({ "message-1": { userId: f.creator.id } });
    first.service.close(); first.native.close();
    const restarted = desktop();
    calls.length = 0;
    expect(restarted.service.read(1, restarted.lease, target(), 200).senders).toEqual(initial.range.senders);
    const warm = await restarted.service.refresh(1, restarted.lease, target(), 200, metadata);
    expect(warm.cached).toBe(true);
    expect(warm.range.senders).toEqual(initial.range.senders);
    expect(warm.range.rows.map((message: { msgId: string }) => message.msgId)).toEqual(["message-1", "assistant"]);
    expect(calls).toEqual([]);

    await mirror([user("message-2")]);
    const changed = await known(); calls.length = 0;
    const continued = await restarted.service.refresh(1, restarted.lease, target(), 200, changed);
    expect(calls.map(call => call.operation)).toEqual(["messages.since"]);
    expect(continued.range.senders).toEqual({ "message-1": { userId: f.creator.id }, "message-2": { userId: f.viewer.id } });
    restarted.service.forget(1, restarted.lease, target()); calls.length = 0;
    const rebuilt = await restarted.service.refresh(1, restarted.lease, target(), 200, changed);
    expect(calls.map(call => call.operation)).toEqual(["messages.range", "messages.range"]);
    expect(rebuilt.range).toEqual(continued.range);
  });

  it("signals the existing per-operation fallback on an N-1 server without discarding cached rows", async () => {
    await mirror([row("m0")]);
    const value = desktop();
    await value.service.refresh(1, value.lease, target(), 200, await known());
    const saved = value.service.read(1, value.lease, target(), 200);
    const command = clients.createCloudChatCacheCommand({ service: async () => value.service, admit: () => ({ window: 1, current: () => true }) });
    legacy = true; calls.length = 0;
    expect(await command({ op: "refresh", lease: value.lease, target: target(), limit: 200 }, {})).toEqual({ ok: false, reason: "unsupported" });
    expect(calls.some(call => call.operation === "messages.since" && call.status === 400)).toBe(true);
    expect(value.service.read(1, value.lease, target(), 200)).toEqual(saved);
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/history`, "POST", { op: "messages.window", params: { chatId: "chat", limit: 200 } });
    expect(response.status).toBe(200);
    expect((await response.json()).result.messages).toEqual([row("m0")]);
  });

  it("restarts a changed receipt page and persists only each caller's own complete snapshot", async () => {
    await mirror([row("m0")]);
    await seedReceipts([...Array.from({ length: 105 }, () => f.viewer), f.creator, f.creator]);
    const viewer = desktop();
    await viewer.service.refresh(1, viewer.lease, target(), 200);
    afterReceipt = () => pool.query("UPDATE cloud_v2_prompt_outbox SET state='failed' WHERE workspace_id=$1", [f.workspace.id]).then(() => {});
    const pending = await viewer.service.refreshPending(1, viewer.lease, target());
    expect(pending.items).toHaveLength(105);
    expect(pending.items.every((item: { state: string }) => item.state === "failed")).toBe(true);
    expect(calls.filter(call => call.path.endsWith("/prompts") && call.status === 409)).toHaveLength(1);
    expect(calls.filter(call => call.path.endsWith("/prompts") && call.after === "0")).toHaveLength(2);
    expect(viewer.service.readPending(1, viewer.lease, target())).toEqual(pending);
    const creator = desktop(f.creator);
    await creator.service.refresh(1, creator.lease, target(), 200);
    const own = await creator.service.refreshPending(1, creator.lease, target());
    expect(own.items.map((item: { receipt: { userMessageId: string } }) => item.receipt.userMessageId)).toEqual(["message-106", "message-107"]);
    expect(viewer.service.readPending(1, viewer.lease, target())).toEqual(pending);
  });

  it("retires confirmed chat deletion and member loss without treating an empty page as authority", async () => {
    await mirror([row("m0")]);
    const viewer = desktop();
    await viewer.service.refresh(1, viewer.lease, target(), 200);
    await f.store.writeHistory(f.workspace.id, { chatDeletions: ["chat"] });
    await expect(viewer.service.refresh(1, viewer.lease, target(), 200)).rejects.toBeInstanceOf(clients.CloudCacheAccessLost);
    expect(viewer.service.read(1, viewer.lease, target(), 200)).toBeNull();
    await mirror([row("new")]);
    await viewer.service.refresh(1, viewer.lease, target(), 200);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
    await expect(viewer.service.refresh(1, viewer.lease, target(), 200)).rejects.toBeInstanceOf(clients.CloudCacheAccessLost);
    expect(viewer.service.read(1, viewer.lease, target(), 200)).toBeNull();
  });
});
