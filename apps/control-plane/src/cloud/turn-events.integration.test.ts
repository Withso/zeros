import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { observeTransactionTiming } from "../request-timing.js";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";

// turn-events-v1: like Conductor's single session-notification stream, a turn's outcome and its context retirement ride
// in the worker's history batch, applied in that one transaction.
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("turn-events-v1: outcomes and retirements in the history batch", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  const features = (events = true) => `${f.features},history-replace-v1,history-digest-v1,chat-edit-v1,history-batch-v1${events ? ",turn-events-v1" : ""}`;
  const row = (id: string) => ({ msgId: id, kind: "text", payload: JSON.stringify({ text: id }), createdAt: 1 });
  const batch = (sequence: number, frames: object[], events: object[], withEvents = true) =>
    f.worker("history/batch", { bootId: f.boot, sequence, frames, events }, { features: features(withEvents) });
  const state = async (userMessageId: string) => (await pool.query("SELECT state FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2",
    [f.workspace.id, userMessageId])).rows[0]?.state;
  const context = async (id: string) => (await pool.query("SELECT state,retirement_id FROM cloud_v2_execution_contexts WHERE id=$1", [id])).rows[0];
  const historySequence = async () => Number((await pool.query("SELECT worker_history_sequence FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].worker_history_sequence);

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    f = await executionFixture(pool, { teamOwnership: true });
    await f.login(); await f.activate();
    const hello = await f.hello(features());
    expect(hello.status).toBe(200);
    expect((await hello.json()).config).toMatchObject({ historyBatch: 1, turnEvents: 1 });
  });
  afterEach(async () => { await f?.close(); await f?.cp.teamSharing.signals.close(); });

  const turnEnd = (turn: Awaited<ReturnType<ExecutionFixture["dispatch"]>>, retirementId = randomUUID()) => [
    { t: "outcome", outcome: { userMessageId: turn.begin.userMessageId, dispatchId: turn.begin.dispatchId, state: "completed" } },
    { t: "retired", contextId: turn.begun.contextId, retired: { retirementId, reason: "outcome", processes: 0 } },
  ];

  it("applies a turn's last rows, its outcome and its retirement in one request and one transaction", async () => {
    const turn = await f.dispatch();
    let transactions = -1;
    const response = await observeTransactionTiming(() => batch(1, [{ chats: [{ id: "chat" }] }, { messages: { chatId: "chat", rows: [row("answer")] } }],
      turnEnd(turn)), summary => { transactions = summary.transactions; });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sequence: 2, events: [{ ok: true, value: { state: "completed" } }, { ok: true, value: { retired: true } }] });
    expect(transactions).toBe(1);
    expect(await state(turn.begin.userMessageId)).toBe("completed");
    expect((await context(turn.begun.contextId)).state).toBe("retired");
    expect(await historySequence()).toBe(2);
  });

  it("carries events without frames, leaving the history sequence where it was", async () => {
    const turn = await f.dispatch();
    const response = await batch(1, [], turnEnd(turn));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sequence: 0, events: [{ ok: true, value: { state: "completed" } }, { ok: true, value: { retired: true } }] });
    expect(await historySequence()).toBe(0);
    expect(await state(turn.begin.userMessageId)).toBe("completed");
  });

  it("a refused event answers like its own route and rolls back only itself", async () => {
    const turn = await f.dispatch();
    const response = await batch(1, [{ chats: [{ id: "chat" }] }], [
      { t: "outcome", outcome: { userMessageId: turn.begin.userMessageId, dispatchId: randomUUID(), state: "completed" } },
      { t: "retired", contextId: turn.begun.contextId, retired: { retirementId: randomUUID(), reason: "outcome", processes: 1 } },
      { t: "outcome", outcome: { userMessageId: turn.begin.userMessageId, dispatchId: turn.begin.dispatchId, state: "accepted" } },
    ]);
    expect(response.status).toBe(200);
    expect((await response.json()).events).toEqual([{ ok: false, status: 409, code: "prompt_conflict" },
      { ok: false, status: 409, code: "execution_not_retired" }, { ok: true, value: { state: "accepted" } }]);
    expect(await historySequence()).toBe(1);
    expect(await state(turn.begin.userMessageId)).toBe("accepted");
    expect((await context(turn.begun.contextId)).state).toBe("active");
  });

  it("a replayed batch (a lost reply) applies nothing twice and answers the same", async () => {
    const turn = await f.dispatch(), retirementId = randomUUID(), frames = [{ chats: [{ id: "chat" }] }];
    const first = await (await batch(1, frames, turnEnd(turn, retirementId))).json();
    const again = await batch(1, frames, turnEnd(turn, retirementId));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect((await context(turn.begun.contextId)).retirement_id).toBe(retirementId);
    expect(await historySequence()).toBe(1);
  });

  it("a retirement batched before a cancelled outcome still records the cancellation's authority event", async () => {
    const turn = await f.dispatch(), other = await f.dispatch(f.prompt(randomUUID(), { chatId: "other" }));
    const events = async () => Number((await pool.query("SELECT count(*) FROM cloud_v2_authority_events WHERE workspace_id=$1", [f.workspace.id])).rows[0].count);
    // Only an R2 boot records events; the fixture's boot may be lease-v1, in which case both counts stay equal.
    const before = await events();
    const separate = await f.worker(`execution-leases/${turn.begun.contextId}/retired`, { retirementId: randomUUID(), reason: "outcome", processes: 0 }, { features: features() });
    expect(separate.status).toBe(200);
    const afterRetire = await events();
    expect(afterRetire).toBe(before);
    const response = await batch(1, [], [
      { t: "outcome", outcome: { userMessageId: other.begin.userMessageId, dispatchId: other.begin.dispatchId, state: "cancelled" } }]);
    expect(response.status).toBe(200);
    const mode = (await pool.query("SELECT authority_mode FROM cloud_v2_execution_boots WHERE boot_id=$1", [f.boot])).rows[0]?.authority_mode;
    if (mode === "message-authority-v1") expect(await events()).toBeGreaterThan(afterRetire);
    const setting = (await pool.query("SELECT current_setting('app.cloud_authority_retirement', true) AS value")).rows[0].value;
    expect(setting ?? "").toBe("");
  });

  it("refuses events from a worker that did not negotiate turn-events-v1, before writing anything", async () => {
    const turn = await f.dispatch();
    const response = await batch(1, [{ chats: [{ id: "chat" }] }], turnEnd(turn), false);
    expect(response.status).toBe(400);
    expect(await historySequence()).toBe(0);
    expect(await state(turn.begin.userMessageId)).toBe("dispatching");
  });
});
