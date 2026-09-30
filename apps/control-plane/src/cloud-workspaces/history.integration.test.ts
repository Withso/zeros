import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import {
  DatabaseCloudWorkspaceDurableRecordService,
  type WorkspaceRecordMutation,
} from "./durable-record.js";
import { DatabaseCloudWorkspaceHistoryService } from "./history.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("cloud history without a running worker", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let records: DatabaseCloudWorkspaceDurableRecordService;
  let history: DatabaseCloudWorkspaceHistoryService;
  let revision = 0;
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 5,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    records = new DatabaseCloudWorkspaceDurableRecordService({
      pool,
      workosEnabled: false,
    });
    history = new DatabaseCloudWorkspaceHistoryService(pool);
    revision = 0;
  });
  const scope = () => ({
    workspaceId: fixture.workspaceId,
    organizationId: fixture.organizationId,
    accountUserId: fixture.userId,
  });
  async function append(mutations: WorkspaceRecordMutation[]) {
    const result = await records.append({
      ...scope(),
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      expectedRevision: revision,
      idempotencyKey: randomUUID(),
      mutations,
    });
    revision = result.currentRevision;
  }
  const chat = (id: string): WorkspaceRecordMutation => ({
    entityKind: "chat",
    entityId: id,
    schemaVersion: 1,
    operation: "upsert",
    occurredAt: new Date().toISOString(),
    document: { version: 1, chat: { id, folder: ".", title: "Saved chat" } },
  });
  const message = (
    chatId: string,
    ord: number,
    payload: Record<string, unknown>,
  ): WorkspaceRecordMutation => {
    const msgId = `message-${ord}`;
    return {
      entityKind: "message",
      entityId: `m:${createHash("sha256").update(`${chatId}\0${msgId}`).digest("hex")}`,
      schemaVersion: 1,
      operation: "upsert",
      occurredAt: new Date().toISOString(),
      document: {
        version: 1,
        chatId,
        msgId,
        ord,
        kind: payload.kind ?? "text",
        payload: JSON.stringify(payload),
        createdAt: ord,
      },
    };
  };

  it("reads saved text and tool calls while the worker is stopped", async () => {
    await append([
      chat("a"),
      message("a", 1, { kind: "text", role: "user", text: "Read the file" }),
      message("a", 2, {
        kind: "tool_call",
        status: "completed",
        title: "Read file",
      }),
      message("a", 3, { kind: "text", role: "assistant", text: "Done" }),
    ]);
    await pool.query(
      "UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1",
      [fixture.workspaceId],
    );
    await pool.query(
      "UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1",
      [fixture.engineInstanceId],
    );
    expect(
      (await history.chats({ ...scope(), limit: 100 })).chats,
    ).toMatchObject([{ id: "a" }]);
    const result = await history.messages({
      ...scope(),
      chatId: "a",
      limit: 2,
    });
    expect(result.messages.map((row) => row.msgId)).toEqual([
      "message-1",
      "message-2",
      "message-3",
    ]);
    expect(JSON.parse(result.messages[1]!.payload)).toMatchObject({
      kind: "tool_call",
      status: "completed",
    });
    expect(
      (
        await history.messages({
          ...scope(),
          chatId: "a",
          limit: 1,
          beforeMsgId: "message-2",
        })
      ).messages,
    ).toMatchObject([{ msgId: "message-1" }]);
  });

  it("searches stopped and archived history in bounded revision-pinned pages without compute", async () => {
    await append([chat("a"), chat("b"), ...Array.from({ length: 5 }, (_, i) => message("a", i + 1, { role: "user", text: "Saved needle" })), message("b", 1, { role: "user", text: "Other needle" })]);
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [fixture.engineInstanceId]);
    const first = await history.search({ ...scope(), query: "saved needle", chatId: "a", limit: 2 });
    expect(first.hits).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const hits = [...first.hits];
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await history.search({ ...scope(), query: "saved needle", chatId: "a", limit: 2, cursor, revision: first.revision });
      hits.push(...next.hits); cursor = next.nextCursor;
    }
    expect(new Set(hits.map(row => row.msgId)).size).toBe(5);
    expect(hits.every(row => row.chatId === "a")).toBe(true);
    await pool.query("UPDATE cloud_workspaces SET status='archived',desired_state='archived' WHERE id=$1", [fixture.workspaceId]);
    expect((await history.search({ ...scope(), query: "needle", folder: ".", limit: 50 })).hits).toHaveLength(6);
    expect((await pool.query("SELECT desired_state FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].desired_state).toBe("archived");
  });

  it("fences search scopes, tombstones, revocation, cursors and invalid bounds", async () => {
    await append([chat("a"), chat("b"), message("a", 1, { text: "needle" }), message("a", 2, { text: "needle" }), message("b", 1, { text: "needle" })]);
    const first = await history.search({ ...scope(), query: "needle", chatId: "a", limit: 1 });
    const other = await seedReadyCloudWorkspace(pool);
    for (const override of [{ accountUserId: other.userId }, { organizationId: other.organizationId }, { workspaceId: other.workspaceId }]) {
      await expect(history.search({ ...scope(), ...override, query: "needle", limit: 50 })).rejects.toMatchObject({ status: 404 });
    }
    for (const override of [{ limit: 201 }, { query: "x".repeat(1001) }, { folder: "../other" }, { cursor: "invalid" }, { chatId: "b", cursor: first.nextCursor!, revision: first.revision }]) {
      await expect(history.search({ ...scope(), query: "needle", chatId: "a", limit: 50, ...override })).rejects.toMatchObject({ status: 422 });
    }
    await append([{ entityKind: "chat", entityId: "a", schemaVersion: 1, operation: "tombstone", occurredAt: new Date().toISOString() }]);
    await expect(history.search({ ...scope(), query: "needle", limit: 1, cursor: first.nextCursor!, revision: first.revision, chatId: "a" })).rejects.toMatchObject({ status: 409 });
    expect((await history.search({ ...scope(), query: "needle", limit: 50 })).hits.map(row => row.chatId)).toEqual(["b"]);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [fixture.organizationId, fixture.userId]);
    await expect(history.search({ ...scope(), query: "needle", limit: 50 })).rejects.toMatchObject({ status: 404 });
  });

  it("advances through empty search pages and byte-limited pages without losing hits", async () => {
    await append([chat("a")]);
    const rows = Array.from({ length: 514 }, (_, i) => message("a", i, { text: "ordinary" }))
      .sort((a, b) => a.entityId.localeCompare(b.entityId));
    rows[513]!.document!.payload = JSON.stringify({ text: "uniqueNeedle" });
    for (let offset = 0; offset < rows.length; offset += 100) await append(rows.slice(offset, offset + 100));
    const first = await history.search({ ...scope(), query: "uniqueNeedle", limit: 50 });
    expect(first.hits).toEqual([]); expect(first.nextCursor).not.toBeNull();
    const last = await history.search({ ...scope(), query: "uniqueNeedle", limit: 50, cursor: first.nextCursor!, revision: first.revision });
    expect(last.hits).toHaveLength(1); expect(last.nextCursor).toBeNull();
    for (let i = 0; i < 7; i++) await append([message("a", 1000 + i, { text: "largeNeedle " + "x ".repeat(255000) })]);
    const firstLarge = await history.search({ ...scope(), query: "largeNeedle", limit: 50 });
    const all = [...firstLarge.hits]; let cursor = firstLarge.nextCursor;
    while (cursor) {
      const next = await history.search({ ...scope(), query: "largeNeedle", limit: 50, cursor, revision: firstLarge.revision });
      all.push(...next.hits); cursor = next.nextCursor;
    }
    expect(all).toHaveLength(7);
    expect(new Set(all.map(row => row.msgId)).size).toBe(7);
  });

  it("keeps workspace, actor, chat and deletion boundaries", async () => {
    await append([
      chat("a"),
      chat("b"),
      message("a", 1, { role: "user", text: "A" }),
      message("b", 1, { role: "user", text: "B" }),
    ]);
    const other = await seedReadyCloudWorkspace(pool);
    await expect(
      history.chats({ ...scope(), accountUserId: other.userId, limit: 100 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      history.chats({
        ...scope(),
        organizationId: other.organizationId,
        limit: 100,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await history.messages({ ...scope(), chatId: "b", limit: 100 })
      ).messages.map((row) => JSON.parse(row.payload).text),
    ).toEqual(["B"]);
    await append([
      {
        entityKind: "chat",
        entityId: "a",
        schemaVersion: 1,
        operation: "tombstone",
        occurredAt: new Date().toISOString(),
      },
    ]);
    const page = await history.chats({ ...scope(), limit: 100 });
    expect(page.chats).toMatchObject([{ id: "b" }]);
    expect(page.chatDeletions).toEqual(["a"]);
    await expect(
      history.messages({ ...scope(), chatId: "a", limit: 100 }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("pages chat metadata at one revision and rejects a mixed snapshot", async () => {
    await append([chat("a"), chat("b"), chat("c")]);
    const first = await history.chats({ ...scope(), limit: 2 });
    expect(first.chats.map((row) => row.id)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBe("b");
    expect(
      (
        await history.chats({
          ...scope(),
          limit: 2,
          afterId: first.nextCursor!,
          revision: first.revision,
        })
      ).chats,
    ).toMatchObject([{ id: "c" }]);
    await append([chat("d")]);
    await expect(
      history.chats({
        ...scope(),
        limit: 2,
        afterId: first.nextCursor!,
        revision: first.revision,
      }),
    ).rejects.toMatchObject({ status: 409, code: "cloud_history_changed" });
  });

  it("keeps older paging empty when its cursor was removed and rejects invalid limits", async () => {
    await append([chat("a"), message("a", 1, { role: "user", text: "First" })]);
    expect(
      (
        await history.messages({
          ...scope(),
          chatId: "a",
          limit: 100,
          beforeMsgId: "deleted",
        })
      ).messages,
    ).toEqual([]);
    await expect(
      history.messages({ ...scope(), chatId: "a", limit: 1001 }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(history.chats({ ...scope(), limit: 0 })).rejects.toMatchObject(
      { status: 422 },
    );
  });

  it("does not lose the remaining chats when a page reaches its byte budget", async () => {
    for (let i = 0; i < 7; i++) {
      const mutation = chat(String(i));
      mutation.document = {
        version: 1,
        chat: { id: String(i), folder: ".", title: "x".repeat(524000) },
      };
      await append([mutation]);
    }
    const first = await history.chats({ ...scope(), limit: 100 });
    expect(first.nextCursor).not.toBeNull();
    const next = await history.chats({
      ...scope(),
      limit: 100,
      afterId: first.nextCursor!,
      revision: first.revision,
    });
    expect([...first.chats, ...next.chats].map((row) => row.id)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    expect(next.nextCursor).toBeNull();
  });

  it("serves authenticated history with compute unconfigured and rejects invalid HTTP queries", async () => {
    await append([chat("a"), message("a", 1, { role: "user", text: "Saved" })]);
    let account = fixture.userId;
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", { id: account } as AuthedUser);
      await next();
    });
    app.route("/", createCloudWorkspaceRoutes(pool, null));
    app.onError((error, c) => {
      if (error instanceof HttpError)
        return c.json({ error: { code: error.code } }, error.status);
      throw error;
    });
    const root = `/v1/organizations/${fixture.organizationId}/cloud-workspaces/${fixture.workspaceId}/history`;
    const chats = await app.request(`${root}/chats`);
    expect(chats.status).toBe(200);
    expect(chats.headers.get("Cache-Control")).toBe("no-store");
    expect(await chats.json()).toMatchObject({ chats: [{ id: "a" }] });
    const messages = await app.request(`${root}/messages/a`);
    expect(messages.status).toBe(200);
    expect(await messages.json()).toMatchObject({
      messages: [{ msgId: "message-1" }],
    });
    const search = await app.request(`${root}/search?query=Saved&folder=.`);
    expect(search.status).toBe(200);
    expect(search.headers.get("Cache-Control")).toBe("no-store");
    expect(await search.json()).toMatchObject({ hits: [{ chatId: "a", msgId: "message-1" }], nextCursor: null });
    for (const suffix of [
      "/chats?limit=0",
      "/chats?revision=-1",
      "/messages/a?limit=1001",
      "/messages/a?before=1&beforeMsgId=message-1",
      "/chats?unexpected=true",
      "/search?query=Saved&limit=201",
      "/search?query=Saved&folder=../other",
      "/search?query=Saved&cursor=invalid",
    ]) {
      expect((await app.request(root + suffix)).status).toBe(422);
    }
    account = (await seedReadyCloudWorkspace(pool)).userId;
    expect((await app.request(`${root}/chats`)).status).toBe(404);
    expect((await app.request(`${root}/messages/a`)).status).toBe(404);
    expect((await app.request(`${root}/search?query=Saved`)).status).toBe(404);
  });
});
