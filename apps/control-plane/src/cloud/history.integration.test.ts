import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// Test-only oracle: the shipped CP remains independent of the worker/protocol.
import { messageWindow } from "../../../cloud-worker/src/sessions/chat-history.js";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import type { CloudV2MessageRow } from "./contract.js";
import { answerCloudV2Offline } from "./composition.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";
import { CloudV2Store, type CloudV2Workspace } from "./store.js";

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
      chats: [{ id: "native-chat", folder: "/home/user/Owner/Project" }], chatDeletions: [],
    } });
    expect(await (await read("messages.window", { chatId: "cloud:org:ws:native-chat" })).json()).toEqual({ result: { messages: [] } });
    expect((await read("messages.window", { chatId: "native-chat" }, randomUUID())).status).toBe(404);
  });

  it("refuses search with a typed unavailable error and never wakes the workspace", async () => {
    const response = await read("messages.search", { chatId: "native-chat", query: "text" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "CLOUD_V2_UNSUPPORTED" } });
    expect(await answerCloudV2Offline(store, workspace, { type: "WORKSPACE_REQUEST", id: "search", op: "messages.search", params: { query: "text" } }))
      .toMatchObject({ type: "WORKSPACE_ERROR", requestId: "search", code: "CLOUD_V2_UNSUPPORTED" });
    expect((await store.get(workspace.id, creator)).state).toBe("stopped");
  });
});
