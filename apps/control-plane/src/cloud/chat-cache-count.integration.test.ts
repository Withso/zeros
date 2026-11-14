import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { teamSharingFixture, type TeamSharingFixture } from "./team-sharing/test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("stored cloud chat message counts", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => { f = await teamSharingFixture(pool); });
  const row = (id: string, text = id) => ({ msgId: id, kind: "text", payload: JSON.stringify({ text }), createdAt: 1 });
  const write = (ids: string[]) => f.store.writeHistory(f.workspace.id, {
    chats: [{ id: "chat" }], messages: { chatId: "chat", rows: ids.map(id => row(id)) },
  });
  async function counts() {
    return (await pool.query(`SELECT s.chat_id,s.message_count::text AS stored,
      (SELECT count(*)::text FROM cloud_v2_messages m WHERE m.workspace_id=s.workspace_id AND m.chat_id=s.chat_id) AS actual
      FROM cloud_v2_history_cache s WHERE s.workspace_id=$1 ORDER BY s.chat_id`, [f.workspace.id])).rows;
  }

  it("tracks mixed inserts, edits, moves and deletes from N-1 SQL statements", async () => {
    await write(["m0", "m1", "m2"]);
    expect(await counts()).toEqual([{ chat_id: "chat", stored: "3", actual: "3" }]);
    await write(["m1", "m3", "m4"]);
    expect(await counts()).toEqual([{ chat_id: "chat", stored: "5", actual: "5" }]);
    await withSystemTx(pool, async tx => {
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      await tx.query("UPDATE cloud_v2_messages SET chat_id='moved' WHERE workspace_id=$1 AND msg_id IN ('m0','m1')", [f.workspace.id]);
      await tx.query("DELETE FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id='chat' AND msg_id='m2'", [f.workspace.id]);
    });
    expect(await counts()).toEqual([{ chat_id: "chat", stored: "2", actual: "2" }, { chat_id: "moved", stored: "2", actual: "2" }]);
    await f.store.writeHistory(f.workspace.id, { chatDeletions: ["chat"] });
    expect(await counts()).toContainEqual({ chat_id: "chat", stored: "0", actual: "0" });
    await write(["m5"]);
    expect(await counts()).toContainEqual({ chat_id: "chat", stored: "1", actual: "1" });
  });

  it("initializes a pre-expansion count exactly once across both UPSERT trigger kinds and later statements", async () => {
    await write(["m0", "m1"]);
    await pool.query("UPDATE cloud_v2_history_cache SET message_count=NULL,count_initialized_txid=NULL WHERE workspace_id=$1", [f.workspace.id]);
    expect((await f.store.listChats(f.workspace.id, false, true)).chats[0]).toMatchObject({ historyCache: { messageCount: 2 } });
    await withSystemTx(pool, async tx => {
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      await tx.query(`INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms)
        SELECT $1,'chat',id,'text','changed',1 FROM unnest(ARRAY['m0','m2','m3']) id
        ON CONFLICT(workspace_id,chat_id,msg_id) DO UPDATE SET payload=EXCLUDED.payload`, [f.workspace.id]);
      await tx.query("DELETE FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id='chat' AND msg_id='m1'", [f.workspace.id]);
      await tx.query(`INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms)
        VALUES($1,'chat','m4','text','{}',1)`, [f.workspace.id]);
    });
    expect(await counts()).toEqual([{ chat_id: "chat", stored: "4", actual: "4" }]);
    await write(["m2", "m5"]);
    expect(await counts()).toEqual([{ chat_id: "chat", stored: "5", actual: "5" }]);
    const snapshot = await f.store.messageRange(f.workspace.id, "chat", 0, 500);
    expect(snapshot.messageCount).toBe(5);
    expect(snapshot.rows).toHaveLength(5);
  });

  it("rolls back count changes and leaves identical message replay inert", async () => {
    await write(["m0", "m1"]);
    const before = await counts();
    await write(["m0", "m1"]);
    expect(await counts()).toEqual(before);
    await expect(withSystemTx(pool, async tx => {
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      await tx.query("DELETE FROM cloud_v2_messages WHERE workspace_id=$1", [f.workspace.id]);
      throw new Error("fixture rollback");
    })).rejects.toThrow("fixture rollback");
    expect(await counts()).toEqual(before);
  });

  it.each([false, true])("serializes concurrent appends with an initialized count=%s", async initialized => {
    await write(initialized ? ["m0"] : []);
    const first = await pool.connect();
    let second: Promise<void> | undefined;
    try {
      await first.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      const pid = (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await first.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      await first.query(`INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms)
        VALUES($1,'chat','m1','text','{}',1)`, [f.workspace.id]);
      second = write(["m2"]);
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [pid]);
        expect(waiting.rowCount).toBe(1);
      }, { timeout: 3000, interval: 20 });
      await first.query("COMMIT");
      await second;
      const count = initialized ? "3" : "2";
      expect(await counts()).toEqual([{ chat_id: "chat", stored: count, actual: count }]);
    } finally {
      await first.query("ROLLBACK"); first.release();
      await second;
    }
  });
});
