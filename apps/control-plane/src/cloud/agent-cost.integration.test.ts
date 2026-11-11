import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { CloudV2CapabilitiesSchema, CloudV2WorkerHistorySchema, type CloudV2MessageRow } from "./contract.js";
import { cloudWorkspaceReportFixture, type CloudWorkspaceReportFixture } from "./workspace-report-test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("workspace agent cost through real history routes and PostgreSQL", () => {
  let pool: pg.Pool, f: CloudWorkspaceReportFixture, sequence: number;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, statement_timeout: 5000 }); });
  afterAll(() => pool.end());
  beforeEach(async () => { f = await cloudWorkspaceReportFixture(pool); sequence = 0; });
  afterEach(() => f.close());
  const row = (id: string, usage?: unknown, extra: Record<string, unknown> = {}): CloudV2MessageRow => ({ msgId: id, kind: "text", createdAt: 1,
    payload: JSON.stringify({ id, kind: "text", role: "user", text: "fixture", createdAt: 1,
      turnSummary: { ord: 1, agentId: "codex", summary: null, status: "completed", startedAt: 1, endedAt: 2, stopReason: "end_turn", files: [], usage }, ...extra }) });
  const input = (rows: CloudV2MessageRow[], chatId = "chat", replace?: true) => ({ messages: { chatId, rows, ...(replace ? { replace } : {}) } });
  const post = (value: object, seq = ++sequence) => f.worker("history", { t: "history", bootId: f.boot, sequence: seq, ...value });
  const cost = async () => (await f.document()).agentCost;
  async function expectCost(totalUsd: number, estimated: boolean) {
    expect(await cost()).toEqual({ totalUsd, estimated });
    expect((await f.apiDocument()).agentCost).toEqual({ totalUsd, estimated });
  }

  it("counts reported and estimated costs once, adjusts rewrites by difference, and preserves per-message identity across chats", async () => {
    expect(await cost()).toBeUndefined();
    const first = input([row("one", { totalCostUsd: 0.1, costKind: "reported", inputTokens: 50 }), row("two", { totalCostUsd: 0.2, costKind: "estimated", outputTokens: 20 })]);
    expect((await post(first)).status).toBe(200);
    await expectCost(0.3, true);
    expect((await post(first, 1)).status).toBe(200);
    expect((await post(first)).status).toBe(200);
    await expectCost(0.3, true);
    expect((await post(input([row("two", { totalCostUsd: 0.15, costKind: "reported" })]))).status).toBe(200);
    await expectCost(0.25, false);
    expect((await post(input([row("one", { totalCostUsd: 0.4, costKind: "estimated" })], "other-chat"))).status).toBe(200);
    await expectCost(0.65, true);
    expect((await post(first, 1)).status).toBe(200);
    await expectCost(0.65, true);
    const conflict = await post(first, sequence);
    expect(conflict.status).toBe(409); expect((await conflict.json()).error.code).toBe("history_sequence_conflict");
    await expectCost(0.65, true);
  });

  it("adjusts replacements and chat deletion atomically, distinguishing a known zero from unknown", async () => {
    expect((await post(input([row("one", { totalCostUsd: 2, costKind: "estimated" }), row("two", { totalCostUsd: 3 })]))).status).toBe(200);
    expect((await post(input([row("two", { totalCostUsd: 4 })], "chat", true))).status).toBe(200);
    await expectCost(4, false);
    const saved = await f.store.windowMessages(f.workspaceId, "chat", 100);
    // A failed batch cannot commit either its deletion or its cost difference.
    const tooManyBytes = row("invalid", { totalCostUsd: 100 }, { text: "é".repeat(600_000) });
    await expect(post(input([tooManyBytes], "chat", true))).rejects.toMatchObject({ code: "23514" });
    sequence--;
    await expectCost(4, false);
    expect(await f.store.windowMessages(f.workspaceId, "chat", 100)).toEqual(saved);
    expect((await post(input([row("zero", { totalCostUsd: 0, costKind: "reported" })], "chat", true))).status).toBe(200);
    await expectCost(0, false);
    expect((await post({ chatDeletions: ["chat"] })).status).toBe(200);
    expect(await cost()).toBeUndefined();
    expect(await f.apiDocument()).not.toHaveProperty("agentCost");
  });

  it("ignores opaque, malformed, non-prompt and invalid usage without refusing history", async () => {
    const rows = [row("no-usage"), row("negative", { totalCostUsd: -1 }), row("string", { totalCostUsd: "9" }),
      row("large", { totalCostUsd: Number.MAX_SAFE_INTEGER + 1 }), row("tokens-only", { inputTokens: 8 }),
      row("assistant", { totalCostUsd: 99 }, { role: "assistant" }), row("steer", { totalCostUsd: 99 }, { steeredTurnId: "opening" }),
      { ...row("invalid"), payload: 'not json "totalCostUsd"' },
      { ...row("numeric-overflow"), payload: '{"role":"user","turnSummary":{"usage":{"totalCostUsd":1e999999}}}' },
      { ...row("unsupported-jsonb"), payload: '{"role":"user","turnSummary":{"usage":{"totalCostUsd":1}},"text":"\\u0000"}' }];
    expect((await post(input(rows))).status).toBe(200);
    expect(await cost()).toBeUndefined();
    expect(await f.store.windowMessages(f.workspaceId, "chat", 100)).toEqual(rows);
    expect((await post(input([row("valid", { totalCostUsd: 1, costKind: "estimated", perModel: [{ model: "fixture", costUsd: 1 }] })]))).status).toBe(200);
    await expectCost(1, true);
  });

  it("keeps costs optional and readable asleep without changing strict capabilities or taking a read lock", async () => {
    expect((await post(input([row("cost", { totalCostUsd: 1.25, costKind: "reported" })]))).status).toBe(200);
    await f.store.requestLifecycle(f.workspaceId, f.owner.id, "stop");
    await f.store.transition(f.workspaceId, ["stopping"], "stopped");
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN"); await lock.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      const document = await f.document();
      expect(document).toMatchObject({ state: "stopped", agentCost: { totalUsd: 1.25, estimated: false } });
      expect(CloudV2CapabilitiesSchema.parse(document.capabilities)).toEqual(document.capabilities);
      expect(document.capabilities).not.toHaveProperty("agentCost");
      await expectCost(1.25, false);
    } finally { await lock.query("ROLLBACK"); lock.release(); }
    expect((await f.store.get(f.workspaceId, f.owner.id)).state).toBe("stopped");
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}`, "GET", undefined, { "x-test-actor": f.other.id })).status).toBe(404);
  });

  it("keeps released INSERT/UPSERT/DELETE shapes correct under zeros_app and denies user-context history writes", async () => {
    const legacy = (message: CloudV2MessageRow) => withSystemTx(pool, async tx => {
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      await tx.query(`INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms)
        VALUES($1,'chat',$2,$3,$4,$5) ON CONFLICT(workspace_id,chat_id,msg_id) DO UPDATE
        SET kind=EXCLUDED.kind,payload=EXCLUDED.payload,created_at_ms=EXCLUDED.created_at_ms`,
      [f.workspaceId, message.msgId, message.kind, message.payload, message.createdAt]);
    });
    await legacy(row("legacy", { totalCostUsd: 2, costKind: "estimated" }));
    await expectCost(2, true);
    await legacy(row("legacy", { totalCostUsd: 2, costKind: "estimated" }));
    await expectCost(2, true);
    await legacy(row("legacy", { totalCostUsd: 3, costKind: "reported" }));
    await expectCost(3, false);
    expect(await withUserTx(pool, f.owner.id, async tx => (await tx.query("DELETE FROM cloud_v2_messages WHERE workspace_id=$1", [f.workspaceId])).rowCount)).toBe(0);
    await expectCost(3, false);
    await withSystemTx(pool, tx => tx.query("DELETE FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id='chat'", [f.workspaceId]));
    expect(await cost()).toBeUndefined();
  });

  it("leaves pre-column history uncounted and ordinary no-cost batches leave the document version alone", async () => {
    // A pre-column row has no recorded contribution, even if its opaque
    // payload contained usage. Reads and identical replays must not backfill it.
    await pool.query("ALTER TABLE cloud_v2_messages DISABLE TRIGGER cloud_v2_messages_agent_cost");
    try {
      const legacy = row("old", { totalCostUsd: 500 });
      await pool.query(`INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms)
        VALUES($1,'chat',$2,$3,$4,$5)`, [f.workspaceId, legacy.msgId, legacy.kind, legacy.payload, legacy.createdAt]);
    } finally { await pool.query("ALTER TABLE cloud_v2_messages ENABLE TRIGGER cloud_v2_messages_agent_cost"); }
    const before = await f.document();
    expect(before).not.toHaveProperty("agentCost");
    expect((await post(input([row("old", { totalCostUsd: 500 }), ...Array.from({ length: 499 }, (_, i) => row(`plain-${i}`))]))).status).toBe(200);
    expect(await f.document()).toEqual(before);
    expect((await post(input([row("new", { totalCostUsd: 0.5 })]))).status).toBe(200);
    await expectCost(0.5, false);
  });

  it("does no cost UPDATE, even at statement level, for ordinary multi-megabyte batches and unchanged costs", async () => {
    await pool.query(`CREATE TABLE workspace_cost_update_probe(level text);
      GRANT INSERT ON workspace_cost_update_probe TO zeros_app;
      CREATE FUNCTION record_workspace_cost_update() RETURNS trigger LANGUAGE plpgsql
      SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN INSERT INTO workspace_cost_update_probe VALUES(TG_LEVEL); RETURN NULL; END $$;
      CREATE TRIGGER workspace_cost_row_probe AFTER UPDATE OF agent_cost_usd,agent_cost_turns,agent_cost_estimated_turns
        ON cloud_v2_workspaces FOR EACH ROW EXECUTE FUNCTION record_workspace_cost_update();
      CREATE TRIGGER workspace_cost_statement_probe AFTER UPDATE OF agent_cost_usd,agent_cost_turns,agent_cost_estimated_turns
        ON cloud_v2_workspaces FOR EACH STATEMENT EXECUTE FUNCTION record_workspace_cost_update();`);
    const updates = async () => (await pool.query("SELECT level FROM workspace_cost_update_probe ORDER BY level")).rows;
    try {
      const plain = Array.from({ length: 500 }, (_, i) => row(`plain-${i}`, undefined, { text: "x".repeat(8192) }));
      expect((await post(input(plain))).status).toBe(200);
      expect(await updates()).toEqual([]);
      expect((await post(input(plain))).status).toBe(200);
      expect(await updates()).toEqual([]);
      const known = row("known", { totalCostUsd: 2, costKind: "estimated" });
      expect((await post(input([known]))).status).toBe(200);
      expect(await updates()).toEqual([{ level: "ROW" }, { level: "STATEMENT" }]);
      await pool.query("DELETE FROM workspace_cost_update_probe");
      expect((await post(input([known, row("no-cost")]))).status).toBe(200);
      expect((await post({ chatDeletions: ["absent"] })).status).toBe(200);
      expect(await updates()).toEqual([]);
      await expectCost(2, true);
      expect((await post(input([row("known", { totalCostUsd: 3, costKind: "estimated" }), row("other", { totalCostUsd: 1 })]))).status).toBe(200);
      await pool.query("DELETE FROM workspace_cost_update_probe");
      expect((await post(input([row("known", { totalCostUsd: 2, costKind: "estimated" }), row("other", { totalCostUsd: 2 })]))).status).toBe(200);
      expect(await updates()).toEqual([]);
      await expectCost(4, true);
    } finally {
      await pool.query(`DROP TRIGGER workspace_cost_statement_probe ON cloud_v2_workspaces;
        DROP TRIGGER workspace_cost_row_probe ON cloud_v2_workspaces;
        DROP FUNCTION record_workspace_cost_update(); DROP TABLE workspace_cost_update_probe;`);
    }
  });

  it("preserves lifecycle timestamps and the idle-stop fallback when a cost changes", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET active_at=NULL,updated_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [f.workspaceId]);
    const before = await f.document();
    expect((await post(input([row("cost", { totalCostUsd: 1 })]))).status).toBe(200);
    expect(await f.document()).toEqual({ ...before, agentCost: { totalUsd: 1, estimated: false } });
    const idleBefore = new Date(Date.now() - 30 * 60_000);
    expect((await f.store.idleSince(idleBefore)).map(workspace => workspace.id)).toContain(f.workspaceId);
    await f.store.stopIdle(f.workspaceId, idleBefore);
    expect((await f.document()).state).toBe("stopping");
  });

  it("skips the per-row cost function for ordinary transcripts while clearing removed costs", async () => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN"); await tx.query("SET LOCAL track_functions='all'");
      await tx.query("SET LOCAL ROLE zeros_app"); await tx.query("SELECT set_config('app.system','on',true)");
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      await tx.query(`INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms)
        SELECT $1,'chat',i::text,'text','{"role":"assistant","text":"fixture"}',1 FROM generate_series(1,1000) i`, [f.workspaceId]);
      await tx.query("UPDATE cloud_v2_messages SET payload=payload || ' ' WHERE workspace_id=$1", [f.workspaceId]);
      const calls = async () => Number((await tx.query(`SELECT coalesce((SELECT calls FROM pg_stat_xact_user_functions
        WHERE funcid='cloud_v2_message_agent_cost'::regproc),0) AS calls`)).rows[0].calls);
      expect(await calls()).toBe(0);
      await tx.query("UPDATE cloud_v2_messages SET payload=$2 WHERE workspace_id=$1 AND msg_id='1'", [f.workspaceId, row("cost", { totalCostUsd: 1, costKind: "estimated" }).payload]);
      expect(await calls()).toBe(1);
      await tx.query("UPDATE cloud_v2_messages SET payload=$2 WHERE workspace_id=$1 AND msg_id='1'", [f.workspaceId, row("cost").payload]);
      expect(await calls()).toBe(2);
      expect((await tx.query("SELECT agent_cost_turns::text,agent_cost_usd::text FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0])
        .toEqual({ agent_cost_turns: "0", agent_cost_usd: "0" });
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });

  it("keeps the parent-before-message lock order when a history write races another cost rewrite", async () => {
    expect((await post(input([row("cost", { totalCostUsd: 1 })]))).status).toBe(200);
    const lock = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await lock.query("BEGIN"); await lock.query("SET LOCAL ROLE zeros_app");
      await lock.query("SELECT set_config('app.system','on',true)");
      expect((await lock.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId])).rowCount).toBe(1);
      pending = post(input([row("cost", { totalCostUsd: 3 })]));
      await expect.poll(async () => Number((await pool.query(`SELECT count(*) FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%worker_history_sequence%worker_token_hash=$1%FOR UPDATE%'`)).rows[0].count)).toBe(1);
      // The waiting history writer cannot hold a message lock before its parent.
      await lock.query("SELECT msg_id FROM cloud_v2_messages WHERE workspace_id=$1 FOR UPDATE NOWAIT", [f.workspaceId]);
      await lock.query("UPDATE cloud_v2_messages SET payload=$2 WHERE workspace_id=$1", [f.workspaceId, row("cost", { totalCostUsd: 2 }).payload]);
      await lock.query("COMMIT");
      expect((await pending).status).toBe(200);
      await expectCost(3, false);
    } finally { await lock.query("ROLLBACK"); lock.release(); await pending; }
  });

  it.each(["workspace", "organization"])("removes totals during history erasure and permits the %s-delete cascade", async deletion => {
    expect((await post(input([row("one", { totalCostUsd: 2, costKind: "estimated" })]))).status).toBe(200);
    await f.store.revoke(f.workspaceId, true);
    expect(await cost()).toBeUndefined();
    const totals = async () => (await pool.query(`SELECT agent_cost_usd::text,agent_cost_turns::text,agent_cost_estimated_turns::text
      FROM cloud_v2_workspaces WHERE id=$1`, [f.workspaceId])).rows;
    expect(await totals()).toEqual([{ agent_cost_usd: "0", agent_cost_turns: "0", agent_cost_estimated_turns: "0" }]);
    await f.store.writeHistory(f.workspaceId, input([row("two", { totalCostUsd: 3, costKind: "estimated" })]));
    await expectCost(3, true);
    await withSystemTx(pool, tx => deletion === "workspace"
      ? tx.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])
      : tx.query("DELETE FROM organizations WHERE id=$1", [f.organizationId]));
    expect(await totals()).toEqual([]);
    expect((await pool.query("SELECT count(*) AS n FROM cloud_v2_messages WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe("0");
  });

  it("keeps the usage-bearing history envelope compatible with released readers in both directions", async () => {
    const root = new URL(process.env.CLOUD_API_TEST_PROTOCOL_ROOT ?? "../../../../packages/protocol/src/", import.meta.url);
    const { CloudV2WorkerHistorySchema: protocol } = await import(new URL("cloud-v2-relay.ts", root).href);
    for (const usage of [undefined, { totalCostUsd: 0.01, costKind: "estimated", inputTokens: 12, outputTokens: 3 }]) {
      const frame = { t: "history", bootId: f.boot, sequence: sequence + 1, ...input([row(`turn-${sequence}`, usage)]) };
      expect(protocol.parse(frame)).toEqual(frame); expect(CloudV2WorkerHistorySchema.parse(frame)).toEqual(frame);
      expect((await post(input(frame.messages.rows))).status).toBe(200);
    }
    await expectCost(0.01, true);
  });
});
