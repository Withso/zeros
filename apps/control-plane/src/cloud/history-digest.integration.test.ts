import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { newCloudV2Token } from "./tokens.js";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";
// The real worker is a test oracle; the deployed control plane stays standalone.
import { SessionStore } from "../../../cloud-worker/src/sessions/session-store.js";
import { HistoryMirror } from "../../../cloud-worker/src/sessions/history-mirror.js";
import type { Transport } from "../../../cloud-worker/src/transport.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const digest = "a".repeat(64);
const row = (id: string) => ({ msgId: id, kind: "text", payload: JSON.stringify({ text: id }), createdAt: 1 });

suite("worker history digest reconciliation", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  let sequence: number;
  const cleanups: Array<() => Promise<void>> = [];
  const capabilities = () => `${f.features},history-replace-v1,history-digest-v1,chat-edit-v1`;
  const read = (options: { token?: string; boot?: string } = {}) => f.worker("history/digests", {}, { features: capabilities(), ...options });
  const write = (input: object, at = sequence + 1) => {
    sequence = Math.max(sequence, at);
    return f.worker("history", { t: "history", bootId: f.boot, sequence: at, ...input }, { features: capabilities() });
  };
  const change = (sql: string, values: unknown[] = [f.workspace.id]) => withSystemTx(pool, tx => tx.query(sql, values));
  const stored = async () => {
    const response = await read();
    expect(response.status).toBe(200);
    return (await response.json() as { chats: { chatId: string; digest: string | null }[] }).chats;
  };
  const seed = async (stamp = true) => {
    expect((await write({ chats: [{ id: "native-chat" }] })).status).toBe(200);
    expect((await write({ messages: { chatId: "native-chat", replace: true, historyState: { revision: 0 }, rows: [row("first")],
      ...(stamp ? { digest } : {}) } })).status).toBe(200);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest: stamp ? digest : null }]);
  };

  const edit = (chatId: string, title: string) => f.cp.store.chatEdits.applyForManager(
    { organizationId: f.organizationId, userId: f.creator.id }, f.workspace.id, chatId, { title }, async () => {});
  async function nativeMirror(options: { chats?: number; rows?: number; restored?: boolean } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "history-digest-integration-"));
    const key = `cloud://${f.organizationId}/${f.workspace.id}`;
    const store = await SessionStore.open(directory, key);
    for (let chat = 0; chat < (options.chats ?? 3); chat++) {
      await store.upsert({ id: `chat-${chat}`, folder: key, title: `Chat ${chat}` });
      await store.importMessages(`chat-${chat}`, Array.from({ length: options.rows ?? 2 }, (_, index) => ({
        msgId: `row-${index}`, kind: "text", createdAt: index,
        payload: JSON.stringify({ id: `row-${index}`, kind: "text", role: "assistant", text: `${chat}/${index}`, createdAt: index }),
      })));
    }
    const frames: Array<Extract<Parameters<Transport["send"]>[0], { t: "history" }>> = [];
    let reads = 0;
    let afterFrame: ((frame: typeof frames[number]) => Promise<void>) | undefined;
    const state = { enabled: true, restored: options.restored ?? false };
    const transport: Transport = {
      start() {}, async dispose() {},
      historyDigests: async () => {
        reads++;
        const response = await read();
        if (!response.ok) throw new Error(`digest read: ${response.status}`);
        return response.json();
      },
      send: async frame => {
        if (frame.t !== "history") throw new Error("unexpected mirror frame");
        frames.push(frame);
        const response = await write(frame);
        if (!response.ok) throw new Error(`history write: ${response.status}`);
        await afterFrame?.(frame);
        return true;
      },
    };
    const mirror = new HistoryMirror(store, transport, () => true, value => value,
      { enabled: () => state.enabled, restored: () => state.restored });
    cleanups.push(async () => { mirror.disconnect(); await mirror.dispose(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
    const connect = async () => { mirror.connect(); expect(await mirror.flush()).toBe(true); };
    return { store, mirror, state, transport, frames, connect, reads: () => reads,
      replaced: () => frames.filter(frame => frame.messages?.replace).map(frame => frame.messages!.chatId).sort(),
      afterFrame: (callback: typeof afterFrame) => { afterFrame = callback; },
      reconnect: async () => { frames.length = 0; reads = 0; mirror.disconnect(); await connect(); } };
  }

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    sequence = 0;
    f = await executionFixture(pool, { teamOwnership: true });
    await f.login(); await f.activate();
    expect((await f.hello(capabilities())).status).toBe(200);
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await f?.close();
    await f?.cp.teamSharing.signals.close();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it("returns only the authenticated workspace's mirrored chats", async () => {
    await f.cp.store.writeHistory(f.workspace.id, { chats: [{ id: "native-chat" }] });
    await f.cp.store.writeHistory(f.own.id, { chats: [{ id: "foreign-chat" }] });
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ chats: [{ chatId: "native-chat", digest: null }] });
  });

  it("stamps only the final frame of a committed replacement chain", async () => {
    expect((await write({ chats: [{ id: "native-chat" }] })).status).toBe(200);
    expect((await write({ messages: { chatId: "native-chat", replace: true, historyState: { revision: 0 }, rows: [row("first")] } })).status).toBe(200);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
    expect((await write({ messages: { chatId: "native-chat", rows: [row("last")], digest } })).status).toBe(200);
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ chats: [{ chatId: "native-chat", digest }] });
    expect(await f.cp.store.windowMessages(f.workspace.id, "native-chat", 10)).toEqual([row("first"), row("last")]);
  });

  it("stamps an empty replacement and returns an empty scoped mirror", async () => {
    expect(await stored()).toEqual([]);
    expect((await write({ chats: [{ id: "native-chat" }] })).status).toBe(200);
    expect((await write({ messages: { chatId: "native-chat", rows: [], replace: true, historyState: { revision: 0 }, digest } })).status).toBe(200);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest }]);
    expect(await f.cp.store.windowMessages(f.workspace.id, "native-chat", 10)).toEqual([]);
  });

  it("does not stamp when an unaware writer changes the chat before its first message frame", async () => {
    expect((await write({ chats: [{ id: "native-chat", title: "Worker title" }] })).status).toBe(200);
    await change("UPDATE cloud_v2_chats SET row=row || '{\"title\":\"Concurrent title\"}'::jsonb WHERE workspace_id=$1");
    expect((await write({ messages: { chatId: "native-chat", replace: true, historyState: { revision: 0 }, rows: [row("first")], digest } })).status).toBe(200);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
    expect((await change("SELECT row->>'title' AS title FROM cloud_v2_chats WHERE workspace_id=$1")).rows).toEqual([{ title: "Concurrent title" }]);
  });

  it("requires a replacement start after the chat frame before accepting a final digest", async () => {
    expect((await write({ chats: [{ id: "native-chat" }] })).status).toBe(200);
    expect((await write({ messages: { chatId: "native-chat", rows: [row("first")], digest } })).status).toBe(200);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
  });

  it.each(["missing", "interleaved", "message write", "chat write"])("does not stamp a replacement with an interrupted prefix: %s", async interruption => {
    if (interruption === "missing") expect((await write({ chats: [{ id: "native-chat" }] })).status).toBe(200);
    else await seed(false);
    if (interruption === "interleaved") expect((await write({ chats: [{ id: "another-chat" }] })).status).toBe(200);
    if (interruption === "message write") await change("UPDATE cloud_v2_messages SET payload=payload WHERE workspace_id=$1");
    if (interruption === "chat write") await change("UPDATE cloud_v2_chats SET row=row WHERE workspace_id=$1");
    expect((await write({ messages: { chatId: "native-chat", rows: [row("last")], digest } })).status).toBe(200);
    expect((await stored()).find(chat => chat.chatId === "native-chat")?.digest).toBeNull();
  });

  it("keeps a failed final frame atomic and permits an exact sequence retry", async () => {
    await seed(false);
    const at = sequence + 1;
    expect((await write({ messages: { chatId: "native-chat", rows: [{ ...row("invalid"), createdAt: -1 }], digest } }, at)).status).toBe(400);
    const final = { messages: { chatId: "native-chat", rows: [row("last")], digest } };
    expect((await write(final, at)).status).toBe(200);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest }]);
    await change("UPDATE cloud_v2_messages SET payload=payload WHERE workspace_id=$1");
    expect((await write(final, at)).status).toBe(200);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
    expect((await write({ messages: { ...final.messages, digest: "b".repeat(64) } }, at)).status).toBe(409);
  });

  it("rolls back database failure without advancing the prefix or sequence", async () => {
    await seed(false);
    const at = sequence + 1;
    await expect(f.cp.store.writeWorkerHistory(f.token, f.boot, at, {
      messages: { chatId: "native-chat", rows: [{ ...row("invalid"), createdAt: -1 }], digest },
    })).rejects.toMatchObject({ code: "23514" });
    expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
    expect(await f.cp.store.windowMessages(f.workspace.id, "native-chat", 10)).toEqual([row("first")]);
    expect((await write({ messages: { chatId: "native-chat", rows: [row("last")], digest } }, at)).status).toBe(200);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest }]);
  });

  it("refuses a sequence gap and never carries a prefix across boots", async () => {
    await seed(false);
    const final = { messages: { chatId: "native-chat", rows: [row("last")], digest } };
    expect((await write(final, sequence + 2)).status).toBe(409);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
    const boot = randomUUID();
    expect((await f.worker("hello", { protocol: 2, bootId: boot, runtimeSha256: "b".repeat(64) }, { boot, features: capabilities() })).status).toBe(200);
    expect((await f.worker("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" }, { boot })).status).toBe(200);
    expect((await read()).status).toBe(401);
    const response = await f.worker("history", { t: "history", bootId: boot, sequence: 1, ...final }, { boot, features: capabilities() });
    expect(response.status).toBe(200);
    expect(await (await read({ boot })).json()).toEqual({ chats: [{ chatId: "native-chat", digest: null }] });
  });

  it("ignores stamps from unsequenced compatibility writes", async () => {
    await seed(false);
    await f.cp.store.writeHistory(f.workspace.id, { messages: { chatId: "native-chat", replace: true, rows: [row("last")], digest } });
    expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
    expect((await write({ messages: { chatId: "native-chat", rows: [], digest } })).status).toBe(200);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
  });

  it("cannot stamp a frame that also acknowledges a pending chat edit", async () => {
    await seed(false); await edit("native-chat", "Edited");
    expect((await write({ chats: [{ id: "native-chat", title: "Edited" }], chatEditAcks: [{ chatId: "native-chat", version: "1" }],
      messages: { chatId: "native-chat", replace: true, historyState: { revision: 0 }, rows: [row("last")], digest } })).status).toBe(200);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
    expect((await change("SELECT version::text,acknowledged_version::text FROM cloud_v2_chat_edits WHERE workspace_id=$1")).rows)
      .toEqual([{ version: "1", acknowledged_version: "1" }]);
  });

  it.each(["edit", "history"])("serializes a manager chat edit and a final history frame with %s holding the workspace first", async first => {
    await seed(false);
    const gate = await pool.connect();
    let firstWrite: Promise<unknown> | undefined, secondWrite: Promise<unknown> | undefined;
    await pool.query(`CREATE FUNCTION test_hold_chat_digest_writer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (TG_ARGV[0]='edit' AND NEW.row->>'title'='Concurrent edit')
          OR (TG_ARGV[0]='history' AND OLD.history_digest IS NULL AND NEW.history_digest IS NOT NULL) THEN
          PERFORM pg_advisory_xact_lock(251,2);
        END IF;
        RETURN NULL;
      END $$;
      CREATE TRIGGER test_hold_chat_digest_writer AFTER UPDATE ON cloud_v2_chats
      FOR EACH ROW EXECUTE FUNCTION test_hold_chat_digest_writer('${first}')`);
    try {
      await gate.query("SELECT pg_advisory_lock(251,2)");
      const history = async () => {
        expect((await write({ messages: { chatId: "native-chat", rows: [row("last")], digest } })).status).toBe(200);
      };
      const manager = async () => {
        expect(await edit("native-chat", "Concurrent edit")).toMatchObject({ title: "Concurrent edit" });
      };
      firstWrite = first === "edit" ? manager() : history();
      let holder = 0;
      await vi.waitFor(async () => {
        const waiting = await pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event='advisory'
            AND query LIKE '%UPDATE cloud_v2_chats%'`);
        expect(waiting.rows).toHaveLength(1);
        holder = waiting.rows[0]!.pid;
      }, { timeout: 3000, interval: 20 });
      secondWrite = first === "edit" ? history() : manager();
      await vi.waitFor(async () => {
        const waiting = await pool.query<{ query: string; workspace_lock: boolean; child_write_lock: boolean }>(`SELECT query,
          EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='cloud_v2_workspaces'::regclass
            AND l.mode='RowShareLock' AND l.granted) AS workspace_lock,
          EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation IN ('cloud_v2_chats'::regclass,'cloud_v2_messages'::regclass)
            AND l.mode='RowExclusiveLock') AS child_write_lock
          FROM pg_stat_activity a WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [holder]);
        expect(waiting.rows).toHaveLength(1);
        // Both production entry points must wait on the parent before trying
        // any chat/message mutation; a later trigger lock cannot prove that.
        expect(waiting.rows[0]!.query).toMatch(/^SELECT id(?:, worker_boot_id| FROM cloud_v2_workspaces)/);
        expect(waiting.rows[0]).toMatchObject({ workspace_lock: true, child_write_lock: false });
      }, { timeout: 3000, interval: 20 });
      await gate.query("SELECT pg_advisory_unlock(251,2)");
      await Promise.all([firstWrite, secondWrite]);
      expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
      expect(await f.cp.store.windowMessages(f.workspace.id, "native-chat", 10)).toEqual([row("first"), row("last")]);
      expect((await change("SELECT row->>'title' AS title FROM cloud_v2_chats WHERE workspace_id=$1")).rows)
        .toEqual([{ title: "Concurrent edit" }]);
      expect((await change("SELECT version::text,acknowledged_version::text FROM cloud_v2_chat_edits WHERE workspace_id=$1")).rows)
        .toEqual([{ version: "1", acknowledged_version: "0" }]);
    } finally {
      await gate.query("SELECT pg_advisory_unlock(251,2)"); gate.release();
      await Promise.allSettled([firstWrite, secondWrite]);
      await pool.query("DROP TRIGGER test_hold_chat_digest_writer ON cloud_v2_chats; DROP FUNCTION test_hold_chat_digest_writer()");
    }
  });

  it("rechecks the invalidated prefix after a concurrent message writer releases its lock", async () => {
    await seed(false);
    const client = await pool.connect();
    let pending: Promise<Response> | undefined;
    let committed = false;
    try {
      await client.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await client.query("UPDATE cloud_v2_messages SET payload='concurrent mutation' WHERE workspace_id=$1", [f.workspace.id]);
      pending = write({ messages: { chatId: "native-chat", rows: [row("last")], digest } });
      await vi.waitFor(async () => {
        const waiting = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND $1=ANY(pg_blocking_pids(pid))) AS waiting`, [pid]);
        expect(waiting.rows[0].waiting).toBe(true);
      }, { timeout: 3000, interval: 20 });
      await client.query("COMMIT"); committed = true;
      expect((await pending).status).toBe(200);
      expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
    } finally {
      if (!committed) await client.query("ROLLBACK");
      client.release(); await pending;
    }
  });

  it("invalidates a first stamp when another transaction moves a message into the chat", async () => {
    expect((await write({ chats: [{ id: "native-chat" }, { id: "source-chat" }] })).status).toBe(200);
    expect((await write({ messages: { chatId: "source-chat", rows: [row("moved")] } })).status).toBe(200);
    expect((await write({ chats: [{ id: "native-chat" }] })).status).toBe(200);
    const gate = await pool.connect();
    let frame: Promise<Response> | undefined;
    let movement: Promise<unknown> | undefined;
    let moved = false;
    await pool.query(`CREATE FUNCTION test_hold_history_digest_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(251,1); RETURN NULL; END $$;
      CREATE TRIGGER test_hold_history_digest_stamp AFTER UPDATE OF history_digest ON cloud_v2_chats
      FOR EACH ROW WHEN (OLD.history_digest IS NULL AND NEW.history_digest IS NOT NULL)
      EXECUTE FUNCTION test_hold_history_digest_stamp()`);
    try {
      await gate.query("SELECT pg_advisory_lock(251,1)");
      frame = write({ messages: { chatId: "native-chat", replace: true, historyState: { revision: 0 }, rows: [row("first")], digest } });
      await vi.waitFor(async () => {
        const waiting = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event='advisory' AND query LIKE '%UPDATE cloud_v2_chats h SET history_digest=%') AS waiting`);
        expect(waiting.rows[0].waiting).toBe(true);
      }, { timeout: 3000, interval: 20 });
      movement = withSystemTx(pool, async tx => {
        await tx.query("SET LOCAL application_name='history-digest-move'");
        const result = await tx.query("UPDATE cloud_v2_messages SET chat_id='native-chat' WHERE workspace_id=$1 AND chat_id='source-chat'", [f.workspace.id]);
        expect(result.rowCount).toBe(1);
      }).then(() => { moved = true; });
      await vi.waitFor(async () => {
        const waiting = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND application_name='history-digest-move' AND wait_event_type='Lock') AS waiting`);
        expect(moved || waiting.rows[0].waiting).toBe(true);
      }, { timeout: 3000, interval: 20 });
      await gate.query("SELECT pg_advisory_unlock(251,1)");
      expect((await frame).status).toBe(200);
      await movement;
      expect(await f.cp.store.windowMessages(f.workspace.id, "native-chat", 10)).toHaveLength(2);
      expect((await stored()).find(chat => chat.chatId === "native-chat")?.digest).toBeNull();
    } finally {
      await gate.query("SELECT pg_advisory_unlock(251,1)"); gate.release();
      await Promise.allSettled([frame, movement]);
      await pool.query("DROP TRIGGER test_hold_history_digest_stamp ON cloud_v2_chats; DROP FUNCTION test_hold_history_digest_stamp()");
    }
  });

  it.each([false, true])("orders a new chat prefix after an already running message move (existing chat: %s)", async existing => {
    await f.cp.store.writeHistory(f.workspace.id, { chats: [...(existing ? [{ id: "native-chat" }] : []), { id: "source-chat" }] });
    await f.cp.store.writeHistory(f.workspace.id, { messages: { chatId: "source-chat", rows: [row("moved")] } });
    const client = await pool.connect();
    let pending: Promise<Response> | undefined;
    let committed = false;
    let prepared = false;
    try {
      await client.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const context = (await client.query("SELECT coalesce(current_setting('app.cloud_execution_protocol',true),'') AS protocol")).rows;
      expect((await client.query("UPDATE cloud_v2_messages SET chat_id='native-chat' WHERE workspace_id=$1 AND chat_id='source-chat'", [f.workspace.id])).rowCount).toBe(1);
      expect((await client.query("SELECT coalesce(current_setting('app.cloud_execution_protocol',true),'') AS protocol")).rows).toEqual(context);
      pending = write({ chats: [{ id: "native-chat" }] }).then(response => { prepared = true; return response; });
      await vi.waitFor(async () => {
        const waiting = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND $1=ANY(pg_blocking_pids(pid))) AS waiting`, [pid]);
        expect(prepared || waiting.rows[0].waiting).toBe(true);
      }, { timeout: 3000, interval: 20 });
      const replace = () => write({ messages: { chatId: "native-chat", replace: true, historyState: { revision: 0 }, rows: [row("first")], digest } });
      const overtook = prepared;
      if (overtook) expect((await replace()).status).toBe(200);
      await client.query("COMMIT"); committed = true;
      expect((await pending).status).toBe(200);
      if (!overtook) expect((await replace()).status).toBe(200);
      expect(await f.cp.store.windowMessages(f.workspace.id, "native-chat", 10)).toEqual([row("first")]);
      expect((await stored()).find(chat => chat.chatId === "native-chat")?.digest).toBe(digest);
    } finally {
      if (!committed) await client.query("ROLLBACK");
      client.release(); await pending;
    }
  });

  it.each([
    ["message insert", "INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms) VALUES($1,'native-chat','second','text','second',2)"],
    ["message update", "UPDATE cloud_v2_messages SET payload='changed' WHERE workspace_id=$1"],
    ["message no-op update", "UPDATE cloud_v2_messages SET payload=payload WHERE workspace_id=$1"],
    ["message delete", "DELETE FROM cloud_v2_messages WHERE workspace_id=$1"],
    ["chat content update", "UPDATE cloud_v2_chats SET row=row || '{\"title\":\"Edited\"}'::jsonb WHERE workspace_id=$1"],
    ["chat no-op update", "UPDATE cloud_v2_chats SET row=row WHERE workspace_id=$1"],
    ["chat timestamp update", "UPDATE cloud_v2_chats SET updated_at=clock_timestamp() WHERE workspace_id=$1"],
    ["chat soft-delete", "UPDATE cloud_v2_chats SET deleted_at=clock_timestamp() WHERE workspace_id=$1"],
  ])("database invalidation covers an unaware writer's %s", async (_kind, sql) => {
    await seed();
    await change(sql);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
  });

  it("clears both scopes of a message move, while a stamp-only UPDATE survives", async () => {
    await seed();
    await f.cp.store.writeHistory(f.own.id, { chats: [{ id: "foreign-chat" }] });
    await change("UPDATE cloud_v2_chats SET history_digest=$2 WHERE workspace_id=$1", [f.own.id, digest]);
    await change("UPDATE cloud_v2_messages SET workspace_id=$2,chat_id='foreign-chat' WHERE workspace_id=$1", [f.workspace.id, f.own.id]);
    const values = await change("SELECT history_digest FROM cloud_v2_chats WHERE workspace_id=ANY($1::uuid[]) ORDER BY chat_id", [[f.workspace.id, f.own.id]]);
    expect(values.rows).toEqual([{ history_digest: null }, { history_digest: null }]);
    await change("UPDATE cloud_v2_chats SET history_digest=$2 WHERE workspace_id=$1", [f.workspace.id, digest]);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest }]);
  });

  it("does not rewrite a chat on message insert, update or delete when its digest and replacement marker are already null", async () => {
    await seed();
    await change("UPDATE cloud_v2_messages SET payload=payload WHERE workspace_id=$1");
    expect((await change("SELECT history_digest,history_replacement_boot_id FROM cloud_v2_chats WHERE workspace_id=$1")).rows)
      .toEqual([{ history_digest: null, history_replacement_boot_id: null }]);
    await withSystemTx(pool, async tx => {
      const mutations = () => tx.query("SELECT n_tup_ins,n_tup_upd,n_tup_del FROM pg_stat_xact_user_tables WHERE relid='cloud_v2_chats'::regclass");
      const before = (await mutations()).rows;
      for (const sql of [
        "INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms) VALUES($1,'native-chat','new','text','new',2)",
        "UPDATE cloud_v2_messages SET payload=payload WHERE workspace_id=$1 AND msg_id='new'",
        "DELETE FROM cloud_v2_messages WHERE workspace_id=$1 AND msg_id='new'",
      ]) {
        expect((await tx.query(sql, [f.workspace.id])).rowCount).toBe(1);
        expect((await mutations()).rows).toEqual(before);
      }
    });
  });

  it("clears a supplied insert stamp and does not retain it after delete/reinsert or a workspace cascade", async () => {
    await seed();
    await change("DELETE FROM cloud_v2_chats WHERE workspace_id=$1");
    await change("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row,history_digest) VALUES($1,'native-chat','{}',$2)", [f.workspace.id, digest]);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest: null }]);
    await change("DELETE FROM cloud_v2_workspaces WHERE id=$1");
    expect((await read()).status).toBe(401);
    expect((await pool.query("SELECT chat_id FROM cloud_v2_chats WHERE workspace_id=$1", [f.workspace.id])).rows).toEqual([]);
    expect((await pool.query("SELECT msg_id FROM cloud_v2_messages WHERE workspace_id=$1", [f.workspace.id])).rows).toEqual([]);
  });

  it("keeps invalidation transactional, preserves caller context, and grants no user write", async () => {
    await seed();
    await expect(withSystemTx(pool, async tx => {
      const context = await tx.query("SELECT current_setting('app.system',true) AS system,current_setting('app.user_id',true) AS actor");
      await tx.query("UPDATE cloud_v2_messages SET payload=payload WHERE workspace_id=$1", [f.workspace.id]);
      expect((await tx.query("SELECT history_digest FROM cloud_v2_chats WHERE workspace_id=$1", [f.workspace.id])).rows).toEqual([{ history_digest: null }]);
      expect((await tx.query("SELECT current_setting('app.system',true) AS system,current_setting('app.user_id',true) AS actor")).rows).toEqual(context.rows);
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    expect(await stored()).toEqual([{ chatId: "native-chat", digest }]);
    const refused = await withUserTx(pool, f.creator.id, tx => tx.query("UPDATE cloud_v2_chats SET history_digest=NULL WHERE workspace_id=$1", [f.workspace.id]));
    expect(refused.rowCount).toBe(0);
    expect(await stored()).toEqual([{ chatId: "native-chat", digest }]);
  });

  it("restores an older writer's compatibility context after a trigger lock failure inside a savepoint", async () => {
    await seed();
    const holder = await pool.connect(), writer = await pool.connect();
    let result: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true),set_config('app.cloud_execution_protocol','1',true)");
      await holder.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      await writer.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true),set_config('app.cloud_execution_protocol','0',true)");
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const context = () => writer.query("SELECT current_setting('app.system',true) AS system,current_setting('app.cloud_execution_protocol',true) AS protocol");
      const before = (await context()).rows;
      await writer.query("SAVEPOINT digest_context");
      result = writer.query("UPDATE cloud_v2_messages SET payload=payload WHERE workspace_id=$1", [f.workspace.id]).catch(error => error);
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
        expect(waiting.rows[0]?.wait_event_type).toBe("Lock");
      }, { timeout: 3000, interval: 20 });
      await pool.query("SELECT pg_cancel_backend($1)", [pid]);
      expect(await result).toMatchObject({ code: "57014" });
      await writer.query("ROLLBACK TO SAVEPOINT digest_context");
      expect((await context()).rows).toEqual(before);
    } finally {
      await holder.query("ROLLBACK"); holder.release();
      await result; await writer.query("ROLLBACK"); writer.release();
    }
    expect(await stored()).toEqual([{ chatId: "native-chat", digest }]);
  });

  it.each(["token", "boot", "organization"])("uses the history writer's current %s authority", async revoked => {
    await seed();
    const options = { features: capabilities(), ...(revoked === "token" ? { token: newCloudV2Token("worker").token } : {}),
      ...(revoked === "boot" ? { boot: randomUUID() } : {}) };
    if (revoked === "organization") await pool.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [f.organizationId]);
    expect((await read(options)).status).toBe(401);
    expect((await f.worker("history", { t: "history", bootId: options.boot ?? f.boot, sequence: sequence + 1, chats: [] }, options)).status).toBe(401);
  });

  it.each(["starting", "stopped", "failed", "deleting", "deleted"])("never returns digests for a %s worker", async state => {
    await seed();
    await pool.query("UPDATE cloud_v2_workspaces SET state=$2 WHERE id=$1", [f.workspace.id, state]);
    expect((await read()).status).toBe(401);
  });

  it("returns at most 4096 chats and falls back on overflow instead of truncating", async () => {
    await change(`INSERT INTO cloud_v2_chats(workspace_id,chat_id,row)
      SELECT $1,'chat-' || id,'{}'::jsonb FROM generate_series(1,4096) id`);
    expect(await stored()).toHaveLength(4096);
    await change("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'overflow','{}')");
    const response = await read();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "history_digest_limit" } });
  });

  it("a clean wake uses one digest read and zero replacement POSTs with the real worker store", async () => {
    const native = await nativeMirror();
    await native.connect();
    expect(native.replaced()).toEqual(["chat-0", "chat-1", "chat-2"]);
    await native.reconnect();
    expect(native.reads()).toBe(1); expect(native.frames).toEqual([]);
  });

  it("a multi-frame native replacement stamps once and is skipped on clean wake", async () => {
    const native = await nativeMirror({ chats: 1, rows: 501 });
    await native.connect();
    expect(native.frames.filter(frame => frame.messages)).toHaveLength(2);
    expect(native.frames.filter(frame => frame.messages?.digest)).toHaveLength(1);
    expect(await stored()).toEqual([{ chatId: "chat-0", digest: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    await native.reconnect();
    expect(native.frames).toEqual([]);
  });

  it.each(["offline gap", "history cut", "control-plane loss"])("the real worker repairs a %s through full replacement", async repair => {
    const native = await nativeMirror();
    await native.connect(); native.mirror.disconnect();
    if (repair === "offline gap") await native.store.upsert({ id: "chat-1", folder: `cloud://${f.organizationId}/${f.workspace.id}`, title: "Offline edit" });
    if (repair === "history cut") await native.store.truncateMessages("chat-1", "row-1");
    if (repair === "control-plane loss") {
      await change("DELETE FROM cloud_v2_messages WHERE workspace_id=$1");
      await change("DELETE FROM cloud_v2_chats WHERE workspace_id=$1");
    }
    await native.reconnect();
    expect(native.replaced()).toEqual(repair === "control-plane loss" ? ["chat-0", "chat-1", "chat-2"] : ["chat-1"]);
    expect(await f.cp.store.windowMessages(f.workspace.id, "chat-1", 10)).toEqual(native.store.history("chat-1"));
  });

  it("an older-checkpoint boot proves the digest route but replaces even matching stored digests", async () => {
    const native = await nativeMirror();
    await native.connect();
    native.mirror.disconnect(); native.frames.length = 0;
    const restored = new HistoryMirror(native.store, native.transport, () => true, value => value,
      { enabled: () => true, restored: () => true });
    cleanups.push(async () => { restored.disconnect(); await restored.dispose(); });
    restored.connect(); expect(await restored.flush()).toBe(true);
    expect(native.reads()).toBe(2); expect(native.replaced()).toEqual(["chat-0", "chat-1", "chat-2"]);
    native.frames.length = 0;
    restored.disconnect(); restored.connect(); expect(await restored.flush()).toBe(true);
    expect(native.reads()).toBe(3); expect(native.frames).toEqual([]);
  });

  it("an edit made while disconnected replaces only that chat and cannot stamp until its ACK commits", async () => {
    const native = await nativeMirror();
    await native.connect(); native.mirror.disconnect();
    await edit("chat-1", "Edited on the control plane");
    await native.reconnect();
    expect(native.replaced()).toEqual(["chat-1"]);
    expect((await stored()).find(chat => chat.chatId === "chat-1")?.digest).toBeNull();
    const persisted = await change("SELECT row->>'title' AS title FROM cloud_v2_chats WHERE workspace_id=$1 AND chat_id='chat-1'");
    expect(persisted.rows).toEqual([{ title: "Edited on the control plane" }]);
    native.mirror.disconnect();
    await native.store.upsert({ id: "chat-1", folder: `cloud://${f.organizationId}/${f.workspace.id}`, title: "Edited on the control plane" });
    native.frames.length = 0;
    native.mirror.connect(); native.mirror.acknowledgeChatEdit("chat-1", "1");
    expect(await native.mirror.flush()).toBe(true);
    expect(native.frames.some(frame => frame.chatEditAcks?.length)).toBe(true);
    expect(native.frames.some(frame => frame.messages?.digest)).toBe(false);
    expect((await stored()).find(chat => chat.chatId === "chat-1")?.digest).toBeNull();
    await native.reconnect();
    expect(native.replaced()).toEqual(["chat-1"]);
    await native.reconnect();
    expect(native.frames).toEqual([]);
  });

  it("an edit between native replacement chunks prevents a stale final stamp", async () => {
    const native = await nativeMirror({ chats: 1, rows: 501 });
    native.afterFrame(async frame => { if (frame.messages?.replace) await edit("chat-0", "Concurrent edit"); });
    await native.connect();
    expect(native.frames.at(-1)?.messages?.digest).toBeDefined();
    expect(await stored()).toEqual([{ chatId: "chat-0", digest: null }]);
    expect((await change("SELECT row->>'title' AS title FROM cloud_v2_chats WHERE workspace_id=$1")).rows).toEqual([{ title: "Concurrent edit" }]);
  });
});
