import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../authz.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// Each scenario's answer, recorded on the tree before statements-1 (ac87dc78d) by its implementation review: begin,
// lease and send must keep refusing a removal, a cut or a revoked session with the same code and leave the same rows.
const expected = JSON.parse(readFileSync(new URL("./__fixtures__/statements-turn-lease.json", import.meta.url), "utf8")) as Record<string, unknown>;
const results: Record<string, unknown> = {};
const checked = new Set<string>();
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("the worker's own turn-lease refuses a removal exactly as before statements-1", () => {
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

  const leaseRoute = async (name: string, user: typeof f.viewer, action: () => Promise<unknown>) => {
    const turn = await f.dispatch(f.prompt(), user);
    afterMaterial(action);
    const response = await f.worker("turn-lease", turn.lease);
    const body = await response.json();
    const again = await f.worker("turn-lease", turn.lease);
    results[name] = { status: response.status, code: body?.error?.code ?? null, contexts: await contexts(), retry: { status: again.status, code: (await again.json())?.error?.code ?? null } };
  };
  it("T1 turn-lease: payer (not sender) cut with no trigger during material", () => leaseRoute("T1", f.viewer, () => silently(member(f.creator.id))));
  it("T2 turn-lease: self-paying sender cut with no trigger during material", () => leaseRoute("T2", f.creator, () => silently(member(f.creator.id))));
  it("T3 turn-lease: sender (not payer) cut with no trigger during material", () => leaseRoute("T3", f.viewer, () => silently(member(f.viewer.id))));
  it("T4 turn-lease: payer removed through the fence during material", () => leaseRoute("T4", f.viewer, () => remove(f.creator.id)));
  it("T5 turn-lease: self-paying sender removed through the fence during material", () => leaseRoute("T5", f.creator, () => remove(f.creator.id)));
  it("T6 turn-lease: payer's connection changed through the fence during material", () => leaseRoute("T6", f.viewer, () =>
    pool.query("UPDATE cloud_agent_organization_connections SET revision=revision+1 WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.creator.id])));
});
