import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// Test-only oracle: the shipped CP remains independent of the worker/protocol.
import { messageWindow } from "../../../cloud-worker/src/sessions/chat-history.js";
import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import type { CloudV2MessageRow } from "./contract.js";
import { answerCloudV2Offline } from "./composition.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";
import { CloudV2Store, type CloudV2Workspace } from "./store.js";
import { mirrorMessageSearch } from "./history-search.js";
import { mirrorMessageWindow } from "./history.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("offline native history paging", () => {
  let pool: pg.Pool, store: CloudV2Store, workspace: CloudV2Workspace, creator: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    store = new CloudV2Store(pool); creator = randomUUID();
    const org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')", [creator, `${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
      VALUES($1,$2,'Org',$3,false,true)`, [org, `org-${org}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, creator]);
    workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: creator,
      repository: "Owner/Project", branch: "zeros/chat", baseBranch: "master", name: "Project", computerBuildId: null });
    workspace = (await store.transition(workspace.id, ["creating"], "stopped"))!;
  });
  const row = (id: string, role = "assistant", extra = {}): CloudV2MessageRow => ({ msgId: id, kind: "text",
    payload: JSON.stringify({ id, kind: "text", role, text: id, createdAt: 1, ...extra }), createdAt: 1 });
  async function mirror(chatId: string, rows: CloudV2MessageRow[]) {
    await store.writeHistory(workspace.id, { chats: [{ id: chatId, folder: "/home/user/Owner/Project" } as { id: string }] });
    for (let i = 0; i < rows.length; i += 500) await store.writeHistory(workspace.id, { messages: { chatId, rows: rows.slice(i, i + 500) } });
  }
  function read(op: string, params: object = {}, userId = creator) {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: userId } as never); await next(); });
    app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
    app.route("/", createCloudV2Routes({ store, bridgeBaseUrl: "wss://example.test" } as CloudV2RouteDeps));
    return app.request(`/v1/cloud-v2/workspaces/${workspace.id}/history`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ op, params }) });
  }

  it("pages before the anchor in insertion order after updates and interleaved chats, without waking", async () => {
    const rows = [row("u", "user"), ...Array.from({ length: 8 }, (_, i) => row(`a${i}`))];
    await mirror("native-chat", rows.slice(0, 3));
    await mirror("another-chat", [row("noise")]);
    await mirror("native-chat", rows.slice(3));
    rows[1] = row("a0", "assistant", { text: "updated" });
    await mirror("native-chat", [rows[1]!]);
    const params = { chatId: "native-chat", beforeMsgId: "a4", limit: 3 };
    const response = await read("messages.windowOlder", params);
    expect(response.status).toBe(200);
    const expected = messageWindow(rows, 3, 6);
    expect(await response.json()).toEqual({ result: expected });
    expect(await answerCloudV2Offline(store, workspace, { type: "WORKSPACE_REQUEST", id: "older", op: "messages.windowOlder", params }))
      .toMatchObject({ type: "WORKSPACE_RESPONSE", requestId: "older", result: expected });
    expect(await (await read("messages.windowOlder", { ...params, beforeMsgId: "missing" })).json()).toEqual({ result: { messages: [] } });
    expect((await store.get(workspace.id, creator)).state).toBe("stopped");
  });

  it("matches worker tail snapping, turnOpening, steers, limits and positional windows", async () => {
    const cases = [
      [row("u", "user"), ...Array.from({ length: 20 }, (_, i) => row(`a${i}`))],
      [row("u", "user"), ...Array.from({ length: 1100 }, (_, i) => row(`a${i}`))],
      [row("opaque-u", "user", { text: "\0" }), ...Array.from({ length: 1100 }, (_, i) => row(`a${i}`))],
      [row("u", "user"), ...Array.from({ length: 1050 }, (_, i) => row(`a${i}`)), row("steer", "user", { steeredTurnId: "turn" }), row("last")],
      [{ msgId: "bad", kind: "text", payload: "{not json", createdAt: 1 }, row("a")],
    ];
    for (const [index, rows] of cases.entries()) {
      const chatId = `native-${index}`;
      await mirror(chatId, rows);
      for (const limit of [0, 3, -1, 1500]) {
        const response = await read("messages.window", { chatId, limit });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ result: messageWindow(rows, limit) });
      }
      for (const before of [3, rows.length + 100, Number.MAX_VALUE]) {
        expect(await (await read("messages.window", { chatId, limit: 2, before })).json())
          .toEqual({ result: messageWindow(rows, 2, before) });
      }
    }
  });

  it("keeps native identities and creator authorization at the HTTP boundary", async () => {
    await mirror("native-chat", [row("u", "user")]);
    expect(await (await read("chats.list")).json()).toEqual({ result: {
      chats: [{ id: "native-chat", folder: "/home/user/Owner/Project", historyCache: { revision: expect.any(Number), messageCount: 1 } }], chatDeletions: [],
    } });
    expect(await (await read("messages.window", { chatId: "cloud:org:ws:native-chat" })).json()).toEqual({ result: { messages: [] } });
    expect((await read("messages.window", { chatId: "native-chat" }, randomUUID())).status).toBe(404);
  });

  it("searches native history through HTTP and offline relay without waking", async () => {
    const saved = row("message", "user", { text: "The relay-core reducer uses ciphertext. Café." });
    await mirror("native-chat", [saved, row("apart", "assistant", { text: "relay without a core" })]);
    await mirror("other-chat", [{ msgId: "tool", kind: "tool", payload: JSON.stringify({ title: "Read relay/server.ts" }), createdAt: 1 }]);
    for (const query of ["relay-core", "ciphertext", "cafe", "\"ciphertext\""]) {
      const params = { query, folder: "/home/user/Owner/Project" };
      const expected = { hits: [{ chatId: "native-chat", msgId: saved.msgId, payload: saved.payload, createdAt: saved.createdAt }] };
      const response = await read("messages.search", params);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: expected });
      expect(await answerCloudV2Offline(store, workspace, { type: "WORKSPACE_REQUEST", id: "search", op: "messages.search", params }))
        .toMatchObject({ type: "WORKSPACE_RESPONSE", requestId: "search", result: expected });
    }
    expect(await (await read("messages.search", { query: "relay", chatId: "other-chat" })).json()).toMatchObject({ result: { hits: [{ chatId: "other-chat", msgId: "tool" }] } });
    expect((await store.get(workspace.id, creator)).state).toBe("stopped");
  });

  it("keeps literal query operators, malformed payloads, deletion and creator scopes inert", async () => {
    await mirror("native-chat", [row("literal", "user", { text: "literal OR expression" }), row("other", "user", { text: "literal expression" }),
      { msgId: "bad", kind: "text", payload: "{invalid", createdAt: 1 }, { msgId: "null", kind: "text", payload: "null", createdAt: 1 }]);
    const request = { query: "literal OR expression" };
    expect(await (await read("messages.search", request)).json()).toMatchObject({ result: { hits: [{ msgId: "literal" }] } });
    expect(await (await read("messages.search", { query: "lit" })).json()).toEqual({ result: { hits: [] } });
    expect(await (await read("messages.search", { query: "literal", chatId: "foreign" })).json()).toEqual({ result: { hits: [] } });
    expect((await read("messages.search", request, randomUUID())).status).toBe(404);
    const other = await store.createWorkspace({ id: randomUUID(), organizationId: workspace.organizationId, creatorUserId: creator,
      repository: "Owner/Other", branch: "zeros/other", baseBranch: "main", name: "Other", computerBuildId: null });
    await store.writeHistory(other.id, { chats: [{ id: "foreign" }], messages: { chatId: "foreign", rows: [row("leak", "user", { text: "literal" })] } });
    expect(await (await read("messages.search", { query: "literal", chatId: "foreign" })).json()).toEqual({ result: { hits: [] } });
    await store.writeHistory(workspace.id, { chatDeletions: ["native-chat"] });
    expect(await (await read("messages.search", request)).json()).toEqual({ result: { hits: [] } });
    expect((await store.get(workspace.id, creator)).state).toBe("stopped");
  });

  it.each(["streaming update", "deletion"])("uses one snapshot across a held scan and a concurrent %s", async change => {
    const saved = row("message", "user", { text: "original needle" });
    await mirror("native-chat", [saved]);
    let changed = false;
    const result = await withSystemTx(pool, async tx => {
      const query = tx.query.bind(tx);
      tx.query = (async (sql: string, values: unknown[]) => {
        const result = await query(sql, values);
        if (!changed && sql.includes("octet_length")) {
          changed = true;
          if (change === "deletion") await store.writeHistory(workspace.id, { chatDeletions: ["native-chat"] });
          else await store.writeHistory(workspace.id, { messages: { chatId: "native-chat", rows: [row("message", "user", { text: "replacement needle" })] } });
        }
        return result;
      }) as typeof tx.query;
      try { return await mirrorMessageSearch(tx, workspace.id, { query: "original" }); }
      finally { tx.query = query; }
    }, { consistentRead: true });
    expect(changed).toBe(true);
    expect(result.hits).toEqual([{ chatId: "native-chat", msgId: "message", payload: saved.payload, createdAt: saved.createdAt }]);
    expect(await (await read("messages.search", { query: "original" })).json()).toEqual({ result: { hits: [] } });
    const next = await (await read("messages.search", { query: "replacement" })).json();
    expect(next).toMatchObject({ result: { hits: change === "deletion" ? [] : [{ chatId: "native-chat", msgId: "message" }] } });
    expect((await store.get(workspace.id, creator)).state).toBe("stopped");
  });

  it("returns typed input and corpus refusals without a partial result", async () => {
    await mirror("native-chat", Array.from({ length: 20 }, (_, i) => row(`large-${i}`, "user", { text: "needle " + "x".repeat(900_000) })));
    const result = await read("messages.search", { query: "needle" });
    expect(result.status).toBe(413);
    expect(await result.json()).toEqual({ error: { code: "SEARCH_LIMIT" } });
    for (const query of [null, 1, "word\0word", "q".repeat(4097)])
      expect((await read("messages.search", { query })).status).toBe(400);
    expect((await store.get(workspace.id, creator)).state).toBe("stopped");
  });

  it("turns a real PostgreSQL statement deadline into a typed search refusal", async () => {
    await mirror("native-chat", [row("message", "user", { text: "needle" })]);
    await expect(withSystemTx(pool, async tx => {
      const query = tx.query.bind(tx);
      tx.query = (async (sql: string, values: unknown[]) => {
        if (sql.includes("set_config")) return query("SELECT set_config('statement_timeout','10',true)");
        if (sql.includes("octet_length")) await query("SELECT pg_sleep(0.1)");
        return query(sql, values);
      }) as typeof tx.query;
      try { return await mirrorMessageSearch(tx, workspace.id, { query: "needle" }); }
      finally { tx.query = query; }
    }, { consistentRead: true })).rejects.toMatchObject({ code: "SEARCH_LIMIT" });
    expect((await store.get(workspace.id, creator)).state).toBe("stopped");
  });
  it("atomically replaces mirrored rows with the sequence, retains retries and fences old boots", async () => {
    await store.transition(workspace.id, ["stopped"], "starting");
    const token = await store.rotateWorkerToken(workspace.id), bootId = randomUUID();
    await store.acceptWorkerHello(token, bootId);
    const first = { chats: [{ id: "native-chat" }], messages: { chatId: "native-chat", rows: [row("kept"), row("removed")] } };
    await store.writeWorkerHistory(token, bootId, 1, first);
    await mirror("unrelated-chat", [row("untouched")]);
    const replacement = { messages: { chatId: "native-chat", replace: true as const, rows: [row("kept")] } };
    await store.writeWorkerHistory(token, bootId, 2, replacement);
    await store.writeWorkerHistory(token, bootId, 2, replacement);
    await store.writeWorkerHistory(token, bootId, 1, first);
    expect(await (await read("messages.window", { chatId: "native-chat" })).json()).toEqual({ result: { messages: [row("kept")] } });
    expect(await (await read("messages.window", { chatId: "unrelated-chat" })).json()).toEqual({ result: { messages: [row("untouched")] } });
    await expect(store.writeWorkerHistory(token, bootId, 3, { messages: { chatId: "native-chat", replace: true, rows: [{ ...row("invalid"), createdAt: -1 }] } }))
      .rejects.toBeDefined();
    expect(await (await read("messages.window", { chatId: "native-chat" })).json()).toEqual({ result: { messages: [row("kept")] } });
    const empty = { messages: { chatId: "native-chat", replace: true as const, rows: [] } };
    await store.writeWorkerHistory(token, bootId, 3, empty);
    await expect(store.writeWorkerHistory(token, bootId, 3, replacement)).rejects.toMatchObject({ code: "history_sequence_conflict" });
    expect(await (await read("messages.window", { chatId: "native-chat" })).json()).toEqual({ result: { messages: [] } });
    await store.acceptWorkerHello(token, randomUUID());
    await expect(store.writeWorkerHistory(token, bootId, 4, first)).rejects.toMatchObject({ code: "worker_boot_changed" });
    expect(await (await read("messages.window", { chatId: "native-chat" })).json()).toEqual({ result: { messages: [] } });
  });

  it("keeps replacement state and rows in one snapshot across metadata upserts, empty cuts and rollback", async () => {
    const historyState = { revision: 1, beforeEpoch: "7" };
    await mirror("native-chat", [row("old")]);
    await store.writeHistory(workspace.id, { messages: { chatId: "native-chat", replace: true, rows: [row("kept")], historyState } });
    await store.writeHistory(workspace.id, { chats: [{ id: "native-chat", title: "Renamed", historyState: { revision: 99 } } as { id: string }] });
    expect(await store.messageWindow(workspace.id, "native-chat")).toEqual({ messages: [row("kept")], historyState });
    await expect(store.writeHistory(workspace.id, { messages: { chatId: "native-chat", replace: true,
      rows: [{ ...row("bad"), createdAt: -1 }], historyState: { revision: 2, beforeEpoch: "8" } } })).rejects.toBeDefined();
    expect(await store.messageWindow(workspace.id, "native-chat")).toEqual({ messages: [row("kept")], historyState });
    let changed = false;
    const old = await withSystemTx(pool, tx => mirrorMessageWindow({ query: async (...args: Parameters<typeof tx.query>) => {
      const result = await tx.query(...args);
      if (!changed) {
        changed = true;
        await store.writeHistory(workspace.id, { messages: { chatId: "native-chat", replace: true, rows: [], historyState: { revision: 2, beforeEpoch: "8" } } });
      }
      return result;
    } } as typeof tx, workspace.id, "native-chat", {}), { consistentRead: true });
    expect(old).toEqual({ messages: [row("kept")], historyState });
    expect(await (await read("messages.window", { chatId: "native-chat" })).json())
      .toEqual({ result: { messages: [], historyState: { revision: 2, beforeEpoch: "8" } } });
  });

});
