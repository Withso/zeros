import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../authz.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// Each scenario's answer, recorded on the tree before statements-1 (ac87dc78d) by its implementation review: begin,
// lease and send must keep refusing a removal, a cut or a revoked session with the same code and leave the same rows.
const expected = JSON.parse(readFileSync(new URL("./__fixtures__/statements-precedence.json", import.meta.url), "utf8")) as Record<string, unknown>;
const results: Record<string, unknown> = {};
const checked = new Set<string>();
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("begin, lease and send refuse a removal exactly as before statements-1", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  const features = () => `${f.features},begin-lease-v1`;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 8000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { teamOwnership: true }); await f.activate(); expect((await f.hello(features())).status).toBe(200);
    await f.login(f.viewer); await f.login(f.creator);
  });
  afterEach(() => {
    for (const name of Object.keys(results).filter(name => !checked.has(name))) { checked.add(name); expect([name, results[name]]).toEqual([name, expected[name]]); }
  });
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); await f?.cp.teamSharing.signals.close(); });
  afterAll(async () => { await pool.end(); });

  const identity = () => ({ token: f.token, bootId: f.boot });
  const delivered = async (user = f.viewer, input = f.prompt()) => {
    expect((await f.send(input, user)).status).toBe(201);
    const pulled = (await (await f.worker("prompts/pull", { waitMs: 0, held: [] }, { features: features() })).json()).prompts
      .find((value: { payload: { userMessageId: string } }) => value.payload.userMessageId === input.userMessageId);
    expect((await f.worker("prompts/ack", { userMessageId: input.userMessageId, deliveryId: pulled.deliveryId }, { features: features() })).status).toBe(200);
    return { input, begin: { userMessageId: input.userMessageId, deliveryId: pulled.deliveryId, dispatchId: randomUUID() } };
  };
  const remove = (id: string) => pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, id]);
  /** No trigger runs: the cut a Hold window opening on the clock makes. */
  const silently = async (...statements: Array<[string, unknown[]]>) => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN; SET LOCAL session_replication_role=replica");
      for (const [text, values] of statements) await tx.query(text, values);
      await tx.query("COMMIT");
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  };
  const member = (id: string): [string, unknown[]] => ["DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, id]];
  const connection = (id: string): [string, unknown[]] => ["DELETE FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, id]];
  const prompt = async (id: string) => (await pool.query("SELECT state FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [f.workspace.id, id])).rows[0]?.state;
  const contexts = async () => (await pool.query(`SELECT state,reason,material IS NOT NULL AS material,sender_ended_at IS NOT NULL AS sender_ended
    FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='turn'`, [f.workspace.id])).rows;
  const answer = async (response: Response) => { const body = await response.json(); return { status: response.status, code: body?.error?.code ?? null, dispatch: body?.dispatch, state: body?.state, lease: "lease" in body }; };
  const thrown = (error: unknown) => error instanceof HttpError ? { status: error.status, code: error.code, class: error.constructor.name } : { raw: String(error) };

  /** Runs `action` once, when begin first reads the chat's agent (after its admission read in both trees). */
  const atAgent = (action: () => Promise<unknown>) => {
    const store = f.cp.execution as unknown as { agent: (...args: unknown[]) => Promise<unknown> };
    const agent = store.agent.bind(store);
    vi.spyOn(store, "agent").mockImplementationOnce(async (...args) => { await action(); return agent(...args); });
  };
  /** Runs `action` once, after the lease's material resolved and before its final transaction. */
  const afterMaterial = (action: () => Promise<unknown>) => {
    const material = f.cp.execution.deps.material;
    vi.spyOn(f.cp.execution.deps, "material").mockImplementationOnce(async (...args) => { const value = await material(...args); await action(); return value; });
  };
  const beginRecord = async (name: string, user: typeof f.viewer, action: () => Promise<unknown>) => {
    const { input, begin } = await delivered(user);
    atAgent(action);
    const reply = await answer(await f.worker("prompts/begin", begin, { features: features() }));
    const before = await prompt(input.userMessageId), rows = await contexts();
    await f.cp.execution.maintenance.workspace(f.workspace.id).catch(() => undefined);
    results[name] = { reply, prompt: before, contexts: rows, afterMaintenance: { prompt: await prompt(input.userMessageId), contexts: await contexts() } };
  };
  const leaseRecord = async (name: string, user: typeof f.viewer, arm: () => void) => {
    const { input, begin } = await delivered(user);
    arm();
    let outcome: unknown;
    try { const { reply, missed } = await f.cp.execution.beginWithLease(identity(), begin); outcome = { dispatch: reply.dispatch, lease: "lease" in reply, missed: missed?.code ?? null }; }
    catch (error) { outcome = { thrown: thrown(error) }; }
    results[name] = { outcome, prompt: await prompt(input.userMessageId), contexts: await contexts() };
  };

  it("B1 begin: sender (not payer) removed through the fence after the admission read", () => beginRecord("B1", f.viewer, () => remove(f.viewer.id)));
  it("B2 begin: sender (not payer) cut with no trigger after the admission read", () => beginRecord("B2", f.viewer, () => silently(member(f.viewer.id))));
  it("B4 begin: self-paying sender cut with no trigger, connection gone too", () => beginRecord("B4", f.creator, () => silently(connection(f.creator.id), member(f.creator.id))));
  it("B5 begin: payer's connection gone and sender cut with no trigger", () => beginRecord("B5", f.viewer, () => silently(connection(f.creator.id), member(f.viewer.id))));

  it("L1 lease: clock-only cut of the sender inside the final transaction (after the context lock)", () => leaseRecord("L1", f.viewer, () => {
    const agentConfig = f.cp.execution.deps.agentConfig;
    vi.spyOn(f.cp.execution.deps, "agentConfig").mockImplementationOnce(async (...args) => { await silently(member(f.viewer.id)); return agentConfig(...args); });
  }));
  it("L2 lease: self-paying sender removed through the fence before the final transaction", () => leaseRecord("L2", f.creator, () => afterMaterial(() => remove(f.creator.id))));
  it("L3 lease: self-paying sender cut with no trigger before the final transaction", () => leaseRecord("L3", f.creator, () => afterMaterial(() => silently(member(f.creator.id)))));
  it("L4 lease: sender cut with no trigger and the payer's connection gone before the final transaction", () =>
    leaseRecord("L4", f.viewer, () => afterMaterial(() => silently(connection(f.creator.id), member(f.viewer.id)))));
  it("L5 lease: sender cut with no trigger and the login read answers 503 in the final transaction", () =>
    leaseRecord("L5", f.viewer, () => afterMaterial(async () => {
      await silently(member(f.viewer.id));
      vi.spyOn(f.cp.execution.deps.logins, "select").mockRejectedValueOnce(new HttpError(503, "agent_credentials_unavailable", "probe"));
    })));
  it("L6 lease: clock-only cut of the payer inside the final transaction", () => leaseRecord("L6", f.viewer, () => {
    const agentConfig = f.cp.execution.deps.agentConfig;
    vi.spyOn(f.cp.execution.deps, "agentConfig").mockImplementationOnce(async (...args) => { await silently(member(f.creator.id)); return agentConfig(...args); });
  }));

  /** Runs `action` between send's preflight and its enqueue transaction. */
  const afterPreflight = (action: () => Promise<unknown>) => {
    const preflight = f.cp.execution.preflightPrompt.bind(f.cp.execution);
    vi.spyOn(f.cp.execution, "preflightPrompt").mockImplementationOnce(async (...args) => { const value = await preflight(...args); await action(); return value; });
  };
  const sendRecord = async (name: string, action: () => Promise<unknown>, replay = false) => {
    const first = f.prompt();
    expect((await f.send(first, f.creator)).status).toBe(201);
    afterPreflight(action);
    const response = await f.send(replay ? first : f.prompt(), f.creator);
    const text = await response.text();
    results[name] = { status: response.status, code: JSON.parse(text)?.error?.code ?? null, receipt: text.includes("sequence") };
  };
  const deleteChat = (): [string, unknown[]] => ["UPDATE cloud_v2_chats SET deleted_at=clock_timestamp() WHERE workspace_id=$1", [f.workspace.id]];
  it("S1 send: creator cut with no trigger after preflight", () => sendRecord("S1", () => silently(member(f.creator.id))));
  it("S2 send: creator cut with no trigger after preflight, chat deleted too", () => sendRecord("S2", () => silently(member(f.creator.id), deleteChat())));
  it("S3 send: session revoked after preflight, chat deleted too", () => sendRecord("S3", async () => {
    await silently(deleteChat());
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.creator.authentication.sessionId]);
  }));
  it("S4 send: session revoked after preflight", () => sendRecord("S4", () =>
    pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.creator.authentication.sessionId])));
  it("S5 send replay: creator cut with no trigger after preflight", () => sendRecord("S5", () => silently(member(f.creator.id)), true));
  it("S6 send replay: session revoked after preflight", () => sendRecord("S6", () =>
    pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.creator.authentication.sessionId]), true));
  it("S7 send: creator's login gone and creator cut with no trigger after preflight", () =>
    sendRecord("S7", () => silently(connection(f.creator.id), member(f.creator.id))));

  it("D1 begin racing account and membership changes: no deadlock", async () => {
    const deadlocks = async () => { await new Promise(resolve => setTimeout(resolve, 1500));
      return Number((await pool.query("SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")).rows[0].deadlocks); };
    const before = await deadlocks(), statuses: number[] = [], failures: string[] = [];
    for (let index = 0; index < 16; index++) {
      const { begin } = await delivered(f.viewer, f.prompt(randomUUID(), { chatId: `chat-${index}` }));
      const change = index % 4 === 0 ? pool.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [f.viewer.id])
        : index % 4 === 1 ? pool.query("UPDATE organization_members SET authorization_revision=authorization_revision+1 WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id])
        : index % 4 === 2 ? pool.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [f.creator.id])
        : pool.query("UPDATE cloud_agent_credentials SET revision=revision WHERE owner_user_id=$1", [f.creator.id]);
      const [reply, changed] = await Promise.allSettled([f.worker("prompts/begin", begin, { features: features() }), change]);
      if (reply.status === "fulfilled") statuses.push(reply.value.status); else failures.push(String(reply.reason));
      if (changed.status === "rejected") failures.push(String(changed.reason));
      // The account revision moved: later sends need the actor's new revision.
      const row = (await pool.query("SELECT auth_revision FROM users WHERE id=$1", [f.viewer.id])).rows[0];
      f.viewer.accountRevision = Number(row.auth_revision);
      const creator = (await pool.query("SELECT auth_revision FROM users WHERE id=$1", [f.creator.id])).rows[0];
      f.creator.accountRevision = Number(creator.auth_revision);
    }
    results.D1 = { statuses, failures, deadlocks: await deadlocks() - before };
  }, 120_000);
});
