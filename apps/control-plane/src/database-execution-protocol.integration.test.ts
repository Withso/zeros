import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemStatement, withSystemTx, withUserTx } from "./db.js";
import { PROTOCOL_DATABASE_CONTEXT } from "./db-context.js";
import { postgresNotificationSubscription } from "./postgres-notifications.js";
import { CLOUD_V2_LIVE_ACCESS } from "./cloud/workspace-access.js";
import { hashCloudV2Token } from "./cloud/tokens.js";
import { sql, SqlFragment } from "./sql-fragment.js";
import { executionFixture, type ExecutionFixture } from "./cloud/execution/test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("transaction-local execution protocol fence", () => {
  let pool: pg.Pool, single: pg.Pool, f: ExecutionFixture;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 });
    single = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  });
  beforeEach(async () => { f = await executionFixture(pool); await f.activate(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(async () => { await single.end(); await pool.end(); });

  it.each(["system", "statement", "user"])("sets the marker in %s work without lending it to the next pooled transaction", async kind => {
    const read = `SELECT pg_backend_pid() AS pid,current_setting('app.cloud_execution_protocol',true) AS marker`;
    const result = kind === "system" ? await withSystemTx(single, tx => tx.query(read))
      : kind === "user" ? await withUserTx(single, f.creator.id, tx => tx.query(read))
        : await withSystemStatement(single, sql`SELECT pg_backend_pid() AS pid,current_setting('app.cloud_execution_protocol',true) AS marker`);
    expect(result.rows[0].marker).toBe("1");
    const client = await single.connect();
    try {
      await client.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      const next = (await client.query(read)).rows[0];
      expect(next.pid).toBe(result.rows[0].pid);
      expect(next.marker).not.toBe("1");
      expect((await client.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows).toEqual([]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("executes fast-path setup as an earlier SQL command, not an unordered CTE side effect", async () => {
    const query = sql`SELECT id FROM cloud_v2_workspaces WHERE id=${SqlFragment.uuid(f.workspace.id)}`;
    expect((await withSystemStatement(single, query)).rows).toEqual([{ id: f.workspace.id }]);
    const client = await single.connect();
    try {
      const reversed = await client.query(`BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true); ${query.text}; ${PROTOCOL_DATABASE_CONTEXT}; COMMIT`) as unknown as pg.QueryResult[];
      expect(reversed[3]!.rows).toEqual([]);
    } finally { client.release(); }
  });

  it("fences released worker and child-table joins while leaving child-only maintenance possible", async () => {
    await f.hello();
    const message = f.prompt(); await f.login(); expect((await f.send(message)).status).toBe(201);
    await f.cp.store.writeHistory(f.workspace.id, { chats: [{ id: "chat" }] });
    await pool.query(`INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,expires_at)
      VALUES($1,$2,'proxy',clock_timestamp()+interval '1 hour')`, [Buffer.alloc(32, 9), f.workspace.id]);
    // These are the workspace predicates from released workerSession,
    // prompt-outbox.worker, token redelivery, and chat reads. Each has a
    // positive control so an empty child table cannot make the fence pass.
    const statements = [
      { sql: `SELECT w.id FROM cloud_v2_workspaces w WHERE worker_token_hash=$1 AND worker_boot_id=$2
        AND state NOT IN ('deleting','deleted') AND ${CLOUD_V2_LIVE_ACCESS}`, args: [hashCloudV2Token(f.token), f.boot] },
      { sql: `SELECT w.id FROM cloud_v2_workspaces w WHERE worker_token_hash=$1 AND worker_boot_id=$2
        AND state IN ('running','stopping') AND ${CLOUD_V2_LIVE_ACCESS} FOR UPDATE OF w`, args: [hashCloudV2Token(f.token), f.boot] },
      { sql: "SELECT t.token_hash FROM cloud_v2_tokens t JOIN cloud_v2_workspaces w ON w.id=t.workspace_id WHERE w.id=$1", args: [f.workspace.id] },
      { sql: "SELECT p.user_message_id FROM cloud_v2_prompt_outbox p JOIN cloud_v2_workspaces w ON w.id=p.workspace_id WHERE w.id=$1", args: [f.workspace.id] },
      { sql: "SELECT h.chat_id FROM cloud_v2_chats h JOIN cloud_v2_workspaces w ON w.id=h.workspace_id WHERE w.id=$1", args: [f.workspace.id] },
    ];
    const client = await single.connect();
    try {
      await client.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      for (const statement of statements) expect((await client.query(statement.sql, statement.args)).rows).toEqual([]);
      expect((await client.query("SELECT user_message_id FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(1);
      expect((await client.query("UPDATE cloud_v2_chat_edits SET last_offered_at=clock_timestamp() WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
      await client.query(PROTOCOL_DATABASE_CONTEXT);
      for (const statement of statements) expect((await client.query(statement.sql, statement.args)).rowCount).toBeGreaterThan(0);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("marks LISTEN setup locally and authorizes its maintenance callback through the normal helper", async () => {
    const listener = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
    const acquired: pg.PoolClient[] = [], setups: string[] = [];
    const connect = listener.connect.bind(listener);
    vi.spyOn(listener, "connect").mockImplementation((async () => {
      const client = await connect(); acquired.push(client);
      const query = client.query.bind(client);
      vi.spyOn(client, "query").mockImplementation(((text: string, ...args: unknown[]) => {
        if (text.includes("LISTEN")) setups.push(text);
        return (query as (...values: unknown[]) => unknown)(text, ...args);
      }) as typeof client.query);
      return client;
    }) as typeof listener.connect);
    const seen: string[] = [];
    const subscription = postgresNotificationSubscription(listener, { channels: [`activation_${randomUUID().replaceAll("-", "")}`],
      onNotification: () => {}, onReady: () => { void withSystemTx(pool, async tx => {
        seen.push((await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].id);
      }); } });
    try {
      await subscription.start(); await expect.poll(() => seen).toEqual([f.workspace.id]);
      expect(setups[0]).toContain(`BEGIN; ${PROTOCOL_DATABASE_CONTEXT}; LISTEN`);
      expect((await acquired[0]!.query("SELECT current_setting('app.cloud_execution_protocol',true) AS marker")).rows[0].marker).not.toBe("1");
    } finally { await subscription.stop(); await listener.end(); }
  });
});
