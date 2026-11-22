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
  let pool: pg.Pool, f: ExecutionFixture, credentialRows = 0;
  const features = () => `${f.features},begin-lease-v1`;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 8000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { teamOwnership: true }); await f.activate(); expect((await f.hello(features())).status).toBe(200);
    await f.login(f.viewer); await f.login(f.creator);
    credentialRows = Number((await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM cloud_agent_credentials WHERE owner_user_id=$1", [f.creator.id])).rows[0]!.count);
    expect(credentialRows).toBeGreaterThan(0);
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
  const refreshActorRevisions = async () => {
    const [viewer, creator] = await Promise.all([
      pool.query("SELECT auth_revision FROM users WHERE id=$1", [f.viewer.id]),
      pool.query("SELECT auth_revision FROM users WHERE id=$1", [f.creator.id]),
    ]);
    f.viewer.accountRevision = Number(viewer.rows[0]!.auth_revision);
    f.creator.accountRevision = Number(creator.rows[0]!.auth_revision);
  };
  const mutationActions = () => [
    { name: "viewer-account", actorChanged: true, expectedRows: 1, run: () => pool.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1 RETURNING id", [f.viewer.id]) },
    { name: "viewer-membership", actorChanged: true, expectedRows: 1, run: () => pool.query("UPDATE organization_members SET authorization_revision=authorization_revision+1 WHERE org_id=$1 AND user_id=$2 RETURNING user_id", [f.organizationId, f.viewer.id]) },
    { name: "payer-account", actorChanged: true, expectedRows: 1, run: () => pool.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1 RETURNING id", [f.creator.id]) },
    { name: "credential-noop", actorChanged: false, expectedRows: credentialRows, run: () => pool.query("UPDATE cloud_agent_credentials SET revision=revision WHERE owner_user_id=$1 RETURNING id", [f.creator.id]) },
  ];
  const beginState = async (userMessageId: string, chatId: string) => {
    const [promptRow, chatRow] = await Promise.all([
      pool.query<{ state: string; dispatch_id: string | null; execution_context_id: string | null; execution_parent_context_id: string | null;
        cancel_requested: boolean; terminal_at: Date | null; payload: unknown | null; payload_bytes: number; delivery_id: string | null; worker_boot_id: string | null }>(
        "SELECT state,dispatch_id,execution_context_id,execution_parent_context_id,cancel_requested,terminal_at,payload,payload_bytes,delivery_id,worker_boot_id FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2",
        [f.workspace.id, userMessageId]),
      pool.query<{ epoch: string; next_sequence: string; stop_acked_epoch: string; active_context_id: string | null; acting_generation: string; acting_user_id: string | null }>(
        "SELECT epoch::text,next_sequence::text,stop_acked_epoch::text,active_context_id,acting_generation::text,acting_user_id FROM cloud_v2_prompt_chats WHERE workspace_id=$1 AND chat_id=$2",
        [f.workspace.id, chatId]),
    ]);
    expect(promptRow.rowCount).toBe(1);
    expect(chatRow.rowCount).toBe(1);
    return { prompt: promptRow.rows[0]!, chat: chatRow.rows[0]! };
  };
  const assertInboxBeforeBegin = (state: Awaited<ReturnType<typeof beginState>>) => {
    expect(state.prompt).toMatchObject({ state: "inboxed", dispatch_id: null, execution_context_id: null,
      execution_parent_context_id: null, cancel_requested: false, terminal_at: null });
    expect(state.prompt.payload).not.toBeNull();
    expect(state.prompt.payload_bytes).toBeGreaterThan(0);
    expect(state.prompt.delivery_id).toEqual(expect.any(String));
    expect(state.chat.active_context_id).toBeNull();
  };
  const readBeginResponse = async (response: Response) => ({
    status: response.status,
    body: await response.json() as { dispatch?: boolean; state?: string; contextId?: string; error?: { code?: string } },
  });
  const assertBeginDispatched = async (begin: { userMessageId: string; dispatchId: string }, chatId: string,
    response: Awaited<ReturnType<typeof readBeginResponse>>) => {
    expect(response.status).toBe(200);
    expect(response.body.dispatch).toBe(true);
    expect(response.body.state).toBe("dispatching");
    expect(response.body.contextId).toEqual(expect.any(String));
    const contextId = response.body.contextId!;
    const state = await beginState(begin.userMessageId, chatId);
    expect(state.prompt).toMatchObject({ state: "dispatching", dispatch_id: begin.dispatchId,
      execution_context_id: contextId, execution_parent_context_id: null, cancel_requested: false });
    const contexts = await pool.query<{ id: string; user_id: string; kind: string; user_message_id: string; dispatch_id: string; generation: string }>(
      `SELECT id,user_id,kind,user_message_id,dispatch_id,generation::text AS generation FROM cloud_v2_execution_contexts
       WHERE workspace_id=$1 AND user_message_id=$2 AND kind='turn'`, [f.workspace.id, begin.userMessageId]);
    expect(contexts.rowCount).toBe(1);
    expect(contexts.rows[0]).toMatchObject({ id: contextId, user_id: f.viewer.id, kind: "turn",
      user_message_id: begin.userMessageId, dispatch_id: begin.dispatchId });
    expect(state.chat).toMatchObject({ active_context_id: contextId, acting_user_id: f.viewer.id,
      acting_generation: contexts.rows[0]!.generation });
  };
  /** A dispatched turn the maintenance recheck has since ended: its context revoked for the changed authority and its
   * prompt cancelled. False while it still runs, so the caller checks the strict dispatch. */
  const endedAfterDispatch = async (begin: { userMessageId: string; dispatchId: string }, chatId: string,
    response: Awaited<ReturnType<typeof readBeginResponse>>) => {
    const context = (await pool.query<{ state: string; reason: string | null }>("SELECT state,reason FROM cloud_v2_execution_contexts WHERE id=$1",
      [response.body.contextId])).rows[0];
    if (context?.state !== "revoked") return false;
    expect(["actor_changed", "access_revoked"]).toContain(context.reason);
    expect((await beginState(begin.userMessageId, chatId)).prompt).toMatchObject({ state: "cancelled", dispatch_id: begin.dispatchId });
    return true;
  };
  const assertBeginRolledBack = async (begin: { userMessageId: string; dispatchId: string }, chatId: string,
    before: Awaited<ReturnType<typeof beginState>>) => {
    expect(before.prompt).toMatchObject({ state: "inboxed", dispatch_id: null, execution_context_id: null,
      execution_parent_context_id: null, cancel_requested: false, terminal_at: null });
    expect(await beginState(begin.userMessageId, chatId)).toEqual(before);
    expect((await pool.query("SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND user_message_id=$2 AND kind='turn'",
      [f.workspace.id, begin.userMessageId])).rowCount).toBe(0);
  };
  const assertBeginCancelled = async (begin: { userMessageId: string }, chatId: string,
    before: Awaited<ReturnType<typeof beginState>>, response: Awaited<ReturnType<typeof readBeginResponse>>) => {
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ dispatch: false, state: "cancelled" });
    expect(before.prompt).toMatchObject({ state: "inboxed", dispatch_id: null, execution_context_id: null,
      execution_parent_context_id: null, cancel_requested: false, terminal_at: null });
    const after = await beginState(begin.userMessageId, chatId);
    expect(after.prompt).toMatchObject({ state: "cancelled", dispatch_id: null, execution_context_id: null,
      execution_parent_context_id: null, cancel_requested: true, payload: null, payload_bytes: 0,
      delivery_id: before.prompt.delivery_id, worker_boot_id: before.prompt.worker_boot_id });
    expect(after.prompt.terminal_at).not.toBeNull();
    expect(after.prompt.payload).toBeNull();
    expect(after.chat).toEqual(before.chat);
    expect((await pool.query("SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND user_message_id=$2 AND kind='turn'",
      [f.workspace.id, begin.userMessageId])).rowCount).toBe(0);
  };

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

  for (const name of ["viewer-account", "viewer-membership", "payer-account", "credential-noop"] as const) {
    it(`D1 begin dispatches when ${name} commits before delivery`, async () => {
      const action = mutationActions().find(candidate => candidate.name === name)!;
      const chatId = `before-${name}`;
      const changed = await action.run();
      expect(changed.rowCount, `${name} row count`).toBe(action.expectedRows);
      await refreshActorRevisions();
      const { input, begin } = await delivered(f.viewer, f.prompt(randomUUID(), { chatId }));
      const before = await beginState(input.userMessageId, chatId);
      assertInboxBeforeBegin(before);
      await assertBeginDispatched(begin, chatId, await readBeginResponse(await f.worker("prompts/begin", begin, { features: features() })));
    });
  }

  for (const name of ["viewer-account", "viewer-membership"] as const) {
    it(`D1 begin cancels when ${name} changes after delivery and before begin`, async () => {
      const action = mutationActions().find(candidate => candidate.name === name)!;
      const chatId = `cancel-${name}`;
      const { input, begin } = await delivered(f.viewer, f.prompt(randomUUID(), { chatId }));
      const before = await beginState(input.userMessageId, chatId);
      assertInboxBeforeBegin(before);
      const changed = await action.run();
      expect(changed.rowCount, `${name} row count`).toBe(action.expectedRows);
      await assertBeginCancelled(begin, chatId, before,
        await readBeginResponse(await f.worker("prompts/begin", begin, { features: features() })));
    });
  }

  for (const name of ["viewer-account", "viewer-membership"] as const) {
    it(`D1 begin rejects ${name} changed after admission and rolls back`, async () => {
      const action = mutationActions().find(candidate => candidate.name === name)!;
      const chatId = `after-${name}`;
      const { input, begin } = await delivered(f.viewer, f.prompt(randomUUID(), { chatId }));
      const before = await beginState(input.userMessageId, chatId);
      assertInboxBeforeBegin(before);
      let hookRuns = 0;
      atAgent(async () => {
        hookRuns++;
        const changed = await action.run();
        expect(changed.rowCount, `${name} row count`).toBe(action.expectedRows);
      });
      const response = await readBeginResponse(await f.worker("prompts/begin", begin, { features: features() }));
      expect(hookRuns).toBe(1);
      expect(response.status).toBe(409);
      expect(response.body.error?.code).toBe("actor_changed");
      await assertBeginRolledBack(begin, chatId, before);
    });
  }

  it("D1 begin rejects a payer account changed after selection and rolls back", async () => {
    const action = mutationActions().find(candidate => candidate.name === "payer-account")!;
    const chatId = "after-payer-account";
    const { input, begin } = await delivered(f.viewer, f.prompt(randomUUID(), { chatId }));
    const before = await beginState(input.userMessageId, chatId);
    assertInboxBeforeBegin(before);
    const logins = f.cp.execution.deps.logins;
    const forWorkspace = logins.forWorkspace.bind(logins);
    let firstSelectionReturned = false, hookRuns = 0;
    const spy = vi.spyOn(logins, "forWorkspace").mockImplementation(async (...args) => {
      if (args[3] === undefined) {
        const selection = await forWorkspace(...args);
        firstSelectionReturned = true;
        return selection;
      }
      if (hookRuns === 0) {
        expect(firstSelectionReturned).toBe(true);
        hookRuns++;
        const changed = await action.run();
        expect(changed.rowCount, "payer account row count").toBe(action.expectedRows);
      }
      return forWorkspace(...args);
    });
    const response = await readBeginResponse(await f.worker("prompts/begin", begin, { features: features() }));
    expect(hookRuns).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("actor_changed");
    await assertBeginRolledBack(begin, chatId, before);
  });

  it("D1 begin racing account and membership changes: no deadlock", async () => {
    const deadlocks = async () => { await new Promise(resolve => setTimeout(resolve, 1500));
      return Number((await pool.query("SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")).rows[0].deadlocks); };
    const before = await deadlocks(), failures: string[] = [], outcomes: Array<Record<string, unknown>> = [], actions = mutationActions();
    for (let index = 0; index < 16; index++) {
      const chatId = `chat-${index}`;
      const { input, begin } = await delivered(f.viewer, f.prompt(randomUUID(), { chatId }));
      const stateBefore = await beginState(input.userMessageId, chatId);
      assertInboxBeforeBegin(stateBefore);
      const action = actions[index % actions.length]!;
      const [reply, changed] = await Promise.allSettled([
        f.worker("prompts/begin", begin, { features: features() }), action.run(),
      ]);
      const outcome: Record<string, unknown> = { index, mutation: action.name };
      if (changed.status === "rejected") failures.push(String(changed.reason));
      else {
        outcome.mutationRowCount = changed.value.rowCount;
        if (changed.value.rowCount !== action.expectedRows) failures.push(`${action.name} updated ${changed.value.rowCount} rows; expected ${action.expectedRows}`);
      }
      if (reply.status === "rejected") failures.push(String(reply.reason));
      else {
        outcome.status = reply.value.status;
        try {
          const response = await readBeginResponse(reply.value);
          outcome.state = response.body.state ?? null;
          outcome.code = response.body.error?.code ?? null;
          outcome.dispatch = response.body.dispatch ?? null;
          outcome.contextId = response.body.contextId ?? null;
          if (response.status === 200 && response.body.dispatch === true) {
            // Begin may dispatch on authority the racing change had already altered (its fence ran before the context
            // existed): the maintenance recheck then ends the turn, asynchronously. Either outcome is correct for an
            // authority change; a change that alters nothing must leave the dispatch exactly as it was.
            if (!(action.actorChanged && await endedAfterDispatch(begin, chatId, response))) await assertBeginDispatched(begin, chatId, response);
          } else if (response.status === 200 && response.body.dispatch === false && response.body.state === "cancelled"
            && (action.name === "viewer-account" || action.name === "viewer-membership")) {
            await assertBeginCancelled(begin, chatId, stateBefore, response);
          } else {
            expect(action.actorChanged, JSON.stringify(outcome)).toBe(true);
            expect(response.status, JSON.stringify(outcome)).toBe(409);
            expect(response.body.error?.code, JSON.stringify(outcome)).toBe("actor_changed");
            await assertBeginRolledBack(begin, chatId, stateBefore);
          }
        } catch (error) { failures.push(`${JSON.stringify(outcome)}: ${String(error)}`); }
      }
      outcomes.push(outcome);
      // The account revision moved: later sends need the actor's new revision.
      await refreshActorRevisions();
    }
    const deadlockDelta = await deadlocks() - before;
    const diagnostic = { outcomes, failures, deadlocks: deadlockDelta };
    console.info(`[D1 outcomes] ${JSON.stringify(diagnostic)}`);
    expect(failures).toEqual([]);
    expect(deadlockDelta).toBe(0);
  }, 120_000);

  /** A begin and an authority change whose statement (and its fence trigger) runs first, uncommitted: begin reads the
   * old authority and dispatches, then the change commits. The fence could not see a context that did not exist yet;
   * the maintenance recheck (CloudExecutionMaintenance, on the zeros_cloud_v2_execution notification) must end it. */
  const raced = async (statement: [string, unknown[]]) => {
    const chatId = `chat-raced-${randomUUID()}`;
    const { input, begin } = await delivered(f.viewer, f.prompt(randomUUID(), { chatId }));
    const held = await pool.connect();
    let reply: Awaited<ReturnType<typeof readBeginResponse>>;
    try {
      await held.query("BEGIN");
      await held.query(statement[0], statement[1]);
      // Begin does not wait for the change: it holds the user, member and organization rows only FOR KEY SHARE.
      reply = await readBeginResponse(await f.worker("prompts/begin", begin, { features: features() }));
      await held.query("COMMIT");
    } catch (error) { await held.query("ROLLBACK"); throw error; } finally { held.release(); }
    expect(reply).toMatchObject({ status: 200, body: { dispatch: true, state: "dispatching" } });
    const ended = async () => {
      const context = (await pool.query("SELECT state,reason,sender_ended_at IS NOT NULL AS sender_ended FROM cloud_v2_execution_contexts WHERE id=$1",
        [reply.body.contextId])).rows[0];
      return { context, prompt: (await beginState(input.userMessageId, chatId)).prompt.state };
    };
    return { ended, reply };
  };

  it.each([
    ["the sender's account changes", (): [string, unknown[]] => ["UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [f.viewer.id]], "actor_changed"],
    ["the organization loses cloud", (): [string, unknown[]] => ["UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [f.organizationId]], "access_revoked"],
  ] as const)("ends a turn begun on authority that changed before it started: %s", async (_name, change, reason) => {
    const { ended } = await raced(change());
    // Ended by the maintenance recheck, asynchronously: about 250 ms here, at most one 30-second execution lease.
    await vi.waitFor(async () => expect(await ended()).toMatchObject({ context: { state: "revoked", reason }, prompt: "cancelled" }), { timeout: 10_000, interval: 100 });
  }, 30_000);

  it("keeps a turn begun before the sender's removal committed on its pinned payer, as a started turn survives its sender (#1113)", async () => {
    const { ended } = await raced(member(f.viewer.id));
    // Begin committed first, so the turn started before the removal took effect: it runs on, marked sender-ended,
    // on the payer it pinned (the creator), never on the removed sender's authority.
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(await ended()).toMatchObject({ context: { state: "active", sender_ended: true }, prompt: "dispatching" });
    const selection = (await pool.query("SELECT selection FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='turn' AND state='active'", [f.workspace.id])).rows[0].selection;
    expect(selection?.payer?.userId).toBe(f.creator.id);
  }, 30_000);
});
