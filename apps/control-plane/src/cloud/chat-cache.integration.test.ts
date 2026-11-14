import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import type { CloudV2MessageRow } from "./contract.js";
import { teamSharingFixture, type TeamSharingFixture } from "./team-sharing/test-fixture.js";
import { mirrorMessageDelta, mirrorMessageRange } from "./history-cache.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("passive cloud chat cache through PostgreSQL and HTTP", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => pool.end());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => { f = await teamSharingFixture(pool); });
  const row = (msgId: string, text = msgId): CloudV2MessageRow => ({ msgId, kind: "text", createdAt: 1,
    payload: JSON.stringify({ id: msgId, kind: "text", role: "assistant", text, createdAt: 1 }) });
  const path = () => `/v1/cloud-v2/workspaces/${f.workspace.id}`;
  const history = (op: string, params: object = {}, actor = f.viewer) => f.call(`${path()}/history`, "POST", { op, params }, actor);
  async function result(op: string, params: object = {}) {
    const response = await history(op, params);
    expect(response.status).toBe(200);
    return (await response.json()).result;
  }
  const range = (fromIndex = 0, toIndex = 500, chatId = "chat") => result("messages.range", { chatId, fromIndex, toIndex });
  const since = (revision: number, chatId = "chat") => result("messages.since", { chatId, revision });
  const mirror = (rows: CloudV2MessageRow[], chatId = "chat") => f.store.writeHistory(f.workspace.id,
    { chats: [{ id: chatId }], messages: { chatId, rows } });
  function receipts(query: Record<string, string> = {}, actor = f.viewer, cache = true, sharing = true) {
    return f.app.request(`${path()}/prompts?${new URLSearchParams({ chatId: "chat", ...query })}`, {
      headers: { "x-test-actor": actor.id, ...(sharing ? { "X-Zeros-Team-Sharing": "1" } : {}),
        ...(cache ? { "X-Zeros-Chat-Cache": "1" } : {}) },
    });
  }
  async function seedReceipts(owners: string[]) {
    await mirror([]);
    await withSystemTx(pool, async tx => {
      await tx.query("INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id,next_sequence) VALUES($1,'chat',$2)", [f.workspace.id, owners.length]);
      for (const [i, userId] of owners.entries()) {
        const userMessageId = `receipt-${i + 1}`, sequence = String(i + 1);
        const payload = { chatId: "chat", userMessageId, agentId: "claude", startedAt: 1, prompt: [{ type: "text", text: "Fixture" }] };
        const receipt = { workspaceId: f.workspace.id, chatId: "chat", userMessageId, sequence, epoch: "0",
          acceptedAt: "2026-01-01T00:00:00.000Z", workspaceState: "stopped" };
        await tx.query(`INSERT INTO cloud_v2_prompt_outbox(workspace_id,chat_id,user_message_id,creator_user_id,sequence,epoch,access_epoch,
          payload_hash,payload,payload_bytes,receipt,state) VALUES($1,'chat',$2,$3,$4,0,0,$5,$6,$7,$8,'completed')`,
        [f.workspace.id, userMessageId, userId, sequence, "0".repeat(64), payload, Buffer.byteLength(JSON.stringify(payload)), receipt]);
      }
    });
  }

  it("uses dense per-chat indexes across global-ordinal gaps and keeps metadata live without waking", async () => {
    await mirror([row("m0"), row("m1")]);
    await mirror([row("noise")], "other");
    await mirror([row("m1", "edited"), row("m2")]);
    const snapshot = await range(1, 10);
    expect(snapshot).toEqual({ revision: expect.any(Number), messageCount: 3, fromIndex: 1, toIndex: 3,
      rows: [{ index: 1, ...row("m1", "edited") }, { index: 2, ...row("m2") }] });
    expect(snapshot.revision).toBeGreaterThan(0);
    expect(await range(50, 60)).toEqual({ revision: snapshot.revision, messageCount: 3, fromIndex: 3, toIndex: 3, rows: [] });
    expect((await result("chats.list")).chats.find((chat: { id: string }) => chat.id === "chat"))
      .toMatchObject({ historyCache: { revision: snapshot.revision, messageCount: 3 } });
    await f.store.writeHistory(f.workspace.id, { chats: [{ id: "chat", title: "Live title" }] });
    expect((await range()).revision).toBe(snapshot.revision);
    expect((await f.store.listChats(f.workspace.id)).chats).toContainEqual({ id: "chat", title: "Live title" });
    expect((await f.store.get(f.workspace.id, f.creator.id)).state).toBe("stopped");
  });

  it("nests cache metadata without replacing legacy worker message counts or revisions", async () => {
    await f.store.writeHistory(f.workspace.id, { chats: [{ id: "chat", messageCount: 87, revision: 42,
      historyCache: { revision: 99, messageCount: 100 } }], messages: { chatId: "chat", rows: [row("m0")] } });
    const snapshot = await range();
    expect((await result("chats.list")).chats).toEqual([{ id: "chat", messageCount: 87, revision: 42,
      historyCache: { revision: snapshot.revision, messageCount: 1 } }]);
  });

  it("returns every final append/edit since the exact base and ignores identical upserts", async () => {
    await mirror([row("m0"), row("m1")]);
    const base = await range();
    await mirror([row("m0", "first edit"), row("m2")]);
    await mirror([row("m0", "final edit"), row("m2")]);
    const delta = await since(base.revision);
    expect(delta).toEqual({ resync: false, fromRevision: base.revision, revision: base.revision + 2, messageCount: 3,
      rows: [{ index: 0, ...row("m0", "final edit") }, { index: 2, ...row("m2") }] });
    await mirror([row("m0", "final edit"), row("m2")]);
    expect(await since(delta.revision)).toEqual({ resync: false, fromRevision: delta.revision, revision: delta.revision, messageCount: 3, rows: [] });
    expect(await since(delta.revision + 1)).toEqual({ resync: true, revision: delta.revision, messageCount: 3 });
  });

  it("forces resync across replacement, deletion and recreation without reusing a revision", async () => {
    await mirror([row("m0"), row("m1")]);
    const base = await range();
    await f.store.writeHistory(f.workspace.id, { messages: { chatId: "chat", replace: true, historyState: { revision: 7, beforeEpoch: "2" }, rows: [row("m1")] } });
    const replaced = await range();
    expect(replaced).toMatchObject({ messageCount: 1, rows: [{ index: 0, ...row("m1") }], historyState: { revision: 7, beforeEpoch: "2" } });
    expect(replaced.revision).toBeGreaterThan(base.revision);
    expect(await since(base.revision)).toEqual({ resync: true, revision: replaced.revision, messageCount: 1 });
    expect(await since(replaced.revision)).toMatchObject({ resync: false, rows: [], historyState: { revision: 7, beforeEpoch: "2" } });
    await f.store.writeHistory(f.workspace.id, { chatDeletions: ["chat"] });
    expect((await result("chats.list")).chatDeletions).toContain("chat");
    await mirror([row("m0", "recreated")]);
    const recreated = await range();
    expect(recreated.revision).toBeGreaterThan(replaced.revision);
    expect(await since(replaced.revision)).toEqual({ resync: true, revision: recreated.revision, messageCount: 1 });
  });

  it("does not truncate a delta larger than 500 changes", async () => {
    await mirror([]);
    const base = await range();
    await mirror(Array.from({ length: 500 }, (_, i) => row(`m${i}`)));
    expect((await since(base.revision)).rows).toHaveLength(500);
    await mirror([row("m500")]);
    expect(await since(base.revision)).toEqual({ resync: true, revision: expect.any(Number), messageCount: 501 });
  });

  it("observes N-1 SQL edits and index renumbering, without the new application protocol", async () => {
    await mirror([row("m0"), row("m1"), row("m2")]);
    const base = await range();
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      await tx.query("UPDATE cloud_v2_messages SET payload=$3 WHERE workspace_id=$1 AND chat_id='chat' AND msg_id=$2", [f.workspace.id, "m1", row("m1", "old writer").payload]);
      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK"); throw error;
    } finally { tx.release(); }
    expect(await since(base.revision)).toMatchObject({ resync: false, rows: [{ index: 1, ...row("m1", "old writer") }] });
    const edited = await range();
    await pool.query("DELETE FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id='chat' AND msg_id='m0'", [f.workspace.id]);
    expect(await since(edited.revision)).toEqual({ resync: true, revision: expect.any(Number), messageCount: 2 });
    expect((await range()).rows.map((message: { index: number }) => message.index)).toEqual([0, 1]);
  });

  it.each(["range", "delta"])("keeps a held %s read on one snapshot during a concurrent edit and append", async kind => {
    await mirror([row("m0"), row("m1")]);
    const base = await range();
    await mirror([row("m0", "before read")]);
    const before = await range();
    let changed = false;
    const held = await withSystemTx(pool, async tx => {
      const query = tx.query.bind(tx);
      tx.query = (async (sql: string, values: unknown[]) => {
        const value = await query(sql, values);
        if (!changed && sql.includes("AS message_count")) {
          changed = true;
          await mirror([row("m1", "during read"), row("m2")]);
        }
        return value;
      }) as typeof tx.query;
      try {
        return kind === "range" ? await mirrorMessageRange(tx, f.workspace.id, "chat", 0, 500)
          : await mirrorMessageDelta(tx, f.workspace.id, "chat", base.revision);
      } finally { tx.query = query; }
    }, { consistentRead: true });
    expect(changed).toBe(true);
    expect(held).toMatchObject({ revision: before.revision, messageCount: 2,
      rows: kind === "range" ? before.rows : [{ index: 0, ...row("m0", "before read") }] });
    expect((await range()).messageCount).toBe(3);
  });

  it("forces a resync when a SQL insert sorts before an existing message", async () => {
    await mirror([row("m0"), row("m1")]);
    const base = await range();
    const ord = (await pool.query("SELECT min(ord)::text AS ord FROM cloud_v2_messages WHERE workspace_id=$1", [f.workspace.id])).rows[0].ord;
    await pool.query(`INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms,ord)
      OVERRIDING SYSTEM VALUE VALUES($1,'chat','earlier','text',$2,1,$3)`, [f.workspace.id, row("earlier").payload, String(BigInt(ord) - 1n)]);
    expect(await since(base.revision)).toEqual({ resync: true, revision: expect.any(Number), messageCount: 3 });
    expect((await range()).rows[0]).toMatchObject({ index: 0, msgId: "earlier" });
  });

  it("keeps a rolled-back edit and an identical worker history replay from creating revisions", async () => {
    await f.store.transition(f.workspace.id, ["stopped"], "starting");
    const token = await f.store.rotateWorkerToken(f.workspace.id), bootId = randomUUID();
    await f.store.acceptWorkerHello(token, bootId);
    const input = { chats: [{ id: "chat" }], messages: { chatId: "chat", replace: true as const, rows: [row("m0")] } };
    await f.store.writeWorkerHistory(token, bootId, 1, input);
    const before = await range();
    await f.store.writeWorkerHistory(token, bootId, 1, input);
    await expect(withSystemTx(pool, async tx => {
      await tx.query("UPDATE cloud_v2_messages SET payload=$2 WHERE workspace_id=$1", [f.workspace.id, row("m0", "rollback").payload]);
      throw new Error("fixture rollback");
    })).rejects.toThrow("fixture rollback");
    expect(await range()).toEqual(before);
  });

  it("reads pre-expansion history without a backfill and resyncs its first tracked mutation", async () => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN; ALTER TABLE cloud_v2_chats DISABLE TRIGGER cloud_v2_chat_cache; ALTER TABLE cloud_v2_messages DISABLE TRIGGER cloud_v2_message_cache");
      await tx.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat','{\"id\":\"chat\"}')", [f.workspace.id]);
      await tx.query("INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms) VALUES($1,'chat','old','text',$2,1)", [f.workspace.id, row("old").payload]);
      await tx.query("ALTER TABLE cloud_v2_chats ENABLE TRIGGER cloud_v2_chat_cache; ALTER TABLE cloud_v2_messages ENABLE TRIGGER cloud_v2_message_cache; COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK"); throw error;
    } finally { tx.release(); }
    expect(await range()).toMatchObject({ revision: 0, messageCount: 1, rows: [{ index: 0, ...row("old") }] });
    expect(await since(0)).toMatchObject({ resync: false, rows: [] });
    await mirror([row("new")]);
    expect(await since(0)).toEqual({ resync: true, revision: 1, messageCount: 2 });
  });

  it.each([
    { fromIndex: -1, toIndex: 1 }, { fromIndex: 2, toIndex: 1 }, { fromIndex: 0, toIndex: 501 },
    { fromIndex: 0.5, toIndex: 1 }, { fromIndex: 0, toIndex: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid range bounds %j", async bounds => {
    const response = await history("messages.range", { chatId: "chat", ...bounds });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("negotiates own-only receipts and leaves unnegotiated live reads unchanged", async () => {
    await seedReceipts([f.viewer.id, f.creator.id, f.viewer.id, f.creator.id]);
    const own = await receipts({ limit: "1" });
    expect(own.status).toBe(200);
    const first = await own.json();
    expect(first).toMatchObject({ epoch: "0", queueRevision: expect.any(Number), nextAfter: "1",
      items: [{ receipt: { userMessageId: "receipt-1" } }] });
    const last = await (await receipts({ after: first.nextAfter, queueRevision: String(first.queueRevision), limit: "1" })).json();
    expect(last).toMatchObject({ queueRevision: first.queueRevision, nextAfter: null,
      items: [{ receipt: { userMessageId: "receipt-3" } }] });
    const live = await (await receipts({}, f.viewer, false)).json();
    expect(live.items).toHaveLength(4);
    expect(live).not.toHaveProperty("queueRevision");
    const creator = await (await receipts({}, f.creator, true, false)).json();
    expect(creator.items.map((item: { receipt: { userMessageId: string } }) => item.receipt.userMessageId)).toEqual(["receipt-2", "receipt-4"]);
    expect((await receipts({ includePayload: "false" })).status).toBe(400);
    expect((await receipts({ userId: f.creator.id })).status).toBe(400);
    expect((await receipts({ after: "1" })).status).toBe(400);
  });

  it.each(["status", "cancel", "receipt", "compaction", "retention", "epoch"])("invalidates a paged own snapshot for %s without requiring a new sequence", async change => {
    await seedReceipts([f.viewer.id, f.viewer.id]);
    const first = await (await receipts({ limit: "1" })).json();
    const sql = change === "status" ? "UPDATE cloud_v2_prompt_outbox SET state='failed' WHERE workspace_id=$1"
      : change === "cancel" ? "UPDATE cloud_v2_prompt_outbox SET cancel_requested=true WHERE workspace_id=$1"
      : change === "receipt" ? "UPDATE cloud_v2_prompt_outbox SET receipt=jsonb_set(receipt,'{workspaceState}','\"running\"') WHERE workspace_id=$1"
      : change === "compaction" ? "UPDATE cloud_v2_prompt_outbox SET payload=NULL,payload_bytes=0 WHERE workspace_id=$1"
      : change === "retention" ? "DELETE FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND sequence=1"
      : "UPDATE cloud_v2_prompt_chats SET epoch=epoch+1 WHERE workspace_id=$1";
    await pool.query(sql, [f.workspace.id]);
    const second = await receipts({ after: "1", queueRevision: String(first.queueRevision) });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "queue_changed" } });
    const current = await (await receipts()).json();
    expect(current.queueRevision).toBeGreaterThan(first.queueRevision);
    await pool.query("UPDATE cloud_v2_prompt_outbox SET updated_at=clock_timestamp() WHERE workspace_id=$1", [f.workspace.id]);
    expect((await (await receipts()).json()).queueRevision).toBe(current.queueRevision);
  });

  it("returns one receipt snapshot when a writer changes status and epoch between reads", async () => {
    await seedReceipts([f.viewer.id]);
    const before = await (await receipts()).json();
    const list = f.store.prompts.listForViewer.bind(f.store.prompts);
    let changed = false, restore = () => {};
    vi.spyOn(f.store.prompts, "listForViewer").mockImplementationOnce(async (id, chat, after, limit, payload, authorize, cache) => {
      let patched = false;
      try {
        return await list(id, chat, after, limit, payload, async tx => {
          await authorize(tx);
          if (patched) return;
          patched = true;
          const query = tx.query.bind(tx);
          restore = () => { tx.query = query; };
          tx.query = (async (sql: string, values: unknown[]) => {
            const value = await query(sql, values);
            if (!changed && sql.includes("LEFT JOIN cloud_v2_prompt_cache")) {
              changed = true;
              await withSystemTx(pool, async writer => {
                await writer.query("UPDATE cloud_v2_prompt_outbox SET state='failed' WHERE workspace_id=$1", [f.workspace.id]);
                await writer.query("UPDATE cloud_v2_prompt_chats SET epoch=epoch+1 WHERE workspace_id=$1", [f.workspace.id]);
              });
            }
            return value;
          }) as typeof tx.query;
        }, cache);
      } finally { restore(); }
    });
    expect(await (await receipts()).json()).toEqual(before);
    expect(changed).toBe(true);
    const next = await (await receipts()).json();
    expect(next.epoch).toBe("1");
    expect(next.queueRevision).toBeGreaterThan(before.queueRevision);
    expect(next.items[0].state).toBe("failed");
  });

  it("tracks trigger-driven Stop and leaves ordinary delivery bookkeeping inert", async () => {
    await seedReceipts([f.viewer.id]);
    await pool.query("UPDATE cloud_v2_prompt_outbox SET state='queued' WHERE workspace_id=$1", [f.workspace.id]);
    const before = await (await receipts()).json();
    await pool.query("UPDATE cloud_v2_prompt_outbox SET lease_until=now()+interval '1 minute',updated_at=now() WHERE workspace_id=$1", [f.workspace.id]);
    expect((await (await receipts()).json()).queueRevision).toBe(before.queueRevision);
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopping' WHERE id=$1", [f.workspace.id]);
    const stopped = await (await receipts()).json();
    expect(stopped.queueRevision).toBeGreaterThan(before.queueRevision);
    expect(stopped).toMatchObject({ epoch: "1", items: [{ state: "cancelled", cancelRequested: true }] });
  });

  it("never reuses a receipt revision after the chat and all receipts are erased", async () => {
    await seedReceipts([f.viewer.id]);
    const before = await (await receipts()).json();
    await f.store.writeHistory(f.workspace.id, { chatDeletions: ["chat"] });
    const erased = await (await receipts()).json();
    expect(erased).toMatchObject({ epoch: "0", items: [], nextAfter: null });
    expect(erased.queueRevision).toBeGreaterThan(before.queueRevision);
    await seedReceipts([f.viewer.id]);
    const recreated = await (await receipts()).json();
    expect(recreated.items[0].receipt.sequence).toBe("1");
    expect(recreated.queueRevision).toBeGreaterThan(erased.queueRevision);
  });

  it("keeps tracking system-only and lets ordinary organization erasure cascade", async () => {
    await seedReceipts([f.viewer.id]);
    await mirror([row("m0")]);
    for (const table of ["cloud_v2_history_cache", "cloud_v2_history_changes", "cloud_v2_prompt_cache"]) {
      expect((await withUserTx(pool, f.creator.id, tx => tx.query(`SELECT * FROM ${table}`))).rowCount).toBe(0);
      expect((await withUserTx(pool, f.creator.id, tx => tx.query(`DELETE FROM ${table}`))).rowCount).toBe(0);
    }
    for (const statement of [
      "INSERT INTO cloud_v2_history_cache(workspace_id,chat_id,revision,resync_revision,last_txid,last_ord,base_ord) VALUES($1,'forbidden',1,1,0,0,0)",
      "INSERT INTO cloud_v2_history_changes(workspace_id,chat_id,msg_id,revision) VALUES($1,'chat','m0',1) ON CONFLICT(workspace_id,chat_id,msg_id) DO UPDATE SET revision=1",
      "INSERT INTO cloud_v2_prompt_cache(workspace_id,chat_id,revision,last_txid) VALUES($1,'forbidden',1,0)",
    ]) await expect(withUserTx(pool, f.creator.id, tx => tx.query(statement, [f.workspace.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(withUserTx(pool, f.creator.id, tx => tx.query("SELECT advance_cloud_history_cache($1,'chat',true,NULL)", [f.workspace.id])))
      .rejects.toMatchObject({ code: "42501" });
    expect((await withUserTx(pool, f.creator.id, tx => tx.query("DELETE FROM organizations WHERE id=$1", [f.organizationId]))).rowCount).toBe(1);
    for (const table of ["cloud_v2_history_cache", "cloud_v2_history_changes", "cloud_v2_prompt_cache"])
      expect((await pool.query(`SELECT * FROM ${table} WHERE workspace_id=$1`, [f.workspace.id])).rowCount).toBe(0);
  });

  it("checks current viewer membership after the passive read finishes", async () => {
    await mirror([row("m0")]);
    const original = f.store.listChats.bind(f.store);
    const read = vi.spyOn(f.store, "listChats").mockImplementationOnce(async (...args) => {
      const value = await original(...args);
      await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
      return value;
    });
    const response = await history("chats.list");
    expect(read).toHaveBeenCalled();
    expect(response.status).toBe(404);
    expect((await f.store.get(f.workspace.id, f.creator.id)).state).toBe("stopped");
  });

  it.each(["range", "delta", "receipts"])("discards a held %s response after viewer removal", async kind => {
    await seedReceipts([f.viewer.id]);
    await mirror([row("m0")]);
    const base = await range();
    const remove = () => pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
    if (kind === "range") {
      const original = f.store.messageRange.bind(f.store);
      vi.spyOn(f.store, "messageRange").mockImplementationOnce(async (...args) => { const value = await original(...args); await remove(); return value; });
    } else if (kind === "delta") {
      const original = f.store.messageSince.bind(f.store);
      vi.spyOn(f.store, "messageSince").mockImplementationOnce(async (...args) => { const value = await original(...args); await remove(); return value; });
    } else {
      const original = f.store.prompts.listForViewer.bind(f.store.prompts);
      vi.spyOn(f.store.prompts, "listForViewer").mockImplementationOnce(async (...args) => { const value = await original(...args); await remove(); return value; });
    }
    const response = kind === "receipts" ? await receipts() : await history(kind === "range" ? "messages.range" : "messages.since",
      kind === "range" ? { chatId: "chat", fromIndex: 0, toIndex: 5 } : { chatId: "chat", revision: base.revision });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
