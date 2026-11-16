import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// Every prompt notification wakes the worker's long poll (two transactions to answer it, two more to poll again) and a
// relay hint. A finished turn wakes it only when the chat has a message waiting behind that turn.
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("a terminal outcome wakes the worker only for a message waiting behind it", () => {
  let pool: pg.Pool, f: ExecutionFixture, listener: pg.PoolClient;
  const heard: string[] = [];
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool);
    await f.login(); await f.activate(); expect((await f.hello()).status).toBe(200);
    listener = await pool.connect();
    listener.on("notification", notice => { if (notice.channel === "zeros_cloud_v2_prompts" && notice.payload) heard.push(notice.payload); });
    await listener.query("LISTEN zeros_cloud_v2_prompts");
  });
  afterEach(async () => {
    heard.length = 0; await listener?.query("UNLISTEN *");
    // A pooled client keeps its handlers: a later test could otherwise hear every notification twice.
    listener?.removeAllListeners("notification"); listener?.release(); await f?.close();
  });
  afterAll(() => pool.end());

  /** Notifications for this workspace between the call and a later sentinel (delivered in commit order). */
  const drain = async () => {
    const sentinel = randomUUID();
    await pool.query("SELECT pg_notify('zeros_cloud_v2_prompts',$1)", [sentinel]);
    await expect.poll(() => heard.includes(sentinel), { timeout: 2000, interval: 5 }).toBe(true);
  };
  const notified = async (run: () => Promise<unknown>) => {
    await drain(); heard.length = 0;
    await run();
    await drain();
    return heard.filter(id => id === f.workspace.id).length;
  };
  const outcome = (turn: Awaited<ReturnType<ExecutionFixture["dispatch"]>>, state = "completed") =>
    f.worker("prompts/outcome", { userMessageId: turn.begin.userMessageId, dispatchId: turn.begin.dispatchId, state }).then(response => expect(response.status).toBe(200));

  it("stays quiet when nothing waits in that chat", async () => {
    const turn = await f.dispatch();
    expect(await notified(() => outcome(turn))).toBe(0);
  });

  it("wakes the worker when the next message in the chat waits behind the finished turn", async () => {
    const turn = await f.dispatch();
    expect((await f.send(f.prompt())).status).toBe(201);
    expect(await notified(() => outcome(turn))).toBe(1);
  });

  it("retiring the finished turn's context wakes nothing (pull never depends on contexts)", async () => {
    const turn = await f.dispatch();
    expect((await f.send(f.prompt())).status).toBe(201);
    await outcome(turn);
    expect(await notified(async () => expect((await f.worker(`execution-leases/${turn.begun.contextId}/retired`,
      { retirementId: randomUUID(), reason: "outcome", processes: 0 })).status).toBe(200))).toBe(0);
  });

  it("a message waiting in another chat does not make it wake", async () => {
    const turn = await f.dispatch();
    // Not blocked by this turn: it was offered at send time, so the finished turn has nothing to release.
    expect((await f.send(f.prompt(undefined, { chatId: "other" }))).status).toBe(201);
    expect(await notified(() => outcome(turn))).toBe(0);
  });
});
