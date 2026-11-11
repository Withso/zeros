import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx, withUserTx } from "../../db.js";
import { CloudV2MessageRowSchema } from "../contract.js";
import { CloudV2PromptReceiptSchema, type CloudV2Prompt } from "../prompt-contract.js";
import { mirrorMessageSenders } from "../history.js";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("durable prompt senders through the sharing router", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, statement_timeout: 2000 }); });
  beforeEach(async () => { f = await teamSharingFixture(pool); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(() => pool.end());
  const path = () => `/v1/cloud-v2/workspaces/${f.workspace.id}`;
  const prompt = (userMessageId = randomUUID(), extra: Partial<CloudV2Prompt> = {}): CloudV2Prompt => ({
    chatId: "chat", userMessageId, agentId: "codex", startedAt: 123,
    prompt: [{ type: "text", text: "A durable message" }], ...extra,
  });
  const send = (input = prompt(), person = f.creator) => f.call(`${path()}/prompts`, "POST", input, person, false);
  const read = (op: string, params: object, person = f.viewer, optIn = true) =>
    f.call(`${path()}/history`, "POST", { op, params }, person, optIn);
  const lookup = (userMessageIds: string[], chatId = "chat", person = f.viewer, optIn = true) =>
    read("messages.senders", { chatId, userMessageIds }, person, optIn);
  const row = (msgId: string, role = "user", extra: object = {}) => ({ msgId, kind: "text",
    payload: JSON.stringify({ id: msgId, kind: "text", role, text: "Transcript", ...extra }), createdAt: 123 });
  const saved = async (id: string) => (await pool.query("SELECT to_jsonb(p) AS row FROM cloud_v2_prompt_outbox p WHERE workspace_id=$1 AND user_message_id=$2", [f.workspace.id, id])).rows[0].row;

  it("records the verified desktop session outside the payload and preserves it on same-person replay", async () => {
    const input = prompt(), first = await send(input);
    expect(first.status).toBe(201);
    const receipt = await first.json();
    expect(CloudV2PromptReceiptSchema.safeParse(receipt.receipt).success).toBe(true);
    const originalSession = f.creator.authentication.sessionId;
    expect(await saved(input.userMessageId)).toMatchObject({ creator_user_id: f.creator.id,
      sender_provider_session_id: originalSession, sender_credential_kind: null, sender_credential_id: null, sender_context_id: null,
      payload: input });
    const session = `session_${randomUUID()}`;
    await pool.query(`INSERT INTO auth_sessions(provider,provider_session_id,provider_sub,user_id,client_kind,status)
      VALUES('workos',$1,$2,$3,'desktop','active')`, [session, f.creator.identity.subject, f.creator.id]);
    f.actors.set(f.creator.id, { ...f.creator, authentication: { ...f.creator.authentication, sessionId: session } });
    const replay = await send(input);
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(receipt);
    expect((await saved(input.userMessageId)).sender_provider_session_id).toBe(originalSession);
    for (const field of ["senderUserId", "senderProviderSessionId", "senderCredentialId", "senderContextId"])
      expect((await send({ ...input, [field]: f.viewer.id })).status).toBe(400);
  });

  it.each([false, true])("refuses a different person's identical replay after a Creator change (compacted: %s)", async compacted => {
    const input = prompt();
    expect((await send(input)).status).toBe(201);
    if (compacted) await pool.query("UPDATE cloud_v2_prompt_outbox SET payload=NULL,payload_bytes=0,state='completed',terminal_at=now() WHERE workspace_id=$1", [f.workspace.id]);
    // A historical receipt keeps its sender when the workspace's Creator changes.
    await pool.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2 WHERE id=$1", [f.workspace.id, f.viewer.id]);
    const replay = await send(input, f.viewer);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: { code: "prompt_conflict" } });
    expect((await saved(input.userMessageId)).creator_user_id).toBe(f.creator.id);
  });

  it("maps only returned user rows, including steers, and ignores claimed sender fields in mirrored payloads", async () => {
    const opening = prompt(), steer = prompt(randomUUID(), { mode: "steer" }), hidden = prompt();
    for (const input of [opening, steer, hidden]) expect((await send(input)).status).toBe(201);
    const messages = [row(opening.userMessageId, "user", { senderUserId: f.viewer.id }),
      row(steer.userMessageId, "user", { steeredTurnId: opening.userMessageId }), row("legacy"), row(hidden.userMessageId, "assistant")];
    await f.store.writeHistory(f.workspace.id, { messages: { chatId: "chat", rows: messages } });
    const result = await (await read("messages.window", { chatId: "chat" })).json();
    expect(result).toEqual({ result: { messages, senders: {
      [opening.userMessageId]: { userId: f.creator.id }, [steer.userMessageId]: { userId: f.creator.id }, legacy: null,
    } } });
    for (const message of result.result.messages) expect(CloudV2MessageRowSchema.safeParse(message).success).toBe(true);
    const older = await (await read("messages.windowOlder", { chatId: "chat", beforeMsgId: "legacy", limit: 1 })).json();
    expect(older.result).toEqual({ messages: [messages[1]], senders: { [steer.userMessageId]: { userId: f.creator.id } } });
    const legacy = await (await read("messages.window", { chatId: "chat" }, f.creator, false)).json();
    expect(legacy).toEqual({ result: { messages } });
    expect((await (await read("chats.list", {})).json()).result).not.toHaveProperty("senders");
  });

  it("includes an oversized turn's separate opening without changing the 1000-row window", async () => {
    const input = prompt(); expect((await send(input)).status).toBe(201);
    const opening = row(input.userMessageId), messages = [opening, ...Array.from({ length: 1100 }, (_, n) => row(`assistant-${n}`, "assistant"))];
    await f.store.writeHistory(f.workspace.id, { messages: { chatId: "chat", rows: messages } });
    const { result } = await (await read("messages.window", { chatId: "chat", limit: 1000 })).json();
    expect(result.messages).toHaveLength(1000); expect(result.turnOpening).toEqual(opening);
    expect(result.senders).toEqual({ [input.userMessageId]: { userId: f.creator.id } });
  });

  it("keeps sender identity through compaction, repeated and replaced history, and membership departure", async () => {
    const input = prompt(); expect((await send(input)).status).toBe(201);
    const other = f.viewer;
    await pool.query("UPDATE cloud_v2_prompt_outbox SET creator_user_id=$3,payload=NULL,payload_bytes=0,state='completed',terminal_at=now() WHERE workspace_id=$1 AND user_message_id=$2", [f.workspace.id, input.userMessageId, other.id]);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, other.id]);
    for (const replace of [false, true, true]) {
      await f.store.writeHistory(f.workspace.id, { messages: { chatId: "chat", replace, rows: [row(input.userMessageId, "user", { userId: f.creator.id })] } });
      const { result } = await (await read("messages.window", { chatId: "chat" }, f.admin)).json();
      expect(result.senders).toEqual({ [input.userMessageId]: { userId: other.id } });
      expect(Object.keys(result.senders[input.userMessageId])).toEqual(["userId"]);
    }
  });

  it("looks up receipts before mirroring, scopes chat/workspace, and keeps unknown and special keys null", async () => {
    const input = prompt(); expect((await send(input)).status).toBe(201);
    const elsewhere = prompt(randomUUID(), { chatId: "elsewhere" }); expect((await send(elsewhere)).status).toBe(201);
    expect((await pool.query("SELECT 1 FROM cloud_v2_messages WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
    const ids = [input.userMessageId, "unknown", "__proto__", "constructor", input.userMessageId];
    const response = await lookup(ids); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { senders: Object.fromEntries(ids.map(id => [id, id === input.userMessageId ? { userId: f.creator.id } : null])) } });
    expect(await (await lookup([input.userMessageId], "elsewhere")).json()).toEqual({ result: { senders: { [input.userMessageId]: null } } });
    expect(await (await f.call(`/v1/cloud-v2/workspaces/${f.own.id}/history`, "POST", { op: "messages.senders", params: { chatId: "chat", userMessageIds: [input.userMessageId] } })).json())
      .toEqual({ result: { senders: { [input.userMessageId]: null } } });
    expect((await lookup([input.userMessageId], "chat", f.outsider)).status).toBe(404);
    expect((await lookup([input.userMessageId], "chat", f.creator, false)).status).toBe(400);
  });

  it("bounds the lookup and accepts all 200 maximum-length IDs", async () => {
    const ids = Array.from({ length: 200 }, (_, n) => `${"雪".repeat(253)}${n.toString().padStart(3, "0")}`);
    const response = await lookup(ids);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { senders: Object.fromEntries(ids.map(id => [id, null])) } });
    for (const userMessageIds of [[], [...ids, "extra"], [""], ["x".repeat(257)], [1]]) {
      const invalid = await read("messages.senders", { chatId: "chat", userMessageIds });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect((await read("messages.senders", { chatId: "chat", userMessageIds: ["known"], userId: f.creator.id })).status).toBe(400);
  });

  it("keeps IDs that cannot be stored in PostgreSQL unknown instead of failing the read", async () => {
    const ids = ["bad\0id", "unknown"];
    for (const chatId of ["chat", "bad\0chat"]) {
      const response = await lookup(ids, chatId); expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: { senders: Object.fromEntries(ids.map(id => [id, null])) } });
    }
  });

  it("is a passive, lock-free read and cannot activate member execution", async () => {
    const input = prompt(); expect((await send(input)).status).toBe(201);
    await f.store.transition(f.workspace.id, ["starting"], "stopped");
    expect((await f.call(path())).status).toBe(200);
    f.fetcher.mockClear();
    const before = (await pool.query("SELECT state,active_at,updated_at,worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    const held = await pool.connect();
    try {
      await held.query("BEGIN");
      await held.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      await held.query("SELECT user_message_id FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 FOR UPDATE", [f.workspace.id]);
      const response = await lookup([input.userMessageId]); expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: { senders: { [input.userMessageId]: { userId: f.creator.id } } } });
    } finally { await held.query("ROLLBACK"); held.release(); }
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state,active_at,updated_at,worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0]).toEqual(before);
    for (const action of ["start", "connect", "prompts"]) {
      const response = await f.call(`${path()}/${action}`, "POST", action === "prompts" ? prompt() : {});
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "workspace_read_only" } });
    }
  });

  it("rechecks membership after an awaited sender lookup", async () => {
    const input = prompt(); expect((await send(input)).status).toBe(201);
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = f.store.messageSenders.bind(f.store);
    vi.spyOn(f.store, "messageSenders").mockImplementationOnce(async (...args) => { const value = await original(...args); entered(); await held; return value; });
    const pending = lookup([input.userMessageId]); await reached;
    try { await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]); }
    finally { release(); }
    const response = await pending; expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("keeps N-1 inserts nullable and system-only and erases provenance with chat/workspace deletion", async () => {
    const input = prompt(); expect((await send(input)).status).toBe(201);
    await pool.query(`INSERT INTO cloud_v2_prompt_outbox(workspace_id,user_message_id,chat_id,creator_user_id,sequence,epoch,access_epoch,payload_hash,payload_bytes,receipt)
      SELECT workspace_id,'n-1',chat_id,creator_user_id,sequence+1,epoch,access_epoch,payload_hash,0,receipt FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2`, [f.workspace.id, input.userMessageId]);
    expect(await saved("n-1")).toMatchObject({ sender_provider_session_id: null, sender_credential_kind: null, sender_credential_id: null, sender_context_id: null });
    const hidden = await withUserTx(pool, f.creator.id, tx => tx.query("SELECT * FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id]));
    expect(hidden.rowCount).toBe(0);
    await f.store.writeHistory(f.workspace.id, { chatDeletions: ["chat"] });
    expect(await (await lookup([input.userMessageId])).json()).toEqual({ result: { senders: { [input.userMessageId]: null } } });
    const another = prompt(randomUUID(), { chatId: "another" }); expect((await send(another)).status).toBe(201);
    await pool.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id]);
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
  });

  it("applies the expand migration to existing and N-1 receipts without rewriting identity or lifecycle state", async () => {
    const input = prompt(); expect((await send(input)).status).toBe(201);
    const migration = await readFile(new URL("../../../migrations/0238_cloud_prompt_senders.sql", import.meta.url), "utf8");
    const tx = await pool.connect(); await tx.query("BEGIN");
    try {
      await tx.query(`ALTER TABLE cloud_v2_prompt_outbox DROP COLUMN sender_provider_session_id,
        DROP COLUMN sender_credential_kind,DROP COLUMN sender_credential_id,DROP COLUMN sender_context_id`);
      await tx.query("SET LOCAL ROLE zeros_app"); await tx.query("SELECT set_config('app.system','on',true)");
      await tx.query(`INSERT INTO cloud_v2_prompt_outbox(workspace_id,user_message_id,chat_id,creator_user_id,sequence,epoch,access_epoch,payload_hash,payload_bytes,receipt)
        SELECT workspace_id,'old-writer',chat_id,creator_user_id,sequence+1,epoch,access_epoch,payload_hash,0,receipt FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2`, [f.workspace.id, input.userMessageId]);
      const before = (await tx.query("SELECT to_jsonb(p) AS row,xmin::text FROM cloud_v2_prompt_outbox p WHERE workspace_id=$1 ORDER BY user_message_id", [f.workspace.id])).rows;
      const workspace = (await tx.query("SELECT state,updated_at,active_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows;
      await tx.query("RESET ROLE"); await tx.query(migration);
      await tx.query("SET LOCAL ROLE zeros_app");
      const after = (await tx.query("SELECT to_jsonb(p) AS row,xmin::text FROM cloud_v2_prompt_outbox p WHERE workspace_id=$1 ORDER BY user_message_id", [f.workspace.id])).rows;
      expect(after).toEqual(before.map(value => ({ ...value, row: { ...value.row,
        sender_provider_session_id: null, sender_credential_kind: null, sender_credential_id: null, sender_context_id: null } })));
      expect((await tx.query("SELECT state,updated_at,active_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows).toEqual(workspace);
      expect(await mirrorMessageSenders(tx, f.workspace.id, "chat", [input.userMessageId, "old-writer", "legacy"]))
        .toEqual({ [input.userMessageId]: { userId: f.creator.id }, "old-writer": { userId: f.creator.id }, legacy: null });
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });

  it("answers sender lookups with one indexed receipt read", async () => {
    const input = prompt(); expect((await send(input)).status).toBe(201);
    await withSystemTx(pool, async tx => {
      await tx.query("SET LOCAL enable_seqscan=off");
      const original = tx.query, query = original.bind(tx), plans: unknown[] = [];
      tx.query = (async (sql: string, values: unknown[]) => {
        plans.push((await query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values)).rows[0]["QUERY PLAN"]);
        return query(sql, values);
      }) as typeof tx.query;
      try {
        expect(await mirrorMessageSenders(tx, f.workspace.id, "chat", [input.userMessageId]))
          .toEqual({ [input.userMessageId]: { userId: f.creator.id } });
      } finally { tx.query = original; }
      expect(plans).toHaveLength(1);
      expect(JSON.stringify(plans)).toMatch(/"Index Name":"cloud_v2_prompt_outbox_(?:pkey|workspace_id_chat_id_sequence_key)"/);
      expect(JSON.stringify(plans)).not.toContain('"Node Type":"Seq Scan"');
    });
  });
});
