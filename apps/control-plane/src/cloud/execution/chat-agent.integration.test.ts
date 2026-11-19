import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// A conversation keeps the agent it was created with. Sending another agent into it answers a code that says so
// (found by the 2026-11-19 Alpha load run, which reused chat ids across runs) instead of the generic actor_changed.
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("a conversation's agent", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(f.creator); await f.login(f.creator, "codex"); await f.activate();
    expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); });
  afterAll(() => pool.end());

  it("refuses another agent in a conversation with chat_agent_mismatch", async () => {
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_v2_chats(workspace_id,chat_id,row,updated_at) VALUES ($1,'claude-chat',$2,clock_timestamp())`,
      [f.workspace.id, JSON.stringify({ id: "claude-chat", agentId: "claude" })]));
    const response = await f.send(f.prompt(randomUUID(), { chatId: "claude-chat", agentId: "codex" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({ code: "chat_agent_mismatch" });
    expect((await f.send(f.prompt(randomUUID(), { chatId: "claude-chat", agentId: "claude" }))).status).toBe(201);
  });
});
